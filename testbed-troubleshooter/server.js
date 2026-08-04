#!/usr/bin/env node
/**
 * Testbed troubleshooter — local web app.
 *
 *   Step 1  ESXi host: IP / username / password  -> reads the virtual network
 *           (vSwitches, portgroups + VLANs, vNIC MACs, VM inventory)
 *   Step 2  Testbed nodes: client, spoke, netem (optional), hub, server
 *   Step 3  Diagnose: says whether the break is L2 or L3 and where, with the
 *           evidence and the fix
 *
 * Usage:  node server.js        # http://127.0.0.1:8791  (TS_PORT to change)
 *
 * Binds 127.0.0.1 only — credentials never leave the machine. Blank secret
 * fields fall back to the saved profile, then to env vars
 * (ESXI_PASS, CLIENT_PASS, SPOKE_PASS, NETEM_PASS, HUB_PASS, SERVER_PASS).
 */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const engine = require("./lib/engine");
const { ROLE_ORDER } = require("./lib/diagnose");
const { isValidHost } = require("./lib/ssh");

const PORT = parseInt(process.env.TS_PORT ?? "8791", 10);
const HOST = "127.0.0.1";
const PUBLIC_DIR = path.join(__dirname, "public");
const PROFILES_FILE = path.join(__dirname, "profiles.json");
const DEFAULT_PROFILE = "__default__";

let running = false;

/* ---------------------------------------------------------------- helpers */

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 2e6) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error("invalid JSON body")); }
    });
  });
}

function loadProfiles() {
  try { return JSON.parse(fs.readFileSync(PROFILES_FILE, "utf8")); }
  catch { return {}; }
}

function saveProfiles(p) {
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(p, null, 2), { mode: 0o600 });
}

function profileNames() {
  return Object.keys(loadProfiles()).filter((n) => n !== DEFAULT_PROFILE);
}

const envPass = (role) => process.env[`${role.toUpperCase()}_PASS`] || "";

/** Fill blank passwords from the remembered config, then the environment. */
function mergeSecrets(cfg) {
  const saved = loadProfiles()[DEFAULT_PROFILE] || {};
  const out = { ...cfg, esxi: { ...(cfg.esxi || {}) }, nodes: {}, options: { ...(cfg.options || {}) } };
  out.esxi.pass = out.esxi.pass || (saved.esxi || {}).pass || envPass("esxi");
  for (const role of ROLE_ORDER) {
    const n = { ...((cfg.nodes || {})[role] || {}) };
    const s = (saved.nodes || {})[role] || {};
    n.pass = n.pass || s.pass || envPass(role);
    out.nodes[role] = n;
  }
  return out;
}

/** Never send secrets back to the browser. */
function redact(cfg) {
  const out = JSON.parse(JSON.stringify(cfg));
  if (out.esxi) { out.esxi.passSet = !!out.esxi.pass; delete out.esxi.pass; }
  for (const role of Object.keys(out.nodes || {})) {
    out.nodes[role].passSet = !!out.nodes[role].pass;
    delete out.nodes[role].pass;
  }
  return out;
}

function remember(cfg) {
  try {
    const p = loadProfiles();
    p[DEFAULT_PROFILE] = cfg;
    saveProfiles(p);
  } catch (e) {
    console.error("could not persist the form:", e.message);
  }
}

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".json": "application/json", ".svg": "image/svg+xml" };

function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end("not found"); return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  res.end(fs.readFileSync(file));
}

/* ----------------------------------------------------------------- routes */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (req.method === "GET" && url.pathname === "/api/status") {
      return json(res, 200, { running, status: engine.getStatus() });
    }

    if (req.method === "GET" && url.pathname === "/api/defaults") {
      const saved = loadProfiles()[DEFAULT_PROFILE] || {};
      return json(res, 200, { ok: true, config: redact(saved), profiles: profileNames() });
    }

    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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
      return undefined;
    }

    // step 1: log in to the ESXi host and read its virtual networking
    if (req.method === "POST" && url.pathname === "/api/esxi/inventory") {
      const b = mergeSecrets({ esxi: (await readBody(req)).esxi || {} });
      const e = b.esxi;
      if (!isValidHost(e.host)) return json(res, 400, { ok: false, error: "ESXi host IP or hostname required" });
      if (!e.user) return json(res, 400, { ok: false, error: "username required (usually root)" });
      if (!e.pass && !e.key) return json(res, 400, { ok: false, error: "password or key path required" });
      try {
        const inv = await engine.esxiInventory(
          { host: e.host, user: e.user, pass: e.pass || null, keyPath: e.key || null });
        return json(res, 200, inv);
      } catch (err) {
        return json(res, 502, { ok: false, error: err.message });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/diagnose") {
      if (running) return json(res, 409, { ok: false, errors: { _global: "a diagnosis is already running" } });
      const cfg = mergeSecrets(await readBody(req));
      remember(cfg);
      const check = engine.validateConfig(cfg);
      if (!check.ok) return json(res, 400, { ok: false, errors: check.errors });
      running = true;
      json(res, 200, { ok: true });
      engine
        .runDiagnosis(cfg)
        .catch(() => { /* already reported through the status/log stream */ })
        .finally(() => {
          running = false;
          engine.bus.emit("status", engine.getStatus());
        });
      return undefined;
    }

    if (req.method === "POST" && url.pathname === "/api/abort") {
      if (!running) return json(res, 409, { ok: false, error: "nothing is running" });
      engine.requestAbort();
      return json(res, 200, { ok: true });
    }

    if (url.pathname === "/api/profiles") {
      const profiles = loadProfiles();
      if (req.method === "GET") {
        const name = url.searchParams.get("name");
        if (name) {
          if (!profiles[name]) return json(res, 404, { ok: false, error: "no such profile" });
          return json(res, 200, { ok: true, config: redact(profiles[name]) });
        }
        return json(res, 200, { ok: true, names: profileNames() });
      }
      if (req.method === "POST") {
        const b = await readBody(req);
        if (!b.name || !/^[\w .-]{1,60}$/.test(b.name)) {
          return json(res, 400, { ok: false, error: "profile name: letters/digits/space/._- (max 60)" });
        }
        profiles[b.name] = mergeSecrets(b.config || {});
        saveProfiles(profiles);
        return json(res, 200, { ok: true, names: profileNames() });
      }
      if (req.method === "DELETE") {
        delete profiles[url.searchParams.get("name")];
        saveProfiles(profiles);
        return json(res, 200, { ok: true, names: profileNames() });
      }
    }

    // the generated HTML report, served from the reports directory
    if (req.method === "GET" && url.pathname === "/report") {
      const file = url.searchParams.get("file") || (engine.getStatus() || {}).reportPath;
      if (!file) { res.writeHead(404); return res.end("no report yet"); }
      try {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(engine.readReport(file));
      } catch (e) {
        res.writeHead(404); return res.end(`report unavailable: ${e.message}`);
      }
    }

    if (req.method === "GET") return serveStatic(res, url.pathname);

    res.writeHead(404);
    res.end("not found");
  } catch (e) {
    json(res, 500, { ok: false, error: e.message });
  }
  return undefined;
});

server.listen(PORT, HOST, () => {
  console.log(`Testbed troubleshooter → http://${HOST}:${PORT}`);
  console.log(`Reports are written to ${engine.REPORT_DIR}`);
});
