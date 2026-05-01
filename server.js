
const http = require("http");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const JOB_TTL_MS = 30_000; // jobs older than 30s are discarded

const queues = new Map();
const pollers = new Map();
const pendingResults = new Map();
const pendingResponds = new Map();

function getOrCreate(userId) {
  if (!queues.has(userId)) queues.set(userId, []);
  return queues.get(userId);
}

function isExpired(job) {
  return Date.now() - (job._enqueuedAt || 0) > JOB_TTL_MS;
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

    // ── POST /push  <- Roblox plugin ──────────────────────────────────────
    if (url === "/push" && req.method === "POST") {
      const { userId, requestId } = data;
      if (!userId)    return json(res, 400, { error: "userId required" });
      if (!requestId) return json(res, 400, { error: "requestId required" });

      console.log(`[/push] userId=${userId} requestId=${requestId}`);

      data._enqueuedAt = Date.now();

      const key = `${userId}:${requestId}`;
      pendingResults.set(key, { ready: false, data: null });

      pendingResponds.set(key, (result) => {
        const slot = pendingResults.get(key);
        if (slot) { slot.ready = true; slot.data = result; }
      });

      if (pollers.has(userId)) {
        const { res: pollRes, timer } = pollers.get(userId);
        clearTimeout(timer);
        pollers.delete(userId);
        json(pollRes, 200, data);
      } else {
        getOrCreate(userId).push(data);
      }

      setTimeout(() => pendingResults.delete(key), 180_000);

      return json(res, 200, { ok: true, requestId });
    }

    // ── GET /result  <- Roblox plugin ─────────────────────────────────────
    if (url === "/result" && req.method === "GET") {
      const params = new URL(req.url, "http://x").searchParams;
      const userId    = params.get("userId");
      const requestId = params.get("requestId");
      if (!userId || !requestId) return json(res, 400, { error: "userId + requestId required" });

      const key = `${userId}:${requestId}`;
      const slot = pendingResults.get(key);

      if (!slot) return json(res, 200, { ready: false });
      if (slot.ready) {
        pendingResults.delete(key);
        return json(res, 200, { ready: true, ...slot.data });
      }
      return json(res, 200, { ready: false });
    }

    // ── GET /poll  <- Chrome extension ────────────────────────────────────
    if (url === "/poll" && req.method === "GET") {
      const userId = new URL(req.url, "http://x").searchParams.get("userId");
      if (!userId) return json(res, 400, { error: "userId required" });

      const queue = getOrCreate(userId);

      // Drain expired jobs before handing anything to the extension
      while (queue.length > 0 && isExpired(queue[0])) {
        const stale = queue.shift();
        console.log(`[/poll] Discarding expired job ${stale.requestId} for userId=${userId}`);
        const key = `${userId}:${stale.requestId}`;
        pendingResults.delete(key);
        pendingResponds.delete(key);
      }

      if (queue.length > 0) {
        return json(res, 200, queue.shift());
      }

      const timer = setTimeout(() => {
        pollers.delete(userId);
        json(res, 200, null);
      }, 25000);

      pollers.set(userId, { res, timer });
      req.on("close", () => {
        clearTimeout(timer);
        pollers.delete(userId);
      });
      return;
    }

    // ── POST /respond  <- Chrome extension ───────────────────────────────
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
