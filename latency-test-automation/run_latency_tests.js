#!/usr/bin/env node
/**
 * Automated netem impairment validation — latency and/or packet-loss modes.
 *
 * Drives the netem web UI (Playwright) to configure link impairments and
 * start traffic, VERIFIES traffic is actually flowing before starting the
 * clock, monitors the spoke's DMTS hourlog over SSH for link switches
 * (screenshotting the UI at every stage), collects DMTS logs + Grid Diag
 * Packs from both Hub and Spoke after each test case, writes everything into
 * a per-TC folder tree, generates summary.md / summary.json / report.html,
 * and (optionally) publishes results + screenshots to Confluence.
 *
 * Latency test cases (default 10 minutes each):
 *   TC1: Link1 = 0 ms          Link2 = 0 ms
 *   TC2: Link1 = 0 ms          Link2 = LEO (130 ms)
 *   TC3: Link1 = LEO (130 ms)  Link2 = MEO latency
 *   TC4: Link1 = MEO latency   Link2 = GEO latency
 *
 * Usage:
 *   npm install && npx playwright install chromium
 *   node run_latency_tests.js                 # interactive setup wizard
 *   node run_latency_tests.js --headed        # watch the browser live
 *   node run_latency_tests.js --non-interactive --traffic udp --tos 0xB8
 *   node ui_server.js                         # web UI with live progress
 *
 * The wizard prompts (with validation and env-var defaults) for:
 *   client IP, server IP, spoke/hub SSH IP + username + password-or-key,
 *   traffic type, ToS, duration, bandwidth, which test (TC1-4/all),
 *   and whether to upload to Confluence.
 *
 * CLI options:
 *   --mode latency|packet-loss|all   (default latency)
 *   --traffic tcp|udp   --tos VALUE   --tc N|all   --duration SECONDS
 *   --client IP         --server IP   --bandwidth 10M
 *   --headless | --headed (default headless; HEADLESS=false env also works)
 *   --no-confluence
 *   --non-interactive   (no prompts; everything from flags + env)
 *
 * Environment variables (used as wizard defaults; never hardcode secrets):
 *   NETEM_UI_URL, CLIENT_IP, SERVER_IP
 *   SPOKE_HOST (default 172.16.226.113), SPOKE_USER (default espace),
 *   SPOKE_PASS or SPOKE_KEY (path to private key) — same for HUB_*
 *   MEO_LATENCY_MS (default 325), GEO_LATENCY_MS (default 560)   TODO: confirm
 *   LOSS_LOW_PCT / LOSS_MED_PCT / LOSS_HIGH_PCT   defaults 1 / 3 / 5
 *   TRAFFIC_MIN_BPS (default 10000), TRAFFIC_BANDWIDTH
 *   GRID_UI_URL_SPOKE / GRID_UI_URL_HUB, GRID_VERSION_CMD, TOPOLOGY
 *   CONF_EMAIL, CONF_TOKEN, CONF_BASE, CONF_PAGE_ID or CONF_SPACE [+CONF_PARENT_ID]
 */

"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { EventEmitter } = require("events");
const { Client } = require("ssh2");
const { chromium } = require("playwright");

/* ========================================================================= *
 * FILL-IN TODOs — things this script cannot know by itself
 * ========================================================================= */

// TODO(1): netem UI selectors. configureNetemViaUi() / startTrafficViaUi() /
// stopTrafficViaUi() contain placeholder selectors that MUST be adapted to
// the actual netem-ui panel (repo: mahadurgap-del/netem-ui). Run --headed to
// watch and fix them.

// TODO(2): Grid Diag Pack generation.
//   Preferred: set GRID_UI_URL_SPOKE / GRID_UI_URL_HUB and fix the selectors
//   in generateDiagPackViaUi().
//   Fallback: fill in the SSH command + output glob below.
const DIAG_PACK_CMD = "TODO: grid diag pack generation command";
const DIAG_PACK_GLOB = "/tmp/grid_diag_*.tar.gz"; // TODO: confirm output path

const DMTS_LOG_DIR = "/var/log/dmts";
const HOURLOG_DIR = `${DMTS_LOG_DIR}/hourLog`;
const LEO_MS = 130;

/* ========================================================================= *
 * Event bus + live status (consumed by the web UI's SSE stream)
 * ========================================================================= */

const bus = new EventEmitter();
bus.setMaxListeners(50);

const status = {
  phase: "idle",          // idle | preflight | running | publishing | done | error
  mode: null,
  currentCase: null,
  caseIndex: 0,
  caseCount: 0,
  caseStartedAt: null,
  netem: null,
  trafficVerified: null,
  switchObserved: null,
  lastSwitch: null,
  collection: {},          // {spoke: "...", hub: "..."}
  confluence: "pending",
  results: [],
  error: null,
};

function setStatus(partial) {
  Object.assign(status, partial);
  bus.emit("status", { ...status, collection: { ...status.collection } });
}

function getStatus() {
  return { ...status, collection: { ...status.collection } };
}

/* ========================================================================= *
 * Logging + retry
 * ========================================================================= */

const LOG_FILE = path.join(process.cwd(), "latency_test_run.log");

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch { /* read-only cwd */ }
  bus.emit("log", line);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, { attempts = 3, delayMs = 3000, label = "operation" } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
      if (i < attempts) {
        log(`WARN: ${label} failed (attempt ${i}/${attempts}): ${e.message} — retrying in ${(delayMs * i) / 1000}s`);
        await sleep(delayMs * i);
      }
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${lastErr.message}`);
}

/* ========================================================================= *
 * Input validators (shared by the CLI wizard and the web UI)
 * ========================================================================= */

function isValidIp(s) {
  const parts = String(s).trim().split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** Accepts "0xB8" or decimal 0-255; returns normalized string or null. */
function parseTos(s) {
  const t = String(s).trim();
  let n;
  if (/^0x[0-9a-f]{1,2}$/i.test(t)) n = parseInt(t, 16);
  else if (/^\d{1,3}$/.test(t)) n = parseInt(t, 10);
  else return null;
  if (n < 0 || n > 255) return null;
  return "0x" + n.toString(16).toUpperCase().padStart(2, "0");
}

/** "" -> null (unset); "10M"/"500K"/"1G"/"5000000" ok. */
function parseBandwidth(s) {
  const t = String(s ?? "").trim();
  if (!t) return { ok: true, value: null };
  if (/^\d+(\.\d+)?[KMG]?$/i.test(t)) return { ok: true, value: t.toUpperCase() };
  return { ok: false, value: null };
}

function parseDuration(s) {
  const n = parseInt(String(s).trim(), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** "1".."4", "tc1".."tc4", "all" -> 1-4 or "all"; null if invalid. */
function parseTcChoice(s) {
  const t = String(s).trim().toLowerCase();
  if (t === "all" || t === "") return "all";
  const m = t.match(/^(?:tc)?([1-4])$/);
  return m ? parseInt(m[1], 10) : null;
}

function parsePort(s) {
  const t = String(s ?? "").trim();
  if (!t) return { ok: true, value: null };
  const n = parseInt(t, 10);
  return Number.isInteger(n) && n >= 1 && n <= 65535
    ? { ok: true, value: n } : { ok: false, value: null };
}

function parsePosInt(s, { optional = false } = {}) {
  const t = String(s ?? "").trim();
  if (!t && optional) return { ok: true, value: null };
  const n = parseInt(t, 10);
  return Number.isInteger(n) && n > 0 ? { ok: true, value: n } : { ok: false, value: null };
}

/** Validate a full parameter set; returns {ok, errors: {field: msg}}. */
function validateParams(p) {
  const errors = {};
  if (!p.netemUiUrl || !/^https?:\/\//.test(p.netemUiUrl)) errors.netemUiUrl = "netem UI URL must start with http(s)://";
  if (!["ssh", "netem-ui"].includes(p.trafficDriver)) errors.trafficDriver = "ssh | netem-ui";
  if (!["iperf3", "scapy", "tcpreplay", "custom"].includes(p.trafficTool)) errors.trafficTool = "iperf3 | scapy | tcpreplay | custom";

  const sshDriver = p.trafficDriver === "ssh";
  if (sshDriver || p.clientIp) {
    if (!isValidIp(p.clientIp)) errors.clientIp = "invalid IPv4 address";
  }
  if (sshDriver || p.serverIp) {
    if (!isValidIp(p.serverIp)) errors.serverIp = "invalid IPv4 address";
  }
  if (sshDriver) {
    if (!p.clientUser) errors.clientUser = "required";
    if (!p.serverUser) errors.serverUser = "required";
    if (!p.clientPass && !p.clientKey) errors.clientAuth = "password or key path required";
    if (!p.serverPass && !p.serverKey) errors.serverAuth = "password or key path required";
    if (p.trafficTool === "custom" && !String(p.clientCmd ?? "").trim())
      errors.clientCmd = "custom tool requires a client command";
  }
  if (p.clientKey && !fs.existsSync(p.clientKey)) errors.clientKey = `key file not found: ${p.clientKey}`;
  if (p.serverKey && !fs.existsSync(p.serverKey)) errors.serverKey = `key file not found: ${p.serverKey}`;
  if (p.clientBindIp && !isValidIp(p.clientBindIp)) errors.clientBindIp = "invalid IPv4 address";

  if (!parsePort(p.clientPort).ok) errors.clientPort = "port 1-65535 or empty";
  if (!parsePort(p.serverPort).ok) errors.serverPort = "port 1-65535 or empty";
  if (!parsePosInt(p.parallelStreams, { optional: true }).ok) errors.parallelStreams = "positive integer or empty";
  if (!parsePosInt(p.packetSize, { optional: true }).ok) errors.packetSize = "bytes (positive integer) or empty";

  if (!isValidIp(p.spokeHost)) errors.spokeHost = "invalid IPv4 address";
  if (!isValidIp(p.hubHost)) errors.hubHost = "invalid IPv4 address";
  if (!p.spokeUser) errors.spokeUser = "required";
  if (!p.hubUser) errors.hubUser = "required";
  if (!p.spokePass && !p.spokeKey) errors.spokeAuth = "password or key path required";
  if (!p.hubPass && !p.hubKey) errors.hubAuth = "password or key path required";
  if (p.spokeKey && !fs.existsSync(p.spokeKey)) errors.spokeKey = `key file not found: ${p.spokeKey}`;
  if (p.hubKey && !fs.existsSync(p.hubKey)) errors.hubKey = `key file not found: ${p.hubKey}`;
  if (!["TCP", "UDP"].includes(String(p.trafficType).toUpperCase())) errors.trafficType = "must be TCP or UDP";
  if (!["upstream", "downstream"].includes(String(p.trafficDirection).toLowerCase()))
    errors.trafficDirection = "upstream | downstream";
  if (["packet-loss", "all"].includes(p.mode)) {
    if (!isValidIp(p.netemHost)) errors.netemHost = "invalid IPv4 address";
    if (!p.netemUser) errors.netemUser = "required";
    if (!p.netemPass && !p.netemKey) errors.netemAuth = "password or key path required";
    if (p.netemKey && !fs.existsSync(p.netemKey)) errors.netemKey = `key file not found: ${p.netemKey}`;
    for (const f of ["rampStepPct", "rampIntervalSec", "burstIntervalSec", "burstDurationSec",
                     "burstLossPct", "randomLossPct"]) {
      if (!parsePosInt(p[f]).ok) errors[f] = "positive integer required";
    }
  }
  if (!parseTos(p.tos)) errors.tos = "must be 0xNN hex or decimal 0-255";
  if (!parseDuration(p.durationSec)) errors.durationSec = "must be a positive integer (seconds)";
  if (!parseBandwidth(p.bandwidth).ok) errors.bandwidth = "e.g. 10M, 500K, 1G, or empty";
  if (parseTcChoice(p.tcChoice) === null) errors.tcChoice = "must be TC1-TC4 or all";
  if (!["latency", "packet-loss", "all"].includes(p.mode)) errors.mode = "latency | packet-loss | all";
  return { ok: Object.keys(errors).length === 0, errors };
}

/* ========================================================================= *
 * Config
 * ========================================================================= */

function envOr(name, dflt) {
  return process.env[name] ?? dflt;
}

/** Build the runtime config from a validated parameter set. */
function buildConfig(p) {
  const creds = (host, user, pass, key) => ({
    host, user,
    pass: pass || null,
    keyPath: key || null,
  });
  return {
    netemUiUrl: p.netemUiUrl,
    clientIp: p.clientIp || null,
    serverIp: p.serverIp || null,
    trafficDriver: p.trafficDriver,
    clientSsh: p.clientIp ? creds(p.clientIp, p.clientUser, p.clientPass, p.clientKey) : null,
    serverSsh: p.serverIp ? creds(p.serverIp, p.serverUser, p.serverPass, p.serverKey) : null,
    clientIface: p.clientIface || null,
    serverIface: p.serverIface || null,
    spoke: creds(p.spokeHost, p.spokeUser, p.spokePass, p.spokeKey),
    hub: creds(p.hubHost, p.hubUser, p.hubPass, p.hubKey),
    netemSsh: creds(p.netemHost, p.netemUser, p.netemPass, p.netemKey),
    netemCandidates: String(p.netemCandidates || "").split(",").map((s) => s.trim()).filter(Boolean),
    netemExclude: String(p.netemExclude || "").split(",").map((s) => s.trim()).filter(Boolean),
    plSchedule: {
      rampStepPct: parseInt(p.rampStepPct, 10) || 2,
      rampIntervalSec: parseInt(p.rampIntervalSec, 10) || 60,
      burstIntervalSec: parseInt(p.burstIntervalSec, 10) || 30,
      burstDurationSec: parseInt(p.burstDurationSec, 10) || 7,
      burstLossPct: parseInt(p.burstLossPct, 10) || 5,
      randomLossPct: parseInt(p.randomLossPct, 10) || 5,
      randomMinGapSec: parseInt(p.randomMinGapSec, 10) || 20,
      randomMaxGapSec: parseInt(p.randomMaxGapSec, 10) || 60,
      randomMinDurSec: parseInt(p.randomMinDurSec, 10) || 5,
      randomMaxDurSec: parseInt(p.randomMaxDurSec, 10) || 15,
    },
    meoMs: parseInt(envOr("MEO_LATENCY_MS", "325"), 10),
    geoMs: parseInt(envOr("GEO_LATENCY_MS", "560"), 10),
    lossLow: parseFloat(envOr("LOSS_LOW_PCT", "1")),
    lossMed: parseFloat(envOr("LOSS_MED_PCT", "3")),
    lossHigh: parseFloat(envOr("LOSS_HIGH_PCT", "5")),
    trafficMinBps: parseInt(envOr("TRAFFIC_MIN_BPS", "10000"), 10),
    gridUiSpoke: envOr("GRID_UI_URL_SPOKE", null),
    gridUiHub: envOr("GRID_UI_URL_HUB", null),
    gridVersionCmd: envOr("GRID_VERSION_CMD", null),
    topology: envOr("TOPOLOGY", "(not specified)"),
    headless: p.headless,
    confluence: p.confluence
      ? {
          email: p.confEmail,
          token: p.confToken,
          base: (p.confBase || "https://espacenetworks.atlassian.net").replace(/\/+$/, ""),
          pageId: p.confPageId || null,
          space: p.confSpace || null,
          parentId: p.confParentId || null,
        }
      : null,
  };
}

/** Default parameter set from env vars (wizard/web-UI prefill). */
function paramsFromEnv() {
  return {
    netemUiUrl: envOr("NETEM_UI_URL", "http://172.16.226.199:8080"),
    // traffic endpoints
    clientIp: envOr("CLIENT_IP", ""),
    serverIp: envOr("SERVER_IP", ""),
    clientPort: envOr("CLIENT_PORT", ""),
    serverPort: envOr("SERVER_PORT", "5001"),
    // traffic generation
    trafficDriver: envOr("TRAFFIC_DRIVER", "ssh"), // ssh | netem-ui
    trafficTool: envOr("TRAFFIC_TOOL", "iperf3"),  // iperf3 | scapy | tcpreplay | custom
    trafficType: "UDP",
    trafficDirection: envOr("TRAFFIC_DIRECTION", "upstream"), // upstream | downstream (-R)
    tos: "0xB8",
    durationSec: 600,
    bandwidth: envOr("TRAFFIC_BANDWIDTH", ""),
    parallelStreams: envOr("PARALLEL_STREAMS", "1"),
    packetSize: envOr("PACKET_SIZE", ""),
    serverCmd: "",   // advanced override — empty = auto-generate
    clientCmd: "",   // advanced override — empty = auto-generate
    // netem VM SSH (dynamic packet-loss impairment via tc + active-link detection)
    netemHost: envOr("NETEM_HOST", "172.16.226.199"),
    netemUser: envOr("NETEM_USER", "espace"),
    netemPass: envOr("NETEM_PASS", ""),
    netemKey: envOr("NETEM_KEY", ""),
    // restrict active-link detection to the overlay link interfaces (csv, e.g.
    // "ens192,ens193"); empty = consider all non-lo, non-bridge interfaces
    netemCandidates: envOr("NETEM_CANDIDATE_IFACES", ""),
    netemExclude: envOr("NETEM_EXCLUDE_IFACES", ""),
    // packet-loss schedules
    rampStepPct: envOr("PL_RAMP_STEP_PCT", "2"),        // TC1: +2% ...
    rampIntervalSec: envOr("PL_RAMP_INTERVAL_SEC", "60"), // ...every 60 s
    burstIntervalSec: envOr("PL_BURST_INTERVAL_SEC", "30"),
    burstDurationSec: envOr("PL_BURST_DURATION_SEC", "7"),
    burstLossPct: envOr("PL_BURST_LOSS_PCT", "5"),
    randomLossPct: envOr("PL_RANDOM_LOSS_PCT", "5"),
    randomMinGapSec: envOr("PL_RANDOM_MIN_GAP_SEC", "20"),
    randomMaxGapSec: envOr("PL_RANDOM_MAX_GAP_SEC", "60"),
    randomMinDurSec: envOr("PL_RANDOM_MIN_DUR_SEC", "5"),
    randomMaxDurSec: envOr("PL_RANDOM_MAX_DUR_SEC", "15"),
    // interface selection (iface name; bind IP discovered from the iface)
    clientIface: envOr("CLIENT_IFACE", ""),
    clientBindIp: envOr("CLIENT_BIND_IP", ""),
    serverIface: envOr("SERVER_IFACE", ""),
    // SSH details
    clientUser: envOr("CLIENT_USER", "espace"),
    clientPass: envOr("CLIENT_PASS", ""),
    clientKey: envOr("CLIENT_KEY", ""),
    serverUser: envOr("SERVER_USER", "espace"),
    serverPass: envOr("SERVER_PASS", ""),
    serverKey: envOr("SERVER_KEY", ""),
    spokeHost: envOr("SPOKE_HOST", "172.16.226.113"),
    spokeUser: envOr("SPOKE_USER", "espace"),
    spokePass: envOr("SPOKE_PASS", ""),
    spokeKey: envOr("SPOKE_KEY", ""),
    hubHost: envOr("HUB_HOST", ""),
    hubUser: envOr("HUB_USER", "espace"),
    hubPass: envOr("HUB_PASS", ""),
    hubKey: envOr("HUB_KEY", ""),
    // test selection
    tcChoice: "all",
    mode: "latency",
    headless: (envOr("HEADLESS", "true")) !== "false",
    confluence: true,
    confEmail: envOr("CONF_EMAIL", ""),
    confToken: envOr("CONF_TOKEN", ""),
    confBase: envOr("CONF_BASE", "https://espacenetworks.atlassian.net"),
    confPageId: envOr("CONF_PAGE_ID", ""),
    confSpace: envOr("CONF_SPACE", ""),
    confParentId: envOr("CONF_PARENT_ID", ""),
  };
}

/**
 * Test cases for a mode. Each link impairment is {delayMs, lossPct}.
 */
function buildTestCases(cfg, mode = "latency") {
  const L = (delayMs) => ({ delayMs, lossPct: 0 });
  const P = (lossPct) => ({ delayMs: 0, lossPct });
  if (mode === "latency") {
    return [
      { n: 1, name: "TC1_0ms_0ms", mode, link1: L(0),         link2: L(0),          expectSwitch: false },
      { n: 2, name: "TC2_0ms_LEO", mode, link1: L(0),         link2: L(LEO_MS),     expectSwitch: true },
      { n: 3, name: "TC3_LEO_MEO", mode, link1: L(LEO_MS),    link2: L(cfg.meoMs),  expectSwitch: true },
      { n: 4, name: "TC4_MEO_GEO", mode, link1: L(cfg.meoMs), link2: L(cfg.geoMs),  expectSwitch: true },
      // TODO: confirm expectSwitch flags — whether a switch is expected
      // depends on which link traffic starts on.
    ];
  }
  if (mode === "packet-loss") {
    // Dynamic cases: traffic starts FIRST, the active link is auto-detected
    // from live netem VM counters, and loss is applied only on that link.
    const s = cfg.plSchedule ?? {};
    const none = { delayMs: 0, lossPct: 0 }; // impairment is applied at runtime
    return [
      { n: 1, name: "PL_TC1_Constant", mode, plType: "constant", link1: none, link2: none,
        expectSwitch: true,
        describe: `+${s.rampStepPct ?? 2}% loss every ${s.rampIntervalSec ?? 60}s on the active link` },
      { n: 2, name: "PL_TC2_Burst", mode, plType: "burst", link1: none, link2: none,
        expectSwitch: true,
        describe: `${s.burstLossPct ?? 5}% loss bursts of ${s.burstDurationSec ?? 7}s every ${s.burstIntervalSec ?? 30}s` },
      { n: 3, name: "PL_TC3_Random", mode, plType: "random", link1: none, link2: none,
        expectSwitch: true,
        describe: `${s.randomLossPct ?? 5}% loss at random intervals for random durations` },
      // TODO: confirm expectSwitch per case against the pass criteria.
    ];
  }
  throw new Error(`unknown mode: ${mode}`);
}

function describeLink(l) {
  const parts = [];
  if (l.delayMs) parts.push(`${l.delayMs} ms`);
  if (l.lossPct) parts.push(`${l.lossPct}% loss`);
  return parts.join(" + ") || "clean";
}

/* ========================================================================= *
 * SSH helpers (ssh2) — password or private-key auth
 * ========================================================================= */

function sshConnectOnce({ host, user, pass, keyPath }) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const opts = {
      host,
      username: user,
      readyTimeout: 30000,
      // spoke/hub are lab VMs — accept whatever host key they present
      hostVerifier: () => true,
    };
    if (keyPath) opts.privateKey = fs.readFileSync(keyPath);
    else opts.password = pass;
    conn
      .on("ready", () => resolve(conn))
      .on("error", (err) => reject(new Error(`SSH ${user}@${host}: ${err.message}`)))
      .connect(opts);
  });
}

function sshConnect(creds) {
  return withRetry(() => sshConnectOnce(creds), { label: `SSH connect ${creds.host}` });
}

function sshExec(conn, command, { sudoPass = null, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    conn.exec(command, { pty: !!sudoPass }, (err, stream) => {
      if (err) return reject(err);
      let stdout = "";
      let stderr = "";
      let fedPassword = false;
      const timer = setTimeout(() => {
        stream.close();
        reject(new Error(`ssh command timed out after ${timeoutMs} ms: ${command}`));
      }, timeoutMs);
      stream
        .on("close", (code) => {
          clearTimeout(timer);
          resolve({ code: code ?? 0, stdout, stderr });
        })
        .on("data", (data) => {
          stdout += data.toString();
          if (sudoPass && !fedPassword && /\[sudo\] password|password for/i.test(stdout)) {
            stream.write(sudoPass + "\n");
            fedPassword = true;
          }
        })
        .stderr.on("data", (data) => (stderr += data.toString()));
    });
  });
}

/** sudo wrapper. With key-based auth we assume passwordless sudo (NOPASSWD);
 *  with password auth the password is fed to the sudo prompt. */
async function sudoExec(conn, creds, command, opts = {}) {
  if (creds.pass) {
    return sshExec(conn, `sudo -S -p '[sudo] password:' ${command}`, { ...opts, sudoPass: creds.pass });
  }
  return sshExec(conn, `sudo ${command}`, opts);
}

function sftpGet(conn, remotePath, localPath) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.fastGet(remotePath, localPath, (err2) => {
        sftp.end();
        if (err2) return reject(new Error(`sftp get ${remotePath}: ${err2.message}`));
        resolve(localPath);
      });
    });
  });
}

/* ========================================================================= *
 * Pre-flight checks — validate connectivity before any test starts
 * ========================================================================= */

async function preflight(cfg) {
  setStatus({ phase: "preflight" });
  log("pre-flight: checking netem UI reachability");
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const resp = await fetch(cfg.netemUiUrl, { signal: ctrl.signal });
    clearTimeout(t);
    log(`pre-flight: netem UI responded HTTP ${resp.status}`);
  } catch (e) {
    throw new Error(`netem UI unreachable at ${cfg.netemUiUrl}: ${e.message}`);
  }

  const sshChecks = [["spoke", cfg.spoke], ["hub", cfg.hub]];
  if (cfg.trafficDriver === "ssh") {
    if (cfg.clientSsh) sshChecks.push(["client", cfg.clientSsh]);
    if (cfg.serverSsh) sshChecks.push(["server", cfg.serverSsh]);
  }
  for (const [label, creds] of sshChecks) {
    log(`pre-flight: SSH check ${label} (${creds.user}@${creds.host})`);
    const conn = await sshConnect(creds);
    try {
      const { code } = await sshExec(conn, "echo ok", { timeoutMs: 15000 });
      if (code !== 0) throw new Error(`echo returned rc=${code}`);
      log(`pre-flight: ${label} SSH OK`);
    } finally {
      conn.end();
    }
  }

  if (cfg.confluence) {
    log("pre-flight: Confluence auth check");
    const url = cfg.confluence.pageId
      ? `${cfg.confluence.base}/wiki/rest/api/content/${cfg.confluence.pageId}`
      : `${cfg.confluence.base}/wiki/rest/api/space/${cfg.confluence.space}`;
    const resp = await fetch(url, {
      headers: { Authorization: confAuthHeader(cfg.confluence) },
    });
    if (!resp.ok) {
      throw new Error(`Confluence check failed: HTTP ${resp.status} on ${url}`);
    }
    log("pre-flight: Confluence OK");
  }
  log("pre-flight: all checks passed");
}

/* ========================================================================= *
 * DMTS hourlog parsing + link-switch monitoring
 * ========================================================================= */

function lastCompleteRecord(text, maxAttempts = 5000) {
  const starts = [];
  for (let i = 0; i < text.length; i++) if (text[i] === "{") starts.push(i);
  const candidates = starts.slice(-maxAttempts).reverse();
  for (const start of candidates) {
    const end = findBalancedEnd(text, start);
    if (end === -1) continue;
    let rec;
    try {
      rec = JSON.parse(text.slice(start, end));
    } catch {
      continue;
    }
    if (rec && typeof rec === "object" && !Array.isArray(rec) && "scores" in rec) return rec;
  }
  return null;
}

function findBalancedEnd(text, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function activeTc(record) {
  const perTc = record?.scores?.per_tc ?? {};
  for (const [name, tc] of Object.entries(perTc)) {
    if (name === "__internal_hp__" || !tc || typeof tc !== "object") continue;
    const qoe = tc.qoe;
    if (qoe === null || qoe === undefined) continue;
    if (["IDLE", "NOREF"].includes(String(qoe).toUpperCase())) continue;
    return { name, tc };
  }
  return null;
}

function linkStats(record, linkId) {
  let channels = record?.channels ?? [];
  if (!Array.isArray(channels)) channels = Object.values(channels);
  for (const ch of channels) {
    if (ch && typeof ch === "object" && ch.link_id === linkId) {
      return { latency95P: ch.latency95P ?? null, packetLoss95P: ch.packetLoss95P ?? null };
    }
  }
  return { latency95P: null, packetLoss95P: null };
}

async function newestHourlogFile(conn) {
  const { stdout } = await sshExec(conn, `ls -t ${HOURLOG_DIR}/*.txt 2>/dev/null | head -1`);
  return stdout.trim() || null;
}

async function monitorLinkSwitches(conn, durationMs, onSwitch) {
  const deadline = Date.now() + durationMs;
  const switches = [];
  let prevLink = null;
  let prevRecord = null;
  let file = await newestHourlogFile(conn);
  log(`monitoring hourlog ${file ?? "(none yet)"} for ${Math.round(durationMs / 1000)}s`);

  while (Date.now() < deadline) {
    try {
      const current = await newestHourlogFile(conn);
      if (current && current !== file) {
        log(`hourlog rolled over: ${file} -> ${current}`);
        file = current;
      }
      if (!file) {
        await sleep(2000);
        continue;
      }
      const { stdout: tail } = await sshExec(conn, `tail -c 262144 '${file}'`);
      const record = lastCompleteRecord(tail);
      const active = record ? activeTc(record) : null;
      const linkMap = active?.tc?.link_map ?? [];
      if (!record || !active || !linkMap.length) {
        await sleep(2000);
        continue;
      }
      const link = linkMap[0];
      if (prevLink === null) {
        prevLink = link;
        log(`active TC ${active.name} starts on link ${link}`);
      } else if (link !== prevLink) {
        let stats = linkStats(record, prevLink);
        if (stats.latency95P === null && prevRecord) stats = linkStats(prevRecord, prevLink);
        const sw = {
          tc: active.name,
          fromLink: prevLink,
          toLink: link,
          time: record.timestamp ?? record.time ?? record.ts ?? new Date().toISOString(),
          wallClock: new Date().toISOString(),
          fromLinkLatency95P: stats.latency95P,
          fromLinkPacketLoss95P: stats.packetLoss95P,
        };
        switches.push(sw);
        log(`LINK SWITCH: TC ${sw.tc} ${sw.fromLink} -> ${sw.toLink} at ${sw.time} ` +
            `(from-link latency95P=${sw.fromLinkLatency95P} ms, packetLoss95P=${sw.fromLinkPacketLoss95P} %)`);
        setStatus({ switchObserved: true, lastSwitch: sw });
        prevLink = link;
        if (onSwitch) {
          try {
            await onSwitch(sw, switches.length === 1);
          } catch (e) {
            log(`WARN: on-switch handler failed: ${e.message}`);
          }
        }
      }
      prevRecord = record;
    } catch (e) {
      log(`WARN: hourlog poll error: ${e.message}`);
    }
    await sleep(2000);
  }
  return switches;
}

/* ========================================================================= *
 * Traffic validation
 * ========================================================================= */

async function ifaceByteTotals(conn) {
  const { stdout } = await sshExec(conn, "cat /proc/net/dev");
  let total = 0;
  for (const line of stdout.split("\n")) {
    if (!line.includes(":")) continue;
    const [name, rest] = line.split(":", 2);
    if (name.trim() === "lo") continue;
    const f = rest.trim().split(/\s+/);
    if (f.length >= 9) total += parseInt(f[0], 10) + parseInt(f[8], 10);
  }
  return total;
}

async function verifyTrafficFlowing(cfg, { attempts = 4, sampleSeconds = 5 } = {}) {
  const conn = await sshConnect(cfg.spoke);
  try {
    const { stdout: procs } = await sshExec(
      conn, "pgrep -a 'iperf3|iperf|tcpkali|scapy|python' 2>/dev/null | head -10");
    if (procs.trim()) log(`traffic processes on spoke:\n${procs.trim()}`);

    for (let i = 1; i <= attempts; i++) {
      const before = await ifaceByteTotals(conn);
      await sleep(sampleSeconds * 1000);
      const after = await ifaceByteTotals(conn);
      const bps = (after - before) / sampleSeconds;
      log(`traffic check ${i}/${attempts}: ${Math.round(bps)} B/s aggregate on spoke ` +
          `(threshold ${cfg.trafficMinBps})`);
      if (bps >= cfg.trafficMinBps) {
        log("traffic confirmed flowing");
        setStatus({ trafficVerified: Math.round(bps) });
        return bps;
      }
    }
  } finally {
    conn.end();
  }
  throw new Error(
    `traffic is NOT flowing (below ${cfg.trafficMinBps} B/s after ${attempts} checks) — failing early`);
}

/* ========================================================================= *
 * Traffic generation over SSH (client/server machines) + interface discovery
 * ========================================================================= */

/** Parse `ip -o -4 addr show` output into [{iface, ip}] (lo excluded). */
function parseInterfaces(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    const m = line.match(/^\d+:\s+(\S+?)\s+inet\s+(\d+\.\d+\.\d+\.\d+)/);
    if (m && m[1] !== "lo") out.push({ iface: m[1], ip: m[2] });
  }
  return out;
}

/** SSH to a host and list its IPv4 interfaces (for the UI dropdowns). */
async function listRemoteInterfaces(creds) {
  const conn = await sshConnect(creds);
  try {
    const { stdout } = await sshExec(conn, "ip -o -4 addr show", { timeoutMs: 15000 });
    return parseInterfaces(stdout);
  } finally {
    conn.end();
  }
}

/**
 * Build the traffic server/client commands from the parameter set.
 * Non-empty p.serverCmd / p.clientCmd (Advanced overrides) win verbatim.
 * A serverCmd starting with "#" means "no server process needed".
 */
function buildTrafficCommands(p) {
  const override = (s) => String(s ?? "").trim();
  if (override(p.serverCmd) || override(p.clientCmd)) {
    return { serverCmd: override(p.serverCmd), clientCmd: override(p.clientCmd) };
  }
  const udp = String(p.trafficType).toUpperCase() === "UDP";
  const tos = parseTos(p.tos);
  const dur = parseDuration(p.durationSec);
  const sPort = parsePort(p.serverPort).value;
  const cPort = parsePort(p.clientPort).value;
  const streams = parsePosInt(p.parallelStreams, { optional: true }).value;
  const pktSize = parsePosInt(p.packetSize, { optional: true }).value;
  const bw = parseBandwidth(p.bandwidth).value;

  switch (p.trafficTool) {
    case "iperf3": {
      const serverCmd = `iperf3 -s${sPort ? ` -p ${sPort}` : ""}`;
      let c = `iperf3 -c ${p.serverIp}`;
      if (sPort) c += ` -p ${sPort}`;
      if (udp) c += " -u";
      if (String(p.trafficDirection).toLowerCase() === "downstream") c += " -R";
      if (bw) c += ` -b ${bw}`;
      c += ` -t ${dur}`;
      if (streams && streams > 1) c += ` -P ${streams}`;
      if (tos) c += ` -S ${tos}`;
      if (pktSize) c += ` -l ${pktSize}`;
      if (cPort) c += ` --cport ${cPort}`;
      if (p.clientBindIp) c += ` -B ${p.clientBindIp}`;
      return { serverCmd, clientCmd: c };
    }
    case "scapy":
      // TODO: point at your Scapy traffic script; requires passwordless sudo
      return {
        serverCmd: "# scapy needs no server process",
        clientCmd: `sudo python3 /path/to/scapy_traffic.py --iface ${p.clientIface || "IFACE"} ` +
          `--dst ${p.serverIp || "SERVER_IP"} --tos ${tos} --duration ${dur}` +
          (pktSize ? ` --size ${pktSize}` : ""),
      };
    case "tcpreplay":
      // TODO: point at your pcap file; requires passwordless sudo
      return {
        serverCmd: "# tcpreplay needs no server process",
        clientCmd: `sudo tcpreplay -i ${p.clientIface || "IFACE"} --loop 0 ` +
          `--duration ${dur} /path/to/traffic.pcap`,
      };
    case "custom":
      return { serverCmd: "", clientCmd: "" }; // must be supplied via Advanced
    default:
      throw new Error(`unknown traffic tool: ${p.trafficTool}`);
  }
}

/** First word of a command with sudo/nohup stripped — used for pkill fallback. */
function toolBinary(cmd) {
  const words = String(cmd).trim().split(/\s+/).filter((w) => !["sudo", "nohup"].includes(w));
  return words[0] || null;
}

/**
 * Start traffic by SSHing to the server (start listener) then the client
 * (start generator). Both run detached with output captured to /tmp logs.
 * Returns handles for stopTrafficViaSsh.
 */
async function startTrafficViaSsh(cfg, traffic) {
  const handles = { serverPid: null, clientPid: null };
  if (traffic.serverCmd && !traffic.serverCmd.startsWith("#")) {
    const conn = await sshConnect(cfg.serverSsh);
    try {
      // clear any stale listener from a previous run
      const bin = toolBinary(traffic.serverCmd);
      if (bin) await sshExec(conn, `pkill -x ${bin} 2>/dev/null; true`);
      const { stdout } = await sshExec(
        conn, `nohup ${traffic.serverCmd} >/tmp/sla_traffic_server.log 2>&1 & echo $!`);
      handles.serverPid = parseInt(stdout.trim(), 10) || null;
      log(`traffic server started on ${cfg.serverSsh.host} (pid ${handles.serverPid}): ${traffic.serverCmd}`);
    } finally {
      conn.end();
    }
    await sleep(1500);
  }
  const conn = await sshConnect(cfg.clientSsh);
  try {
    const { stdout } = await sshExec(
      conn, `nohup ${traffic.clientCmd} >/tmp/sla_traffic_client.log 2>&1 & echo $!`);
    handles.clientPid = parseInt(stdout.trim(), 10) || null;
    log(`traffic client started on ${cfg.clientSsh.host} (pid ${handles.clientPid}): ${traffic.clientCmd}`);
  } finally {
    conn.end();
  }
  return handles;
}

/** Stop SSH-driven traffic on both ends; downloads the tool logs into destDir. */
async function stopTrafficViaSsh(cfg, traffic, handles, destDir) {
  for (const [side, creds, pid, cmd, logName] of [
    ["client", cfg.clientSsh, handles?.clientPid, traffic.clientCmd, "sla_traffic_client.log"],
    ["server", cfg.serverSsh, handles?.serverPid, traffic.serverCmd, "sla_traffic_server.log"],
  ]) {
    if (!creds || !cmd || cmd.startsWith("#")) continue;
    try {
      const conn = await sshConnect(creds);
      try {
        const bin = toolBinary(cmd);
        await sshExec(conn,
          `${pid ? `kill ${pid} 2>/dev/null;` : ""}${bin ? ` pkill -x ${bin} 2>/dev/null;` : ""} true`);
        log(`traffic ${side} stopped on ${creds.host}`);
        if (destDir) {
          try {
            await sftpGet(conn, `/tmp/${logName}`, path.join(destDir, logName));
          } catch { /* log file may not exist */ }
        }
      } finally {
        conn.end();
      }
    } catch (e) {
      log(`WARN: stopping traffic ${side} failed: ${e.message}`);
    }
  }
}

/* ========================================================================= *
 * Netem VM: active-link detection + dynamic impairment via tc (SSH)
 * ========================================================================= */

/** Parse /proc/net/dev into {iface: {rxPkts, txPkts}}. */
function parsePacketCounters(text) {
  const out = {};
  for (const line of String(text).split("\n")) {
    if (!line.includes(":")) continue;
    const [name, rest] = line.split(":", 2);
    const f = rest.trim().split(/\s+/);
    if (f.length >= 10) {
      out[name.trim()] = { rxPkts: parseInt(f[1], 10), txPkts: parseInt(f[9], 10) };
    }
  }
  return out;
}

/**
 * Detect the interface carrying the test traffic on the netem VM: sample the
 * packet counters twice and rank by pps. cfg.netemCandidates (if set)
 * restricts the ranking to the overlay link interfaces (recommended —
 * NETEM_CANDIDATE_IFACES="ens192,ens193"); otherwise lo, bridges, and
 * cfg.netemExclude are skipped. Returns {iface, pps, table}.
 */
async function detectActiveLink(cfg, sampleSeconds = 3) {
  const conn = await sshConnect(cfg.netemSsh);
  try {
    const a = parsePacketCounters((await sshExec(conn, "cat /proc/net/dev")).stdout);
    await sleep(sampleSeconds * 1000);
    const b = parsePacketCounters((await sshExec(conn, "cat /proc/net/dev")).stdout);
    const table = [];
    for (const [iface, cb] of Object.entries(b)) {
      if (iface === "lo") continue;
      if (cfg.netemCandidates.length) {
        if (!cfg.netemCandidates.includes(iface)) continue;
      } else {
        if (iface.startsWith("br") || cfg.netemExclude.includes(iface)) continue;
      }
      const ca = a[iface] ?? { rxPkts: 0, txPkts: 0 };
      const pps = Math.round((cb.rxPkts - ca.rxPkts + cb.txPkts - ca.txPkts) / sampleSeconds);
      table.push({ iface, pps });
    }
    table.sort((x, y) => y.pps - x.pps);
    if (!table.length) throw new Error("no candidate interfaces found on the netem VM");
    for (const row of table.slice(0, 6)) log(`  ${row.iface.padEnd(12)} ${row.pps} pps`);
    const active = table[0];
    log(`active link on netem VM: ${active.iface} (${active.pps} pps)`);
    return { ...active, table };
  } finally {
    conn.end();
  }
}

/** Apply a netem impairment ({lossPct} and/or {delayMs}) to one interface. */
async function applyNetemImpairment(cfg, iface, spec) {
  const parts = [];
  if (spec.delayMs) parts.push(`delay ${spec.delayMs}ms`);
  if (spec.lossPct) parts.push(`loss ${spec.lossPct}%`);
  const conn = await sshConnect(cfg.netemSsh);
  try {
    const cmd = parts.length
      ? `tc qdisc replace dev ${iface} root netem ${parts.join(" ")}`
      : `tc qdisc del dev ${iface} root`;
    const r = await sudoExec(conn, cfg.netemSsh, cmd);
    if (r.code !== 0 && parts.length) {
      throw new Error(`tc failed on ${iface} (rc=${r.code}): ${(r.stderr || r.stdout).slice(0, 200)}`);
    }
    log(`netem ${iface}: ${parts.join(" ") || "cleared"}`);
  } finally {
    conn.end();
  }
}

async function clearNetemImpairment(cfg, iface) {
  const conn = await sshConnect(cfg.netemSsh);
  try {
    await sudoExec(conn, cfg.netemSsh, `tc qdisc del dev ${iface} root 2>/dev/null; true`);
    log(`netem ${iface}: cleared`);
  } finally {
    conn.end();
  }
}

/** Sleep, but never past the deadline. */
async function sleepWithin(deadline, ms) {
  const remain = deadline - Date.now();
  if (remain <= 0) return false;
  await sleep(Math.min(ms, remain));
  return Date.now() < deadline;
}

const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

/**
 * Run the packet-loss impairment schedule for one dynamic test case.
 * plType: "constant" (ramp +step% every interval on the initially-active
 * link), "burst" (loss for burstDuration every burstInterval on the
 * currently-active link), "random" (loss at random intervals for random
 * durations). Records every event via onEvent and returns the event list.
 */
async function runPacketLossSchedule(cfg, plType, durationMs, impairedIfaces, onEvent) {
  const s = cfg.plSchedule;
  const deadline = Date.now() + durationMs;
  const events = [];
  const note = (iface, event) => {
    const ev = { t: new Date().toISOString(), iface, event };
    events.push(ev);
    setStatus({ netem: `${event} on ${iface}` });
    log(`impairment: ${event} on ${iface}`);
    if (onEvent) onEvent(ev);
  };

  if (plType === "constant") {
    // The ramp stays on the initially-active link: traffic leaving it under
    // increasing loss (and possibly returning) is exactly what we measure.
    const { iface } = await detectActiveLink(cfg);
    let pct = 0;
    while (Date.now() < deadline) {
      pct += s.rampStepPct;
      await applyNetemImpairment(cfg, iface, { lossPct: pct });
      impairedIfaces.add(iface);
      note(iface, `loss ${pct}%`);
      if (!(await sleepWithin(deadline, s.rampIntervalSec * 1000))) break;
    }
  } else if (plType === "burst") {
    while (Date.now() < deadline) {
      const { iface } = await detectActiveLink(cfg);
      await applyNetemImpairment(cfg, iface, { lossPct: s.burstLossPct });
      impairedIfaces.add(iface);
      note(iface, `burst loss ${s.burstLossPct}%`);
      await sleepWithin(deadline, s.burstDurationSec * 1000);
      await clearNetemImpairment(cfg, iface);
      note(iface, "clear");
      if (!(await sleepWithin(deadline,
        Math.max(1, s.burstIntervalSec - s.burstDurationSec) * 1000))) break;
    }
  } else if (plType === "random") {
    while (Date.now() < deadline) {
      if (!(await sleepWithin(deadline,
        randInt(s.randomMinGapSec, s.randomMaxGapSec) * 1000))) break;
      const { iface } = await detectActiveLink(cfg);
      await applyNetemImpairment(cfg, iface, { lossPct: s.randomLossPct });
      impairedIfaces.add(iface);
      note(iface, `random loss ${s.randomLossPct}%`);
      await sleepWithin(deadline, randInt(s.randomMinDurSec, s.randomMaxDurSec) * 1000);
      await clearNetemImpairment(cfg, iface);
      note(iface, "clear");
    }
  } else {
    throw new Error(`unknown packet-loss type: ${plType}`);
  }
  return events;
}

/* ========================================================================= *
 * Playwright — drive the netem UI
 * TODO(1): every selector below is a PLACEHOLDER.
 * ========================================================================= */

async function openNetemUi(cfg) {
  const browser = await chromium.launch({ headless: cfg.headless });
  const page = await browser.newPage();
  log(`opening netem UI ${cfg.netemUiUrl}`);
  await withRetry(
    () => page.goto(cfg.netemUiUrl, { waitUntil: "networkidle", timeout: 30000 }),
    { label: "open netem UI" });
  return { browser, page };
}

async function configureNetemViaUi(page, tc) {
  log(`configuring netem: link1=${describeLink(tc.link1)}, link2=${describeLink(tc.link2)}`);
  await withRetry(async () => {
    // ---- TODO(1): replace with the real controls of netem-ui ----
    await page.fill('[data-testid="link1-latency"]', String(tc.link1.delayMs));
    await page.fill('[data-testid="link1-loss"]', String(tc.link1.lossPct));
    await page.fill('[data-testid="link2-latency"]', String(tc.link2.delayMs));
    await page.fill('[data-testid="link2-loss"]', String(tc.link2.lossPct));
    await page.click('[data-testid="apply-netem"]');
    await page.waitForSelector('[data-testid="netem-applied"]', { timeout: 15000 });
    // -------------------------------------------------------------
  }, { label: "apply netem via UI" });
  log("netem configuration applied");
}

async function startTrafficViaUi(page, cfg, traffic) {
  log(`starting traffic: type=${traffic.type}, ToS=${traffic.tos}` +
      (traffic.bandwidth ? `, bw=${traffic.bandwidth}` : "") +
      (cfg.clientIp ? `, client=${cfg.clientIp}` : "") +
      (cfg.serverIp ? `, server=${cfg.serverIp}` : ""));
  await withRetry(async () => {
    // ---- TODO(1): replace with the real controls of netem-ui ----
    if (cfg.clientIp) await page.fill('[data-testid="traffic-client-ip"]', cfg.clientIp);
    if (cfg.serverIp) await page.fill('[data-testid="traffic-server-ip"]', cfg.serverIp);
    await page.selectOption('[data-testid="traffic-type"]', traffic.type.toLowerCase());
    await page.fill('[data-testid="traffic-tos"]', String(traffic.tos));
    if (traffic.bandwidth) await page.fill('[data-testid="traffic-bandwidth"]', traffic.bandwidth);
    await page.click('[data-testid="start-traffic"]');
    await page.waitForSelector('[data-testid="traffic-running"]', { timeout: 30000 });
    // -------------------------------------------------------------
  }, { label: "start traffic via UI" });
  log("traffic running");
}

async function stopTrafficViaUi(page) {
  log("stopping traffic");
  await withRetry(async () => {
    // ---- TODO(1): replace with the real controls of netem-ui ----
    await page.click('[data-testid="stop-traffic"]');
    await page.waitForSelector('[data-testid="traffic-stopped"]', { timeout: 30000 });
    // -------------------------------------------------------------
  }, { label: "stop traffic via UI" });
  log("traffic stopped");
}

async function snap(page, tcDir, name) {
  try {
    const dir = path.join(tcDir, "screenshots");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    log(`screenshot: ${file}`);
    return file;
  } catch (e) {
    log(`WARN: screenshot ${name} failed: ${e.message}`);
    return null;
  }
}

/* ========================================================================= *
 * Grid Diag Pack — via the Grid UI button (preferred) or SSH (fallback)
 * ========================================================================= */

async function generateDiagPackViaUi(browser, gridUiUrl, destDir, label, tag) {
  log(`[${label}] generating diag pack via Grid UI ${gridUiUrl}`);
  const page = await browser.newPage();
  try {
    return await withRetry(async () => {
      await page.goto(gridUiUrl, { waitUntil: "networkidle", timeout: 30000 });
      // ---- TODO(2): replace with the real Grid UI controls ----
      const downloadPromise = page.waitForEvent("download", { timeout: 600000 });
      await page.click('button:has-text("Generate Diag Pack")');
      // ----------------------------------------------------------
      const download = await downloadPromise;
      const localPath = path.join(destDir, `${tag}_diagpack_${label}_${download.suggestedFilename()}`);
      await download.saveAs(localPath);
      log(`[${label}] diag pack downloaded via UI: ${localPath}`);
      return localPath;
    }, { label: `diag pack via UI (${label})`, attempts: 2 });
  } finally {
    await page.close();
  }
}

async function generateDiagPackViaSsh(creds, destDir, label, tag) {
  if (DIAG_PACK_CMD.startsWith("TODO")) {
    log(`[${label}] WARN: no GRID_UI_URL_* set and DIAG_PACK_CMD not filled in — skipping diag pack`);
    return null;
  }
  const conn = await sshConnect(creds);
  try {
    log(`[${label}] generating Grid Diag Pack over SSH`);
    const gen = await sudoExec(conn, creds, DIAG_PACK_CMD, { timeoutMs: 600000 });
    if (gen.code !== 0) throw new Error(`diag pack generation failed on ${label} (rc=${gen.code})`);
    const { stdout } = await sshExec(conn, `ls -t ${DIAG_PACK_GLOB} 2>/dev/null | head -1`);
    const remotePath = stdout.trim();
    if (!remotePath) throw new Error(`no diag pack matching ${DIAG_PACK_GLOB} on ${label}`);
    await sudoExec(conn, creds, `chown ${creds.user}:${creds.user} '${remotePath}'`);
    const localPath = path.join(destDir, `${tag}_diagpack_${label}_${path.basename(remotePath)}`);
    await sftpGet(conn, remotePath, localPath);
    log(`[${label}] diag pack saved: ${localPath}`);
    return localPath;
  } finally {
    conn.end();
  }
}

async function collectDiagPack(cfg, browser, label, destDir, tag) {
  const gridUiUrl = label === "spoke" ? cfg.gridUiSpoke : cfg.gridUiHub;
  const creds = label === "spoke" ? cfg.spoke : cfg.hub;
  if (gridUiUrl) return generateDiagPackViaUi(browser, gridUiUrl, destDir, label, tag);
  return generateDiagPackViaSsh(creds, destDir, label, tag);
}

/* ========================================================================= *
 * DMTS log collection (Hub + Spoke)
 * ========================================================================= */

const DMTS_COMPONENTS = ["hourLog", "curLog", "ubd"];

/**
 * Collect the COMPLETE DMTS archive plus the INDIVIDUAL components
 * (hourLog, curLog, ubd as per-directory tarballs, and ubdLatest.tar as-is)
 * from one host. Files are named `<tag>_<label>_...` so attachments stay
 * unique per test case on the Confluence page. Returns the list of local
 * paths that were actually collected.
 */
async function collectDmtsLogs(creds, destDir, label, tag) {
  const conn = await sshConnect(creds);
  const collected = [];
  const grab = async (remotePath, localName) => {
    await sudoExec(conn, creds, `chown ${creds.user}:${creds.user} '${remotePath}'`);
    const localPath = path.join(destDir, localName);
    await sftpGet(conn, remotePath, localPath);
    await sshExec(conn, `rm -f '${remotePath}'`);
    log(`[${label}] saved ${localName} (${fs.statSync(localPath).size} bytes)`);
    collected.push(localPath);
  };
  try {
    log(`[${label}] listing ${DMTS_LOG_DIR}`);
    const listing = await sudoExec(conn, creds, `ls -laht ${DMTS_LOG_DIR}/ | head -50`);
    const size = await sudoExec(conn, creds, `du -sh ${DMTS_LOG_DIR}/`);
    fs.writeFileSync(path.join(destDir, `dmts_dir_listing_${label}.txt`),
      listing.stdout + "\n" + size.stdout);

    // 1. complete archive (hourLog + curLog + ubd + ubdLatest.tar)
    log(`[${label}] archiving complete DMTS logs`);
    const fullRemote = `/tmp/dmts_full_${label}.tar.gz`;
    const tar = await sudoExec(
      conn, creds,
      `tar czf ${fullRemote} -C ${DMTS_LOG_DIR} hourLog curLog ubd ubdLatest.tar`,
      { timeoutMs: 300000 }
    );
    if (tar.code === 0) {
      await grab(fullRemote, `${tag}_${label}_dmts_full.tar.gz`);
    } else {
      log(`WARN: [${label}] complete archive failed (rc=${tar.code}): ` +
          `${(tar.stderr || tar.stdout).slice(0, 300)} — collecting components individually`);
    }

    // 2. individual components as separate tarballs
    for (const comp of DMTS_COMPONENTS) {
      const remote = `/tmp/dmts_${comp}_${label}.tar.gz`;
      const r = await sudoExec(conn, creds,
        `tar czf ${remote} -C ${DMTS_LOG_DIR} ${comp}`, { timeoutMs: 180000 });
      if (r.code !== 0) {
        log(`WARN: [${label}] ${comp} archive failed (rc=${r.code}) — skipping`);
        continue;
      }
      await grab(remote, `${tag}_${label}_${comp}.tar.gz`);
    }

    // 3. ubdLatest.tar as-is
    const ubdRemote = `/tmp/ubdLatest_${label}.tar`;
    const cp = await sudoExec(conn, creds, `cp ${DMTS_LOG_DIR}/ubdLatest.tar ${ubdRemote}`);
    if (cp.code === 0) await grab(ubdRemote, `${tag}_${label}_ubdLatest.tar`);
    else log(`WARN: [${label}] ubdLatest.tar not found — skipping`);

    if (!collected.length) throw new Error(`no DMTS logs could be collected from ${label}`);
    return collected;
  } finally {
    conn.end();
  }
}

async function collectHourlogSnapshot(creds, destDir, tag) {
  const conn = await sshConnect(creds);
  try {
    const remoteTar = `/tmp/dmts_hourlog_${tag}_$(hostname).tar.gz`;
    log(`snapshotting hourLog after switch (${tag})`);
    const tar = await sudoExec(conn, creds,
      `tar czf ${remoteTar} -C ${DMTS_LOG_DIR} hourLog`, { timeoutMs: 180000 });
    if (tar.code !== 0) throw new Error(`hourLog tar failed (rc=${tar.code})`);
    await sudoExec(conn, creds, `chown ${creds.user}:${creds.user} /tmp/dmts_hourlog_${tag}_*.tar.gz`);
    const { stdout } = await sshExec(conn, `ls -t /tmp/dmts_hourlog_${tag}_*.tar.gz | head -1`);
    const remotePath = stdout.trim();
    const localPath = path.join(destDir, path.basename(remotePath));
    await sftpGet(conn, remotePath, localPath);
    await sshExec(conn, `rm -f ${remotePath}`);
    log(`hourLog snapshot saved: ${localPath}`);
    return localPath;
  } finally {
    conn.end();
  }
}

/* ========================================================================= *
 * Run metadata
 * ========================================================================= */

async function collectRunMetadata(cfg, trafficType, tos) {
  let gridVersion = "(GRID_VERSION_CMD not set)";
  if (cfg.gridVersionCmd) {
    try {
      const conn = await sshConnect(cfg.spoke);
      try {
        const { stdout } = await sshExec(conn, cfg.gridVersionCmd);
        gridVersion = stdout.trim().split("\n")[0] || "(empty)";
      } finally {
        conn.end();
      }
    } catch (e) {
      gridVersion = `(failed: ${e.message})`;
    }
  }
  return {
    gridVersion,
    topology: cfg.topology,
    trafficType,
    tos,
    spokeHost: cfg.spoke.host,
    hubHost: cfg.hub.host,
    executedAt: new Date().toISOString(),
  };
}

/* ========================================================================= *
 * Per-test-case runner
 * ========================================================================= */

async function runTestCase(cfg, browser, page, tc, traffic, baseDir, durationMs) {
  const tcDir = path.join(baseDir, tc.name);
  const spokeDir = path.join(tcDir, "spoke");
  const hubDir = path.join(tcDir, "hub");
  for (const d of [tcDir, spokeDir, hubDir]) fs.mkdirSync(d, { recursive: true });

  log(`===== ${tc.name}: link1=${describeLink(tc.link1)}, link2=${describeLink(tc.link2)} =====`);
  setStatus({
    currentCase: tc.name,
    caseStartedAt: new Date().toISOString(),
    netem: `${describeLink(tc.link1)} / ${describeLink(tc.link2)}`,
    trafficVerified: null,
    switchObserved: false,
    lastSwitch: null,
    collection: {},
  });
  const result = {
    tc: tc.n,
    name: tc.name,
    mode: tc.mode,
    link1: tc.link1,
    link2: tc.link2,
    trafficType: traffic.type,
    tos: traffic.tos,
    startTime: new Date().toISOString(),
    endTime: null,
    trafficDriver: cfg.trafficDriver,
    direction: traffic.direction,
    plType: tc.plType || null,
    plDescribe: tc.describe || null,
    serverCmd: traffic.serverCmd || null,
    clientCmd: traffic.clientCmd || null,
    trafficVerifiedBps: null,
    impairments: [],
    switches: [],
    switchObserved: false,
    expectSwitch: tc.expectSwitch,
    artifacts: { spoke: [], hub: [] },
    screenshots: [],
    errors: [],
    result: "FAIL",
  };
  const shot = async (name) => {
    const p = await snap(page, tcDir, name);
    if (p) result.screenshots.push(p);
  };

  const isDynamicPL = !!tc.plType;
  await shot("01_before_netem");
  if (!isDynamicPL) {
    // static latency case: configure both links up front via the netem UI
    await configureNetemViaUi(page, tc);
    await shot("02_after_netem");
  } else {
    log(`${tc.name}: ${tc.describe} — impairment is applied at runtime to the auto-detected active link`);
  }

  let sshHandles = null;
  const startTraffic = async () => {
    if (cfg.trafficDriver === "ssh") sshHandles = await startTrafficViaSsh(cfg, traffic);
    else await startTrafficViaUi(page, cfg, traffic);
  };
  const stopTraffic = async () => {
    if (cfg.trafficDriver === "ssh") await stopTrafficViaSsh(cfg, traffic, sshHandles, tcDir);
    else await stopTrafficViaUi(page);
  };

  await startTraffic();

  try {
    result.trafficVerifiedBps = await verifyTrafficFlowing(cfg);
  } catch (e) {
    result.errors.push(e.message);
    await shot("99_traffic_not_flowing");
    try { await stopTraffic(); } catch (e2) { result.errors.push(`stop traffic: ${e2.message}`); }
    result.endTime = new Date().toISOString();
    fs.writeFileSync(path.join(tcDir, "observations.txt"), observationsText(result));
    log(`${tc.name} FAILED EARLY: ${e.message}`);
    return result;
  }

  const impairedIfaces = new Set();
  const spokeMonitor = await sshConnect(cfg.spoke);
  try {
    const monitorP = monitorLinkSwitches(spokeMonitor, durationMs, async (sw, isFirst) => {
      await shot(`03_switch_${result.switches.length}`);
      if (isFirst) {
        const snapTar = await collectHourlogSnapshot(cfg.spoke, spokeDir, `${tc.name}_switch`);
        if (snapTar) result.artifacts.spoke.push(snapTar);
      }
    });
    const scheduleP = isDynamicPL
      ? runPacketLossSchedule(cfg, tc.plType, durationMs, impairedIfaces, null)
      : Promise.resolve([]);
    const [switches, impairments] = await Promise.all([monitorP, scheduleP]);
    result.switches = switches;
    result.impairments = impairments;
  } finally {
    spokeMonitor.end();
    for (const iface of impairedIfaces) {
      try { await clearNetemImpairment(cfg, iface); }
      catch (e) { log(`WARN: clearing netem on ${iface} failed: ${e.message}`); }
    }
  }
  result.switchObserved = result.switches.length > 0;

  try {
    await stopTraffic();
  } catch (e) {
    result.errors.push(`stop traffic: ${e.message}`);
    log(`WARN: failed to stop traffic: ${e.message}`);
  }
  await shot("04_test_complete");

  for (const [label, creds, dir] of [
    ["spoke", cfg.spoke, spokeDir],
    ["hub", cfg.hub, hubDir],
  ]) {
    setStatus({ collection: { ...status.collection, [label]: "collecting" } });
    try {
      const logs = await withRetry(() => collectDmtsLogs(creds, dir, label, tc.name),
        { label: `${label} DMTS log collection`, attempts: 2 });
      result.artifacts[label].push(...logs);
      setStatus({ collection: { ...status.collection, [label]: "logs done" } });
    } catch (e) {
      result.errors.push(`${label} DMTS logs: ${e.message}`);
      setStatus({ collection: { ...status.collection, [label]: "logs FAILED" } });
      log(`ERROR: ${e.message}`);
    }
    try {
      const pack = await collectDiagPack(cfg, browser, label, dir, tc.name);
      if (pack) {
        result.artifacts[label].push(pack);
        setStatus({ collection: { ...status.collection, [label]: "done" } });
      }
    } catch (e) {
      result.errors.push(`${label} diag pack: ${e.message}`);
      setStatus({ collection: { ...status.collection, [label]: "diag FAILED" } });
      log(`ERROR: ${e.message}`);
    }
  }

  result.endTime = new Date().toISOString();
  result.result =
    result.switchObserved === tc.expectSwitch && result.errors.length === 0
      ? "PASS"
      : "FAIL";

  result.observationsFile = path.join(tcDir, "observations.txt");
  fs.writeFileSync(result.observationsFile, observationsText(result));
  log(`${tc.name} finished: ${result.result} (switches: ${result.switches.length})`);
  return result;
}

/** mm:ss offset of t from start (falls back to the raw value). */
function offsetStr(start, t) {
  const ms = new Date(t) - new Date(start);
  if (!isFinite(ms) || ms < 0) return String(t);
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** "00:00 SES-1 / 01:42 Switched SES-2 / 03:15 Returned SES-1" rows. */
function trafficMovement(r) {
  if (!r.switches.length) return [];
  const first = r.switches[0].fromLink;
  const rows = [{ at: "00:00", what: `${first}` }];
  for (const sw of r.switches) {
    const label = sw.toLink === first ? `Returned ${sw.toLink}` : `Switched ${sw.toLink}`;
    rows.push({ at: offsetStr(r.startTime, sw.wallClock ?? sw.time), what: label });
  }
  return rows;
}

function observationsText(r) {
  return [
    `Test case:        ${r.name} (TC${r.tc}, mode=${r.mode})`,
    r.plType
      ? `Impairment:       dynamic packet loss (${r.plType}) — ${r.plDescribe}`
      : `Impairment:       link1=${describeLink(r.link1)}, link2=${describeLink(r.link2)}`,
    ...(r.impairments?.length
      ? ["Impairment schedule:",
         ...r.impairments.map((ev) => `  ${offsetStr(r.startTime, ev.t)}  ${ev.event} (${ev.iface})`)]
      : []),
    `Traffic:          ${r.trafficType} ${r.direction ?? ""} ToS=${r.tos}` +
      (r.trafficVerifiedBps != null ? ` (verified ${Math.round(r.trafficVerifiedBps)} B/s)` : " (NOT verified)"),
    ...(r.serverCmd ? [`Server command:   ${r.serverCmd}`] : []),
    ...(r.clientCmd ? [`Client command:   ${r.clientCmd}`] : []),
    `Window:           ${r.startTime} .. ${r.endTime}`,
    `Switch expected:  ${r.expectSwitch ? "Yes" : "No"}`,
    `Switch observed:  ${r.switchObserved ? "Yes" : "No"}`,
    ...r.switches.map(
      (s, i) =>
        `  switch ${i + 1}: TC=${s.tc} ${s.fromLink} -> ${s.toLink} at ${s.time} ` +
        `(from-link latency95P=${s.fromLinkLatency95P} ms, pl95P=${s.fromLinkPacketLoss95P} %)`
    ),
    `Spoke artifacts:  ${r.artifacts.spoke.map((p) => path.basename(p)).join(", ") || "(none)"}`,
    `Hub artifacts:    ${r.artifacts.hub.map((p) => path.basename(p)).join(", ") || "(none)"}`,
    `Screenshots:      ${r.screenshots.map((p) => path.basename(p)).join(", ") || "(none)"}`,
    `Errors:           ${r.errors.join(" | ") || "(none)"}`,
    `Result:           ${r.result}`,
    "",
  ].join("\n");
}

/* ========================================================================= *
 * Reports: summary.md, summary.json, report.html
 * ========================================================================= */

function writeSummary(baseDir, results, meta) {
  const lines = [
    `# ${meta.trafficType}/${meta.tos} impairment test summary — ${meta.executedAt}`,
    ``,
    `- GRID version: ${meta.gridVersion}`,
    `- Topology: ${meta.topology}`,
    `- Spoke: ${meta.spokeHost}   Hub: ${meta.hubHost}`,
    ``,
    `| TC | Impairment (L1/L2) | Start | End | Switch expected | Switch observed | Switch time | Result |`,
    `|----|--------------------|-------|-----|-----------------|-----------------|-------------|--------|`,
  ];
  for (const r of results) {
    lines.push(
      `| ${r.name} | ${describeLink(r.link1)} / ${describeLink(r.link2)} | ${r.startTime} | ${r.endTime} | ` +
      `${r.expectSwitch ? "Yes" : "No"} | ${r.switchObserved ? "Yes" : "No"} | ` +
      `${r.switches[0]?.time ?? "-"} | **${r.result}** |`
    );
  }
  lines.push(``, `## Per-case detail`, ``);
  for (const r of results) {
    lines.push(`### ${r.name}`);
    lines.push(`- DMTS observations: ${r.switches.length} switch(es)` +
      r.switches.map((s) => ` [${s.fromLink}->${s.toLink} @ ${s.time}]`).join(""));
    lines.push(`- Spoke artifacts: ${r.artifacts.spoke.map((p) => path.basename(p)).join(", ") || "(none)"}`);
    lines.push(`- Hub artifacts: ${r.artifacts.hub.map((p) => path.basename(p)).join(", ") || "(none)"}`);
    if (r.errors.length) lines.push(`- Errors: ${r.errors.join(" | ")}`);
    lines.push(``);
  }
  const md = lines.join("\n");
  fs.writeFileSync(path.join(baseDir, "summary.md"), md);
  fs.writeFileSync(path.join(baseDir, "summary.json"),
    JSON.stringify({ meta, results }, null, 2));
  log(`summary written: ${path.join(baseDir, "summary.md")}`);
  return md;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function writeHtmlReport(baseDir, results, meta) {
  const rel = (p) => path.relative(baseDir, p).split(path.sep).join("/");
  const overall = results.every((r) => r.result === "PASS") ? "PASS" : "FAIL";
  const badge = (v) =>
    `<span class="badge ${v === "PASS" ? "pass" : "fail"}">${v}</span>`;

  const rows = results.map((r) => `
    <tr>
      <td>${escapeHtml(r.name)}</td>
      <td>${escapeHtml(describeLink(r.link1))} / ${escapeHtml(describeLink(r.link2))}</td>
      <td>${escapeHtml(r.startTime ?? "-")}<br>${escapeHtml(r.endTime ?? "-")}</td>
      <td>${r.expectSwitch ? "Yes" : "No"}</td>
      <td>${r.switchObserved ? "Yes" : "No"}</td>
      <td>${escapeHtml(r.switches[0]?.time ?? "-")}</td>
      <td>${badge(r.result)}</td>
    </tr>`).join("");

  const sections = results.map((r) => {
    const timeline = r.switches.length
      ? `<ol class="timeline">` + r.switches.map((s) =>
          `<li><b>${escapeHtml(s.time)}</b> — TC ${escapeHtml(s.tc)} switched link ` +
          `${escapeHtml(s.fromLink)} &rarr; ${escapeHtml(s.toLink)} ` +
          `(from-link latency95P=${escapeHtml(s.fromLinkLatency95P)} ms, ` +
          `pl95P=${escapeHtml(s.fromLinkPacketLoss95P)} %)</li>`).join("") + `</ol>`
      : `<p>No link switch observed.</p>`;
    const schedule = r.impairments?.length
      ? `<h3>Impairment schedule</h3><ol class="timeline">` + r.impairments.map((ev) =>
          `<li><b>${escapeHtml(offsetStr(r.startTime, ev.t))}</b> — ${escapeHtml(ev.event)} ` +
          `on ${escapeHtml(ev.iface)}</li>`).join("") + `</ol>`
      : "";
    const artifacts = [...r.artifacts.spoke, ...r.artifacts.hub].map((p) =>
      `<li><a href="${escapeHtml(rel(p))}">${escapeHtml(path.basename(p))}</a></li>`).join("")
      || "<li>(none)</li>";
    const shots = r.screenshots.map((p) =>
      `<figure><img src="${escapeHtml(rel(p))}" loading="lazy">` +
      `<figcaption>${escapeHtml(path.basename(p))}</figcaption></figure>`).join("");
    const errors = r.errors.length
      ? `<p class="errors">Errors: ${escapeHtml(r.errors.join(" | "))}</p>` : "";
    const cmds = r.clientCmd
      ? `<pre class="cmds">${r.serverCmd ? "server: " + escapeHtml(r.serverCmd) + "\n" : ""}client: ${escapeHtml(r.clientCmd)}</pre>`
      : "";
    return `
    <section>
      <h2>${escapeHtml(r.name)} ${badge(r.result)}</h2>
      <p>Impairment: ${r.plType ? escapeHtml(`dynamic packet loss (${r.plType}) — ${r.plDescribe}`)
          : escapeHtml(describeLink(r.link1)) + " / " + escapeHtml(describeLink(r.link2))}
         — Traffic ${escapeHtml(r.trafficType)} ${escapeHtml(r.direction ?? "")} ToS ${escapeHtml(r.tos)}
         ${r.trafficVerifiedBps != null ? `(verified ${Math.round(r.trafficVerifiedBps)} B/s)` : "(traffic NOT verified)"}</p>
      ${cmds}
      ${schedule}
      <h3>Switch timeline</h3>${timeline}
      <h3>Artifacts</h3><ul>${artifacts}</ul>
      ${shots ? `<h3>Screenshots</h3><div class="shots">${shots}</div>` : ""}
      ${errors}
    </section>`;
  }).join("");

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Impairment Test Report — ${escapeHtml(meta.executedAt)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 1100px; padding: 0 1rem; color: #1a1a2e; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #cbd5e1; padding: 6px 10px; font-size: 14px; text-align: left; }
  th { background: #f1f5f9; }
  .badge { padding: 2px 10px; border-radius: 10px; font-weight: 700; font-size: 13px; }
  .badge.pass { background: #dcfce7; color: #166534; }
  .badge.fail { background: #fee2e2; color: #991b1b; }
  .timeline li { margin: 4px 0; }
  .shots { display: flex; flex-wrap: wrap; gap: 12px; }
  .shots figure { margin: 0; max-width: 480px; }
  .shots img { max-width: 100%; border: 1px solid #cbd5e1; border-radius: 4px; }
  .shots figcaption { font-size: 12px; color: #64748b; }
  .errors { color: #991b1b; }
  .cmds { background:#f1f5f9; padding:8px 10px; border-radius:6px; font-size:12px; overflow-x:auto; }
  .meta td:first-child { font-weight: 600; width: 180px; }
  section { margin-top: 2.5rem; }
</style></head><body>
<h1>Impairment Test Report ${badge(overall)}</h1>
<table class="meta"><tbody>
  <tr><td>Executed at</td><td>${escapeHtml(meta.executedAt)}</td></tr>
  <tr><td>GRID version</td><td>${escapeHtml(meta.gridVersion)}</td></tr>
  <tr><td>Topology</td><td>${escapeHtml(meta.topology)}</td></tr>
  <tr><td>Traffic / ToS</td><td>${escapeHtml(meta.trafficType)} / ${escapeHtml(meta.tos)}</td></tr>
  <tr><td>Spoke / Hub</td><td>${escapeHtml(meta.spokeHost)} / ${escapeHtml(meta.hubHost)}</td></tr>
</tbody></table>
<h2>Summary</h2>
<table><thead><tr><th>TC</th><th>Impairment (L1/L2)</th><th>Start / End</th>
<th>Switch expected</th><th>Switch observed</th><th>Switch time</th><th>Result</th></tr></thead>
<tbody>${rows}</tbody></table>
${sections}
</body></html>`;
  const file = path.join(baseDir, "report.html");
  fs.writeFileSync(file, html);
  log(`HTML report written: ${file}`);
  return file;
}

/* ========================================================================= *
 * Confluence publishing
 * ========================================================================= */

function confAuthHeader(conf) {
  return "Basic " + Buffer.from(`${conf.email}:${conf.token}`).toString("base64");
}

async function confFetch(conf, url, options = {}, label = "Confluence API") {
  return withRetry(async () => {
    const resp = await fetch(url, {
      ...options,
      headers: { Authorization: confAuthHeader(conf), ...(options.headers || {}) },
    });
    if (resp.status === 429 || resp.status >= 500) {
      throw new Error(`HTTP ${resp.status} ${(await resp.text()).slice(0, 200)}`);
    }
    return resp;
  }, { label });
}

function escapeXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildStorageBody(results, meta) {
  const metaTable =
    `<table><tbody>` +
    `<tr><th>Executed at</th><td>${escapeXml(meta.executedAt)}</td></tr>` +
    `<tr><th>GRID version</th><td>${escapeXml(meta.gridVersion)}</td></tr>` +
    `<tr><th>Topology</th><td>${escapeXml(meta.topology)}</td></tr>` +
    `<tr><th>Traffic type / ToS</th><td>${escapeXml(meta.trafficType)} / ${escapeXml(meta.tos)}</td></tr>` +
    `<tr><th>Spoke / Hub</th><td>${escapeXml(meta.spokeHost)} / ${escapeXml(meta.hubHost)}</td></tr>` +
    `</tbody></table>`;

  const header =
    "<tr><th>TC</th><th>Impairment (L1/L2)</th><th>Start</th><th>End</th>" +
    "<th>Switch observed</th><th>Switch time</th><th>Artifacts</th><th>Result</th></tr>";
  const rows = results
    .map((r) => {
      const artifacts = [...r.artifacts.spoke, ...r.artifacts.hub]
        .map((p) => `<ac:link><ri:attachment ri:filename="${escapeXml(path.basename(p))}"/></ac:link>`)
        .join("<br/>") || "-";
      return (
        `<tr><td>${escapeXml(r.name)}</td>` +
        `<td>${escapeXml(describeLink(r.link1))} / ${escapeXml(describeLink(r.link2))}</td>` +
        `<td>${escapeXml(r.startTime ?? "-")}</td><td>${escapeXml(r.endTime ?? "-")}</td>` +
        `<td>${r.switchObserved ? "Yes" : "No"}</td>` +
        `<td>${escapeXml(r.switches[0]?.time ?? "-")}</td>` +
        `<td>${artifacts}</td>` +
        `<td><strong>${r.result}</strong></td></tr>`
      );
    })
    .join("");

  const sections = results.map(buildCaseSection).join("");

  return (
    `<h2>Impairment validation run — ${escapeXml(meta.executedAt)}</h2>` +
    metaTable +
    `<h3>Results</h3><table><tbody>${header}${rows}</tbody></table>` +
    sections
  );
}

/** Which of the standard artifacts were actually collected for this case:
 *  complete DMTS archive + individual hourLog/curLog/ubd/ubdLatest.tar and
 *  the Diag Pack, from both Spoke and Hub. */
function artifactChecklist(r) {
  const rows = [];
  for (const side of ["spoke", "hub"]) {
    const files = (r.artifacts[side] ?? []).map((p) => path.basename(p).toLowerCase());
    const has = (s) => files.some((f) => f.includes(s));
    const S = side[0].toUpperCase() + side.slice(1);
    rows.push([`${S} DMTS archive (complete)`, has("dmts_full")]);
    rows.push([`${S} hourLog`, has("hourlog")]);
    rows.push([`${S} curLog`, has("curlog")]);
    rows.push([`${S} ubd`, has("_ubd.tar")]);
    rows.push([`${S} ubdLatest.tar`, has("ubdlatest")]);
    rows.push([`${S} Diag Pack`, has(`diagpack_${side}`)]);
  }
  return rows;
}

/** One Confluence section per test case: Configuration / Schedule /
 *  Traffic Movement / Artifacts / Result. */
function buildCaseSection(r) {
  const row = (k, v) => `<tr><th>${escapeXml(k)}</th><td>${escapeXml(v)}</td></tr>`;
  const config =
    `<h4>Configuration</h4><table><tbody>` +
    row("Traffic", r.trafficType) +
    row("Direction", r.direction ? r.direction[0].toUpperCase() + r.direction.slice(1) : "-") +
    row("ToS", r.tos) +
    row("Impairment", r.plType ? `dynamic packet loss (${r.plType}) — ${r.plDescribe}` :
      `${describeLink(r.link1)} / ${describeLink(r.link2)}`) +
    (r.clientCmd ? row("Client command", r.clientCmd) : "") +
    row("Window", `${r.startTime ?? "-"} .. ${r.endTime ?? "-"}`) +
    `</tbody></table>`;

  const schedule = r.impairments?.length
    ? `<h4>Packet Loss Schedule</h4><table><tbody>` +
      `<tr><th>Time</th><th>Event</th><th>Interface</th></tr>` +
      r.impairments.map((ev) =>
        `<tr><td>${escapeXml(offsetStr(r.startTime, ev.t))}</td>` +
        `<td>${escapeXml(ev.event)}</td><td>${escapeXml(ev.iface)}</td></tr>`).join("") +
      `</tbody></table>`
    : "";

  const moves = trafficMovement(r);
  const movement =
    `<h4>Traffic Movement</h4>` +
    (moves.length
      ? `<table><tbody><tr><th>Time</th><th>Link</th></tr>` +
        moves.map((m) => `<tr><td>${escapeXml(m.at)}</td><td>${escapeXml(m.what)}</td></tr>`).join("") +
        `</tbody></table>`
      : `<p>No link switch observed.</p>`);

  const artifacts =
    `<h4>Artifacts</h4><ul>` +
    artifactChecklist(r).map(([name, ok]) => `<li>${ok ? "&#10003;" : "&#10007;"} ${escapeXml(name)}</li>`).join("") +
    `</ul><p>` +
    [...r.artifacts.spoke, ...r.artifacts.hub]
      .map((p) => `<ac:link><ri:attachment ri:filename="${escapeXml(path.basename(p))}"/></ac:link>`)
      .join(" &nbsp; ") +
    `</p>`;

  const shots = r.screenshots
    .map((p) => `<ac:image ac:width="480"><ri:attachment ri:filename="${escapeXml(path.basename(p))}"/></ac:image>`)
    .join(" ");
  const errs = r.errors.length
    ? `<p><strong>Errors:</strong> ${escapeXml(r.errors.join(" | "))}</p>` : "";

  return (
    `<h3>${escapeXml(r.name)}${r.plDescribe ? " — " + escapeXml(r.plDescribe) : ""}</h3>` +
    config + schedule + movement + artifacts +
    `<h4>Result</h4><p><strong>${r.result}</strong></p>` +
    errs + shots
  );
}

async function confUploadAttachment(conf, pageId, filepath, asName = null) {
  const url = `${conf.base}/wiki/rest/api/content/${pageId}/child/attachment?allowDuplicated=true`;
  const form = new FormData();
  const buf = fs.readFileSync(filepath);
  form.append("file", new Blob([buf]), asName || path.basename(filepath));
  form.append("minorEdit", "true");
  const resp = await confFetch(conf, url, {
    method: "POST",
    headers: { "X-Atlassian-Token": "no-check" },
    body: form,
  }, `attach ${path.basename(filepath)}`);
  if (!resp.ok) {
    throw new Error(`attachment upload ${path.basename(filepath)}: HTTP ${resp.status} ${(await resp.text()).slice(0, 300)}`);
  }
  log(`attached to Confluence: ${path.basename(filepath)}`);
}

async function publishToConfluence(conf, results, meta, extraFiles = []) {
  const body = buildStorageBody(results, meta);
  let pageId = conf.pageId;

  if (pageId) {
    const getResp = await confFetch(conf,
      `${conf.base}/wiki/rest/api/content/${pageId}?expand=body.storage,version`, {}, "get page");
    if (!getResp.ok) throw new Error(`get page ${pageId}: HTTP ${getResp.status}`);
    const page = await getResp.json();
    if (String(page.id) !== String(pageId)) {
      throw new Error(`page id mismatch: got ${page.id}, expected ${pageId} — refusing to write`);
    }
    const payload = {
      id: pageId,
      type: "page",
      title: page.title,
      version: { number: page.version.number + 1, message: "impairment test automation run" },
      body: { storage: { value: page.body.storage.value + body, representation: "storage" } },
    };
    const putResp = await confFetch(conf, `${conf.base}/wiki/rest/api/content/${pageId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }, "update page");
    if (!putResp.ok) throw new Error(`update page: HTTP ${putResp.status} ${(await putResp.text()).slice(0, 300)}`);
    log(`Confluence page ${pageId} updated (appended run section)`);
  } else {
    const payload = {
      type: "page",
      title: `Impairment Test Run ${meta.executedAt.replace(/[:]/g, "-")}`,
      space: { key: conf.space },
      ...(conf.parentId ? { ancestors: [{ id: conf.parentId }] } : {}),
      body: { storage: { value: body, representation: "storage" } },
    };
    const resp = await confFetch(conf, `${conf.base}/wiki/rest/api/content`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }, "create page");
    if (!resp.ok) throw new Error(`create page: HTTP ${resp.status} ${(await resp.text()).slice(0, 300)}`);
    const created = await resp.json();
    pageId = created.id;
    log(`Confluence page created: ${pageId} ("${created.title}")`);
  }

  const files = [
    ...results.flatMap((r) => [...r.artifacts.spoke, ...r.artifacts.hub, ...r.screenshots]),
    ...extraFiles,
  ];
  // generic filenames (observations.txt, report.html, ...) collide across
  // TC folders/modes — prefix them with their parent directory name
  const GENERIC = ["observations.txt", "summary.json", "summary.md", "report.html"];
  const uploadName = (f) => {
    const b = path.basename(f);
    return GENERIC.includes(b) ? `${path.basename(path.dirname(f))}_${b}` : b;
  };
  for (const f of files) {
    try {
      await confUploadAttachment(conf, pageId, f, uploadName(f));
    } catch (e) {
      log(`WARN: ${e.message}`);
    }
  }
  return pageId;
}

/* ========================================================================= *
 * Suite runner — shared by the CLI and the web UI
 * params: {trafficType, tos, bandwidth, durationSec, mode, tcChoice, confluence}
 * ========================================================================= */

async function runSuite(cfg, params) {
  const cmds = cfg.trafficDriver === "ssh" ? buildTrafficCommands(params) : {};
  if (cfg.trafficDriver === "ssh" && !String(cmds.clientCmd ?? "").trim()) {
    throw new Error("no client traffic command — pick a tool or fill the Advanced commands");
  }
  const traffic = {
    type: params.trafficType.toUpperCase(),
    direction: String(params.trafficDirection || "upstream").toLowerCase(),
    tos: parseTos(params.tos),
    bandwidth: parseBandwidth(params.bandwidth).value,
    serverCmd: cmds.serverCmd ?? null,
    clientCmd: cmds.clientCmd ?? null,
  };
  if (traffic.clientCmd) log(`traffic commands:\n  server: ${traffic.serverCmd || "(none)"}\n  client: ${traffic.clientCmd}`);
  const modes = params.mode === "all" ? ["latency", "packet-loss"] : [params.mode];
  const tcFilter = parseTcChoice(params.tcChoice);
  const durationMs = parseDuration(params.durationSec) * 1000;

  await preflight(cfg);

  const meta = await collectRunMetadata(cfg, traffic.type, traffic.tos);
  log(`run start: modes=[${modes.join(",")}] traffic=${traffic.type} ToS=${traffic.tos} ` +
      `tc=${tcFilter} duration=${durationMs / 1000}s/case, GRID=${meta.gridVersion}`);

  const { browser, page } = await openNetemUi(cfg);
  const allResults = [];
  const reportFiles = [];
  try {
    for (const mode of modes) {
      let cases = buildTestCases(cfg, mode);
      if (tcFilter !== "all") cases = cases.filter((c) => c.n === tcFilter);
      const baseDir = path.join(process.cwd(),
        mode === "latency" ? "Latency_Test" : "Packet_Loss_Test");
      fs.mkdirSync(baseDir, { recursive: true });
      setStatus({ phase: "running", mode, caseCount: cases.length, caseIndex: 0 });

      const results = [];
      for (const [i, tc] of cases.entries()) {
        setStatus({ caseIndex: i + 1 });
        try {
          const r = await runTestCase(cfg, browser, page, tc, traffic, baseDir, durationMs);
          results.push(r);
        } catch (e) {
          log(`ERROR: ${tc.name} aborted: ${e.message}`);
          results.push({
            tc: tc.n, name: tc.name, mode, link1: tc.link1, link2: tc.link2,
            trafficType: traffic.type, tos: traffic.tos,
            startTime: null, endTime: null, trafficVerifiedBps: null,
            switches: [], switchObserved: false, expectSwitch: tc.expectSwitch,
            artifacts: { spoke: [], hub: [] }, screenshots: [],
            errors: [e.message], result: "FAIL",
          });
        }
        setStatus({ results: results.map((r) => ({ name: r.name, result: r.result })) });
      }
      writeSummary(baseDir, results, meta);
      reportFiles.push(writeHtmlReport(baseDir, results, meta));
      reportFiles.push(path.join(baseDir, "summary.json"));
      reportFiles.push(...results.map((r) => r.observationsFile).filter(Boolean));
      allResults.push(...results);
    }
  } finally {
    await browser.close();
  }

  let pageId = null;
  if (params.confluence && cfg.confluence) {
    setStatus({ phase: "publishing", confluence: "uploading" });
    try {
      pageId = await publishToConfluence(cfg.confluence, allResults, meta, reportFiles);
      setStatus({ confluence: `done (page ${pageId})` });
      log(`results published to Confluence page ${pageId}`);
    } catch (e) {
      setStatus({ confluence: `FAILED: ${e.message}` });
      log(`ERROR: Confluence publish failed: ${e.message}`);
    }
  } else {
    setStatus({ confluence: "skipped" });
  }

  const failed = allResults.filter((r) => r.result !== "PASS");
  log(`run complete: ${allResults.length - failed.length}/${allResults.length} PASS` +
      (failed.length ? ` — failed: ${failed.map((r) => r.name).join(", ")}` : ""));
  setStatus({ phase: "done" });
  return { results: allResults, meta, reportFiles, pageId, failed: failed.length };
}

/* ========================================================================= *
 * Interactive setup wizard (CLI)
 * ========================================================================= */

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

/** Prompt with hidden echo (for passwords/tokens). */
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const orig = rl._writeToOutput;
    rl.question(question, (a) => {
      rl._writeToOutput = orig;
      rl.close();
      process.stdout.write("\n");
      resolve(a.trim());
    });
    rl._writeToOutput = function (str) {
      // echo the prompt itself, mask everything typed after it
      if (str.startsWith(question)) rl.output.write(question);
      else rl.output.write("*");
    };
  });
}

/** Ask until validate(answer) returns a non-null value; empty answer takes the default. */
async function askValidated(label, dflt, validate, { hidden = false } = {}) {
  const suffix = dflt !== "" && dflt !== null && dflt !== undefined ? ` [${dflt}]` : "";
  for (;;) {
    const raw = await (hidden ? askHidden(`${label}${suffix}: `) : ask(`${label}${suffix}: `));
    const answer = raw === "" ? String(dflt ?? "") : raw;
    const v = validate(answer);
    if (v !== null && v !== false) return v === true ? answer : v;
    console.log(`  invalid value, try again`);
  }
}

async function interactiveSetup(p) {
  console.log("\n=== Impairment test setup ===  (Enter accepts the [default])\n");

  p.trafficDriver = await askValidated("Traffic driver (ssh/netem-ui)", p.trafficDriver,
    (s) => (["ssh", "netem-ui"].includes(s.toLowerCase()) ? s.toLowerCase() : null));
  const sshDriver = p.trafficDriver === "ssh";

  const ipRequired = (s) => (isValidIp(s) ? s : null);
  const ipOptional = (s) => (s === "" || isValidIp(s) ? s : null);
  p.clientIp = await askValidated("Client IP", p.clientIp, sshDriver ? ipRequired : ipOptional);
  p.serverIp = await askValidated("Server IP", p.serverIp, sshDriver ? ipRequired : ipOptional);
  p.clientPort = await askValidated("Client port (optional)", p.clientPort,
    (s) => (parsePort(s).ok ? s : null));
  p.serverPort = await askValidated("Server port", p.serverPort,
    (s) => (parsePort(s).ok ? s : null));
  p.clientIface = await askValidated("Client interface (optional, e.g. ens3)", p.clientIface, (s) => s);
  p.serverIface = await askValidated("Server interface (optional, e.g. ens4)", p.serverIface, (s) => s);
  p.clientBindIp = await askValidated("Client bind IP on that interface (optional)", p.clientBindIp, ipOptional);
  p.spokeHost = await askValidated("Spoke SSH IP", p.spokeHost, ipRequired);
  p.hubHost = await askValidated("Hub SSH IP", p.hubHost, ipRequired);

  const sides = sshDriver ? ["client", "server", "spoke", "hub"] : ["spoke", "hub"];
  for (const side of sides) {
    const user = await askValidated(`${side} SSH username`, p[`${side}User`], (s) => (s ? s : null));
    p[`${side}User`] = user;
    const method = await askValidated(
      `${side} auth method (password/key)`,
      p[`${side}Key`] ? "key" : "password",
      (s) => (["password", "key"].includes(s.toLowerCase()) ? s.toLowerCase() : null));
    if (method === "key") {
      p[`${side}Key`] = await askValidated(`${side} private key path`, p[`${side}Key`],
        (s) => (s && fs.existsSync(s) ? s : null));
      p[`${side}Pass`] = "";
    } else {
      p[`${side}Pass`] = await askValidated(`${side} SSH password`,
        p[`${side}Pass`] ? "(from env)" : "",
        (s) => (s ? (s === "(from env)" ? p[`${side}Pass`] : s) : null),
        { hidden: true });
      p[`${side}Key`] = "";
    }
  }

  if (sshDriver) {
    p.trafficTool = await askValidated("Traffic tool (iperf3/scapy/tcpreplay/custom)", p.trafficTool,
      (s) => (["iperf3", "scapy", "tcpreplay", "custom"].includes(s.toLowerCase()) ? s.toLowerCase() : null));
  }
  p.trafficType = (await askValidated("Protocol (TCP/UDP)", p.trafficType,
    (s) => (["tcp", "udp"].includes(s.toLowerCase()) ? s.toUpperCase() : null)));
  p.trafficDirection = await askValidated("Traffic direction (upstream/downstream)", p.trafficDirection,
    (s) => (["upstream", "downstream"].includes(s.toLowerCase()) ? s.toLowerCase() : null));
  p.tos = await askValidated("ToS/DSCP value (hex 0xNN or decimal)", p.tos, (s) => parseTos(s));
  p.durationSec = await askValidated("Traffic duration seconds", p.durationSec, (s) => parseDuration(s));
  p.bandwidth = await askValidated("Bandwidth (e.g. 10M, empty = tool default)", p.bandwidth,
    (s) => (parseBandwidth(s).ok ? (s || "") : null));
  p.parallelStreams = await askValidated("Parallel streams", p.parallelStreams,
    (s) => (parsePosInt(s, { optional: true }).ok ? s : null));
  p.packetSize = await askValidated("Packet size bytes (optional)", p.packetSize,
    (s) => (parsePosInt(s, { optional: true }).ok ? s : null));
  if (sshDriver) {
    const gen = buildTrafficCommands(p);
    console.log(`\nGenerated commands:\n  server: ${gen.serverCmd || "(none)"}\n  client: ${gen.clientCmd || "(none)"}`);
    const edit = await askValidated("Edit commands before run? (yes/no)", "no",
      (s) => (["yes", "no", "y", "n"].includes(s.toLowerCase()) ? s.toLowerCase() : null));
    if (edit.startsWith("y")) {
      p.serverCmd = await askValidated("Server command", gen.serverCmd, (s) => s);
      p.clientCmd = await askValidated("Client command", gen.clientCmd, (s) => (s ? s : null));
    }
  }
  p.tcChoice = await askValidated("Which test (TC1/TC2/TC3/TC4/all)", p.tcChoice,
    (s) => (parseTcChoice(s) !== null ? s : null));
  p.mode = await askValidated("Mode (latency/packet-loss/all)", p.mode,
    (s) => (["latency", "packet-loss", "all"].includes(s.toLowerCase()) ? s.toLowerCase() : null));
  if (["packet-loss", "all"].includes(p.mode)) {
    p.netemHost = await askValidated("Netem VM SSH IP", p.netemHost, ipRequired);
    p.netemUser = await askValidated("Netem VM SSH username", p.netemUser, (s) => (s ? s : null));
    p.netemPass = await askValidated("Netem VM SSH password", p.netemPass ? "(from env)" : "",
      (s) => (s ? (s === "(from env)" ? p.netemPass : s) : null), { hidden: true });
    p.netemCandidates = await askValidated(
      "Overlay link interfaces on netem VM (csv, e.g. ens192,ens193; empty = auto)",
      p.netemCandidates, (s) => s);
  }
  p.confluence = (await askValidated("Upload to Confluence? (yes/no)",
    p.confluence ? "yes" : "no",
    (s) => (["yes", "no", "y", "n"].includes(s.toLowerCase()) ? s.toLowerCase() : null)))
    .startsWith("y");

  if (p.confluence) {
    p.confEmail = await askValidated("Confluence email", p.confEmail, (s) => (s.includes("@") ? s : null));
    p.confToken = await askValidated("Confluence API token",
      p.confToken ? "(from env)" : "",
      (s) => (s ? (s === "(from env)" ? p.confToken : s) : null),
      { hidden: true });
    p.confBase = await askValidated("Confluence base URL", p.confBase,
      (s) => (/^https?:\/\//.test(s) ? s.replace(/\/+$/, "") : null));
    p.confPageId = await askValidated("Confluence page ID to update (empty = create new)",
      p.confPageId, (s) => (s === "" || /^\d+$/.test(s) ? s : null));
    if (!p.confPageId) {
      p.confSpace = await askValidated("Confluence space key", p.confSpace, (s) => (s ? s : null));
      p.confParentId = await askValidated("Parent page ID (optional)", p.confParentId,
        (s) => (s === "" || /^\d+$/.test(s) ? s : null));
    }
  }

  p.netemUiUrl = await askValidated("netem UI URL", p.netemUiUrl,
    (s) => (/^https?:\/\//.test(s) ? s : null));

  return p;
}

/* ========================================================================= *
 * CLI
 * ========================================================================= */

function parseArgs(argv) {
  const args = { nonInteractive: false, headless: null, overrides: {} };
  const o = args.overrides;
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--traffic": o.trafficType = argv[++i]; break;
      case "--tos": o.tos = argv[++i]; break;
      case "--tc": o.tcChoice = argv[++i]; break;
      case "--duration": o.durationSec = argv[++i]; break;
      case "--mode": o.mode = argv[++i]; break;
      case "--client": o.clientIp = argv[++i]; break;
      case "--server": o.serverIp = argv[++i]; break;
      case "--bandwidth": o.bandwidth = argv[++i]; break;
      case "--headless": args.headless = true; break;
      case "--headed": args.headless = false; break;
      case "--no-confluence": o.confluence = false; break;
      case "--non-interactive": args.nonInteractive = true; break;
      case "--help":
        console.log("usage: node run_latency_tests.js [--non-interactive] " +
          "[--mode latency|packet-loss|all] [--traffic tcp|udp] [--tos VALUE] " +
          "[--tc N|all] [--duration SECONDS] [--client IP] [--server IP] " +
          "[--bandwidth 10M] [--headless|--headed] [--no-confluence]\n" +
          "Without --non-interactive an input wizard collects and validates all settings.");
        process.exit(0);
      default:
        console.error(`unknown argument: ${argv[i]}`);
        process.exit(1);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  let p = { ...paramsFromEnv(), ...args.overrides };
  if (args.headless !== null) p.headless = args.headless;

  if (!args.nonInteractive) {
    p = await interactiveSetup(p);
  }

  const check = validateParams(p);
  if (!check.ok) {
    console.error("Configuration invalid:");
    for (const [field, msg] of Object.entries(check.errors)) console.error(`  - ${field}: ${msg}`);
    process.exit(1);
  }
  if (p.confluence && !p.confEmail) {
    console.error("Confluence upload enabled but CONF_EMAIL/CONF_TOKEN missing (or use --no-confluence)");
    process.exit(1);
  }

  const cfg = buildConfig(p);
  const { failed } = await runSuite(cfg, p);
  if (failed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((e) => {
    setStatus({ phase: "error", error: e.message });
    log(`FATAL: ${e.stack || e.message}`);
    process.exit(1);
  });
}

module.exports = {
  // engine
  runSuite, buildConfig, paramsFromEnv, preflight,
  // events / status (web UI)
  bus, getStatus, setStatus,
  // validators
  isValidIp, parseTos, parseBandwidth, parseDuration, parseTcChoice, validateParams,
  parsePort, parsePosInt,
  // traffic generation + interface discovery
  buildTrafficCommands, toolBinary, parseInterfaces, listRemoteInterfaces,
  // netem impairment + dynamic packet loss
  parsePacketCounters, detectActiveLink, applyNetemImpairment, clearNetemImpairment,
  runPacketLossSchedule, offsetStr, trafficMovement, artifactChecklist, buildCaseSection,
  // parsing / cases / reports (tests)
  lastCompleteRecord, findBalancedEnd, activeTc, linkStats,
  buildTestCases, describeLink, buildStorageBody, escapeXml, escapeHtml,
  writeSummary, writeHtmlReport, withRetry, observationsText,
};
