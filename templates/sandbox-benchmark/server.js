"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");
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
    "X-Benchmark": "sandbox-app-benchmark/3.1"
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

function detectSandboxEngine() {
  if (process.env.BENCHMARK_ENGINE) return process.env.BENCHMARK_ENGINE;
  try { if (fs.existsSync("/run/.containerenv")) return "Podman"; } catch (_) {}
  try { if (fs.existsSync("/.dockerenv")) return "Docker"; } catch (_) {}
  return "unknown";
}

function health() {
  return {
    ok: true,
    service: "sandbox-app-benchmark",
    version: "3.1.0",
    node: process.version,
    sandbox_engine: detectSandboxEngine(),
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

function isPrivateIp(ip) {
  const value = String(ip || '');
  if (net.isIPv4(value)) {
    const [a,b,c,d] = value.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  return value === '::1' || value === '::' || /^(fc|fd)/i.test(value) || /^fe80:/i.test(value) || /^ff/i.test(value);
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
  const dnsResults = await Promise.all(targets.map((host) => dnsProbe(host)));
  const httpsResults = await Promise.all(targets.map((host) => httpsProbe(`https://${host}/`)));
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


async function tcpProbe(host, port = 443) {
  const started = Date.now();
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: 5000 });
    socket.once('connect', () => { const ms = Date.now() - started; socket.destroy(); resolve({ ok: true, host, port, ms }); });
    socket.once('timeout', () => { socket.destroy(); resolve({ ok: false, host, port, ms: Date.now() - started, error: 'timeout' }); });
    socket.once('error', (e) => resolve({ ok: false, host, port, ms: Date.now() - started, error: String(e?.code || e?.message || e) }));
  });
}

async function tlsProbe(host) {
  const started = Date.now();
  return await new Promise((resolve) => {
    const socket = require('tls').connect({ host, port: 443, servername: host, timeout: 7000, rejectUnauthorized: true }, () => {
      const cert = socket.getPeerCertificate() || {};
      resolve({ ok: true, host, protocol: socket.getProtocol(), authorized: socket.authorized, issuer: cert.issuer?.O || cert.issuer?.CN || '', ms: Date.now() - started });
      socket.end();
    });
    socket.once('timeout', () => { socket.destroy(); resolve({ ok: false, host, ms: Date.now() - started, error: 'timeout' }); });
    socket.once('error', (e) => resolve({ ok: false, host, ms: Date.now() - started, error: String(e?.code || e?.message || e) }));
  });
}

async function getProbe(url) {
  const started = Date.now();
  try {
    const r = await withTimeout(fetch(url, { redirect: 'manual', headers: { 'user-agent': 'Pi-App-Factory-Sandbox-Benchmark/4.0', accept: 'text/html,text/plain,*/*' } }), 10000);
    const text = await withTimeout(r.text(), 5000);
    return { ok: r.status >= 200 && r.status < 400, url, status: r.status, bytes: Buffer.byteLength(text), content_type: r.headers.get('content-type') || '', location: r.headers.get('location') || '', ms: Date.now() - started };
  } catch (e) {
    return { ok: false, url, ms: Date.now() - started, error: String(e?.cause?.code || e?.code || e?.message || e) };
  }
}

async function browserLikeFetchProbe(url) {
  const started = Date.now();
  try {
    const r = await withTimeout(fetch(url, { redirect: 'follow', headers: { 'user-agent': 'Pi-App-Factory-Sandbox-Benchmark/4.0' } }), 10000);
    return { ok: r.status >= 200 && r.status < 400, url, final_url: r.url, status: r.status, content_type: r.headers.get('content-type') || '', ms: Date.now() - started };
  } catch (e) {
    return { ok: false, url, ms: Date.now() - started, error: String(e?.cause?.code || e?.code || e?.message || e) };
  }
}

async function runInternetDeep() {
  const targets = ['example.com', 'www.google.com', 'github.com', 'cloudflare.com'];
  const httpTargets = ['http://example.com/', 'http://github.com/'];
  const followTargets = ['https://google.com/', 'https://github.com/'];
  const dnsResults = await Promise.all(targets.map(host => withTimeout(dnsProbe(host), 4500).catch(e => ({ok:false,host,error:String(e?.message || e)}))));
  const publicIps = Object.fromEntries(dnsResults.map(x => [x.host, (x.addresses || []).find(a => !isPrivateIp(a)) || null]));
  // If DNS is completely unavailable, stop here. TCP/TLS/HTTP cannot provide
  // meaningful evidence without a public destination and should not add delay.
  if (!dnsResults.some(x => x.ok)) {
    const counts = { dns: 0, tcp443: 0, tls: 0, https: 0, http: 0, follow: 0 };
    return {
      ok: false, diagnosis: 'DNS_BLOCKED', tested_at: new Date().toISOString(), node: process.version,
      elapsed_ms: Date.now() - STARTED_AT,
      proxy_env: Object.fromEntries(['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY'].map(k => [k, process.env[k] ? 'SET' : 'unset'])),
      counts, dns: dnsResults, tcp_443: [], tls: [], https: [], http: [], redirects_fetch: [],
      interpretation: { dns: 'DNS resolution failed for all public test names.', tcp_443: 'Not tested because DNS produced no public destination.', tls: 'Not tested because DNS produced no public destination.', https: 'Not tested because DNS produced no public destination.', redirects_fetch: 'Not tested because DNS produced no public destination.' },
      remediation: 'Fix Sandbox DNS/network attachment first. TCP, TLS and HTTPS tests are intentionally skipped until DNS works.'
    };
  }
  const [tcpResults, tlsResults, httpsResults] = await Promise.all([
    Promise.all(targets.map(h => publicIps[h] ? withTimeout(tcpProbe(publicIps[h],443),4500).then(r => ({...r,host:h,ip:publicIps[h]})).catch(e => ({ok:false,host:h,ip:publicIps[h],error:String(e?.message||e)})) : {ok:false,host:h,error:'no public DNS address'})),
    Promise.all(targets.map(h => publicIps[h] ? withTimeout(tlsProbe(h),6000).then(r => ({...r,host:h,ip:publicIps[h]})).catch(e => ({ok:false,host:h,ip:publicIps[h],error:String(e?.message||e)})) : {ok:false,host:h,error:'no public DNS address'})),
    Promise.all(targets.map(h => withTimeout(getProbe(`https://${h}/`),7000).catch(e => ({ok:false,host:h,url:`https://${h}/`,error:String(e?.message||e)}))))
  ]);
  const [httpResults, followResults] = await Promise.all([
    Promise.all(httpTargets.map(u => withTimeout(getProbe(u),7000).catch(e => ({ok:false,url:u,error:String(e?.message||e)})))),
    Promise.all(followTargets.map(u => withTimeout(browserLikeFetchProbe(u),7000).catch(e => ({ok:false,url:u,error:String(e?.message||e)}))))
  ]);
  const counts = {dns:dnsResults.filter(x=>x.ok).length,tcp443:tcpResults.filter(x=>x.ok).length,tls:tlsResults.filter(x=>x.ok).length,https:httpsResults.filter(x=>x.ok).length,http:httpResults.filter(x=>x.ok).length,follow:followResults.filter(x=>x.ok).length};
  const overall = counts.dns > 0 && counts.tcp443 > 0 && counts.tls > 0 && counts.https > 0;
  let diagnosis='INTERNET_HEALTHY';
  if(!counts.dns) diagnosis='DNS_BLOCKED'; else if(!counts.tcp443) diagnosis='TCP_443_BLOCKED'; else if(!counts.tls) diagnosis='TLS_BLOCKED'; else if(!counts.https) diagnosis='HTTPS_BLOCKED'; else if(counts.https<targets.length) diagnosis='PARTIAL_INTERNET'; else if(counts.follow<followTargets.length) diagnosis='REDIRECT_OR_FETCH_ISSUE';
  return {ok:overall,diagnosis,tested_at:new Date().toISOString(),node:process.version,elapsed_ms:Date.now()-STARTED_AT,proxy_env:Object.fromEntries(['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY'].map(k=>[k,process.env[k]?'SET':'unset'])),counts,dns:dnsResults,tcp_443:tcpResults,tls:tlsResults,https:httpsResults,http:httpResults,redirects_fetch:followResults,interpretation:{dns:counts.dns?`DNS can resolve ${counts.dns}/${targets.length} public names.`:'DNS resolution failed for all public test names.',tcp_443:counts.tcp443?`Outbound TCP/443 is reachable for ${counts.tcp443}/${targets.length}.`:'Outbound TCP/443 is blocked or unreachable.',tls:counts.tls?`TLS handshake works for ${counts.tls}/${targets.length}.`:'TLS handshake fails for all public hosts.',https:counts.https?`HTTPS GET works for ${counts.https}/${targets.length} public endpoints.`:'HTTPS GET failed for all public endpoints.',redirects_fetch:counts.follow===followTargets.length?'Redirect-following fetch works.':`Redirect/follow works for ${counts.follow}/${followTargets.length}.`},remediation:!counts.dns?'Fix Sandbox DNS/network attachment first.':!counts.tcp443?'Fix Sandbox outbound network/firewall/NAT before changing app code.':!counts.tls?'Inspect TLS interception, CA trust, clock, or egress policy.':!counts.https?'Inspect HTTPS egress/proxy policy.':'Sandbox outbound Internet is reachable. If a Browser app fails, inspect its navigation/proxy/CORS/CSP/runtime logic separately.'};
}

function safeWebUrl(value) {
  try {
    const u = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(u.protocol) || !u.hostname || u.username || u.password) return null;
    return u.href;
  } catch { return null; }
}

function rewriteWebHtml(html, baseUrl) {
  return String(html || '').replace(/\b(href|src|poster|action)=(['"])(.*?)\2/gi, (m,a,q,v) => {
    try { const u = new URL(v, baseUrl); if (!['http:','https:'].includes(u.protocol)) return m; return `${a}=${q}/api/web-view?url=${encodeURIComponent(u.href)}${q}`; } catch { return m; }
  }).replace(/<base\b[^>]*>/gi, '');
}

async function proxyWebView(req, res, value, redirects = 0) {
  const safe = safeWebUrl(value);
  if (!safe || redirects > 4) return false;
  const u = new URL(safe);
  try {
    const records = await dns.lookup(u.hostname, { all: true, verbatim: true });
    if (!records.length || records.some(r => {
      const ip = r.address;
      return net.isIPv4(ip) ? (() => { const [a,b,c]=ip.split('.').map(Number); return a===10||a===127||a===0||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a>=224; })() : (ip==='::1'||ip==='::'||/^f[cd]/i.test(ip)||/^fe80:/i.test(ip)||/^ff/i.test(ip));
    })) return false;
  } catch { return false; }
  const mod = u.protocol === 'https:' ? https : http;
  return await new Promise(resolve => {
    const rq = mod.get(u, { timeout: 10000, headers: { 'user-agent': 'Pi-App-Factory-Sandbox-Benchmark/4.0', accept: req.headers.accept || 'text/html,*/*' } }, up => {
      const status = up.statusCode || 502;
      if (status >= 300 && status < 400 && up.headers.location) { up.resume(); proxyWebView(req,res,new URL(up.headers.location,u).href,redirects+1).then(resolve); return; }
      let bytes=0, chunks=[];
      up.on('data', c => { bytes += c.length; if (bytes <= 2*1024*1024) chunks.push(c); else rq.destroy(); });
      up.on('end', () => {
        if (bytes > 2*1024*1024 || status >= 500) { resolve(false); return; }
        const headers={...up.headers}; for (const k of ['content-length','content-encoding','content-security-policy','x-frame-options','set-cookie']) delete headers[k];
        let body=Buffer.concat(chunks); const ct=String(headers['content-type']||'');
        if (ct.includes('text/html')) body=Buffer.from(rewriteWebHtml(body.toString('utf8'),u.href),'utf8');
        res.writeHead(status,{...headers,'cache-control':'no-store','x-benchmark-web-view':'safe'}); res.end(body); resolve(true);
      });
    });
    rq.on('timeout',()=>rq.destroy()); rq.on('error',()=>resolve(false));
  });
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

  if (url.pathname === "/api/internet-deep") {
    Promise.race([runInternetDeep(), new Promise((resolve) => setTimeout(() => resolve({ ok: false, diagnosis: "DEEP_TEST_TIMEOUT", error: "Deep network diagnostics exceeded 30 seconds. Treat this as a Sandbox network hang until proven otherwise.", remediation: "Inspect Sandbox/Podman DNS, egress and firewall policy before changing app code." }), 30000))]).then((result) => finishJson(result)).catch((e) => finishJson({ ok: false, diagnosis: "BENCHMARK_ERROR", error: String(e?.message || e) }, 500));
    return;
  }

  if (url.pathname === "/api/web-view") {
    const target = safeWebUrl(url.searchParams.get("url"));
    if (!target) return finishJson({ ok: false, error: "Only public http/https URLs are allowed." }, 400);
    proxyWebView(req, res, target).then((ok) => { if (!ok && !res.headersSent) finishJson({ ok: false, error: "External page unavailable or blocked by safe network policy." }, 502); });
    return;
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
      "X-Benchmark": "sandbox-app-benchmark/3.1"
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
