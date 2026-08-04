/**
 * Orchestrator: collect facts -> derive the topology -> probe -> diagnose.
 *
 * Progress and log lines are published on `bus` so the web panel can stream
 * them (same pattern as latency-test-automation/ui_server.js).
 */

"use strict";

const EventEmitter = require("events");
const fs = require("fs");
const path = require("path");

const { isValidHost } = require("./ssh");
const { collectEsxi } = require("./esxi");
const guest = require("./guest");
const diagnose = require("./diagnose");
const report = require("./report");
const { ROLE_ORDER, ROLE_LABEL } = diagnose;

const bus = new EventEmitter();
const REPORT_DIR = path.join(__dirname, "..", "reports");

let status = emptyStatus();
let aborted = false;

function emptyStatus() {
  return {
    phase: "idle",
    step: "",
    esxi: null,
    nodes: {},
    verdict: null,
    summary: "",
    findings: [],
    segments: [],
    topology: null,
    reportPath: null,
    startedAt: null,
    finishedAt: null,
    error: null,
  };
}

function getStatus() { return status; }

function setStatus(patch) {
  status = { ...status, ...patch };
  bus.emit("status", status);
  return status;
}

function log(line) {
  const msg = `${new Date().toISOString()} ${line}`;
  bus.emit("log", msg);
  return msg;
}

function requestAbort() { aborted = true; }
function isAborted() { return aborted; }

/* ------------------------------------------------------------- validation */

/** Roles that must always be present; netem is optional by design. */
const REQUIRED_ROLES = ["client", "spoke", "hub", "server"];

function validateConfig(cfg) {
  const errors = {};
  const esxi = cfg.esxi || {};
  if (!esxi.skip) {
    if (!isValidHost(esxi.host)) errors["esxi.host"] = "ESXi host IP or name required";
    if (!esxi.user) errors["esxi.user"] = "username required (usually root)";
    if (!esxi.pass && !esxi.key) errors["esxi.pass"] = "password or key path required";
  }
  for (const role of ROLE_ORDER) {
    const n = (cfg.nodes || {})[role] || {};
    const required = REQUIRED_ROLES.includes(role);
    // an optional node counts as in use once it is ticked or partly filled in,
    // so "include netem" with an empty IP is an error rather than a silent skip
    const partlyFilled = !!(n.host || n.user || n.vmName || n.dataIp);
    const inUse = required || (n.enabled !== false && (n.enabled === true || partlyFilled));
    if (!inUse) continue;
    if (!isValidHost(n.host)) {
      errors[`${role}.host`] = required
        ? `${ROLE_LABEL[role]} management IP is required`
        : "management IP required — or untick include";
    }
    if (!n.user) errors[`${role}.user`] = "username required";
    if (!n.pass && !n.key) errors[`${role}.pass`] = "password or key path required";
    if (n.dataIp && !isValidHost(n.dataIp)) errors[`${role}.dataIp`] = "not a valid IP";
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

function nodeCreds(role, n) {
  return {
    role,
    host: String(n.host).trim(),
    user: String(n.user).trim(),
    pass: n.pass || null,
    keyPath: n.key || null,
    vmName: n.vmName || "",
    dataIp: n.dataIp ? String(n.dataIp).trim() : "",
  };
}

/* ---------------------------------------------------------------- the run */

async function runDiagnosis(cfg) {
  aborted = false;
  status = emptyStatus();
  setStatus({ phase: "running", startedAt: new Date().toISOString(), step: "starting" });

  const opts = {
    maxHops: Math.min(Math.max(parseInt(cfg.options?.maxHops ?? 12, 10) || 12, 2), 30),
    mtuBytes: Math.min(Math.max(parseInt(cfg.options?.mtuBytes ?? 1500, 10) || 1500, 576), 9000),
    activeProbes: cfg.options?.activeProbes !== false,
  };

  const facts = { esxi: { ok: false, error: "not collected" }, nodes: {}, probes: {}, options: opts };
  const conns = {};

  try {
    /* 1 — ESXi host ----------------------------------------------------- */
    if (cfg.esxi && !cfg.esxi.skip) {
      setStatus({ phase: "running", step: "reading the ESXi host" });
      log(`Connecting to ESXi ${cfg.esxi.host} …`);
      try {
        facts.esxi = await collectEsxi(
          { host: cfg.esxi.host, user: cfg.esxi.user, pass: cfg.esxi.pass || null, keyPath: cfg.esxi.key || null },
          log);
        setStatus({
          esxi: {
            ok: true,
            host: facts.esxi.host,
            version: `${facts.esxi.version.product} ${facts.esxi.version.version}`.trim(),
            vswitches: facts.esxi.vswitches.length,
            portgroups: facts.esxi.portgroups.length,
            vms: facts.esxi.vms.length,
          },
        });
      } catch (e) {
        facts.esxi = { ok: false, error: e.message };
        log(`WARN: ESXi collection failed (${e.message}) — continuing with in-guest evidence only`);
        setStatus({ esxi: { ok: false, error: e.message } });
      }
    } else {
      facts.esxi = { ok: false, error: "skipped by request" };
      log("ESXi step skipped — L2 verdict will rest on in-guest evidence only");
    }

    /* 2 — guests -------------------------------------------------------- */
    setStatus({ step: "reading the testbed nodes" });
    const roles = ROLE_ORDER.filter((r) => {
      const n = (cfg.nodes || {})[r];
      return n && n.enabled !== false && n.host;
    });
    const collected = await Promise.all(roles.map(async (role) => {
      const creds = nodeCreds(role, cfg.nodes[role]);
      const { node, conn } = await guest.collectNode(role, creds, log);
      node.creds = creds;
      return { role, node, conn };
    }));
    for (const c of collected) {
      facts.nodes[c.role] = c.node;
      if (c.conn) conns[c.role] = c.conn;
    }
    diagnose.attachEsxiPorts(facts);
    for (const role of roles) {
      const n = facts.nodes[role];
      setStatus({
        nodes: {
          ...status.nodes,
          [role]: {
            host: n.host,
            reachable: n.reachable,
            error: n.error,
            hostname: n.hostname || "",
            kind: diagnose.classifyNode(n),
            addrs: (n.addrs || []).map((a) => `${a.iface} ${a.ip}/${a.prefix}`),
            ports: Object.entries(n.ifacePorts || {}).map(([i, p]) => `${i} -> ${p.portgroup} (${p.vswitch})`),
            netemActive: !!n.netemActive,
          },
        },
      });
    }
    if (!Object.values(facts.nodes).some((n) => n.reachable)) {
      throw new Error("no testbed node could be reached over SSH — check the credentials");
    }

    /* 3 — topology ------------------------------------------------------ */
    const topo = diagnose.buildTopology(facts);
    log(`Path: ${topo.present.map((r) => `${ROLE_LABEL[r]}(${facts.nodes[r].kind})`).join(" -> ")}`);
    if (topo.bridges.length) {
      log(`Transparent L2 bridge(s): ${topo.bridges.join(", ")} — collapsed out of the L3 chain`);
    }
    log(`L3 chain: ${topo.l3Chain.join(" -> ")} | flow ${topo.target.srcIp || "?"} -> ${topo.target.dstIp || "?"}`);
    setStatus({ topology: { ...topo.target, path: topo.present, l3Chain: topo.l3Chain, bridges: topo.bridges } });

    /* 4 — probes -------------------------------------------------------- */
    facts.probes = { segments: {}, routeGets: {}, endToEnd: {}, mtu: null };
    if (opts.activeProbes) {
      setStatus({ step: "probing L2 adjacency on each segment" });
      for (const seg of topo.segments) {
        if (aborted) throw new Error("aborted");
        const conn = conns[seg.a];
        if (!conn || !seg.aAddr || !seg.bAddr) {
          log(`Segment ${seg.key}: skipped (${!conn ? `${seg.a} unreachable` : "no shared subnet to probe"})`);
          continue;
        }
        log(`Segment ${seg.key}: ARP + ping ${seg.aAddr.ip} -> ${seg.bAddr.ip} on ${seg.aAddr.iface}`);
        facts.probes.segments[seg.key] = await guest.probeAdjacency(conn, facts.nodes[seg.a].creds, {
          iface: seg.aAddr.iface,
          srcIp: seg.aAddr.ip,
          peerIp: seg.bAddr.ip,
        });
        const p = facts.probes.segments[seg.key];
        log(`  ARP: ${p.neigh ? `${p.neigh.state} ${p.neigh.mac || "(no lladdr)"}` : "no entry"}` +
          ` | ping: ${p.ping.lossPct}% loss` +
          (p.arping ? ` | arping: ${p.arping.ok ? "reply" : "no reply"}` : ""));
      }

      const { srcIp, dstIp } = topo.target;
      if (srcIp && dstIp) {
        setStatus({ step: "probing the routing path" });
        for (const role of topo.l3Chain) {
          const conn = conns[role];
          if (!conn) continue;
          const toDst = await guest.probeRouteGet(conn, dstIp);
          const toSrc = await guest.probeRouteGet(conn, srcIp);
          facts.probes.routeGets[role] = { toDst, toSrc };
          log(`${role}: route to ${dstIp} -> ${toDst.unreachable ? "UNREACHABLE" :
            `${toDst.via ? `via ${toDst.via} ` : ""}dev ${toDst.dev || "?"}`}`);
        }

        if (conns.client) {
          log(`End-to-end: ping ${srcIp} -> ${dstIp}`);
          facts.probes.endToEnd.forward = await guest.probePing(conns.client, dstIp, { srcIp, count: 4 });
          log(`  forward: ${facts.probes.endToEnd.forward.lossPct}% loss` +
            (facts.probes.endToEnd.forward.rttAvgMs ? `, ${facts.probes.endToEnd.forward.rttAvgMs} ms avg` : ""));
          facts.probes.endToEnd.traceroute = await guest.probeTraceroute(conns.client, dstIp, {
            srcIp, maxHops: opts.maxHops, tools: facts.nodes.client.tools || [],
          });
          log(`  ${facts.probes.endToEnd.traceroute.via}: ` +
            facts.probes.endToEnd.traceroute.hops.map((h) => `${h.ttl}:${h.ip || "*"}`).join(" "));

          const payload = Math.max(opts.mtuBytes - 28, 64);
          facts.probes.mtu = {
            size: opts.mtuBytes,
            small: await guest.probePing(conns.client, dstIp, { srcIp, count: 2, size: 56 }),
            large: await guest.probePing(conns.client, dstIp, { srcIp, count: 2, size: payload, df: true }),
          };
          log(`  MTU probe: 56B ${facts.probes.mtu.small.lossPct}% loss, ` +
            `${payload}B DF ${facts.probes.mtu.large.lossPct}% loss`);
        }
        if (conns.server) {
          facts.probes.endToEnd.reverse = await guest.probePing(conns.server, srcIp, { srcIp: dstIp, count: 3 });
          log(`  reverse: ${facts.probes.endToEnd.reverse.lossPct}% loss`);
        }
      } else {
        log("WARN: could not determine the test flow endpoints — set the client/server data IPs for L3 checks");
      }
    } else {
      log("Active probes disabled — verdict from configuration only (no ICMP sent)");
    }

    /* 5 — verdict ------------------------------------------------------- */
    setStatus({ step: "correlating findings" });
    const result = diagnose.analyze(facts, topo);
    log(`VERDICT: ${result.verdict}`);
    for (const line of result.summary.split("\n")) log(`  ${line}`);

    /* 6 — report -------------------------------------------------------- */
    const paths = report.write(REPORT_DIR, facts, topo, result);
    log(`Report written: ${paths.html}`);

    setStatus({
      phase: "done",
      step: "",
      verdict: result.verdict,
      summary: result.summary,
      findings: result.findings,
      segments: result.segments.map(publicSegment),
      reportPath: paths.html,
      reportJson: paths.json,
      finishedAt: new Date().toISOString(),
    });
    return { ...result, reportPaths: paths };
  } catch (e) {
    log(`FATAL: ${e.message}`);
    setStatus({ phase: "error", error: e.message, finishedAt: new Date().toISOString() });
    throw e;
  } finally {
    for (const conn of Object.values(conns)) { try { conn.end(); } catch { /* already closed */ } }
  }
}

/** Trim a segment down to what the UI needs (drops raw command output). */
function publicSegment(seg) {
  return {
    key: seg.key,
    a: seg.a,
    b: seg.b,
    status: seg.status || "unknown",
    subnet: seg.subnet,
    viaBridge: seg.viaBridge,
    aIp: seg.aAddr ? `${seg.aAddr.ip}/${seg.aAddr.prefix}` : null,
    bIp: seg.bAddr ? `${seg.bAddr.ip}/${seg.bAddr.prefix}` : null,
    aIface: seg.aAddr ? seg.aAddr.iface : null,
    bIface: seg.bAddr ? seg.bAddr.iface : null,
    aPortgroup: seg.portA ? seg.portA.portgroup : null,
    bPortgroup: seg.portB ? seg.portB.portgroup : null,
    aVswitch: seg.portA ? seg.portA.vswitch : null,
    bVswitch: seg.portB ? seg.portB.vswitch : null,
    sameL2Domain: seg.sameL2Domain,
    arp: seg.probe && seg.probe.neigh ? `${seg.probe.neigh.state} ${seg.probe.neigh.mac || ""}`.trim() : null,
    lossPct: seg.probe && seg.probe.ping ? seg.probe.ping.lossPct : null,
  };
}

/** ESXi inventory for the role dropdowns in step 2. */
async function esxiInventory(creds) {
  const esxi = await collectEsxi(creds, log);
  return {
    ok: true,
    host: esxi.host,
    version: `${esxi.version.product} ${esxi.version.version} build ${esxi.version.build}`.trim(),
    vswitches: esxi.vswitches.map((v) => ({ name: v.name, kind: v.kind, mtu: v.mtu, uplinks: v.uplinks })),
    portgroups: esxi.portgroups.map((p) => ({ name: p.name, vswitch: p.vswitch, vlan: p.vlan })),
    vms: esxi.inventory.length
      ? esxi.inventory.map((v) => v.name)
      : esxi.vms.map((v) => v.name),
    poweredOn: esxi.vms.map((v) => ({
      name: v.name,
      ports: v.ports.map((p) => ({ portgroup: p.portgroup, vswitch: p.vswitch, mac: p.mac, ip: p.ip })),
    })),
  };
}

function readReport(file) {
  const p = path.resolve(file);
  if (!p.startsWith(path.resolve(REPORT_DIR))) throw new Error("outside the report directory");
  return fs.readFileSync(p, "utf8");
}

module.exports = {
  bus, getStatus, setStatus, log, requestAbort, isAborted,
  validateConfig, runDiagnosis, esxiInventory, readReport,
  REPORT_DIR, REQUIRED_ROLES, publicSegment,
};
