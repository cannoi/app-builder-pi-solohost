/**
 * SoloHost Feedback Hub — client module v2.2
 * Integrate once. Policy, copy, fee flags and update rules come from the Hub.
 *
 * Browser: <script src="HUB/api/sdk.js"></script>
 * Node/bundler: import from module/shfh-client.js (same file)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.SHFH = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const SCHEMA = "2.2";
  const PAYMENT_STATES = ["free", "unpaid", "pending", "paid", "supporter", "expired", "waived", "unknown"];

  function uuid() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
  function nowIso() { return new Date().toISOString(); }
  function storage() {
    try { return window.localStorage; } catch { return null; }
  }
  function get(k, fallback) {
    const s = storage();
    if (!s) return fallback;
    const v = s.getItem(k);
    return v == null ? fallback : v;
  }
  function set(k, v) { const s = storage(); if (s) s.setItem(k, v); }
  function parseJson(k, fallback) {
    try { return JSON.parse(get(k, "null")) ?? fallback; } catch { return fallback; }
  }
  function cmpVer(a, b) {
    const pa = String(a || "0").split(/[^\d]+/).map((n) => parseInt(n, 10) || 0);
    const pb = String(b || "0").split(/[^\d]+/).map((n) => parseInt(n, 10) || 0);
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
    return 0;
  }

  function create(opts) {
    const hubUrl = String(opts.hubUrl || "").replace(/\/$/, "");
    const ingestToken = opts.ingestToken || "";
    const appId = opts.appId;
    const appName = opts.appName || opts.appId;
    const version = opts.version || "0.0.0";
    const platform = opts.platform || "solohost";
    const locale = opts.locale || "vi";
    if (!hubUrl || !appId) throw new Error("SHFH: hubUrl and appId required");

    const prefix = "shfh_" + appId + "_";
    let anonymousId = get(prefix + "anon") || get("shfh_anon_" + appId) || uuid();
    set(prefix + "anon", anonymousId);
    if (!get(prefix + "installed_at")) set(prefix + "installed_at", opts.installedAt || nowIso());
    const installedAt = get(prefix + "installed_at");

    function license() {
      return parseJson(prefix + "license", {
        state: "unknown",
        paid: false,
        plan: "free",
        txn_id: "",
        method: "",
        amount: "",
        paid_at: "",
        paid_until: "",
      });
    }
    function saveLicense(next) {
      const cur = { ...license(), ...next };
      if (cur.state === "paid" || cur.state === "supporter" || cur.state === "waived") cur.paid = true;
      if (cur.state === "unpaid" || cur.state === "expired" || cur.state === "unknown") cur.paid = false;
      set(prefix + "license", JSON.stringify(cur));
      return cur;
    }
    function queue() { return parseJson(prefix + "queue", []); }
    function saveQueue(q) { set(prefix + "queue", JSON.stringify(q.slice(-50))); }

    async function http(method, path, body) {
      const headers = { "Content-Type": "application/json", "Accept": "application/json" };
      if (ingestToken && method !== "GET") headers.Authorization = "Bearer " + ingestToken;
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const t = ctrl ? setTimeout(() => ctrl.abort(), 12000) : null;
      try {
        const r = await fetch(hubUrl + path, {
          method, headers, body: body != null ? JSON.stringify(body) : undefined,
          signal: ctrl ? ctrl.signal : undefined,
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
        return j;
      } finally { if (t) clearTimeout(t); }
    }
    async function post(path, body) { return http("POST", path, body); }
    async function getJson(path) { return http("GET", path); }

    function envelope(extra) {
      const lic = license();
      return {
        schema_version: SCHEMA,
        app_id: appId,
        app_name: appName,
        version,
        platform,
        anonymous_id: anonymousId,
        installed_at: installedAt,
        locale,
        license: {
          paid: !!lic.paid,
          plan: lic.plan,
          txn_id: lic.txn_id,
          method: lic.method,
          amount: lic.amount,
          state: lic.state,
          paid_until: lic.paid_until,
        },
        ...extra,
      };
    }

    function classifyPayment(policy) {
      const lic = license();
      const fee = !!(policy && policy.fee_required);
      if (!fee) return saveLicense({ state: lic.paid ? "supporter" : "free", plan: lic.plan || "free" });
      if (lic.state === "waived") return lic;
      if (lic.paid_until && Date.parse(lic.paid_until) < Date.now()) return saveLicense({ state: "expired", paid: false });
      if (lic.state === "pending") return lic;
      if (lic.paid || lic.state === "paid" || lic.state === "supporter") return saveLicense({ state: "supporter", paid: true });
      return saveLicense({ state: "unpaid", paid: false });
    }

    function updateNeeded(policy) {
      const latest = policy && policy.latest_update;
      if (!latest || !latest.published) return { needed: false };
      const seen = get(prefix + "seen_update") || "";
      if (seen === latest.id) return { needed: false, item: latest, already_seen: true };
      const newerVer = cmpVer(latest.version, version) > 0;
      const publishedAfterInstall = Date.parse(latest.created_at || latest.published_at || 0) > Date.parse(installedAt);
      const needed = newerVer || publishedAfterInstall;
      return { needed, item: latest, newerVer, publishedAfterInstall, installedAt, currentVersion: version };
    }

    async function flushQueue() {
      const q = queue();
      const keep = [];
      for (const item of q) {
        try { await post("/api/feedback", item); }
        catch { keep.push(item); }
      }
      saveQueue(keep);
      return { flushed: q.length - keep.length, pending: keep.length };
    }

    async function sendFeedback(fields) {
      const body = envelope({
        event: "feedback",
        type: fields.type || "improvement",
        rating: Number(fields.rating) || 0,
        message: fields.message,
      });
      try { return await post("/api/feedback", body); }
      catch (e) {
        saveQueue(queue().concat([body]));
        return { ok: false, queued: true, error: e.message };
      }
    }

    async function reportPayment({ txn_id, method = "pi", amount = "", state = "pending" } = {}) {
      saveLicense({
        state: state === "paid" || state === "supporter" ? "supporter" : "pending",
        paid: state === "paid" || state === "supporter",
        plan: "supporter",
        txn_id, method, amount, paid_at: nowIso(),
      });
      const body = envelope({
        event: "payment",
        type: "payment",
        message: "payment:" + method + " " + (txn_id || ""),
      });
      try {
        const out = await post("/api/feedback", body);
        if (out.ok) saveLicense({ state: "supporter", paid: true });
        return out;
      } catch (e) {
        saveQueue(queue().concat([body]));
        return { ok: false, queued: true, error: e.message };
      }
    }

    async function markRead(id) {
      set(prefix + "seen_notice_" + id, "1");
      try { return await post("/api/notices/" + encodeURIComponent(id) + "/read", {}); }
      catch { return { ok: false }; }
    }

    function markUpdateSeen(id) { if (id) set(prefix + "seen_update", id); }

    async function policy() {
      return getJson("/api/client-policy?app_id=" + encodeURIComponent(appId) + "&version=" + encodeURIComponent(version));
    }

    async function sync() {
      await flushQueue();
      let pol = null;
      try { pol = await policy(); } catch (e) { pol = { ok: false, error: e.message }; }
      const pay = classifyPayment(pol);
      const upd = updateNeeded(pol);
      let notices = [];
      try {
        const n = await getJson("/api/notices?app_id=" + encodeURIComponent(appId) + "&anonymous_id=" + encodeURIComponent(anonymousId));
        notices = (n.items || []).filter((x) => !get(prefix + "seen_notice_" + x.id));
      } catch { /* offline */ }

      const actions = [];
      if (pay.state === "unpaid" || pay.state === "expired") {
        actions.push({ kind: "unpaid_nudge", title: (pol.templates && pol.templates.unpaid_nudge) || "Ủng hộ dự án" });
      }
      if (pay.state === "supporter" && !get(prefix + "thanked_pay")) {
        actions.push({ kind: "payment_ok", title: (pol.templates && pol.templates.payment_ok) || "Cảm ơn đã ủng hộ" });
        set(prefix + "thanked_pay", "1");
      }
      if (upd.needed) {
        actions.push({ kind: "update", title: upd.item.notice || ("Cập nhật " + upd.item.version), update: upd.item });
      }
      for (const n of notices) actions.push({ kind: n.kind, title: n.title, body: n.body, id: n.id });

      return {
        ok: true,
        schema: SCHEMA,
        app_id: appId,
        installed_at: installedAt,
        version,
        payment: pay,
        update: upd,
        notices,
        actions,
        policy: pol,
        donate: pol && pol.donate,
      };
    }

    return {
      SCHEMA,
      PAYMENT_STATES,
      anonymousId,
      installedAt,
      version,
      license,
      setPaymentState: (state, extra) => saveLicense({ state, ...extra }),
      sendFeedback,
      reportPayment,
      pullNotices: async () => getJson("/api/notices?app_id=" + encodeURIComponent(appId) + "&anonymous_id=" + encodeURIComponent(anonymousId)),
      markRead,
      markUpdateSeen,
      updates: async () => getJson("/api/updates?app_id=" + encodeURIComponent(appId)),
      config: async () => getJson("/api/config"),
      policy,
      sync,
      flushQueue,
      compareVersion: cmpVer,
    };
  }

  return { create, SCHEMA, PAYMENT_STATES };
});
