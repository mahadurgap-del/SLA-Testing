/**
 * ESXi host collector — the L2 half of the picture.
 *
 * Everything is read over SSH with esxcli / vim-cmd (read-only commands only).
 * esxcli's JSON formatter is used when the host supports it (6.0+) and the
 * plain-text output is parsed as a fallback, because that is the one thing that
 * differs across lab hosts.
 *
 * What we care about, and why:
 *   vswitch list ................ MTU + uplinks + which portgroups live where
 *   portgroup list .............. VLAN ID per portgroup  -> VLAN mismatch
 *   portgroup security policy ... MAC changes / forged transmits / promiscuous
 *                                 -> a bridging netem VM is silently dropped
 *                                    when MAC changes are rejected
 *   vm list + vm port list ...... which portgroup each vNIC lands in, and the
 *                                 MAC the vSwitch believes that port owns
 *                                 -> portgroup mismatch + MAC mismatch
 *   nic list .................... physical uplink state (only matters when the
 *                                 segment has to leave the host)
 */

"use strict";

const { sshConnect, sshExec } = require("./ssh");

/* ------------------------------------------------------------------ parsers */

function camel(key) {
  const s = String(key).replace(/[^A-Za-z0-9]+/g, " ").trim();
  if (!s) return "";
  return s
    .split(" ")
    .map((w, i) => (i === 0 ? w[0].toLowerCase() + w.slice(1) : w[0].toUpperCase() + w.slice(1)))
    .join("");
}

function camelKeys(obj) {
  if (Array.isArray(obj)) return obj.map(camelKeys);
  if (!obj || typeof obj !== "object") return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[camel(k)] = camelKeys(v);
  return out;
}

/**
 * esxcli tables: a header row, a row of dashes that defines the column widths,
 * then the data. Slicing by the dash groups is the only safe way — values
 * contain spaces ("Management Network").
 */
function parseDashTable(text) {
  const lines = String(text).replace(/\r/g, "").split("\n");
  const sepIdx = lines.findIndex((l) => /^-{2,}(\s+-{2,})+\s*$/.test(l));
  if (sepIdx < 1) return [];
  const spans = [];
  const sep = lines[sepIdx];
  const re = /-+/g;
  let m;
  while ((m = re.exec(sep))) spans.push([m.index, m.index + m[0].length]);
  const header = lines[sepIdx - 1];
  const cols = spans.map(([a, b], i) =>
    camel((i === spans.length - 1 ? header.slice(a) : header.slice(a, b)).trim()));
  const rows = [];
  for (const line of lines.slice(sepIdx + 1)) {
    if (!line.trim()) continue;
    const row = {};
    spans.forEach(([a, b], i) => {
      row[cols[i]] = (i === spans.length - 1 ? line.slice(a) : line.slice(a, b)).trim();
    });
    rows.push(row);
  }
  return rows;
}

/**
 * esxcli "get" / nested-list output. A record starts at an unindented title
 * line (`vswitch standard list`) OR after a blank line (`vm port list`, which
 * emits every vNIC as an indented block with no title), and indented
 * "Key: value" lines fill it. A key repeating inside a record also starts a new
 * one, so a missing separator cannot silently merge two vNICs into one.
 */
function parseIndentedBlocks(text) {
  const records = [];
  let cur = null;
  for (const raw of String(text).replace(/\r/g, "").split("\n")) {
    if (!raw.trim()) { cur = null; continue; }
    const indented = /^\s/.test(raw);
    const kv = raw.trim().match(/^([^:]+):\s*(.*)$/);
    if (!indented) {
      cur = { _title: raw.trim() };
      records.push(cur);
      if (kv) cur[camel(kv[1])] = kv[2].trim();
      continue;
    }
    if (!kv) continue;
    const key = camel(kv[1]);
    if (!cur || key in cur) { cur = {}; records.push(cur); }
    cur[key] = kv[2].trim();
  }
  // a bare "get" with no title line still produces one usable record
  return records;
}

function parseEsxcliText(text) {
  return /^-{2,}(\s+-{2,})+\s*$/m.test(text) ? parseDashTable(text) : parseIndentedBlocks(text);
}

function tryJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/** First present value among several possible key spellings. */
function pick(obj, ...keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return undefined;
}

function csvList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return String(v ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x && x !== "None");
}

function boolish(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (["true", "yes", "1", "allow", "accept", "enabled", "up"].includes(s)) return true;
  if (["false", "no", "0", "reject", "deny", "disabled", "down"].includes(s)) return false;
  return null;
}

const normMac = (m) => String(m ?? "").trim().toLowerCase().replace(/-/g, ":");

/* ---------------------------------------------------------------- collectors */

/** Run one esxcli namespace, JSON first, text parsing as fallback. */
async function esxcli(conn, args, { timeoutMs = 30000 } = {}) {
  const j = await sshExec(conn, `esxcli --formatter=json ${args}`, { timeoutMs });
  if (j.code === 0) {
    const parsed = tryJson(j.stdout.trim());
    if (parsed) {
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      return { rows: camelKeys(arr), raw: j.stdout, format: "json" };
    }
  }
  const p = await sshExec(conn, `esxcli ${args}`, { timeoutMs });
  if (p.code !== 0) {
    const msg = (p.stderr || p.stdout || "").trim().split("\n").filter(Boolean)[0] || `exit ${p.code}`;
    throw new Error(`esxcli ${args}: ${msg}`);
  }
  return { rows: parseEsxcliText(p.stdout), raw: p.stdout, format: "text" };
}

async function collectVersion(conn) {
  try {
    const { rows } = await esxcli(conn, "system version get");
    const r = rows[0] || {};
    return {
      product: pick(r, "product") || "VMware ESXi",
      version: pick(r, "version") || "",
      build: pick(r, "build") || "",
    };
  } catch {
    const { stdout } = await sshExec(conn, "vmware -v", { timeoutMs: 15000 });
    return { product: stdout.trim() || "unknown", version: "", build: "" };
  }
}

async function collectVswitches(conn) {
  const out = [];
  try {
    const { rows } = await esxcli(conn, "network vswitch standard list");
    for (const r of rows) {
      const name = pick(r, "name", "_title");
      if (!name) continue;
      out.push({
        name,
        kind: "standard",
        mtu: parseInt(pick(r, "mTU", "mtu") ?? "1500", 10) || 1500,
        uplinks: csvList(pick(r, "uplinks")),
        portgroups: csvList(pick(r, "portgroups")),
      });
    }
  } catch { /* no standard switches, or command unavailable */ }
  try {
    const { rows } = await esxcli(conn, "network vswitch dvs vmware list");
    for (const r of rows) {
      const name = pick(r, "name", "_title");
      if (!name) continue;
      out.push({
        name,
        kind: "dvs",
        mtu: parseInt(pick(r, "mTU", "mtu") ?? "1500", 10) || 1500,
        uplinks: csvList(pick(r, "uplinks")),
        portgroups: csvList(pick(r, "portgroups", "vLANs")),
      });
    }
  } catch { /* host has no distributed switch */ }
  return out;
}

async function collectPortgroups(conn, vswitches) {
  const out = [];
  try {
    const { rows } = await esxcli(conn, "network vswitch standard portgroup list");
    for (const r of rows) {
      const name = pick(r, "name", "_title");
      if (!name) continue;
      const vlanRaw = pick(r, "vLANID", "vlanId", "vLANId");
      out.push({
        name,
        vswitch: pick(r, "virtualSwitch", "vSwitch") || "",
        vlan: vlanRaw === undefined ? null : parseInt(vlanRaw, 10),
        activeClients: parseInt(pick(r, "activeClients") ?? "0", 10) || 0,
        kind: "standard",
      });
    }
  } catch { /* ignore */ }
  // distributed portgroups: name only, VLAN lives on the vCenter side
  for (const vs of vswitches.filter((v) => v.kind === "dvs")) {
    for (const pg of vs.portgroups) {
      if (!out.some((p) => p.name === pg)) {
        out.push({ name: pg, vswitch: vs.name, vlan: null, activeClients: 0, kind: "dvs" });
      }
    }
  }
  return out;
}

/** Security policy per standard portgroup — inherited values show as blank. */
async function collectPortgroupSecurity(conn, portgroups) {
  const sec = {};
  for (const pg of portgroups.filter((p) => p.kind === "standard")) {
    try {
      const { rows } = await esxcli(
        conn, `network vswitch standard portgroup policy security get -p ${shq(pg.name)}`);
      const r = rows[0] || {};
      sec[pg.name] = {
        promiscuous: boolish(pick(r, "allowPromiscuous", "promiscuousMode")),
        macChanges: boolish(pick(r, "allowMACAddressChange", "mACAddressChanges", "macAddressChanges")),
        forgedTransmits: boolish(pick(r, "allowForgedTransmits", "forgedTransmits")),
      };
    } catch { sec[pg.name] = { promiscuous: null, macChanges: null, forgedTransmits: null }; }
  }
  for (const vs of new Set(portgroups.filter((p) => p.kind === "standard").map((p) => p.vswitch))) {
    if (!vs) continue;
    try {
      const { rows } = await esxcli(conn, `network vswitch standard policy security get -v ${shq(vs)}`);
      const r = rows[0] || {};
      sec[`vswitch:${vs}`] = {
        promiscuous: boolish(pick(r, "allowPromiscuous", "promiscuousMode")),
        macChanges: boolish(pick(r, "allowMACAddressChange", "mACAddressChanges", "macAddressChanges")),
        forgedTransmits: boolish(pick(r, "allowForgedTransmits", "forgedTransmits")),
      };
    } catch { /* ignore */ }
  }
  return sec;
}

async function collectPnics(conn) {
  try {
    const { rows } = await esxcli(conn, "network nic list");
    return rows
      .map((r) => ({
        name: pick(r, "name", "_title") || "",
        mac: normMac(pick(r, "mACAddress", "macAddress", "mac")),
        mtu: parseInt(pick(r, "mTU", "mtu") ?? "1500", 10) || 1500,
        linkUp: boolish(pick(r, "linkStatus", "link")) === true ||
                /^up$/i.test(String(pick(r, "linkStatus", "link") ?? "")),
        speed: String(pick(r, "speed") ?? ""),
        driver: String(pick(r, "driver") ?? ""),
      }))
      .filter((n) => n.name);
  } catch { return []; }
}

/** VM inventory (registered VMs, powered on or off). */
async function collectInventory(conn) {
  const { stdout } = await sshExec(conn, "vim-cmd vmsvc/getallvms", { timeoutMs: 40000 });
  const vms = [];
  for (const line of stdout.replace(/\r/g, "").split("\n")) {
    const m = line.match(/^(\d+)\s{2,}(.+?)\s{2,}\[/);
    if (m) vms.push({ vmid: m[1], name: m[2].trim() });
  }
  return vms;
}

/**
 * Per-VM vNIC ports: portgroup, vSwitch, MAC and (when VMware Tools reports it)
 * the guest IP. This is the authoritative "what is this vNIC plugged into".
 */
async function collectVmPorts(conn) {
  const vms = [];
  let rows = [];
  try { ({ rows } = await esxcli(conn, "network vm list")); } catch { return vms; }
  for (const r of rows) {
    const worldId = String(pick(r, "worldID", "worldId", "world") ?? "").trim();
    const name = pick(r, "name", "_title");
    if (!worldId || !name) continue;
    const vm = { name, worldId, networks: csvList(pick(r, "networks")), ports: [] };
    try {
      const { rows: prows } = await esxcli(conn, `network vm port list -w ${worldId}`);
      for (const p of prows) {
        vm.ports.push({
          portId: String(pick(p, "portID", "portId") ?? ""),
          vswitch: pick(p, "vSwitch", "virtualSwitch", "portset") || "",
          portgroup: pick(p, "portgroup", "portGroup", "dVPortID", "dVPortId") || "",
          mac: normMac(pick(p, "mACAddress", "macAddress", "mac")),
          ip: pick(p, "iPAddress", "ipAddress", "ip") || "",
          teamUplink: pick(p, "teamUplink") || "",
          uplinkPortId: String(pick(p, "uplinkPortID", "uplinkPortId") ?? ""),
          filters: pick(p, "activeFilters", "filters") || "",
        });
      }
    } catch { /* VM may have powered off between the two calls */ }
    vms.push(vm);
  }
  return vms;
}

function shq(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

/**
 * Collect everything we need from the ESXi host. Individual collectors degrade
 * to empty rather than aborting the whole run — a host that refuses
 * `vim-cmd` still gives us portgroups and MACs, which is what the L2 verdict
 * actually rests on.
 */
async function collectEsxi(creds, log = () => {}) {
  const conn = await sshConnect(creds, { onWarn: log });
  try {
    log(`ESXi ${creds.host}: connected as ${creds.user}`);
    const version = await collectVersion(conn);
    log(`ESXi ${creds.host}: ${version.product} ${version.version} build ${version.build}`);

    const vswitches = await collectVswitches(conn);
    log(`ESXi: ${vswitches.length} virtual switch(es): ${vswitches.map((v) => v.name).join(", ") || "none"}`);

    const portgroups = await collectPortgroups(conn, vswitches);
    log(`ESXi: ${portgroups.length} portgroup(s)`);

    const security = await collectPortgroupSecurity(conn, portgroups);
    const pnics = await collectPnics(conn);
    log(`ESXi: ${pnics.length} physical NIC(s), ${pnics.filter((n) => n.linkUp).length} up`);

    let inventory = [];
    try { inventory = await collectInventory(conn); }
    catch (e) { log(`WARN: vim-cmd inventory unavailable (${e.message})`); }

    const vms = await collectVmPorts(conn);
    log(`ESXi: ${vms.length} powered-on VM(s) with ${vms.reduce((n, v) => n + v.ports.length, 0)} vNIC port(s)`);

    return { ok: true, host: creds.host, version, vswitches, portgroups, security, pnics, inventory, vms };
  } finally {
    conn.end();
  }
}

/* ------------------------------------------------------------------ lookups */

function findVm(esxi, vmName) {
  if (!esxi || !esxi.ok || !vmName) return null;
  const want = String(vmName).trim().toLowerCase();
  return (
    esxi.vms.find((v) => v.name.toLowerCase() === want) ||
    esxi.vms.find((v) => v.name.toLowerCase().includes(want)) ||
    null
  );
}

function portgroupInfo(esxi, pgName) {
  if (!esxi || !esxi.ok || !pgName) return null;
  return esxi.portgroups.find((p) => p.name === pgName) || null;
}

function vswitchInfo(esxi, vsName) {
  if (!esxi || !esxi.ok || !vsName) return null;
  return esxi.vswitches.find((v) => v.name === vsName) || null;
}

/** Effective security policy for a port: portgroup override, else vSwitch. */
function securityFor(esxi, port) {
  if (!esxi || !esxi.ok || !port) return { promiscuous: null, macChanges: null, forgedTransmits: null };
  const pg = esxi.security[port.portgroup] || {};
  const vs = esxi.security[`vswitch:${port.vswitch}`] || {};
  const merge = (k) => (pg[k] === null || pg[k] === undefined ? (vs[k] ?? null) : pg[k]);
  return { promiscuous: merge("promiscuous"), macChanges: merge("macChanges"), forgedTransmits: merge("forgedTransmits") };
}

/** All vNIC ports on the host, flattened, for duplicate-MAC detection. */
function allPorts(esxi) {
  if (!esxi || !esxi.ok) return [];
  return esxi.vms.flatMap((v) => v.ports.map((p) => ({ ...p, vm: v.name })));
}

module.exports = {
  collectEsxi,
  esxcli,
  findVm,
  portgroupInfo,
  vswitchInfo,
  securityFor,
  allPorts,
  // parsing internals (unit-tested)
  parseDashTable,
  parseIndentedBlocks,
  parseEsxcliText,
  camel,
  camelKeys,
  boolish,
  csvList,
  normMac,
  pick,
};
