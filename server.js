// server.js
// Deploy on Railway / Render / Fly.io / any Node host
// No dependencies beyond Node built-ins

const http = require("http");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;

// In-memory job queue — keyed by userId
// { [userId]: { requestId, data, resolve, timer }[] }
const queues = new Map();

// Active long-poll connections from extensions
// { [userId]: { res, timer } }
const pollers = new Map();

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

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" });
    return res.end();
  }

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const data = body ? JSON.parse(body) : {};
    const url = req.url.split("?")[0];

    // ── POST /send  ←  Roblox plugin ─────────────────────────────────────
    // Body: { userId, prompt, ...anything }
    if (url === "/send" && req.method === "POST") {
      const { userId } = data;
      if (!userId) return json(res, 400, { error: "userId required" });

      const requestId = crypto.randomUUID();
      data.requestId = requestId;

      console.log(`[/send] userId=${userId} requestId=${requestId}`);

      // If an extension is already long-polling for this user, wake it immediately
      if (pollers.has(userId)) {
        const { res: pollRes, timer } = pollers.get(userId);
        clearTimeout(timer);
        pollers.delete(userId);
        json(pollRes, 200, data);

        // Now wait for /respond before replying to Roblox
        waitForRespond(userId, requestId, res);
        return;
      }

      // Otherwise queue it and wait
      const queue = getOrCreate(userId);
      waitForRespond(userId, requestId, res);
      queue.push(data);
      return;
    }

    // ── GET /poll?userId=xxx  ←  Chrome extension ─────────────────────────
    // Long-polls: holds open until a job arrives (or 25s timeout)
    if (url === "/poll" && req.method === "GET") {
      const userId = new URL(req.url, "http://x").searchParams.get("userId");
      if (!userId) return json(res, 400, { error: "userId required" });

      const queue = getOrCreate(userId);

      // If there's already a queued job, return it immediately
      if (queue.length > 0) {
        const job = queue.shift();
        return json(res, 200, job);
      }

      // Otherwise hold the connection open
      const timer = setTimeout(() => {
        pollers.delete(userId);
        json(res, 200, null); // null = nothing to do
      }, 25000);

      pollers.set(userId, { res, timer });
      req.on("close", () => {
        clearTimeout(timer);
        pollers.delete(userId);
      });
      return;
    }

    // ── POST /respond  ←  Chrome extension ───────────────────────────────
    // Body: { userId, requestId, ...result }
    if (url === "/respond" && req.method === "POST") {
      const { userId, requestId } = data;
      if (!userId || !requestId) return json(res, 400, { error: "userId + requestId required" });

      const key = `${userId}:${requestId}`;
      const resolve = pendingResponds.get(key);
      if (resolve) {
        resolve(data);
        pendingResponds.delete(key);
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: "Unknown requestId" });
    }

    // ── GET /health ───────────────────────────────────────────────────────
    if (url === "/health") {
      return json(res, 200, { ok: true, queues: queues.size, pollers: pollers.size });
    }

    json(res, 404, { error: "Not found" });
  });
});

// Pending /respond callbacks — keyed by "userId:requestId"
const pendingResponds = new Map();

function waitForRespond(userId, requestId, robloxRes) {
  const key = `${userId}:${requestId}`;

  const timer = setTimeout(() => {
    pendingResponds.delete(key);
    json(robloxRes, 504, { error: "Extension did not respond in time" });
  }, 30000);

  pendingResponds.set(key, (result) => {
    clearTimeout(timer);
    json(robloxRes, 200, result);
  });
}

server.listen(PORT, () => {
  console.log(`Bridge running on port ${PORT}`);
});
