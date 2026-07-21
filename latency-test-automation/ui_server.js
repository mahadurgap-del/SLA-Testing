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

const PORT = parseInt(process.env.UI_PORT ?? "8790", 10);
const HOST = "127.0.0.1";
const PROFILES_FILE = path.join(__dirname, "profiles.json");

let running = false;

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

function formDefaults() {
  // saved form state wins over env defaults
  const p = { ...engine.paramsFromEnv(), ...savedDefaults() };
  const d = { ...p };
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
</style></head><body>
<h1>SLA Impairment Test Control Panel</h1>
<div class="cols">
<form id="f">
  <fieldset><legend>Connection profile</legend><div class="grid" style="grid-template-columns: 2fr 1fr 1fr 1fr;">
    <div><label>Profile</label><select id="profSel">
      <option value="">— select —</option>
      ${profileNames.map((n) => `<option>${esc(n)}</option>`).join("")}
    </select></div>
    <div><label>&nbsp;</label><button type="button" class="small grey" id="profLoad">Load</button></div>
    <div><label>&nbsp;</label><button type="button" class="small grey" id="profSave">Save as…</button></div>
    <div><label>&nbsp;</label><button type="button" class="small grey" id="profDel">Delete</button></div>
    <div class="full errmsg" id="proferr"></div>
  </div></fieldset>

  <fieldset><legend>1 — Traffic endpoints</legend><div class="grid4">
    <div><label>Client IP</label><input name="clientIp" value="${esc(d.clientIp)}"><div class="errmsg"></div></div>
    <div><label>Client port</label><input name="clientPort" value="${esc(d.clientPort)}" placeholder="auto"><div class="errmsg"></div></div>
    <div><label>Server IP</label><input name="serverIp" value="${esc(d.serverIp)}"><div class="errmsg"></div></div>
    <div><label>Server port</label><input name="serverPort" value="${esc(d.serverPort)}"><div class="errmsg"></div></div>
    <div><label>Protocol</label><select name="trafficType">
      <option${d.trafficType === "UDP" ? " selected" : ""}>UDP</option>
      <option${d.trafficType === "TCP" ? " selected" : ""}>TCP</option></select><div class="errmsg"></div></div>
    <div style="grid-column: 2 / -1;"><label>netem UI URL</label><input name="netemUiUrl" value="${esc(d.netemUiUrl)}"><div class="errmsg"></div></div>
  </div></fieldset>

  <fieldset><legend>2 — SSH details</legend><div class="sshgrid">
    ${["client", "server", "spoke", "hub", "netem"].map((side) => `
    <div class="sshbox"><h4>${side === "netem" ? "Netem VM" : side[0].toUpperCase() + side.slice(1)}${["spoke", "hub", "netem"].includes(side) ? "" : " (uses IP above)"}</h4>
      ${["spoke", "hub", "netem"].includes(side)
        ? `<label>IP</label><input name="${side}Host" value="${esc(d[side + "Host"])}"><div class="errmsg"></div>` : ""}
      <label>Username</label><input name="${side}User" value="${esc(d[side + "User"])}"><div class="errmsg"></div>
      <label>Password ${d[side + "PassSet"] ? "(saved — blank keeps it)" : ""}</label><input name="${side}Pass" type="password"><div class="errmsg"></div>
      <label>or key path</label><input name="${side}Key" value="${esc(d[side + "Key"])}"><div class="errmsg"></div>
    </div>`).join("")}
  </div></fieldset>

  <fieldset><legend>3 — Interface selection</legend><div class="grid">
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

  <fieldset><legend>4 — Traffic generation</legend><div class="grid3">
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

  <fieldset><legend>4a — Latency ranges, RTT ms (mode: latency — a value is drawn at random per run and recorded in all reports)</legend><div class="grid3">
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

  <fieldset><legend>4b — Packet-loss schedule (mode: packet-loss — impairment auto-applied to the active link)</legend><div class="grid3">
    <div><label>TC1 ramp step (%)</label><input name="rampStepPct" value="${esc(d.rampStepPct)}"><div class="errmsg"></div></div>
    <div><label>TC1 ramp interval (s)</label><input name="rampIntervalSec" value="${esc(d.rampIntervalSec)}"><div class="errmsg"></div></div>
    <div><label>TC2 burst interval (s)</label><input name="burstIntervalSec" value="${esc(d.burstIntervalSec)}"><div class="errmsg"></div></div>
    <div><label>TC2 burst duration (s)</label><input name="burstDurationSec" value="${esc(d.burstDurationSec)}"><div class="errmsg"></div></div>
    <div><label>TC2 burst loss (%)</label><input name="burstLossPct" value="${esc(d.burstLossPct)}"><div class="errmsg"></div></div>
    <div><label>TC3 random loss (%)</label><input name="randomLossPct" value="${esc(d.randomLossPct)}"><div class="errmsg"></div></div>
    <div style="grid-column: 1 / -1;"><label>Overlay link ports on netem VM (csv, e.g. ens192,ens193,ens224,ens225 — empty = auto-detect bridge links; impairment is applied to ALL ports of the active bridge)</label>
      <input name="netemCandidates" value="${esc(d.netemCandidates)}"><div class="errmsg"></div></div>
  </div></fieldset>

  <fieldset><legend>5 — Traffic command</legend>
    <div style="padding: 0 8px;">
    <label><input type="checkbox" id="advanced" style="width:auto"> Advanced — edit commands before execution</label>
    <label>Server command</label><textarea name="serverCmd" rows="2" readonly>${esc(d.serverCmd)}</textarea><div class="errmsg"></div>
    <label>Client command</label><textarea name="clientCmd" rows="2" readonly>${esc(d.clientCmd)}</textarea><div class="errmsg"></div>
    </div>
  </fieldset>

  <fieldset><legend>6 — Test selection</legend><div class="grid4">
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

  <fieldset><legend>Confluence</legend><div class="grid">
    <div class="full"><label><input type="checkbox" name="confluence" style="width:auto" ${d.confluence ? "checked" : ""}> Upload results to Confluence</label></div>
    <div><label>Email</label><input name="confEmail" value="${esc(d.confEmail)}"><div class="errmsg"></div></div>
    <div><label>API token ${d.confTokenSet ? "(saved — blank keeps it)" : ""}</label><input name="confToken" type="password"><div class="errmsg"></div></div>
    <div class="full"><label>Base URL</label><input name="confBase" value="${esc(d.confBase)}"><div class="errmsg"></div></div>
    <div><label>Page URL or ID (update)</label><input name="confPageId" value="${esc(d.confPageId)}" placeholder="paste the page link"><div class="errmsg"></div></div>
    <div><label>Space key (create)</label><input name="confSpace" value="${esc(d.confSpace)}"><div class="errmsg"></div></div>
  </div></fieldset>

  <div class="errmsg" id="globalerr"></div>
  <button id="start" type="submit">Start Test</button>
  <button id="stop" type="button" class="red" disabled>Stop</button>
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

/* ---------- helpers ---------- */
function formBody() {
  const fd = new FormData(form);
  const body = Object.fromEntries(fd.entries());
  body.confluence = fd.has("confluence");
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
  }
}, 1000);
function render(running, s) {
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
    '<span class="badge ' + (r.result === "PASS" ? "pass" : "fail") + '">' + r.name + " " + r.result + "</span>").join("") || "—";
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
</script>
</body></html>`;

server.listen(PORT, HOST, () => {
  console.log(`SLA impairment test control panel: http://${HOST}:${PORT}`);
});
