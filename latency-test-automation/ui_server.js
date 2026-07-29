#!/usr/bin/env node
/**
 * Web UI for the impairment test automation.
 *
 * Control panel sections:
 *   1. Connection profiles — save/load/delete full configurations (stored in
 *      profiles.json next to this file, gitignored; passwords included, so
 *      keep the file local).
 *   2. Traffic endpoints — client/server IP + ports + protocol.
 *   3. Interface selection — "Discover" buttons SSH into client/server and
 *      list their NICs (name + IP) as dropdowns; picking a client interface
 *      sets the bind IP so traffic leaves the right NIC.
 *   4. Traffic generation — tool (iperf3/scapy/tcpreplay/custom), bandwidth,
 *      duration, parallel streams, ToS/DSCP, packet size.
 *   5. Traffic command — live preview of the generated server/client
 *      commands, editable in the Advanced box before execution.
 *   6. SSH details — client, server, spoke, hub (password or key each).
 * Clicking Start shows a Traffic Path confirmation
 * (Client -> Spoke -> Hub -> Server with interfaces and the exact commands)
 * before anything runs. Live progress + log stream via SSE.
 *
 * Usage:  node ui_server.js       # http://127.0.0.1:8790 (UI_PORT to change)
 * Binds 127.0.0.1 only — credentials never leave the machine. Secret fields
 * left blank fall back to env vars.
 */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const engine = require("./run_latency_tests.js");
const regression = require("./run_regression.js");

const PORT = parseInt(process.env.UI_PORT ?? "8790", 10);
const HOST = "127.0.0.1";
const PROFILES_FILE = path.join(__dirname, "profiles.json");

let running = false;

// The "SLA Full Regression (6x7 Matrix)" profile fixes every test parameter
// (runtime, latency/packet-loss progression, mode, ToS/direction placeholders,
// drivers). The operator supplies ONLY the 5 connection targets + Confluence
// creds; these overrides guarantee engine.validateParams() passes regardless of
// what the (hidden) advanced fields hold. Real ToS/direction come per-case from
// the matrix inside run_regression.js.
const REGRESSION_FIXED = {
  trafficDriver: "ssh", impairmentDriver: "ssh-tc", trafficTool: "iperf3",
  trafficDirection: "upstream", tos: "0x04", mode: "all", tcChoice: "all",
  durationSec: "300", baselineDurationSec: "300",
  leoMinMs: "30", leoMaxMs: "50", meoMinMs: "150", meoMaxMs: "180", geoMinMs: "600", geoMaxMs: "1000",
  latencyStabilizeSec: "180", latencyRampStepMs: "50", latencyRampIntervalSec: "60", latencyRampMaxMs: "1000",
  rampStepPct: "2", rampIntervalSec: "60", plStabilizeSec: "180", plRampMaxPct: "20",
  burstIntervalSec: "30", burstDurationSec: "7", burstLossPct: "5",
  randomLossPct: "5", randomMinGapSec: "20", randomMaxGapSec: "60", randomMinDurSec: "5", randomMaxDurSec: "15",
};

/* ------------------------------------------------------------------------ */

const SECRET_FIELDS = ["clientPass", "serverPass", "spokePass", "hubPass", "netemPass", "confToken"];

// the form state is auto-saved under this profile on every Start and
// prefilled on page load — no retyping after a refresh
const DEFAULT_PROFILE = "__default__";

function savedDefaults() {
  return loadProfiles()[DEFAULT_PROFILE] || {};
}

function rememberDefaults(params) {
  try {
    const profiles = loadProfiles();
    profiles[DEFAULT_PROFILE] = { ...params };
    saveProfiles(profiles);
  } catch (e) {
    console.error("could not persist defaults:", e.message);
  }
}

// Regression fields the operator must supply. Blank by default on purpose —
// nothing lab-specific is pre-filled; placeholders show the expected format.
const REGRESSION_FIELDS = [
  "linkA", "linkB", "plTargetLink", "regressionTos", "iptvServerIp", "iptvPort",
  "iptvFlows", "iptvPktLen", "iptvInterval", "iptvBwUp", "iptvBwDown",
  "regDirection", "caseMaxSec", "iptvStabilizeSec", "tosTcMap",
  "latLeo", "latMeo", "latGeo",
  "plStartPct", "plStepPct", "iptvLossCeiling", "plOnSec", "plOffSec", "plRandomSpec",
  "iptvResetSettleSec", "runLabel", "latLeoFixed", "latMeoFixed", "latGeoFixed", "latProgression",
  "plMaxPct", "plHoldSec", "plMinGapSec", "plMaxGapSec", "plMinDurSec", "plMaxDurSec",
];

function formDefaults() {
  // saved form state wins over env defaults
  const p = { ...engine.paramsFromEnv(), ...savedDefaults() };
  const d = { ...p };
  for (const f of REGRESSION_FIELDS) if (d[f] === undefined || d[f] === null) d[f] = "";
  // ToS is now a single-line field: normalise any previously saved multi-line
  // list (and the legacy regressionTosList key) into a comma-separated value.
  const tosSrc = d.regressionTos || p.regressionTosList || "";
  d.regressionTos = String(tosSrc).split(/[,\s]+/).filter(Boolean).join(",");
  for (const f of SECRET_FIELDS) {
    d[f + "Set"] = !!p[f];
    d[f] = ""; // secrets are never rendered into the page
  }
  return d;
}

function mergeSecrets(body) {
  const envp = engine.paramsFromEnv();
  const saved = savedDefaults();
  const base = { ...envp, ...saved };
  const p = { ...base, ...body };
  for (const f of SECRET_FIELDS) if (!body[f]) p[f] = saved[f] || envp[f];
  p.durationSec = body.durationSec || base.durationSec;
  p.baselineDurationSec = body.baselineDurationSec || base.baselineDurationSec;
  p.headless = body.headless !== false;
  p.confluence = !!body.confluence;
  p.debugMode = !!body.debugMode;
  p.latencyRampEnabled = !!body.latencyRampEnabled;
  return p;
}

function loadProfiles() {
  try { return JSON.parse(fs.readFileSync(PROFILES_FILE, "utf8")); }
  catch { return {}; }
}

function saveProfiles(profiles) {
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2));
}

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error("invalid JSON body")); }
    });
  });
}

/* ------------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE(formDefaults(), Object.keys(loadProfiles()).filter((n) => n !== DEFAULT_PROFILE)));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      json(res, 200, { running, status: engine.getStatus() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const send = (event, data) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("status", { running, status: engine.getStatus() });
      const onStatus = (s) => send("status", { running, status: s });
      const onLog = (line) => send("log", line);
      engine.bus.on("status", onStatus);
      engine.bus.on("log", onLog);
      const keepAlive = setInterval(() => res.write(": ping\n\n"), 15000);
      req.on("close", () => {
        clearInterval(keepAlive);
        engine.bus.off("status", onStatus);
        engine.bus.off("log", onLog);
      });
      return;
    }

    // discover NICs on a remote host: {side, host, user, pass, key}
    if (req.method === "POST" && url.pathname === "/api/interfaces") {
      const b = await readBody(req);
      if (!engine.isValidIp(b.host)) return json(res, 400, { ok: false, error: "invalid host IP" });
      if (!b.user) return json(res, 400, { ok: false, error: "username required" });
      const envp = engine.paramsFromEnv();
      const pass = b.pass || envp[(b.side || "") + "Pass"] || "";
      const keyPath = b.key || "";
      if (!pass && !keyPath) {
        return json(res, 400, {
          ok: false,
          error: `enter the ${b.side} SSH password or key in section 2 first`,
        });
      }
      try {
        const ifaces = await engine.listRemoteInterfaces(
          { host: b.host, user: b.user, pass: pass || null, keyPath: keyPath || null });
        json(res, 200, { ok: true, interfaces: ifaces });
      } catch (e) {
        json(res, 502, { ok: false, error: e.message });
      }
      return;
    }

    // preview the generated traffic commands for the current form values
    if (req.method === "POST" && url.pathname === "/api/commands") {
      const b = await readBody(req);
      const p = mergeSecrets(b);
      try {
        json(res, 200, { ok: true, ...engine.buildTrafficCommands(p) });
      } catch (e) {
        json(res, 400, { ok: false, error: e.message });
      }
      return;
    }

    // connection profiles
    if (url.pathname === "/api/profiles") {
      if (req.method === "GET") {
        const profiles = loadProfiles();
        const name = url.searchParams.get("name");
        if (name) {
          if (!profiles[name]) return json(res, 404, { ok: false, error: "no such profile" });
          return json(res, 200, { ok: true, profile: profiles[name] });
        }
        return json(res, 200, { ok: true, names: Object.keys(profiles).filter((n) => n !== DEFAULT_PROFILE) });
      }
      if (req.method === "POST") {
        const b = await readBody(req);
        if (!b.name || !/^[\w .-]{1,60}$/.test(b.name))
          return json(res, 400, { ok: false, error: "profile name: letters/digits/space/._- (max 60)" });
        const profiles = loadProfiles();
        profiles[b.name] = b.params || {};
        saveProfiles(profiles);
        return json(res, 200, { ok: true, names: Object.keys(profiles).filter((n) => n !== DEFAULT_PROFILE) });
      }
      if (req.method === "DELETE") {
        const name = url.searchParams.get("name");
        const profiles = loadProfiles();
        delete profiles[name];
        saveProfiles(profiles);
        return json(res, 200, { ok: true, names: Object.keys(profiles).filter((n) => n !== DEFAULT_PROFILE) });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/continue") {
      const released = engine.continueRun();
      return json(res, released ? 200 : 409,
        released ? { ok: true } : { ok: false, error: "nothing is paused" });
    }

    if (req.method === "POST" && url.pathname === "/api/stop") {
      if (!running) return json(res, 409, { ok: false, error: "no run in progress" });
      engine.requestAbort("stopped from the panel");
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/start") {
      if (running) {
        return json(res, 409, { ok: false, errors: { _global: "a run is already in progress" } });
      }
      const body = await readBody(req);
      const p = mergeSecrets(body);
      // remember the form (with resolved secrets) even if validation fails,
      // so a refresh never loses what was typed
      rememberDefaults(p);
      const check = engine.validateParams(p);
      if (p.confluence) {
        if (!p.confEmail) { check.ok = false; check.errors.confEmail = "required for Confluence upload"; }
        if (!p.confToken) { check.ok = false; check.errors.confToken = "required (or set CONF_TOKEN env)"; }
        if (!p.confPageId && !p.confSpace) { check.ok = false; check.errors.confPageId = "page ID or space key required"; }
      }
      if (!check.ok) return json(res, 400, { ok: false, errors: check.errors });

      const cfg = engine.buildConfig(p);
      running = true;
      json(res, 200, { ok: true });
      engine
        .runSuite(cfg, p)
        .catch((e) => {
          engine.bus.emit("log", `${new Date().toISOString()} FATAL: ${e.message}`);
          engine.setStatus({ phase: "error", error: e.message });
        })
        .finally(() => {
          running = false;
          engine.bus.emit("status", engine.getStatus());
        });
      return;
    }

    /* ---- SLA Full Regression (6x7 Matrix) profile ---- */

    if (req.method === "GET" && url.pathname === "/api/regression/state") {
      const state = regression.stateSummary();
      return json(res, 200, { ok: true, running, state: state || { exists: false } });
    }

    if (req.method === "POST" &&
        (url.pathname === "/api/regression/start" || url.pathname === "/api/regression/resume")) {
      if (running) {
        return json(res, 409, { ok: false, errors: { _global: "a run is already in progress" } });
      }
      const resume = url.pathname.endsWith("/resume");
      const body = await readBody(req);
      // Persist only the operator-supplied connection/Confluence values (so the
      // Custom Run form's saved defaults are NOT polluted with the fixed
      // regression schedule), then overlay the profile-fixed parameters.
      const base = mergeSecrets(body);
      rememberDefaults(base);
      const p = { ...base, ...REGRESSION_FIXED };
      // Confluence is OPTIONAL: honour the form checkbox. When off, the run still
      // collects DMTS hourLogs + writes per-case reports locally (SLA_Regression/),
      // it just skips the page upload.
      p.confluence = !!body.confluence;
      if (body.caseMaxSec) p.caseMaxSec = body.caseMaxSec;
      // IPTV / single-ToS options from the regression form
      p.iptvMode = !!body.iptvMode;
      if (body.regressionTos && String(body.regressionTos).trim()) p.regressionTosList = String(body.regressionTos).trim();
      if (body.iptvServerIp && String(body.iptvServerIp).trim()) p.iptvServerIp = String(body.iptvServerIp).trim();
      if (body.iptvPort && String(body.iptvPort).trim()) p.iptvPort = String(body.iptvPort).trim();
      if (body.iptvFlows && String(body.iptvFlows).trim()) p.iptvFlows = String(body.iptvFlows).trim();
      if (body.iptvBwUp && String(body.iptvBwUp).trim()) p.iptvBwUp = String(body.iptvBwUp).trim();
      if (body.iptvBwDown && String(body.iptvBwDown).trim()) p.iptvBwDown = String(body.iptvBwDown).trim();
      if (body.iptvPktLen && String(body.iptvPktLen).trim()) p.iptvPktLen = String(body.iptvPktLen).trim();
      if (body.iptvStabilizeSec != null && String(body.iptvStabilizeSec).trim()) {
        const s = parseInt(String(body.iptvStabilizeSec).trim(), 10);
        if (Number.isFinite(s) && s >= 0) p.iptvStabilizeSec = s;
      }
      if (body.iptvLossCeiling != null && String(body.iptvLossCeiling).trim()) {
        const s = parseInt(String(body.iptvLossCeiling).trim(), 10);
        if (Number.isFinite(s) && s > 0) p.iptvLossCeiling = s;
      }
      if (body.iptvInterval && String(body.iptvInterval).trim()) p.iptvInterval = String(body.iptvInterval).trim();
      // ---- Link configuration (operator-defined interface groups) ----
      const str = (v) => String(v ?? "").trim();
      if (str(body.linkA)) p.linkA = str(body.linkA);
      if (str(body.linkB)) p.linkB = str(body.linkB);
      { const t = str(body.plTargetLink).toUpperCase();
        p.plTargetLink = (t === "A" || t === "B") ? t : "active"; }
      if (str(body.regDirection)) p.regDirection = str(body.regDirection);
      if (str(body.runLabel)) p.runLabel = str(body.runLabel);
      if (str(body.iptvResetSettleSec)) {
        const s = parseInt(str(body.iptvResetSettleSec), 10);
        if (Number.isFinite(s) && s >= 0) p.iptvResetSettleSec = s;
      }
      // ---- Test case selection ----
      let sel = body.selectedCases;
      if (typeof sel === "string") sel = sel.split(/[,\s]+/).filter(Boolean);
      if (Array.isArray(sel)) p.selectedCases = sel.map((s) => String(s).trim()).filter(Boolean);
      // ---- Latency: fixed values + optional progression ----
      p.latProgression = !!body.latProgression;
      for (const f of ["latLeoFixed", "latMeoFixed", "latGeoFixed", "latLeo", "latMeo", "latGeo"]) {
        if (str(body[f])) p[f] = str(body[f]);
      }
      // ---- Packet-loss shape (all operator-supplied) ----
      for (const f of ["plStartPct", "plStepPct", "plMaxPct", "plHoldSec", "plOnSec", "plOffSec",
                       "plMinGapSec", "plMaxGapSec", "plMinDurSec", "plMaxDurSec"]) {
        if (str(body[f])) p[f] = str(body[f]);
      }
      if (body.tosTcMap && String(body.tosTcMap).trim()) {
        // grid-specific ToS→traffic-class overrides, lines/commas of "tos:regex"
        p.tosTcMap = {};
        for (const pair of String(body.tosTcMap).split(/[\n,]+/)) {
          const i = pair.indexOf(":");
          if (i > 0) p.tosTcMap[pair.slice(0, i).trim().toLowerCase()] = pair.slice(i + 1).trim();
        }
      }

      const check = engine.validateParams(p);
      // ---- regression configuration: everything must be supplied, nothing assumed ----
      const need = (field, value, msg) => { if (!String(value ?? "").trim()) { check.ok = false; check.errors[field] = msg; } };
      need("regressionTos", p.regressionTosList, "required — e.g. 0x04 (used for the whole run)");
      need("linkA", p.linkA, "required — netem interfaces for Link A, e.g. ens192,ens193");
      need("linkB", p.linkB, "required — netem interfaces for Link B, e.g. ens224,ens225");
      need("iptvServerIp", p.iptvServerIp || p.serverTrafficIp, "required — server data-plane IP for traffic");
      need("iptvPort", p.iptvPort, "required — iperf3 server port");
      need("iptvFlows", p.iptvFlows, "required — number of parallel streams");
      need("iptvPktLen", p.iptvPktLen, "required — packet length in bytes");
      need("iptvBwUp", p.iptvBwUp || p.iptvBw, "required — upstream bandwidth per flow, e.g. 3M");
      need("iptvBwDown", p.iptvBwDown || p.iptvBw, "required — downstream bandwidth per flow, e.g. 6M");
      need("plStepPct", p.plStepPct, "required — loss increment %");
      need("plMaxPct", p.plMaxPct || p.iptvLossCeiling, "required — maximum loss %");
      if (!Array.isArray(p.selectedCases) || !p.selectedCases.length) {
        check.ok = false; check.errors._global = "Select at least one test case to run";
      }
      // Link A / Link B must not overlap
      const laSet = new Set(String(p.linkA || "").split(/[,\s]+/).filter(Boolean));
      const lbArr = String(p.linkB || "").split(/[,\s]+/).filter(Boolean);
      const dupIf = lbArr.filter((x) => laSet.has(x));
      if (dupIf.length) { check.ok = false; check.errors.linkB = `also listed in Link A: ${dupIf.join(", ")}`; }
      // latency progressions for the orbit classes the scenarios use
      // only the classes the SELECTED cases actually use must be configured
      const clsFixed = { leo: "latLeoFixed", meo: "latMeoFixed", geo: "latGeoFixed" };
      const clsList = { leo: "latLeo", meo: "latMeo", geo: "latGeo" };
      const selSet = new Set((p.selectedCases || []).map((s) => String(s).toUpperCase()));
      const usesCls = { leo: selSet.has("TC2") || selSet.has("TC3"), meo: selSet.has("TC3") || selSet.has("TC4"), geo: selSet.has("TC4") };
      for (const cls of regression.requiredOrbitClasses()) {
        if (!usesCls[cls]) continue;
        const fx = clsFixed[cls];
        if (!regression.parseLatList(p[fx]) && !(p.latProgression && regression.parseLatList(p[clsList[cls]]))) {
          check.ok = false;
          check.errors[fx] = `required — ${cls.toUpperCase()} latency in ms (e.g. ${cls === "leo" ? "130" : cls === "meo" ? "200" : "1000"})`;
        }
      }
      // SSH credentials for every node the regression touches
      for (const [side, label] of [["client", "Client"], ["server", "Server"], ["netem", "Netem"], ["spoke", "Spoke"], ["hub", "Hub"]]) {
        const hostField = side === "client" ? "clientIp" : side === "server" ? "serverIp" : side + "Host";
        need(hostField, p[hostField], `required — ${label} IP/hostname`);
        need(side + "User", p[side + "User"], `required — ${label} SSH username`);
        if (!String(p[side + "Pass"] ?? "").trim() && !String(p[side + "Key"] ?? "").trim()) {
          check.ok = false;
          check.errors[side + "Pass"] = `required — ${label} SSH password or key path`;
        }
      }
      if (p.confluence) {
        if (!p.confEmail) { check.ok = false; check.errors.confEmail = "required for Confluence upload"; }
        if (!p.confToken) { check.ok = false; check.errors.confToken = "required (or set CONF_TOKEN env)"; }
        if (!p.confPageId && !p.confSpace) {
          check.ok = false;
          check.errors.confPageId = "space key (to create the page in) or a page URL/ID (to create it under) required";
        }
      }
      if (!check.ok) return json(res, 400, { ok: false, errors: check.errors });

      const cfg = engine.buildConfig(p);
      running = true;
      json(res, 200, { ok: true, resume });
      regression
        .runRegression(cfg, p, { resume })
        .catch((e) => {
          engine.bus.emit("log", `${new Date().toISOString()} FATAL: ${e.message}`);
          engine.setStatus({ phase: "error", error: e.message });
        })
        .finally(() => {
          running = false;
          engine.bus.emit("status", engine.getStatus());
        });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/regression/reset") {
      if (running) return json(res, 409, { ok: false, error: "stop the running regression first" });
      regression.clearState();
      return json(res, 200, { ok: true });
    }

    res.writeHead(404);
    res.end("not found");
  } catch (e) {
    json(res, 500, { ok: false, error: e.message });
  }
});

/* ------------------------------------------------------------------------ */

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const PAGE = (d, profileNames) => `<!doctype html>
<html><head><meta charset="utf-8">
<title>SLA Impairment Test Control Panel</title>
<style>
  :root { --line:#cbd5e1; --mut:#64748b; --bad:#991b1b; --ok:#166534; }
  body { font-family: system-ui, sans-serif; margin: 1.5rem auto; max-width: 1320px; padding: 0 1rem; color:#1a1a2e; }
  h1 { font-size: 22px; } h2 { font-size: 16px; margin: 0 0 10px; }
  .cols { display:grid; grid-template-columns: minmax(560px, 660px) 1fr; gap: 24px; align-items:start; }
  @media (max-width: 1100px) { .cols { grid-template-columns: 1fr; } }
  fieldset { border:1px solid var(--line); border-radius:8px; margin-bottom:14px; padding: 10px 12px 12px; }
  legend { font-weight:600; font-size:13px; padding:0 6px; }
  .grid { display:grid; grid-template-columns: 1fr 1fr; gap: 10px 14px; }
  .grid3 { display:grid; grid-template-columns: repeat(3, 1fr); gap: 10px 14px; }
  .grid4 { display:grid; grid-template-columns: repeat(4, 1fr); gap: 10px 14px; }
  label { font-size:12px; color:var(--mut); display:block; margin-bottom:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  input, select, textarea { width:100%; box-sizing:border-box; padding:6px 8px; border:1px solid var(--line); border-radius:5px; font-size:13px; }
  .sshbox label { margin-top:6px; }
  .sshbox label:first-of-type { margin-top:0; }
  textarea { font-family: ui-monospace, monospace; font-size:12px; }
  input.err, textarea.err { border-color:var(--bad); background:#fef2f2; }
  .errmsg { color:var(--bad); font-size:11px; min-height:13px; }
  .full { grid-column: 1 / -1; }
  button { padding:8px 18px; font-size:14px; font-weight:600; border:0; border-radius:7px; background:#1d4ed8; color:#fff; cursor:pointer; }
  button.small { padding:4px 10px; font-size:12px; }
  button.grey { background:#64748b; }
  button.red { background:#dc2626; }
  button:disabled { background:#94a3b8; cursor:not-allowed; }
  .panel { border:1px solid var(--line); border-radius:8px; padding:14px; margin-bottom:14px; }
  .stat { display:grid; grid-template-columns: 190px 1fr; gap:6px 10px; font-size:14px; }
  .stat b { font-weight:600; }
  .badge { padding:1px 10px; border-radius:10px; font-weight:700; font-size:12px; }
  .badge.pass { background:#dcfce7; color:var(--ok); } .badge.fail { background:#fee2e2; color:var(--bad); }
  .badge.run { background:#dbeafe; color:#1e40af; }
  #log { background:#0f172a; color:#e2e8f0; font: 12px/1.5 ui-monospace, monospace; padding:10px; border-radius:8px; height:280px; overflow-y:auto; white-space:pre-wrap; }
  .chips span { display:inline-block; margin:2px 6px 2px 0; }
  .sshgrid { display:grid; grid-template-columns: 1fr 1fr; gap:10px; padding: 8px; }
  .sshbox { border:1px solid var(--line); border-radius:6px; padding:8px; }
  .sshbox h4 { margin:0 0 6px; font-size:12px; }
  #confirm { display:none; border:2px solid #1d4ed8; border-radius:8px; padding:14px; margin-bottom:14px; background:#eff6ff; }
  .path { text-align:center; font-size:14px; line-height:1.4; }
  .path .node { display:inline-block; border:1px solid var(--line); background:#fff; border-radius:8px; padding:6px 16px; margin:4px 0; }
  .path .arrow { color:var(--mut); }
  pre.cmds { background:#f1f5f9; padding:8px 10px; border-radius:6px; font-size:12px; overflow-x:auto; text-align:left; }
  #runtype { border:2px solid #1d4ed8; background:#eff6ff; }
  #runtype label { display:inline; color:#1a1a2e; font-size:13px; margin-right:20px; white-space:normal; }
  #regNote { display:none; font-size:12px; color:var(--mut); margin:6px 0 0; }
  body[data-runtype="regression"] #regNote { display:block; }
  .reg-only { display:block; }        /* single mode: always shown */
  .custom-only { display:none; }      /* legacy duplicate config: retired */
  fieldset.custom-only { display:none; }
  #resumeBanner { display:none; border:2px solid #f59e0b; border-radius:8px; padding:14px; margin-bottom:14px; background:#fffbeb; }
  #resumeBanner b { font-size:14px; }
  .badge.obs { background:#e0e7ff; color:#3730a3; }
  /* --- clean configuration layout --- */
  form#f { display:flex; flex-direction:column; }
  fieldset#runtype { order:0; }
  fieldset.sec-ssh { order:2; }
  fieldset.sec-link { order:3; }
  fieldset.sec-traffic { order:4; }
  fieldset.sec-latency { order:5; }
  fieldset.sec-pl { order:6; }
  fieldset.custom-only { order:7; }
  fieldset.sec-conf { order:9; }
  fieldset { border:1px solid #e5e7eb; border-radius:10px; padding:16px 18px 18px; margin:0 0 16px; }
  legend { font-weight:700; font-size:12px; letter-spacing:.06em; text-transform:uppercase; color:#374151; padding:0 8px; }
  label { display:block; font-size:12px; font-weight:600; color:#374151; margin-bottom:5px; }
  input, select, textarea { width:100%; box-sizing:border-box; padding:8px 10px; font-size:13px;
    border:1px solid #d1d5db; border-radius:7px; background:#fff; transition:border-color .12s, box-shadow .12s; }
  input:focus, select:focus, textarea:focus { outline:none; border-color:#2563eb; box-shadow:0 0 0 3px #2563eb22; }
  .grid2 { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:14px 18px; }
  .grid3 { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:14px 18px; }
  .grid4 { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:14px 18px; }
  .hint { font-size:11.5px; color:#6b7280; margin:2px 0 14px; line-height:1.5; }
  .hint code { background:#0f172a0d; padding:1px 5px; border-radius:4px; font-size:11px; }
  .req { color:#dc2626; font-weight:700; }
  .errmsg { font-size:11px; color:#dc2626; margin-top:3px; min-height:0; }
  /* connection cards */
  .sshgrid { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:14px; }
  .sshbox { border:1px solid #e5e7eb; border-radius:9px; padding:12px 13px; background:#fafafa; }
  .sshbox h4 { margin:0 0 10px; font-size:12px; font-weight:700; color:#111827;
    text-transform:uppercase; letter-spacing:.04em; padding-bottom:7px; border-bottom:1px solid #e5e7eb; }
  .sshbox label { margin-top:9px; font-size:11px; font-weight:600; }
  .sshbox label:first-of-type { margin-top:0; }
  /* scenario reference tables */
  table.scenario { width:100%; border-collapse:collapse; margin-top:14px; font-size:12px; }
  table.scenario th { text-align:left; padding:7px 10px; background:#f3f4f6; color:#374151;
    font-weight:700; font-size:11px; text-transform:uppercase; letter-spacing:.04em; border-bottom:1px solid #e5e7eb; }
  table.scenario td { padding:7px 10px; border-bottom:1px solid #f3f4f6; color:#374151; }
  table.scenario tr:last-child td { border-bottom:none; }
  /* --- regression profile: collapsible sections --- */
  .profile details { border:1px solid var(--bd,#e5e7eb); border-radius:8px; margin:8px 0; background:var(--card,#fff); overflow:hidden; }
  .profile summary { cursor:pointer; padding:10px 12px; font-weight:600; list-style:none; display:flex; align-items:center; gap:8px; }
  .profile summary::-webkit-details-marker { display:none; }
  .profile summary::before { content:"\\25B8"; color:var(--mut,#6b7280); transition:transform .15s; }
  .profile details[open] summary::before { transform:rotate(90deg); }
  .profile .body { padding:0 14px 12px 14px; }
  .profile pre { font:12.5px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace; background:#0f172a08; border-radius:6px; padding:10px 12px; margin:6px 0; white-space:pre-wrap; }
  .profile .chk { color:#166534; font-weight:700; }
  .profile .arrow { color:#2563eb; }
  /* --- progress bar --- */
  .pbar { height:12px; border-radius:99px; background:#e5e7eb; overflow:hidden; margin:6px 0; }
  .pbar > i { display:block; height:100%; background:linear-gradient(90deg,#2563eb,#22c55e); width:0%; transition:width .4s ease; }
  .summary-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-top:8px; }
  .summary-grid > div { background:#0f172a06; border-radius:8px; padding:8px 10px; }
  .summary-grid .k { font-size:11px; color:var(--mut,#6b7280); text-transform:uppercase; letter-spacing:.04em; }
  .summary-grid .v { font-size:16px; font-weight:700; margin-top:2px; }
  /* --- current test case card --- */
  .tcard { border:2px solid #2563eb; border-radius:10px; padding:12px 14px; background:#eff6ff; margin-top:4px; }
  .tcard.idle { border-color:#e5e7eb; background:#f9fafb; }
  .tcard .row2 { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px; margin-top:8px; }
  .tcard .k { font-size:11px; color:var(--mut,#6b7280); text-transform:uppercase; letter-spacing:.04em; }
  .tcard .v { font-size:15px; font-weight:700; }
  /* --- test case selection --- */
  .casegrid { display:grid; grid-template-columns:repeat(auto-fit,minmax(215px,1fr)); gap:10px; }
  .casebox { display:flex; gap:9px; align-items:flex-start; padding:10px 12px; border:1px solid #e5e7eb;
    border-radius:8px; background:#fafafa; cursor:pointer; font-size:12.5px; font-weight:500;
    transition:border-color .12s, background .12s; margin:0; }
  .casebox:hover { border-color:#c7d2fe; background:#f8faff; }
  .casebox:has(input:checked) { border-color:#2563eb; background:#eff6ff; }
  .casebox input { margin-top:2px; }
  .casebox .cnote { color:#6b7280; font-weight:400; font-size:11px; }
  .plan { padding:9px 12px; border-radius:8px; background:#eff6ff; border:1px solid #bfdbfe;
    font-size:12.5px; color:#1e40af; }
  .plan.warn { background:#fffbeb; border-color:#fde68a; color:#92400e; }
  label.toggle { display:flex; gap:9px; align-items:flex-start; font-weight:500; font-size:12.5px;
    padding:10px 12px; border:1px solid #e5e7eb; border-radius:8px; background:#fafafa; cursor:pointer; }
  fieldset.sec-cases { order:2; }
  fieldset.sec-ssh { order:3; }
  fieldset.sec-link { order:4; }
  fieldset.sec-traffic { order:5; }
  fieldset.sec-latency { order:6; }
  fieldset.sec-pl { order:7; }
  /* run controls sit at the BOTTOM of the form, with breathing room.
     (Without an explicit order they default to 0 and jump to the top.) */
  #globalerr { order:28; margin:4px 0 0; }
  .btnrow { order:29; display:flex; gap:12px; align-items:stretch; margin:14px 0 26px; }
  .btnrow #start { flex:1 1 auto; padding:13px 20px; font-size:14px; font-weight:700; }
  .btnrow #stop { flex:0 0 140px; padding:13px 20px; font-size:14px; font-weight:600; }
  /* saved configurations: a utility, not configuration — keep it last and small */
  fieldset.sec-profile { order:30; }
  fieldset.sec-profile .grid { grid-template-columns:2fr auto auto auto !important; align-items:end; gap:10px; }
  /* --- live status: alerts, checklist, activity log --- */
  .panel.alert-err { border:2px solid #dc2626; background:#fef2f2; }
  .statusdot { font-size:15px; }
  .tally { font-size:12px; font-weight:700; padding:2px 7px; border-radius:99px; background:#f3f4f6; }
  .tally.ok { color:#166534; background:#dcfce7; }
  .tally.bad { color:#991b1b; background:#fee2e2; }
  .checklist { margin-top:6px; display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:4px 14px; }
  .checklist .ck { font-size:12.5px; display:flex; gap:7px; align-items:baseline; }
  .checklist .ck .ic { width:14px; flex:none; }
  .checklist .ck.ok { color:#166534; }
  .checklist .ck.run { color:#2563eb; font-weight:600; }
  .checklist .ck.fail { color:#991b1b; font-weight:700; }
  .checklist .ck .dt { color:#6b7280; font-weight:400; font-size:11.5px; }
  .actlog { margin-top:6px; font:11.5px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace;
    max-height:190px; overflow-y:auto; background:#0f172a08; border-radius:7px; padding:9px 11px; color:#374151; }
  /* --- testcase flow checklist --- */
  .flow { display:flex; flex-wrap:wrap; gap:14px; margin-top:6px; }
  .flow .grp { min-width:150px; }
  .flow .grp h4 { margin:0 0 4px; font-size:12px; color:var(--mut,#6b7280); text-transform:uppercase; letter-spacing:.04em; }
  .flow .step { padding:3px 8px; border-radius:6px; font-size:13px; display:flex; align-items:center; gap:6px; }
  .flow .step.done { color:#166534; }
  .flow .step.cur { background:#2563eb; color:#fff; font-weight:700; }
  .flow .step.todo { color:#9ca3af; }
</style></head><body>
<h1>SLA Impairment Test Control Panel</h1>
<div id="resumeBanner"></div>
<div class="cols">
<form id="f">
  <!-- ============ TEST CASE SELECTION ============ -->
  <fieldset id="runtype" class="sec-cases"><legend>Test Case Selection</legend>
    <p class="hint">Pick exactly what to execute. Selected cases run for <b>every ToS value</b>; with <b>Both</b> directions the whole selected set runs upstream first, then downstream.</p>
    <div class="casegrid">
      ${[["TC1", "Baseline", "both links 0 ms"],
         ["TC2", "Clean vs LEO", "0 ms vs LEO"],
         ["TC3", "LEO vs MEO", "LEO fixed vs MEO"],
         ["TC4", "MEO vs GEO", "MEO fixed vs GEO"],
         ["PL_TC1", "Constant Loss", "steady, escalating"],
         ["PL_TC2", "Periodic Loss", "on/off cycles"],
         ["PL_TC3", "Random Loss", "random gap + duration"]]
        .map(([id, name, note]) => `
      <label class="casebox"><input type="checkbox" name="selectedCases" value="${id}" style="width:auto" checked>
        <span><b>${id}</b> &mdash; ${name}<br><span class="cnote">${note}</span></span></label>`).join("")}
    </div>
    <div class="grid3" style="margin-top:14px;">
      <div><label>Direction</label>
        <select name="regDirection">
          <option value="both"${d.regDirection === "both" || !d.regDirection ? " selected" : ""}>Both — upstream, then downstream</option>
          <option value="upstream"${d.regDirection === "upstream" ? " selected" : ""}>Upstream only</option>
          <option value="downstream"${d.regDirection === "downstream" ? " selected" : ""}>Downstream only</option>
        </select><div class="errmsg"></div></div>
      <div><label>ToS value(s) <span class="req">*</span></label>
        <input name="regressionTos" value="${esc(d.regressionTos)}" placeholder="0x04 or 0x04,0x24,0x38,0x74"><div class="errmsg"></div>
        <div class="hint" style="margin:3px 0 0;">All selected cases run for each value.</div></div>
      <div><label>&nbsp;</label>
        <div id="planSummary" class="plan">&mdash;</div></div>
    </div>
  </fieldset>

  <!-- ============ LINK CONFIGURATION ============ -->
  <fieldset class="reg-only sec-link"><legend>Link Configuration</legend>
    <p class="hint">Two interface groups on the netem VM. Scenarios apply values to <b>Link A</b> and <b>Link B</b> exactly as defined &mdash; no active/standby detection.</p>
    <div class="grid2">
      <div><label>Link A interfaces <span class="req">*</span></label>
        <input name="linkA" value="${esc(d.linkA)}" placeholder="e.g. ens192,ens193"><div class="errmsg"></div></div>
      <div><label>Link B interfaces <span class="req">*</span></label>
        <input name="linkB" value="${esc(d.linkB)}" placeholder="e.g. ens224,ens225"><div class="errmsg"></div></div>
      <div class="full hint" style="margin:2px 0 0;">The link carrying traffic is detected from <b>netem packet counters</b> on these
        interfaces. Impairment always targets that link (packet loss on it, the degraded latency value on it) and leaves the
        other one clean &mdash; there is nothing to choose.</div>
      <div><label>Results folder name <span style="font-weight:400;color:#6b7280">(optional)</span></label>
        <input name="runLabel" value="${esc(d.runLabel)}" placeholder="e.g. smoke_tc2_pl1"><div class="errmsg"></div>
        <div class="hint" style="margin:3px 0 0;">Saved under SLA_Regression/&lt;name&gt;/ — blank uses the root.</div></div>
      <div><label>Reset settle time (s)</label>
        <input name="iptvResetSettleSec" value="${esc(d.iptvResetSettleSec)}" placeholder="3"><div class="errmsg"></div></div>
    </div>
  </fieldset>

  <!-- ============ TRAFFIC CONFIGURATION ============ -->
  <fieldset class="reg-only sec-traffic"><legend>Traffic Configuration</legend>
    <div class="grid3">
      <div><label>Server traffic IP <span class="req">*</span></label>
        <input name="iptvServerIp" value="${esc(d.iptvServerIp)}" placeholder="data-plane IP"><div class="errmsg"></div>
        <div class="hint">Must be an address the <b>server VM itself owns</b> (checked at start) — not a gateway.</div></div>
      <div><label>Server port <span class="req">*</span></label>
        <input name="iptvPort" value="${esc(d.iptvPort)}" placeholder="5201"><div class="errmsg"></div></div>
      <div><label>Protocol</label>
        <select name="trafficType">
          <option value="UDP"${d.trafficType === "TCP" ? "" : " selected"}>UDP (adds -u)</option>
          <option value="TCP"${d.trafficType === "TCP" ? " selected" : ""}>TCP</option>
        </select><div class="errmsg"></div></div>
      <div><label>Parallel streams (-P) <span class="req">*</span></label>
        <input name="iptvFlows" value="${esc(d.iptvFlows)}" placeholder="10"><div class="errmsg"></div></div>
      <div><label>Packet length (-l bytes) <span class="req">*</span></label>
        <input name="iptvPktLen" value="${esc(d.iptvPktLen)}" placeholder="1200"><div class="errmsg"></div></div>
      <div><label>Report interval (-i s)</label>
        <input name="iptvInterval" value="${esc(d.iptvInterval)}" placeholder="10"><div class="errmsg"></div></div>
      <div><label>Upstream bandwidth / flow <span class="req">*</span></label>
        <input name="iptvBwUp" value="${esc(d.iptvBwUp)}" placeholder="e.g. 3M"><div class="errmsg"></div></div>
      <div><label>Downstream bandwidth / flow <span class="req">*</span></label>
        <input name="iptvBwDown" value="${esc(d.iptvBwDown)}" placeholder="e.g. 6M"><div class="errmsg"></div></div>
      <div><label>Test duration / case (s)</label>
        <input name="caseMaxSec" value="${esc(d.caseMaxSec)}" placeholder="300"><div class="errmsg"></div></div>
      <div><label>Stabilise after switch (s)</label>
        <input name="iptvStabilizeSec" value="${esc(d.iptvStabilizeSec)}" placeholder="60"><div class="errmsg"></div></div>
      <div><label>ToS &rarr; DMTS class (optional)</label>
        <input name="tosTcMap" value="${esc(d.tosTcMap)}" placeholder="0x74:Streaming"><div class="errmsg"></div>
        <div class="hint">Grid-specific. Blank = auto-detect busiest class.</div></div>
    </div>
  </fieldset>

  <!-- ============ LATENCY CONFIGURATION ============ -->
  <fieldset class="reg-only sec-latency"><legend>Latency Configuration</legend>
    <p class="hint">Fixed latency per orbit class, held for the whole test case. Enable progression below to step the <i>higher</i> class of each comparison instead.</p>
    <div class="grid3">
      <div><label>LEO latency (ms) <span class="req">*</span></label>
        <input name="latLeoFixed" value="${esc(d.latLeoFixed)}" placeholder="e.g. 130"><div class="errmsg"></div></div>
      <div><label>MEO latency (ms) <span class="req">*</span></label>
        <input name="latMeoFixed" value="${esc(d.latMeoFixed)}" placeholder="e.g. 200"><div class="errmsg"></div></div>
      <div><label>GEO latency (ms) <span class="req">*</span></label>
        <input name="latGeoFixed" value="${esc(d.latGeoFixed)}" placeholder="e.g. 1000"><div class="errmsg"></div></div>
    </div>

    <label class="toggle" style="margin-top:14px;">
      <input type="checkbox" name="latProgression" id="latProgChk" style="width:auto"${d.latProgression ? " checked" : ""}>
      <span><b>Enable latency progression</b> &mdash; step the higher class through a list instead of holding one value</span></label>
    <div id="progFields" style="display:${d.latProgression ? "block" : "none"};margin-top:10px;">
      <div class="grid3">
        <div><label>LEO progression (ms)</label>
          <input name="latLeo" value="${esc(d.latLeo)}" placeholder="30,50,75,100,120,130"><div class="errmsg"></div></div>
        <div><label>MEO progression (ms)</label>
          <input name="latMeo" value="${esc(d.latMeo)}" placeholder="150,165,180"><div class="errmsg"></div></div>
        <div><label>GEO progression (ms)</label>
          <input name="latGeo" value="${esc(d.latGeo)}" placeholder="600,800,1000"><div class="errmsg"></div></div>
      </div>
      <div class="hint" style="margin:8px 0 0;">Comma-separated list or a range (<code>30-130</code>). One value applied per minute; a class left blank falls back to its fixed value.</div>
    </div>

    <table class="scenario"><thead><tr><th>Case</th><th>Link A</th><th>Link B &mdash; fixed mode</th><th>Link B &mdash; progression mode</th></tr></thead>
      <tbody>
        <tr><td>TC1</td><td>0 ms</td><td>0 ms</td><td>0 ms</td></tr>
        <tr><td>TC2</td><td>0 ms</td><td>LEO (fixed)</td><td>LEO list, stepped</td></tr>
        <tr><td>TC3</td><td>LEO</td><td>MEO (fixed)</td><td>MEO list, stepped</td></tr>
        <tr><td>TC4</td><td>MEO</td><td>GEO (fixed)</td><td>GEO list, stepped</td></tr>
      </tbody></table>
  </fieldset>

  <!-- ============ PACKET LOSS CONFIGURATION ============ -->
  <fieldset class="reg-only sec-pl"><legend>Packet Loss Configuration</legend>
    <p class="hint">Applied to the target link chosen above; the other link stays clean. Loss escalates by the step until the ceiling or a switch.</p>
    <div class="grid3">
      <div><label>Start loss (%)</label>
        <input name="plStartPct" value="${esc(d.plStartPct)}" placeholder="e.g. 0"><div class="errmsg"></div></div>
      <div><label>Loss increment (%) <span class="req">*</span></label>
        <input name="plStepPct" value="${esc(d.plStepPct)}" placeholder="e.g. 2"><div class="errmsg"></div></div>
      <div><label>Maximum loss (%) <span class="req">*</span></label>
        <input name="plMaxPct" value="${esc(d.plMaxPct)}" placeholder="e.g. 10"><div class="errmsg"></div></div>
      <div><label>Hold time (s)</label>
        <input name="plHoldSec" value="${esc(d.plHoldSec)}" placeholder="seconds at each level"><div class="errmsg"></div></div>
      <div><label>Periodic ON (s)</label>
        <input name="plOnSec" value="${esc(d.plOnSec)}" placeholder="e.g. 20"><div class="errmsg"></div></div>
      <div><label>Periodic OFF (s)</label>
        <input name="plOffSec" value="${esc(d.plOffSec)}" placeholder="e.g. 20"><div class="errmsg"></div></div>
      <div><label>Random interval min (s)</label>
        <input name="plMinGapSec" value="${esc(d.plMinGapSec)}" placeholder="e.g. 10"><div class="errmsg"></div></div>
      <div><label>Random interval max (s)</label>
        <input name="plMaxGapSec" value="${esc(d.plMaxGapSec)}" placeholder="e.g. 30"><div class="errmsg"></div></div>
      <div><label>Random duration min (s)</label>
        <input name="plMinDurSec" value="${esc(d.plMinDurSec)}" placeholder="e.g. 5"><div class="errmsg"></div></div>
      <div><label>Random duration max (s)</label>
        <input name="plMaxDurSec" value="${esc(d.plMaxDurSec)}" placeholder="e.g. 15"><div class="errmsg"></div></div>
    </div>
    <table class="scenario"><thead><tr><th>Case</th><th>Scenario</th><th>Behaviour</th></tr></thead>
      <tbody>
        <tr><td>PL_TC1</td><td>Constant Loss</td><td>Hold, then escalate by step each interval</td></tr>
        <tr><td>PL_TC2</td><td>Periodic Loss</td><td>ON/OFF cycles, escalating each cycle</td></tr>
        <tr><td>PL_TC3</td><td>Random Loss</td><td>Random gap + duration, escalating each event</td></tr>
      </tbody></table>
  </fieldset>
  <fieldset class="sec-profile"><legend>Saved Configurations <span style="font-weight:400;text-transform:none;letter-spacing:0;color:#6b7280">(optional)</span></legend>
    <p class="hint">Save the settings above under a name, or load a previously saved set.</p><div class="grid" style="grid-template-columns: 2fr 1fr 1fr 1fr;">
    <div><label>Profile</label><select id="profSel">
      <option value="">— select —</option>
      ${profileNames.map((n) => `<option>${esc(n)}</option>`).join("")}
    </select></div>
    <div><label>&nbsp;</label><button type="button" class="small grey" id="profLoad">Load</button></div>
    <div><label>&nbsp;</label><button type="button" class="small grey" id="profSave">Save as…</button></div>
    <div><label>&nbsp;</label><button type="button" class="small grey" id="profDel">Delete</button></div>
    <div class="full errmsg" id="proferr"></div>
  </div></fieldset>

  <!-- ============ SSH CONNECTIONS ============ -->
  <fieldset class="sec-ssh"><legend>SSH Connections</legend>
    <p class="hint">Credentials for every node the regression uses — traffic generation, netem control, DMTS hourLog collection and diagnostics all use these. Provide a password <b>or</b> a key path per node.</p>
    <div class="sshgrid">
    ${[["client", "Client", "traffic source"], ["server", "Server", "traffic sink"],
       ["netem", "Netem", "impairment"], ["spoke", "Spoke", "upstream DMTS"], ["hub", "Hub", "downstream DMTS"]]
      .map(([side, label, role]) => {
        const hostField = side === "client" ? "clientIp" : side === "server" ? "serverIp" : side + "Host";
        return `
    <div class="sshbox"><h4>${label} <span style="font-weight:500;text-transform:none;letter-spacing:0;color:#6b7280">· ${role}</span></h4>
      <label>IP / Hostname <span class="req">*</span></label>
      <input name="${hostField}" value="${esc(d[hostField])}" placeholder="e.g. 10.0.0.10"><div class="errmsg"></div>
      <label>Username <span class="req">*</span></label>
      <input name="${side}User" value="${esc(d[side + "User"])}" placeholder="ssh user"><div class="errmsg"></div>
      <label>Password ${d[side + "PassSet"] ? "<span style=\"font-weight:400;color:#6b7280\">(saved — blank keeps it)</span>" : ""}</label>
      <input name="${side}Pass" type="password" placeholder="${d[side + "PassSet"] ? "•••••• saved" : "password"}"><div class="errmsg"></div>
      <label>or SSH key path</label>
      <input name="${side}Key" value="${esc(d[side + "Key"])}" placeholder="/path/to/id_rsa"><div class="errmsg"></div>
    </div>`; }).join("")}
    </div>
    <div class="grid3" style="margin-top:14px;">
      <div class="custom-only"><label>Client port</label><input name="clientPort" value="${esc(d.clientPort)}" placeholder="auto"><div class="errmsg"></div></div>
      <div class="custom-only"><label>Server port</label><input name="serverPort" value="${esc(d.serverPort)}"><div class="errmsg"></div></div>
      <div class="full hint">Netem is controlled over <b>SSH</b> (<code>tc qdisc</code> on the netem VM) and traffic is generated over <b>SSH</b> (<code>iperf3</code>). The netem web UI is not used and is not required.</div>
    </div>
  </fieldset>

  <fieldset class="custom-only"><legend>3 — Interface selection</legend><div class="grid">
    <div><label>Client interface <button type="button" class="small grey" data-discover="client">Discover</button></label>
      <select name="clientIface" id="clientIfaceSel"><option value="">— (default route) —</option>
      ${d.clientIface ? `<option selected>${esc(d.clientIface)}</option>` : ""}</select>
      <input type="hidden" name="clientBindIp" value="${esc(d.clientBindIp)}"><div class="errmsg" id="clientIfaceErr"></div></div>
    <div><label>Server interface — its IP becomes the traffic destination <button type="button" class="small grey" data-discover="server">Discover</button></label>
      <select name="serverIface" id="serverIfaceSel"><option value="">— (default route) —</option>
      ${d.serverIface ? `<option selected>${esc(d.serverIface)}</option>` : ""}</select>
      <input type="hidden" name="serverTrafficIp" value="${esc(d.serverTrafficIp)}">
      <div class="errmsg" id="serverIfaceErr"></div></div>
  </div></fieldset>

  <fieldset class="custom-only"><legend>4 — Traffic generation</legend><div class="grid3">
    <div><label>Traffic via</label><select name="trafficDriver">
      <option value="ssh"${d.trafficDriver === "ssh" ? " selected" : ""}>SSH (this tool)</option>
      <option value="netem-ui"${d.trafficDriver === "netem-ui" ? " selected" : ""}>netem UI page</option></select><div class="errmsg"></div></div>
    <div><label>Netem via</label><select name="impairmentDriver">
      <option value="ssh-tc"${d.impairmentDriver === "ssh-tc" ? " selected" : ""}>SSH tc (auto-detect link)</option>
      <option value="netem-ui"${d.impairmentDriver === "netem-ui" ? " selected" : ""}>netem UI page</option></select><div class="errmsg"></div></div>
    <div><label>Tool</label><select name="trafficTool">
      ${["iperf3", "scapy", "tcpreplay", "custom"].map((t) =>
        `<option${d.trafficTool === t ? " selected" : ""}>${t}</option>`).join("")}
      </select><div class="errmsg"></div></div>
    <div><label>Bandwidth</label><input name="bandwidth" value="${esc(d.bandwidth)}" placeholder="e.g. 1000M"><div class="errmsg"></div></div>
    <div><label>Duration (s)</label><input name="durationSec" value="${esc(d.durationSec)}"><div class="errmsg"></div></div>
    <div><label>TC1 baseline duration (s)</label><input name="baselineDurationSec" value="${esc(d.baselineDurationSec)}"><div class="errmsg"></div></div>
    <div><label>Parallel streams</label><input name="parallelStreams" value="${esc(d.parallelStreams)}"><div class="errmsg"></div></div>
    <div><label>ToS / DSCP</label><input name="tos" value="${esc(d.tos)}"><div class="errmsg"></div></div>
    <div><label>Packet size (bytes)</label><input name="packetSize" value="${esc(d.packetSize)}" placeholder="tool default"><div class="errmsg"></div></div>
    <div style="grid-column: 1 / -1;"><label>Traffic direction</label>
      <label style="display:inline; margin-right:16px;"><input type="radio" name="trafficDirection" value="upstream" style="width:auto"${d.trafficDirection !== "downstream" ? " checked" : ""}> Upstream (iperf3 -c)</label>
      <label style="display:inline;"><input type="radio" name="trafficDirection" value="downstream" style="width:auto"${d.trafficDirection === "downstream" ? " checked" : ""}> Downstream (iperf3 -c -R)</label>
      <div class="errmsg"></div></div>
  </div></fieldset>

  <fieldset class="custom-only"><legend>4a — Latency ranges, RTT ms (mode: latency — a value is drawn at random per run and recorded in all reports)</legend><div class="grid3">
    <div><label>LEO min</label><input name="leoMinMs" value="${esc(d.leoMinMs)}"><div class="errmsg"></div></div>
    <div><label>LEO max</label><input name="leoMaxMs" value="${esc(d.leoMaxMs)}"><div class="errmsg"></div></div>
    <div></div>
    <div><label>MEO min</label><input name="meoMinMs" value="${esc(d.meoMinMs)}"><div class="errmsg"></div></div>
    <div><label>MEO max</label><input name="meoMaxMs" value="${esc(d.meoMaxMs)}"><div class="errmsg"></div></div>
    <div></div>
    <div><label>GEO min</label><input name="geoMinMs" value="${esc(d.geoMinMs)}"><div class="errmsg"></div></div>
    <div><label>GEO max</label><input name="geoMaxMs" value="${esc(d.geoMaxMs)}"><div class="errmsg"></div></div>
    <div style="grid-column: 1 / -1;"><label><input type="checkbox" name="latencyRampEnabled" style="width:auto" ${d.latencyRampEnabled ? "checked" : ""}> Ramp latency until switch (default OFF = hold the configured LEO/MEO/GEO values for the duration and observe)</label></div>
    <div style="grid-column: 1 / -1; color:var(--mut); font-size:11px;">Ramp-only settings (ignored when ramp is off):</div>
    <div><label>Stabilize before ramp (s)</label><input name="latencyStabilizeSec" value="${esc(d.latencyStabilizeSec)}"><div class="errmsg"></div></div>
    <div><label>Ramp step (ms)</label><input name="latencyRampStepMs" value="${esc(d.latencyRampStepMs)}"><div class="errmsg"></div></div>
    <div><label>Ramp interval (s)</label><input name="latencyRampIntervalSec" value="${esc(d.latencyRampIntervalSec)}"><div class="errmsg"></div></div>
    <div><label>Ramp ceiling (ms)</label><input name="latencyRampMaxMs" value="${esc(d.latencyRampMaxMs)}"><div class="errmsg"></div></div>
  </div></fieldset>

  <fieldset class="custom-only"><legend>4b — Packet-loss schedule (mode: packet-loss — impairment auto-applied to the active link)</legend><div class="grid3">
    <div><label>TC1 ramp step (%)</label><input name="rampStepPct" value="${esc(d.rampStepPct)}"><div class="errmsg"></div></div>
    <div><label>TC1 ramp interval (s)</label><input name="rampIntervalSec" value="${esc(d.rampIntervalSec)}"><div class="errmsg"></div></div>
    <div><label>TC2 burst interval (s)</label><input name="burstIntervalSec" value="${esc(d.burstIntervalSec)}"><div class="errmsg"></div></div>
    <div><label>TC2 burst duration (s)</label><input name="burstDurationSec" value="${esc(d.burstDurationSec)}"><div class="errmsg"></div></div>
    <div><label>TC2 burst loss (%)</label><input name="burstLossPct" value="${esc(d.burstLossPct)}"><div class="errmsg"></div></div>
    <div><label>TC3 random loss (%)</label><input name="randomLossPct" value="${esc(d.randomLossPct)}"><div class="errmsg"></div></div>
    <div style="grid-column: 1 / -1;"><label>Overlay link ports on netem VM (csv, e.g. ens192,ens193,ens224,ens225 — empty = auto-detect bridge links; impairment is applied to ALL ports of the active bridge)</label>
      <input name="netemCandidates" value="${esc(d.netemCandidates)}"><div class="errmsg"></div></div>
  </div></fieldset>

  <fieldset class="custom-only"><legend>5 — Traffic command</legend>
    <div style="padding: 0 8px;">
    <label><input type="checkbox" id="advanced" style="width:auto"> Advanced — edit commands before execution</label>
    <label>Server command</label><textarea name="serverCmd" rows="2" readonly>${esc(d.serverCmd)}</textarea><div class="errmsg"></div>
    <label>Client command</label><textarea name="clientCmd" rows="2" readonly>${esc(d.clientCmd)}</textarea><div class="errmsg"></div>
    </div>
  </fieldset>

  <fieldset class="custom-only"><legend>6 — Test selection</legend><div class="grid4">
    <div><label>Test case</label><select name="tcChoice">
      <option value="all"${d.tcChoice === "all" ? " selected" : ""}>All</option>
      <option value="1">TC1</option><option value="2">TC2</option>
      <option value="3">TC3</option><option value="4">TC4</option></select><div class="errmsg"></div></div>
    <div><label>Mode</label><select name="mode">
      <option${d.mode === "latency" ? " selected" : ""}>latency</option>
      <option${d.mode === "packet-loss" ? " selected" : ""}>packet-loss</option>
      <option${d.mode === "all" ? " selected" : ""}>all</option></select><div class="errmsg"></div></div>
    <div><label><input type="checkbox" name="headed" style="width:auto"> Headed browser</label></div>
    <div><label><input type="checkbox" name="debugMode" style="width:auto" ${d.debugMode ? "checked" : ""}> Debug mode — pause after each stage</label></div>
  </div></fieldset>

  <fieldset class="sec-conf"><legend>Confluence <span style="font-weight:400;text-transform:none;letter-spacing:0;color:#6b7280">(optional)</span></legend><div class="grid">
    <div class="full"><label><input type="checkbox" name="confluence" style="width:auto" ${d.confluence ? "checked" : ""}> Upload results to Confluence</label></div>
    <div><label>Email</label><input name="confEmail" value="${esc(d.confEmail)}"><div class="errmsg"></div></div>
    <div><label>API token ${d.confTokenSet ? "(saved — blank keeps it)" : ""}</label><input name="confToken" type="password"><div class="errmsg"></div></div>
    <div class="full"><label>Base URL</label><input name="confBase" value="${esc(d.confBase)}"><div class="errmsg"></div></div>
    <div><label>Page URL or ID (update)</label><input name="confPageId" value="${esc(d.confPageId)}" placeholder="paste the page link"><div class="errmsg"></div></div>
    <div><label>Space key (create)</label><input name="confSpace" value="${esc(d.confSpace)}"><div class="errmsg"></div></div>
  </div></fieldset>

  <div class="errmsg" id="globalerr"></div>
  <div class="btnrow">
    <button id="start" type="submit">Start Run</button>
    <button id="stop" type="button" class="red" disabled>Stop</button>
  </div>
</form>

<div>
  <div id="confirm">
    <h2>Confirm traffic path</h2>
    <div class="path" id="pathview"></div>
    <pre class="cmds" id="cmdview"></pre>
    <button type="button" id="confirmGo">Confirm &amp; Start</button>
    <button type="button" class="grey" id="confirmCancel">Cancel</button>
  </div>
  <div class="panel" id="pausebox" style="display:none; border-color:#f59e0b; background:#fffbeb;">
    <b>Debug mode:</b> paused after <span id="pausestage"></span>
    <button type="button" id="continueBtn" style="margin-left:14px;">Continue</button>
  </div>
  <!-- ============ ERROR / ALERT BANNER ============ -->
  <div class="panel alert-err reg-only" id="errBanner" style="display:none;">
    <h2 style="color:#991b1b;">🔴 Regression Stopped</h2>
    <div class="summary-grid">
      <div><div class="k">Stage</div><div class="v" id="e-stage">—</div></div>
      <div><div class="k">Test case</div><div class="v" id="e-case">—</div></div>
      <div><div class="k">Operation</div><div class="v" id="e-op">—</div></div>
    </div>
    <div style="margin-top:10px;"><div class="k">Reason</div><div id="e-reason" style="font-weight:600;color:#991b1b;">—</div></div>
    <div style="margin-top:8px;"><div class="k">Suggested action</div><div id="e-fix" style="font-size:12.5px;">—</div></div>
  </div>

  <!-- ============ LIVE STATUS BANNER ============ -->
  <div class="panel reg-only" id="regProgress">
    <h2>Regression Status <span class="statusdot" id="s-dot">⚪</span> <span id="s-word" style="font-weight:600;font-size:14px;">Idle</span></h2>
    <div class="summary-grid">
      <div><div class="k">Current stage</div><div class="v" id="s-stage">—</div></div>
      <div><div class="k">Overall progress</div><div class="v" id="p-completed">0 / 0</div></div>
      <div><div class="k">Elapsed</div><div class="v" id="p-runtime">00:00:00</div></div>
      <div><div class="k">Remaining</div><div class="v" id="p-remaining">—</div></div>
      <div><div class="k">Est. finish</div><div class="v" id="p-finish">—</div></div>
    </div>
    <div style="margin-top:10px;"><div class="k">Current operation</div>
      <div id="s-op" style="font-weight:600;font-size:13.5px;">—</div></div>
    <div class="pbar" style="margin-top:12px;"><i id="p-bar"></i></div>
    <div style="display:flex;justify-content:space-between;font-size:12px;margin-top:4px;">
      <span id="p-pct" style="font-weight:700;">0%</span>
      <span><span class="tally ok" id="t-pass">✅ 0</span> <span class="tally bad" id="t-fail">❌ 0</span> <span class="tally" id="t-skip">⏭ 0</span></span>
    </div>

    <!-- pre-flight checklist -->
    <div id="pfBox" style="display:none;margin-top:14px;">
      <div class="k">Pre-flight validation</div>
      <div id="pfList" class="checklist"></div>
    </div>

    <!-- current test case -->
    <div class="tcard idle" id="p-tcard" style="margin-top:14px;">
      <div class="k">Current test case</div>
      <div class="v" id="p-tc-title" style="font-size:17px;">Idle</div>
      <div class="row2">
        <div><div class="k">ToS</div><div class="v" id="p-tc-tos">—</div></div>
        <div><div class="k">Direction</div><div class="v" id="p-tc-dir">—</div></div>
        <div><div class="k">Link A</div><div class="v" id="p-linkA">—</div></div>
        <div><div class="k">Link B</div><div class="v" id="p-linkB">—</div></div>
        <div><div class="k">Elapsed</div><div class="v" id="p-tc-elapsed">—</div></div>
      </div>
      <div id="p-tc-note" style="margin-top:8px;color:var(--mut);font-size:12px;">—</div>
      <div id="p-stab" style="display:none;margin-top:8px;font-weight:700;color:#2563eb;"></div>
    </div>

    <div class="flow" id="p-flow" style="margin-top:14px;"></div>

    <!-- live activity log -->
    <div style="margin-top:14px;">
      <div class="k">Live activity</div>
      <div id="actLog" class="actlog">—</div>
    </div>
  </div>
  <div class="panel">
    <h2>Live progress</h2>
    <div class="stat">
      <b>Phase</b><span id="s-phase">idle</span>
      <b>Current test case</b><span id="s-case">—</span>
      <b>Elapsed (this case)</b><span id="s-elapsed">—</span>
      <b>Netem settings</b><span id="s-netem">—</span>
      <b>Traffic verified</b><span id="s-traffic">—</span>
      <b>Link switch detected</b><span id="s-switch">—</span>
      <b>Last switch</b><span id="s-lastswitch">—</span>
      <b>Log collection</b><span id="s-collect">—</span>
      <b>Confluence upload</b><span id="s-conf">pending</span>
      <b>Results</b><span id="s-results" class="chips">—</span>
    </div>
  </div>
  <div class="panel">
    <h2>Checkpoints <span style="font-weight:400;font-size:12px;color:var(--mut)">(automation.log)</span></h2>
    <div id="checkpoints" style="font:12px/1.6 ui-monospace,monospace; max-height:220px; overflow-y:auto;">—</div>
  </div>
  <div id="log"></div>
</div>
</div>

<script>
const $ = (id) => document.getElementById(id);
const form = $("f"), startBtn = $("start");
let caseStartedAt = null, phase = "idle", pendingBody = null;
let runStartedAt = null, lastStatus = null;
const EST_SEC_PER_CASE = 330; // ~5.5 min average (5-min window + reset/collect)
const fmtDur = (sec) => { sec = Math.max(0, Math.round(sec)); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), sc = sec % 60; return h ? (h + "h " + m + "m") : (m + "m " + sc + "s"); };

/* ---------- helpers ---------- */
function formBody() {
  const fd = new FormData(form);
  const body = Object.fromEntries(fd.entries());
  body.confluence = fd.has("confluence");
  body.iptvMode = true;                       // single execution mode
  body.latProgression = fd.has("latProgression");
  // multi-value checkbox group: every selected test case
  body.selectedCases = fd.getAll("selectedCases");
  body.headless = !fd.has("headed");
  delete body.headed;
  if (!$("advanced").checked) { body.serverCmd = ""; body.clientCmd = ""; }
  return body;
}
function clearErrors() {
  document.querySelectorAll(".errmsg").forEach((e) => (e.textContent = ""));
  document.querySelectorAll("input,textarea,select").forEach((e) => e.classList.remove("err"));
  $("globalerr").textContent = "";
}
function showErrors(errors) {
  const alias = { clientAuth: "clientPass", serverAuth: "serverPass", spokeAuth: "spokePass",
                  hubAuth: "hubPass", netemAuth: "netemPass" };
  for (const [field, msg] of Object.entries(errors || {})) {
    if (field === "_global") { $("globalerr").textContent = msg; continue; }
    const input = form.querySelector('[name="' + (alias[field] || field) + '"]');
    if (input) {
      input.classList.add("err");
      const em = (input.nextElementSibling && input.nextElementSibling.classList.contains("errmsg"))
        ? input.nextElementSibling
        : input.parentElement.querySelector(".errmsg");
      if (em) em.textContent = msg;
    } else $("globalerr").textContent += field + ": " + msg + "  ";
  }
}

/* ---------- elapsed ticker + status render ---------- */
setInterval(() => {
  if (phase === "running" && caseStartedAt) {
    const sec = Math.max(0, Math.floor((Date.now() - new Date(caseStartedAt)) / 1000));
    $("s-elapsed").textContent = Math.floor(sec / 60) + "m " + (sec % 60) + "s";
    if ($("p-tc-elapsed")) $("p-tc-elapsed").textContent = fmtDur(sec);
  }
  if (phase === "running" && runStartedAt && lastStatus) {
    const runSec = (Date.now() - new Date(runStartedAt)) / 1000;
    const total = lastStatus.caseCount || 0;
    const done = lastStatus.completedCount != null ? lastStatus.completedCount : (lastStatus.caseIndex || 0);
    // ETA from measured case durations once we have data, else the estimate
    const perCase = caseDurations.length
      ? caseDurations.reduce((a, b) => a + b, 0) / caseDurations.length
      : EST_SEC_PER_CASE;
    const remainSec = Math.max(0, total - done) * perCase;
    if ($("p-runtime")) $("p-runtime").textContent = fmtDur(runSec);
    if ($("p-remaining")) $("p-remaining").textContent = total ? fmtDur(remainSec) : "—";
    if ($("p-finish")) {
      $("p-finish").textContent = total
        ? new Date(Date.now() + remainSec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : "—";
    }
  }
  // post-switch stabilisation countdown
  const stab = $("p-stab");
  if (stab && lastStatus && lastStatus.stabilizeUntil) {
    const left = Math.ceil((lastStatus.stabilizeUntil - Date.now()) / 1000);
    if (left > 0) { stab.style.display = "block"; stab.textContent = "Stabilising on the new link… " + left + "s"; }
    else { stab.style.display = "none"; }
  } else if (stab) stab.style.display = "none";
}, 1000);
// Canonical per-block testcase order + display labels for the flow checklist.
const FLOW = {
  latency: [["TC1", "Baseline"], ["TC2", "LEO"], ["TC3", "MEO"], ["TC4", "GEO"]],
  "packet-loss": [["PL_TC1", "Constant"], ["PL_TC2", "Periodic"], ["PL_TC3", "Random"]],
};
const FLOW_ORDER = [...FLOW.latency.map((x) => ["latency", x[0]]), ...FLOW["packet-loss"].map((x) => ["packet-loss", x[0]])];
function renderFlow(s) {
  const el = $("p-flow"); if (!el) return;
  const curIdx = FLOW_ORDER.findIndex(([su, tc]) => su === s.currentSuite && tc === s.currentTc);
  const plNum = { PL_TC1: "TC5", PL_TC2: "TC6", PL_TC3: "TC7" };
  const group = (title, suite) => {
    const steps = FLOW[suite].map(([tc, label]) => {
      const gi = FLOW_ORDER.findIndex(([su, t]) => su === suite && t === tc);
      const cls = curIdx < 0 ? "todo" : gi < curIdx ? "done" : gi === curIdx ? "cur" : "todo";
      const num = suite === "packet-loss" ? plNum[tc] : tc;
      const mark = cls === "done" ? "\\u2713" : cls === "cur" ? "\\u25B6" : "\\u25CB";
      return '<div class="step ' + cls + '">' + mark + " " + num + " " + label + "</div>";
    }).join("");
    return '<div class="grp"><h4>' + title + "</h4>" + steps + "</div>";
  };
  el.innerHTML = group("Latency", "latency") + group("Packet Loss", "packet-loss");
}
/* ---------- live status helpers ---------- */
let caseDurations = [];      // actual seconds per completed case → better ETA
let lastCompletedCount = 0, lastCaseStart = null, errorBeeped = false;
const actSeen = new Set();

function beepAlarm() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.28, 0.56].forEach((t) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "square"; o.frequency.value = 880;
      g.gain.setValueAtTime(0.09, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.22);
      o.connect(g); g.connect(ctx.destination);
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.22);
    });
  } catch (e) { /* audio unavailable — visual alert still shows */ }
}

function pushActivity(msg) {
  const el = $("actLog"); if (!el) return;
  const stamp = new Date().toTimeString().slice(0, 8);
  const line = "[" + stamp + "] " + msg;
  if (actSeen.has(msg)) return;      // don't repeat the same operation every tick
  actSeen.add(msg);
  if (el.textContent === "—") el.textContent = "";
  el.textContent += line + "\\n";
  el.scrollTop = el.scrollHeight;
}

function renderPreflight(list) {
  const box = $("pfBox"), out = $("pfList");
  if (!box || !out) return;
  if (!list || !list.length) { box.style.display = "none"; return; }
  box.style.display = "block";
  const ic = { ok: "✓", run: "⏳", fail: "✗" };
  out.innerHTML = list.map((s) =>
    '<div class="ck ' + s.status + '"><span class="ic">' + (ic[s.status] || "•") + "</span><span>" +
    s.name.replace(/</g, "&lt;") +
    (s.detail ? ' <span class="dt">— ' + String(s.detail).replace(/</g, "&lt;").slice(0, 70) + "</span>" : "") +
    "</span></div>").join("");
}

function renderError(s) {
  const b = $("errBanner"); if (!b) return;
  const e = s.errorDetail;
  if (!e && !s.error) { b.style.display = "none"; errorBeeped = false; return; }
  b.style.display = "block";
  $("e-stage").textContent = (e && e.stage) || s.stage || "—";
  $("e-case").textContent = (e && e.testcase) || s.currentCase || "—";
  $("e-op").textContent = (e && e.operation) || "—";
  $("e-reason").textContent = (e && e.reason) || s.error || "—";
  $("e-fix").textContent = (e && e.suggestion) || "Review the configuration for this component and retry.";
  if (!errorBeeped) { errorBeeped = true; beepAlarm(); pushActivity("ERROR: " + ((e && e.reason) || s.error)); }
}

function renderRegression(running, s) {
  if (!$("regProgress")) return;
  runStartedAt = s.runStartedAt || runStartedAt;
  const total = s.caseCount || 0;
  const done = s.completedCount != null ? s.completedCount : (s.caseIndex || 0);
  const pct = total ? Math.round((done / total) * 100) : 0;
  $("p-bar").style.width = pct + "%";
  $("p-pct").textContent = pct + "%";
  $("p-completed").textContent = done + " / " + total + " test cases";

  // status word + dot
  const phase = s.phase || "idle";
  const dot = phase === "error" ? "🔴" : running ? "🔵" : phase === "done" ? "🟢" : "⚪";
  $("s-dot").textContent = dot;
  $("s-word").textContent = phase === "error" ? "Stopped (error)" : running ? "Running" : phase === "done" ? "Complete" : "Idle";
  $("s-stage").textContent = s.stage || (running ? "Starting" : "—");
  const op = s.operation || "—";
  $("s-op").textContent = op;
  if (running && op !== "—") pushActivity(op);

  // pass/fail/skip tally from results
  const res = s.results || [];
  const fails = res.filter((r) => r.result === "FAIL" || r.result === "ERROR").length;
  const skips = res.filter((r) => r.result === "SKIPPED").length;
  $("t-pass").textContent = "✅ " + Math.max(0, res.length - fails - skips);
  $("t-fail").textContent = "❌ " + fails;
  $("t-skip").textContent = "⏭ " + skips;

  renderPreflight(s.preflight);
  renderError(s);

  // learn actual case duration for a real ETA
  if (done > lastCompletedCount) {
    if (lastCaseStart) caseDurations.push((Date.now() - lastCaseStart) / 1000);
    lastCompletedCount = done; lastCaseStart = Date.now();
  }
  if (!lastCaseStart && running) lastCaseStart = Date.now();

  // current test case card
  const card = $("p-tcard");
  const active = running && s.currentCase;
  card.className = "tcard" + (active ? "" : " idle");
  if (active) {
    const suiteLabel = s.currentSuite === "packet-loss" ? "Packet Loss" : "Latency";
    $("p-tc-title").textContent = suiteLabel + " " + (s.currentTc || "") + "  ·  case " + s.caseIndex + "/" + total;
    $("p-tc-tos").textContent = s.currentTos || "—";
    $("p-tc-dir").textContent = s.currentDir || "—";
    $("p-linkA").textContent = s.currentLinkA || "—";
    $("p-linkB").textContent = s.currentLinkB || "—";
    $("p-tc-note").textContent = s.switchObserved
      ? "Switch detected" + (s.switchFrom ? " (" + s.switchFrom + " → " + s.switchTo + ")" : "") + " — stabilising before hourLog"
      : (s.netem ? "Impairment: " + s.netem : "Waiting for a link switch…");
  } else {
    $("p-tc-title").textContent = phase === "done" ? "Run complete" : phase === "error" ? "Stopped" : "Idle";
    ["p-tc-tos", "p-tc-dir", "p-linkA", "p-linkB", "p-tc-elapsed"].forEach((id) => { if ($(id)) $(id).textContent = "—"; });
    $("p-tc-note").textContent = "—";
    if ($("p-stab")) $("p-stab").style.display = "none";
  }
  renderFlow(s);
}
function render(running, s) {
  lastStatus = s;
  renderRegression(running, s);
  phase = s.phase; caseStartedAt = s.caseStartedAt;
  $("s-phase").innerHTML = s.phase + (running ? ' <span class="badge run">RUNNING</span>' : "");
  $("s-case").textContent = s.currentCase ? s.currentCase + " (" + s.caseIndex + "/" + s.caseCount + ")" : "—";
  $("s-netem").textContent = s.netem ?? "—";
  $("s-traffic").textContent = s.trafficVerified != null ? s.trafficVerified + " B/s" : "—";
  $("s-switch").textContent = s.switchObserved == null ? "—" : (s.switchObserved ? "Yes" : "No");
  $("s-lastswitch").textContent = s.lastSwitch
    ? s.lastSwitch.fromLink + " → " + s.lastSwitch.toLink + " @ " + s.lastSwitch.time : "—";
  $("s-collect").textContent = Object.entries(s.collection || {}).map(([k, v]) => k + ": " + v).join(", ") || "—";
  $("s-conf").textContent = s.confluence;
  $("s-results").innerHTML = (s.results || []).map(r =>
    '<span class="badge ' + (r.result === "PASS" ? "pass" : r.result === "OBSERVED" ? "obs" : "fail") + '">' + r.name + " " + r.result + "</span>").join("") || "—";
  if (s.error) $("globalerr").textContent = s.error;
  startBtn.disabled = running;
  $("stop").disabled = !running;
  $("pausebox").style.display = s.paused ? "block" : "none";
  if (s.paused) $("pausestage").textContent = s.paused;
  const cps = s.checkpoints || [];
  $("checkpoints").innerHTML = cps.length
    ? cps.slice(-60).map((c) =>
        '<div style="color:' + (c.ok ? "#166534" : "#991b1b") + '">[' + (c.ok ? "PASS" : "FAIL") + "] " +
        c.name.replace(/</g, "&lt;") + (c.detail ? " — " + String(c.detail).replace(/</g, "&lt;") : "") + "</div>"
      ).join("")
    : "—";
  const cpEl = $("checkpoints");
  cpEl.scrollTop = cpEl.scrollHeight;
}
$("continueBtn").addEventListener("click", async () => {
  const out = await (await fetch("/api/continue", { method: "POST" })).json();
  if (!out.ok) $("globalerr").textContent = out.error;
});
$("stop").addEventListener("click", async () => {
  if (!confirm("Stop the current test run? Traffic is stopped and netem impairments " +
               "are cleared; remaining test cases are skipped.")) return;
  $("stop").disabled = true;
  const out = await (await fetch("/api/stop", { method: "POST" })).json();
  if (!out.ok) $("globalerr").textContent = out.error;
});
const es = new EventSource("/api/events");
es.addEventListener("status", (e) => { const { running, status } = JSON.parse(e.data); render(running, status); });
es.addEventListener("log", (e) => {
  const el = $("log");
  el.textContent += JSON.parse(e.data) + "\\n";
  while (el.textContent.split("\\n").length > 500)
    el.textContent = el.textContent.slice(el.textContent.indexOf("\\n") + 1);
  el.scrollTop = el.scrollHeight;
});

/* ---------- advanced command editing + live preview ---------- */
const sCmd = form.querySelector('[name="serverCmd"]'), cCmd = form.querySelector('[name="clientCmd"]');
$("advanced").addEventListener("change", () => {
  const on = $("advanced").checked;
  sCmd.readOnly = cCmd.readOnly = !on;
});
async function refreshCommands() {
  if ($("advanced").checked) return; // don't clobber manual edits
  const body = formBody();
  try {
    const r = await fetch("/api/commands", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const out = await r.json();
    if (out.ok) { sCmd.value = out.serverCmd || ""; cCmd.value = out.clientCmd || ""; }
  } catch {}
}
["trafficTool", "trafficType", "bandwidth", "durationSec", "parallelStreams", "tos",
 "packetSize", "serverIp", "serverPort", "clientPort"].forEach((n) => {
  const el = form.querySelector('[name="' + n + '"]');
  if (el) el.addEventListener("change", refreshCommands);
});
document.querySelectorAll('[name="trafficDirection"]').forEach((el) =>
  el.addEventListener("change", refreshCommands));
refreshCommands();

/* ---------- interface discovery ---------- */
document.querySelectorAll("[data-discover]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const side = btn.dataset.discover;
    const body = {
      side,
      host: form.querySelector('[name="' + side + 'Ip"]').value,
      user: form.querySelector('[name="' + side + 'User"]').value,
      pass: form.querySelector('[name="' + side + 'Pass"]').value,
      key: form.querySelector('[name="' + side + 'Key"]').value,
    };
    const errEl = $(side + "IfaceErr");
    errEl.textContent = "discovering…";
    const r = await fetch("/api/interfaces", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const out = await r.json();
    if (!out.ok) { errEl.textContent = out.error; return; }
    errEl.textContent = "";
    const sel = $(side + "IfaceSel");
    sel.innerHTML = '<option value="">— (default route) —</option>' +
      out.interfaces.map((i) => '<option value="' + i.iface + '" data-ip="' + i.ip + '">' +
        i.iface + " (" + i.ip + ")</option>").join("");
  });
});
$("clientIfaceSel").addEventListener("change", () => {
  const opt = $("clientIfaceSel").selectedOptions[0];
  form.querySelector('[name="clientBindIp"]').value = (opt && opt.dataset.ip) || "";
  refreshCommands();
});
$("serverIfaceSel").addEventListener("change", () => {
  const opt = $("serverIfaceSel").selectedOptions[0];
  form.querySelector('[name="serverTrafficIp"]').value = (opt && opt.dataset.ip) || "";
  refreshCommands();
});

/* ---------- connection profiles ---------- */
async function refreshProfiles(names) {
  if (!names) names = (await (await fetch("/api/profiles")).json()).names;
  $("profSel").innerHTML = '<option value="">— select —</option>' +
    names.map((n) => "<option>" + n.replace(/</g, "&lt;") + "</option>").join("");
}
$("profSave").addEventListener("click", async () => {
  const name = prompt("Profile name:", $("profSel").value || "lab-default");
  if (!name) return;
  const r = await fetch("/api/profiles", { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, params: formBody() }) });
  const out = await r.json();
  $("proferr").textContent = out.ok ? 'saved "' + name + '" (profiles.json, local only)' : out.error;
  if (out.ok) { await refreshProfiles(out.names); $("profSel").value = name; }
});
$("profLoad").addEventListener("click", async () => {
  const name = $("profSel").value;
  if (!name) { $("proferr").textContent = "select a profile first"; return; }
  const out = await (await fetch("/api/profiles?name=" + encodeURIComponent(name))).json();
  if (!out.ok) { $("proferr").textContent = out.error; return; }
  for (const [k, v] of Object.entries(out.profile)) {
    const el = form.querySelector('[name="' + k + '"]');
    if (!el) continue;
    if (el.type === "checkbox") el.checked = !!v;
    else if (el.tagName === "SELECT" && k.endsWith("Iface") && v) {
      el.innerHTML = '<option value="">— (default route) —</option><option selected>' + v + "</option>";
    } else el.value = v;
  }
  $("proferr").textContent = 'loaded "' + name + '"';
  refreshCommands();
});
$("profDel").addEventListener("click", async () => {
  const name = $("profSel").value;
  if (!name || !confirm('Delete profile "' + name + '"?')) return;
  const out = await (await fetch("/api/profiles?name=" + encodeURIComponent(name), { method: "DELETE" })).json();
  await refreshProfiles(out.names);
  $("proferr").textContent = "deleted";
});

/* ---------- traffic path confirmation + start ---------- */
form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  clearErrors();
  if (runType() === "regression") { startRegression(false); return; }
  const body = formBody();
  let cmds = { serverCmd: sCmd.value, clientCmd: cCmd.value };
  if (!$("advanced").checked) {
    try {
      const r = await fetch("/api/commands", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const out = await r.json();
      if (out.ok) cmds = out;
    } catch {}
  } else {
    body.serverCmd = sCmd.value;
    body.clientCmd = cCmd.value;
  }
  pendingBody = body;
  const node = (title, ip, iface) =>
    '<div class="node"><b>' + title + "</b><br>" + (ip || "?") + (iface ? "<br>Interface: " + iface : "") + "</div>";
  $("pathview").innerHTML =
    node("Client", body.clientIp + (body.clientBindIp ? " → src " + body.clientBindIp : ""), body.clientIface) +
    '<div class="arrow">↓</div>' +
    node("Spoke", body.spokeHost, "") + '<div class="arrow">↓</div>' +
    node("Hub", body.hubHost, "") + '<div class="arrow">↓</div>' +
    node("Server", body.serverIp + (body.serverTrafficIp ? " → dst " + body.serverTrafficIp : ""), body.serverIface);
  $("cmdview").textContent = body.trafficDriver === "netem-ui"
    ? "(traffic driven by the netem UI page)"
    : (cmds.serverCmd ? "server: " + cmds.serverCmd + "\\n" : "") +
      (cmds.clientCmd ? "client: " + cmds.clientCmd : "(no client command — check tool/Advanced)");
  $("confirm").style.display = "block";
  $("confirm").scrollIntoView({ behavior: "smooth" });
});
$("confirmCancel").addEventListener("click", () => { $("confirm").style.display = "none"; pendingBody = null; });
$("confirmGo").addEventListener("click", async () => {
  $("confirm").style.display = "none";
  if (!pendingBody) return;
  startBtn.disabled = true;
  const resp = await fetch("/api/start", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(pendingBody) });
  const out = await resp.json();
  if (!out.ok) { startBtn.disabled = false; showErrors(out.errors); }
  pendingBody = null;
});

/* ---------- SLA Full Regression (6x7 Matrix) ---------- */
/* single execution mode — no run-type toggle */
function runType() { return "regression"; }
function applyRunType() {
  document.body.dataset.runtype = "regression";
  startBtn.textContent = "Start Run";
  refreshRegressionState();
}

/** Selected case ids, direction and ToS list → the execution plan. */
function selectedPlan() {
  const cases = [...form.querySelectorAll('[name="selectedCases"]:checked')].map((c) => c.value);
  const dirEl = form.querySelector('[name="regDirection"]');
  const dir = dirEl ? dirEl.value : "both";
  const tosArr = (form.querySelector('[name="regressionTos"]').value || "").trim()
    .split(/[,\\s]+/).filter(Boolean);
  const nDir = dir === "both" ? 2 : 1;
  return { cases, dir, tosArr, total: cases.length * nDir * (tosArr.length || 0) };
}

/** Live "N cases will run" summary under the selection. */
function updatePlanSummary() {
  const el = $("planSummary"); if (!el) return;
  const p = selectedPlan();
  if (!p.cases.length) { el.textContent = "No test cases selected"; el.className = "plan warn"; return; }
  if (!p.tosArr.length) { el.textContent = "Enter at least one ToS value"; el.className = "plan warn"; return; }
  const dirTxt = p.dir === "both" ? "up + down" : p.dir;
  el.innerHTML = "<b>" + p.total + "</b> test case" + (p.total === 1 ? "" : "s") +
    " &mdash; " + p.cases.length + " selected \\u00d7 " + p.tosArr.length + " ToS \\u00d7 " + dirTxt;
  el.className = "plan";
}
["selectedCases", "regDirection", "regressionTos"].forEach((n) =>
  form.querySelectorAll('[name="' + n + '"]').forEach((el) => {
    el.addEventListener("change", updatePlanSummary);
    el.addEventListener("input", updatePlanSummary);
  }));
// latency progression fields show only when the option is enabled
const latChk = $("latProgChk");
if (latChk) latChk.addEventListener("change", () => {
  $("progFields").style.display = latChk.checked ? "block" : "none";
});

async function startRegression(resume) {
  clearErrors();
  const plan = selectedPlan();
  if (!plan.cases.length) { showErrors({ _global: "Select at least one test case" }); return; }
  if (!plan.tosArr.length) { showErrors({ regressionTos: "required — at least one ToS value" }); return; }
  const scope = plan.total + " test cases — " + plan.cases.join(", ") +
    " \\u00d7 ToS " + plan.tosArr.join(", ") +
    " \\u00d7 " + (plan.dir === "both" ? "upstream then downstream" : plan.dir);
  const confOn = form.querySelector('[name="confluence"]') && form.querySelector('[name="confluence"]').checked;
  if (!resume && !confirm(
    "Start the SLA regression?\\n\\n" +
    "\\u2022 " + scope + " \\u2014 runs automatically.\\n" +
    "\\u2022 " + (confOn
      ? "A new Confluence page is created and each test case is uploaded to it immediately."
      : "Confluence OFF \\u2014 hourLogs + reports are saved locally only (SLA_Regression/).") + "\\n" +
    "\\u2022 Observations only \\u2014 no PASS/FAIL.\\n\\n" +
    "You can Stop at any time and Resume later.")) return;
  startBtn.disabled = true;
  const path = resume ? "/api/regression/resume" : "/api/regression/start";
  const resp = await fetch(path, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(formBody()) });
  const out = await resp.json();
  if (!out.ok) { startBtn.disabled = false; showErrors(out.errors || { _global: out.error || "start failed" }); }
  else { $("resumeBanner").style.display = "none"; }
}

async function refreshRegressionState() {
  let out;
  try { out = await (await fetch("/api/regression/state")).json(); } catch { return; }
  const s = out && out.state;
  const banner = $("resumeBanner");
  // reflect a resumable saved run in the progress panel (so it isn't stuck at 0%)
  if (s && s.exists && !out.running && $("regProgress")) {
    const pct = s.total ? Math.round((s.completedCount / s.total) * 100) : 0;
    $("p-bar").style.width = pct + "%"; $("p-pct").textContent = pct + "%";
    $("p-completed").textContent = (s.completedCount || 0) + " / " + (s.total || 0);
    $("p-est").textContent = s.total ? fmtDur(s.total * EST_SEC_PER_CASE) : "—";
  }
  if (!s || !s.exists || s.done || out.running) { banner.style.display = "none"; return; }
  const rf = s.resumeFrom;
  banner.innerHTML =
    "<b>Previous SLA Regression found.</b><br>" +
    "Completed: " + s.completedCount + " / " + s.total + " testcases<br>" +
    (rf ? "Resume from: <b>" + rf.direction + " \\u00b7 ToS " + rf.tos + " \\u00b7 " + rf.suite + " " + rf.testcase + "</b><br>" : "") +
    (s.pageUrl ? '<a href="' + s.pageUrl + '" target="_blank" rel="noopener">open Confluence page</a><br>' : "") +
    '<div style="margin-top:8px">' +
    '<button type="button" id="regResume">Resume</button> ' +
    '<button type="button" class="grey" id="regRestart">Restart</button> ' +
    '<button type="button" class="grey" id="regCancel">Cancel</button></div>';
  banner.style.display = "block";
  $("regResume").addEventListener("click", () => startRegression(true));
  $("regCancel").addEventListener("click", () => { banner.style.display = "none"; });
  $("regRestart").addEventListener("click", async () => {
    if (!confirm("Discard the saved progress and start the 42-case regression from the beginning? " +
                 "(A new Confluence page will be created; the previous one is left as-is.)")) return;
    await fetch("/api/regression/reset", { method: "POST" });
    startRegression(false);
  });
}
// On launch: if an unfinished regression exists, switch to regression mode and
// surface the Resume/Restart/Cancel banner automatically.
(async () => {
  try {
    const out = await (await fetch("/api/regression/state")).json();
  } catch {}
  applyRunType();
  updatePlanSummary();   // show the execution plan straight away
})();
</script>
</body></html>`;

server.listen(PORT, HOST, () => {
  console.log(`SLA impairment test control panel: http://${HOST}:${PORT}`);
});
