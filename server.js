// server.js
// Deploy on Railway / Render / Fly.io / any Node host
// No dependencies beyond Node built-ins

const http = require("http");

const PORT = process.env.PORT || 3000;

// How long (ms) a queued job is considered valid.
// If the extension picks it up after this window the plugin has already timed out,
// so we discard it instead of processing a ghost request.
const JOB_TTL_MS = 90_000; // 90 s  (plugin polls for 100 s, so this is safe)

// ── In-memory stores ─────────────────────────────────────────────────────────

// Queued jobs waiting for the extension to poll
// { [userId]: { requestId, pushedAt, ...payload }[] }
const queues = new Map();

// Active long-poll connections from the extension
// { [userId]: { res, timer } }
const pollers = new Map();

// Pending result slots for the push/poll pattern (plugin polls /result)
// { [userId:requestId]: { ready: bool, data: object|null } }
const pendingResults = new Map();

// Callbacks wired by /push so that /respond can resolve the result slot
// { [userId:requestId]: (result) => void }
const pendingResponds = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

function getOrCreate(userId) {
  if (!queues.has(userId)) queues.set(userId, []);
  return queues.get(userId);
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // CORS pre-flight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    return res.end();
  }

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let data = {};
    if (body) {
      try { data = JSON.parse(body); }
      catch { return json(res, 400, { error: "Invalid JSON body" }); }
    }

    const url = req.url.split("?")[0];

    // ── POST /push  ← Roblox plugin ──────────────────────────────────────────
    // Body: { userId, requestId, provider, model, messages, params, jwt, … }
    if (url === "/push" && req.method === "POST") {
      const { userId, requestId } = data;
      if (!userId)    return json(res, 400, { error: "userId required" });
      if (!requestId) return json(res, 400, { error: "requestId required" });

      console.log(`[/push] userId=${userId} requestId=${requestId}`);

      const key = `${userId}:${requestId}`;

      // Create the result slot
      const slot = { ready: false, data: null };
      pendingResults.set(key, slot);

      // Wire /respond to fill the slot
      pendingResponds.set(key, (result) => {
        slot.ready = true;
        slot.data  = result;
      });

      // Stamp the job so stale ones can be discarded
      const job = { ...data, pushedAt: Date.now() };

      // Wake extension if it's already long-polling, otherwise queue
      if (pollers.has(userId)) {
        const { res: pollRes, timer } = pollers.get(userId);
        clearTimeout(timer);
        pollers.delete(userId);
        json(pollRes, 200, job);
      } else {
        getOrCreate(userId).push(job);
      }

      // Auto-clean the result slot after JOB_TTL_MS + a small grace period
      setTimeout(() => {
        pendingResults.delete(key);
        pendingResponds.delete(key);
      }, JOB_TTL_MS + 10_000);

      return json(res, 200, { ok: true, requestId });
    }

    // ── GET /result?userId=xxx&requestId=xxx  ← Roblox plugin ────────────────
    if (url === "/result" && req.method === "GET") {
      const params    = new URL(req.url, "http://x").searchParams;
      const userId    = params.get("userId");
      const requestId = params.get("requestId");
      if (!userId || !requestId)
        return json(res, 400, { error: "userId + requestId required" });

      const key  = `${userId}:${requestId}`;
      const slot = pendingResults.get(key);

      if (!slot)        return json(res, 200, { ready: false });
      if (slot.ready) {
        pendingResults.delete(key);
        return json(res, 200, { ready: true, ...slot.data });
      }
      return json(res, 200, { ready: false });
    }

    // ── GET /poll?userId=xxx  ← Chrome extension ──────────────────────────────
    // Long-polls: holds open until a job arrives (or 25 s timeout → null)
    if (url === "/poll" && req.method === "GET") {
      const userId = new URL(req.url, "http://x").searchParams.get("userId");
      if (!userId) return json(res, 400, { error: "userId required" });

      const queue = getOrCreate(userId);

      // Drain any stale jobs first, then return the first fresh one
      while (queue.length > 0) {
        const job = queue.shift();
        const age = Date.now() - (job.pushedAt || 0);
        if (age <= JOB_TTL_MS) {
          console.log(`[/poll] userId=${userId} dispatching requestId=${job.requestId} (age=${age}ms)`);
          return json(res, 200, job);
        }
        // Job is too old — discard it and clean up its slots
        const key = `${userId}:${job.requestId}`;
        pendingResults.delete(key);
        pendingResponds.delete(key);
        console.log(`[/poll] userId=${userId} discarded stale requestId=${job.requestId} (age=${age}ms)`);
      }

      // No fresh job — hold the connection open for up to 25 s
      const timer = setTimeout(() => {
        pollers.delete(userId);
        json(res, 200, null); // null = nothing to do, extension should re-poll
      }, 25_000);

      pollers.set(userId, { res, timer });

      req.on("close", () => {
        clearTimeout(timer);
        pollers.delete(userId);
      });
      return;
    }

    // ── POST /respond  ← Chrome extension ────────────────────────────────────
    // Body: { userId, requestId, success, response, … }
    if (url === "/respond" && req.method === "POST") {
      const { userId, requestId } = data;
      if (!userId || !requestId)
        return json(res, 400, { error: "userId + requestId required" });

      const key     = `${userId}:${requestId}`;
      const resolve = pendingResponds.get(key);

      if (resolve) {
        resolve(data);
        pendingResponds.delete(key);
        console.log(`[/respond] userId=${userId} requestId=${requestId} resolved`);
        return json(res, 200, { ok: true });
      }

      // Slot already expired or unknown — still 200 so the extension doesn't crash
      console.warn(`[/respond] unknown or expired key=${key}`);
      return json(res, 200, { ok: false, warn: "Unknown or expired requestId" });
    }

    // ── GET /health ───────────────────────────────────────────────────────────
    if (url === "/health") {
      return json(res, 200, {
        ok: true,
        queues:         queues.size,
        pollers:        pollers.size,
        pendingResults: pendingResults.size,
        pendingResponds: pendingResponds.size,
      });
    }

    json(res, 404, { error: "Not found" });
  });
});

server.listen(PORT, () => {
  console.log(`Shard bridge running on port ${PORT}`);
});
