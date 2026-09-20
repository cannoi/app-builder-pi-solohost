"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const dns = require("dns").promises;
const https = require("https");

const PORT = Number(process.env.PORT || 8080);
const BIND = process.env.BIND || "0.0.0.0";
const STARTED_AT = Date.now();
const PUBLIC_DIR = path.join(__dirname, "public");

const WRITE_DIRS = [
  path.join(__dirname, "runtime"),
  path.join("/tmp", "sandbox-runtime"),
  os.tmpdir()
];

for (const dir of WRITE_DIRS) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignore */ }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

function send(res, code, type, body, extra) {
  extra = extra || {};
  res.writeHead(code, Object.assign({
    "Content-Type": type,
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "X-Benchmark": "sandbox-app-benchmark/2.0"
  }, extra));
  res.end(body);
}

function json(res, data, code) {
  send(res, code || 200, "application/json; charset=utf-8", JSON.stringify(data));
}

function memoryInfo() {
  const mem = process.memoryUsage();
  return {
    rss_mb: +(mem.rss / 1048576).toFixed(1),
    heap_used_mb: +(mem.heapUsed / 1048576).toFixed(1)
  };
}

function health() {
  return {
    ok: true,
    service: "sandbox-app-benchmark",
    version: "3.0.0",
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    hostname: os.hostname(),
    cpu_count: os.cpus().length,
    uptime_sec: Math.round(process.uptime()),
    uptime_ms: Date.now() - STARTED_AT,
    memory: memoryInfo(),
    timestamp: new Date().toISOString()
  };
}

function pickWritableDir() {
  for (const dir of WRITE_DIRS) {
    try {
      const probe = path.join(dir, ".probe-" + process.pid);
      fs.writeFileSync(probe, "ok");
      fs.unlinkSync(probe);
      return dir;
    } catch (_) { /* try next */ }
  }
  return null;
}

function runWriteTest() {
  const dir = pickWritableDir();
  if (!dir) {
    return { ok: false, error: "no writable directory among /app/runtime, /tmp/sandbox-runtime, os.tmpdir()" };
  }
  const file = path.join(dir, "sandbox-write-test.txt");
  const value = "Sandbox write test " + new Date().toISOString() + " " + crypto.randomUUID();
  fs.writeFileSync(file, value, "utf8");
  const readBack = fs.readFileSync(file, "utf8");
  return {
    ok: readBack === value,
    bytes: Buffer.byteLength(readBack),
    dir: dir,
    file: file
  };
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))
  ]);
}

async function dnsProbe(host) {
  const started = Date.now();
  try {
    const addresses = await withTimeout(dns.lookup(host, { all: true }), 5000);
    return { ok: addresses.length > 0, host, addresses: addresses.map((a) => a.address), ms: Date.now() - started };
  } catch (e) {
    return { ok: false, host, ms: Date.now() - started, error: String(e?.code || e?.message || e) };
  }
}

async function httpsProbe(url) {
  const started = Date.now();
  return new Promise((resolve) => {
    const req = https.request(url, { method: "HEAD", timeout: 7000, headers: { "User-Agent": "Pi-App-Factory-Sandbox-Benchmark/3.0" } }, (res) => {
      res.resume();
      resolve({ ok: res.statusCode > 0, url, status: res.statusCode, ms: Date.now() - started });
    });
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.on("error", (e) => resolve({ ok: false, url, ms: Date.now() - started, error: String(e?.code || e?.message || e) }));
    req.end();
  });
}

async function runInternetTest() {
  const targets = ["example.com", "www.google.com", "cloudflare.com"];
  const dnsResults = [];
  for (const host of targets) dnsResults.push(await dnsProbe(host));
  const httpsResults = [];
  for (const host of targets) httpsResults.push(await httpsProbe(`https://${host}/`));
  const dnsOk = dnsResults.filter((x) => x.ok).length;
  const httpsOk = httpsResults.filter((x) => x.ok).length;
  let diagnosis = "INTERNET_OK";
  if (!dnsOk) diagnosis = "DNS_UNAVAILABLE";
  else if (!httpsOk) diagnosis = "DNS_OK_BUT_HTTPS_BLOCKED";
  else if (httpsOk < targets.length) diagnosis = "PARTIAL_INTERNET";
  return {
    ok: httpsOk > 0,
    diagnosis,
    tested_at: new Date().toISOString(),
    dns: dnsResults,
    https: httpsResults,
    summary: httpsOk > 0 ? `Outbound HTTPS works for ${httpsOk}/${targets.length} targets.` : (dnsOk > 0 ? "DNS resolves, but outbound HTTPS failed." : "DNS resolution failed for all test hosts."),
    remediation: diagnosis === "DNS_UNAVAILABLE"
      ? "Check sandbox DNS/network attachment. Do not change application proxy code yet."
      : diagnosis === "DNS_OK_BUT_HTTPS_BLOCKED"
        ? "Sandbox has DNS but outbound HTTPS is blocked. Fix Sandbox/Podman network policy before blaming the app."
        : diagnosis === "PARTIAL_INTERNET"
          ? "Internet is partially reachable. Check the target domain, proxy, TLS and DNS behavior used by the app."
          : "Sandbox outbound Internet is available. If the app still cannot browse, inspect its proxy/gateway code and browser CORS/CSP behavior."
  };
}

function runCpuTest(ms) {
  const requested = Math.min(Math.max(Number(ms) || 250, 25), 2000);
  const start = Date.now();
  let hash = Buffer.alloc(0);
  while (Date.now() - start < requested) {
    hash = crypto.createHash("sha256").update(hash).update(String(Math.random())).digest();
  }
  return {
    ok: true,
    requested_ms: requested,
    elapsed_ms: Date.now() - start,
    digest: hash.toString("hex").slice(0, 16)
  };
}

const server = http.createServer(function (req, res) {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  } catch {
    return send(res, 400, "text/plain; charset=utf-8", "Bad Request");
  }

  function finish(code, type, body, extra) {
    extra = extra || {};
    extra["X-Response-Time-Ms"] = String(Date.now() - started);
    send(res, code, type, body, extra);
  }
  function finishJson(data, code) {
    finish(code || 200, "application/json; charset=utf-8", JSON.stringify(data));
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return finish(405, "text/plain; charset=utf-8", "Method Not Allowed");
  }

  if (url.pathname === "/health" || url.pathname === "/ready" || url.pathname === "/live") {
    return finishJson(health());
  }

  if (url.pathname === "/api/info" || url.pathname === "/api/container" || url.pathname === "/container") {
    return finishJson(Object.assign({}, health(), {
      writable_dir: pickWritableDir(),
      write_candidates: WRITE_DIRS,
      container: true
    }));
  }

  if (url.pathname === "/api/write-test") {
    try {
      return finishJson(runWriteTest());
    } catch (e) {
      return finishJson({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
    }
  }

  if (url.pathname === "/api/internet-test") {
    runInternetTest().then((result) => finishJson(result)).catch((e) => finishJson({ ok: false, diagnosis: "BENCHMARK_ERROR", error: String(e?.message || e) }, 500));
    return;
  }

  if (url.pathname === "/api/cpu-test") {
    return finishJson(runCpuTest(url.searchParams.get("ms")));
  }

  if (url.pathname === "/api/parallel-test") {
    return finishJson({
      ok: true,
      requests: 5,
      server_time: Date.now(),
      request_id: crypto.randomUUID()
    });
  }

  if (url.pathname === "/api/self-test") {
    const t0 = Date.now();
    let fsResult;
    try { fsResult = runWriteTest(); } catch (e) {
      fsResult = { ok: false, error: String(e && e.message ? e.message : e) };
    }
    const cpu = runCpuTest(50);
    return finishJson({
      ok: !!(fsResult.ok && cpu.ok),
      elapsed_ms: Date.now() - t0,
      health: health(),
      filesystem: fsResult,
      cpu: cpu
    });
  }

  if (url.pathname === "/favicon.ico") {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0f766e"/><text x="16" y="22" text-anchor="middle" font-size="16" fill="white" font-family="sans-serif">S</text></svg>';
    return finish(200, "image/svg+xml", svg);
  }

  const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return finish(403, "text/plain; charset=utf-8", "Forbidden");
  }

  fs.stat(filePath, function (err, st) {
    if (err || !st.isFile()) {
      return finish(404, "text/plain; charset=utf-8", "Not found");
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "X-Response-Time-Ms": String(Date.now() - started),
      "X-Benchmark": "sandbox-app-benchmark/2.0"
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
});

server.keepAliveTimeout = 5000;
server.headersTimeout = 8000;
server.requestTimeout = 10000;

server.listen(PORT, BIND, function () {
  console.log(JSON.stringify({
    msg: "Sandbox App Benchmark listening",
    bind: BIND,
    port: PORT,
    node: process.version,
    pid: process.pid
  }));
});
