/**
 * Guest collectors + active probes — the L3 half of the picture, plus the
 * in-guest evidence needed to confirm an L2 verdict (link state, MAC, ARP).
 *
 * Everything here is read-only on the node. The only "writes" are ICMP probes
 * (ping / arping / traceroute), which are what an engineer would run by hand.
 * Parsers are exported separately so they can be unit-tested without a lab.
 */

"use strict";

const { sshConnect, sshExec, sudoExec } = require("./ssh");
const { cidrOf } = require("./ipmath");

const normMac = (m) => String(m ?? "").trim().toLowerCase().replace(/-/g, ":");

/* ------------------------------------------------------------------ parsers */

/** `ip -o -d link show` -> [{iface, mac, state, mtu, master, kind, flags}] */
function parseIpLink(text) {
  const out = [];
  for (const raw of String(text).replace(/\r/g, "").split("\n")) {
    const line = raw.replace(/\\\s+/g, " ").trim();
    if (!line) continue;
    const m = line.match(/^\d+:\s+([^:@]+)(?:@\S+)?:\s+<([^>]*)>\s+(.*)$/);
    if (!m) continue;
    const iface = m[1].trim();
    if (iface === "lo") continue;
    const flags = m[2].split(",").filter(Boolean);
    const rest = m[3];
    const mtu = parseInt((rest.match(/\bmtu\s+(\d+)/) || [])[1] ?? "0", 10) || null;
    const state = ((rest.match(/\bstate\s+(\S+)/) || [])[1] || "").toUpperCase();
    const mac = normMac((rest.match(/link\/ether\s+([0-9a-f:]{17})/i) || [])[1] || "");
    const master = (rest.match(/\bmaster\s+(\S+)/) || [])[1] || null;
    let kind = "device";
    if (/\bbridge_slave\b/.test(rest)) kind = "bridge_slave";
    else if (/\bbridge\b/.test(rest)) kind = "bridge";
    else if (/\bvlan\b/.test(rest)) kind = "vlan";
    else if (/\bbond\b/.test(rest)) kind = "bond";
    out.push({
      iface, mac, state, mtu, master, kind, flags,
      carrier: !flags.includes("NO-CARRIER"),
      up: flags.includes("UP"),
    });
  }
  return out;
}

/** `ip -o -4 addr show` -> [{iface, ip, prefix, cidr}] */
function parseIpAddr(text) {
  const out = [];
  for (const line of String(text).replace(/\r/g, "").split("\n")) {
    const m = line.match(/^\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)\/(\d+)/);
    if (!m || m[1] === "lo") continue;
    const prefix = parseInt(m[3], 10);
    out.push({ iface: m[1], ip: m[2], prefix, cidr: cidrOf(m[2], prefix) });
  }
  return out;
}

/** `ip -4 route show` -> [{dst, via, dev, src, metric, proto, raw}] */
function parseIpRoute(text) {
  const out = [];
  for (const raw of String(text).replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (!line || /^\s/.test(raw) === false && !/\S/.test(line)) continue;
    const first = line.split(/\s+/)[0];
    if (!first || first === "cache" || first === "unreachable") continue;
    out.push({
      dst: first,
      via: (line.match(/\bvia\s+(\d+\.\d+\.\d+\.\d+)/) || [])[1] || null,
      dev: (line.match(/\bdev\s+(\S+)/) || [])[1] || null,
      src: (line.match(/\bsrc\s+(\d+\.\d+\.\d+\.\d+)/) || [])[1] || null,
      metric: parseInt((line.match(/\bmetric\s+(\d+)/) || [])[1] ?? "", 10) || null,
      proto: (line.match(/\bproto\s+(\S+)/) || [])[1] || null,
      raw: line,
    });
  }
  return out;
}

/** `ip -4 neigh show` -> [{ip, dev, mac, state}] */
function parseIpNeigh(text) {
  const out = [];
  for (const raw of String(text).replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d+\.\d+\.\d+\.\d+)\s+dev\s+(\S+)(.*)$/);
    if (!m) continue;
    const rest = m[3];
    out.push({
      ip: m[1],
      dev: m[2],
      mac: normMac((rest.match(/lladdr\s+([0-9a-f:]{17})/i) || [])[1] || ""),
      state: (rest.trim().split(/\s+/).pop() || "").toUpperCase(),
    });
  }
  return out;
}

/** `ip route get <dst>` -> {via, dev, src, unreachable, raw} */
function parseRouteGet(text) {
  const t = String(text).replace(/\r/g, "").trim();
  const unreachable = /Network is unreachable|No route to host|RTNETLINK answers/i.test(t);
  const first = t.split("\n")[0] || "";
  return {
    unreachable,
    local: /\blocal\b/.test(first),
    via: (first.match(/\bvia\s+(\d+\.\d+\.\d+\.\d+)/) || [])[1] || null,
    dev: (first.match(/\bdev\s+(\S+)/) || [])[1] || null,
    src: (first.match(/\bsrc\s+(\d+\.\d+\.\d+\.\d+)/) || [])[1] || null,
    raw: t,
  };
}

/** `ping` output -> {sent, received, lossPct, rttAvgMs, ok, raw} */
function parsePing(text) {
  const t = String(text).replace(/\r/g, "");
  const m = t.match(/(\d+)\s+packets transmitted,\s+(\d+)\s+(?:packets\s+)?received/);
  const sent = m ? parseInt(m[1], 10) : 0;
  const received = m ? parseInt(m[2], 10) : 0;
  const rtt = t.match(/=\s*[\d.]+\/([\d.]+)\/[\d.]+/);
  const lossPct = sent ? Math.round(((sent - received) / sent) * 1000) / 10 : 100;
  return {
    sent,
    received,
    lossPct,
    rttAvgMs: rtt ? parseFloat(rtt[1]) : null,
    ok: received > 0,
    frag: /Frag needed|Message too long|message too long/i.test(t),
    unreachable: /Destination Host Unreachable|Destination Net Unreachable|Network is unreachable/i.test(t),
    raw: t.trim(),
  };
}

/** traceroute / tracepath / TTL-sweep output -> [{ttl, ip, rttMs, timeout}] */
function parseTraceroute(text) {
  const hops = [];
  const t = String(text).replace(/\r/g, "");
  // TTL sweep marker format emitted by ttlSweepCmd()
  if (/^TTL=\d+/m.test(t)) {
    let ttl = null;
    for (const line of t.split("\n")) {
      const mk = line.match(/^TTL=(\d+)/);
      if (mk) { ttl = parseInt(mk[1], 10); continue; }
      if (ttl === null) continue;
      const from = line.match(/From\s+(\d+\.\d+\.\d+\.\d+)/) || line.match(/from\s+(\d+\.\d+\.\d+\.\d+)/);
      const bytes = line.match(/bytes from\s+(\d+\.\d+\.\d+\.\d+)/);
      if (bytes) hops.push({ ttl, ip: bytes[1], timeout: false, final: true });
      else if (from) hops.push({ ttl, ip: from[1], timeout: false });
      else if (line.trim()) hops.push({ ttl, ip: null, timeout: true });
      ttl = null;
    }
    return hops;
  }
  for (const line of t.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const ttl = parseInt(m[1], 10);
    const body = m[2];
    const ip = (body.match(/(\d+\.\d+\.\d+\.\d+)/) || [])[1] || null;
    const rtt = parseFloat((body.match(/([\d.]+)\s*ms/) || [])[1] ?? "");
    hops.push({ ttl, ip, rttMs: Number.isFinite(rtt) ? rtt : null, timeout: !ip });
  }
  return hops;
}

/** `iptables -S` -> {policies:{CHAIN:TARGET}, dropRules:[...], raw} */
function parseIptables(text) {
  const t = String(text).replace(/\r/g, "");
  const policies = {};
  const dropRules = [];
  for (const line of t.split("\n")) {
    const p = line.match(/^-P\s+(\S+)\s+(\S+)/);
    if (p) { policies[p[1]] = p[2]; continue; }
    if (/^-A\s+\S+/.test(line) && /-j\s+(DROP|REJECT)\b/.test(line)) dropRules.push(line.trim());
  }
  return { policies, dropRules, raw: t.trim() };
}

/** `for f in /proc/sys/.../rp_filter; do ...` -> {ifaceOrAll: value} */
function parseSysctlDump(text) {
  const out = {};
  for (const line of String(text).replace(/\r/g, "").split("\n")) {
    const m = line.match(/^(\S+)=(\S*)$/);
    if (!m) continue;
    const name = m[1].replace("/proc/sys/net/ipv4/conf/", "").replace("/rp_filter", "");
    out[name] = m[2];
  }
  return out;
}

/* ----------------------------------------------------------- shell fragments */

const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

function ttlSweepCmd(dst, maxHops) {
  return `for t in $(seq 1 ${maxHops}); do echo "TTL=$t"; ` +
    `ping -n -c1 -W1 -t $t ${shq(dst)} 2>&1 | sed -n '2p'; done`;
}

/* ---------------------------------------------------------------- collection */

/**
 * Collect one node's networking state. Missing tooling degrades to a null
 * section instead of failing the run.
 */
async function collectNode(role, creds, log = () => {}) {
  const node = {
    role,
    host: creds.host,
    user: creds.user,
    vmName: creds.vmName || "",
    dataIp: creds.dataIp || "",
    reachable: false,
    error: null,
  };
  let conn;
  try {
    conn = await sshConnect(creds, { onWarn: log });
  } catch (e) {
    node.error = e.message;
    log(`ERROR: ${role} (${creds.host}) unreachable over SSH: ${e.message}`);
    return { node, conn: null };
  }
  node.reachable = true;
  log(`${role} (${creds.host}): connected as ${creds.user}`);

  const run = (cmd, ms = 20000) => sshExec(conn, cmd, { timeoutMs: ms });

  node.hostname = (await run("hostname")).stdout.trim();
  node.kernel = (await run("uname -sr")).stdout.trim();
  node.links = parseIpLink((await run("ip -o -d link show")).stdout);
  node.addrs = parseIpAddr((await run("ip -o -4 addr show")).stdout);
  node.routes = parseIpRoute((await run("ip -4 route show")).stdout);
  node.neigh = parseIpNeigh((await run("ip -4 neigh show")).stdout);

  node.ipForward = (await run("cat /proc/sys/net/ipv4/ip_forward")).stdout.trim() === "1";
  node.rpFilter = parseSysctlDump(
    (await run('for f in /proc/sys/net/ipv4/conf/*/rp_filter; do echo "$f=$(cat $f)"; done')).stdout);

  const tc = await run("tc -s qdisc show");
  node.tcQdisc = tc.code === 0 ? tc.stdout.trim() : "";
  node.netemActive = /\bnetem\b/.test(node.tcQdisc);

  const br = await run("bridge link show 2>/dev/null || true");
  node.bridgeRaw = br.stdout.trim();
  node.bridges = node.links
    .filter((l) => l.kind === "bridge")
    .map((b) => ({
      name: b.iface,
      mtu: b.mtu,
      state: b.state,
      members: node.links.filter((l) => l.master === b.iface).map((l) => l.iface),
    }));

  const ipt = await sudoExec(conn, creds, "iptables -S", { timeoutMs: 20000 });
  node.firewall = ipt.code === 0 ? parseIptables(ipt.stdout) : null;
  if (!node.firewall) {
    const nft = await sudoExec(conn, creds, "nft list ruleset", { timeoutMs: 20000 });
    node.nftRaw = nft.code === 0 ? nft.stdout.trim().slice(0, 4000) : "";
    if (!node.nftRaw) log(`WARN: ${role}: could not read the firewall (needs sudo) — skipping filter checks`);
  }

  const tools = await run("for b in ping traceroute tracepath arping mtr; do command -v $b >/dev/null && echo $b; done");
  node.tools = tools.stdout.split("\n").map((s) => s.trim()).filter(Boolean);

  return { node, conn };
}

/* -------------------------------------------------------------------- probes */

/**
 * Prove (or disprove) L2 adjacency to a peer on the same subnet:
 *   1. ping the peer so the kernel is forced to ARP for it
 *   2. read the resulting neighbour entry
 *   3. when available, arping — which answers at L2 even if ICMP is filtered
 */
async function probeAdjacency(conn, creds, { iface, srcIp, peerIp, count = 3 }) {
  const bind = srcIp ? `-I ${shq(srcIp)}` : iface ? `-I ${shq(iface)}` : "";
  const ping = parsePing(
    (await sshExec(conn, `ping -n -c ${count} -W 2 ${bind} ${shq(peerIp)} 2>&1`, { timeoutMs: 20000 })).stdout);
  const neighOut = await sshExec(conn, `ip -4 neigh show ${shq(peerIp)}`, { timeoutMs: 10000 });
  const neigh = parseIpNeigh(neighOut.stdout).find((n) => n.ip === peerIp) || null;

  let arping = null;
  const ar = await sudoExec(conn, creds,
    `arping -c 2 -w 3 ${iface ? `-I ${shq(iface)}` : ""} ${shq(peerIp)}`, { timeoutMs: 15000 });
  if (ar.code !== 127 && !/command not found|not found/i.test(ar.stderr + ar.stdout)) {
    const reply = ar.stdout.match(/reply from\s+\S+\s+\[([0-9a-fA-F:]{17})\]/);
    arping = {
      ok: /Received \d+ repl/i.test(ar.stdout) ? !/Received 0 repl/i.test(ar.stdout) : /reply from/i.test(ar.stdout),
      mac: reply ? normMac(reply[1]) : "",
      raw: ar.stdout.trim().slice(0, 800),
    };
  }
  return { iface, srcIp, peerIp, ping, neigh, arping };
}

async function probeRouteGet(conn, dst, srcIp = null) {
  const r = await sshExec(conn, `ip -4 route get ${shq(dst)}${srcIp ? ` from ${shq(srcIp)}` : ""} 2>&1`,
    { timeoutMs: 10000 });
  return parseRouteGet(r.stdout || r.stderr);
}

async function probePing(conn, dst, { srcIp = null, count = 3, size = null, df = false, timeoutMs = 25000 } = {}) {
  const parts = ["ping", "-n", `-c ${count}`, "-W 2"];
  if (srcIp) parts.push(`-I ${shq(srcIp)}`);
  if (df) parts.push("-M do");
  if (size) parts.push(`-s ${size}`);
  parts.push(shq(dst), "2>&1");
  const r = await sshExec(conn, parts.join(" "), { timeoutMs });
  return parsePing(r.stdout);
}

/** traceroute with graceful degradation: traceroute -> tracepath -> TTL sweep */
async function probeTraceroute(conn, dst, { srcIp = null, maxHops = 12, tools = [] } = {}) {
  const has = (t) => tools.includes(t);
  let cmd;
  let via;
  if (has("traceroute")) {
    cmd = `traceroute -n -w 1 -q 1 -m ${maxHops}${srcIp ? ` -s ${shq(srcIp)}` : ""} ${shq(dst)} 2>&1`;
    via = "traceroute";
  } else if (has("tracepath")) {
    cmd = `tracepath -n -m ${maxHops} ${shq(dst)} 2>&1`;
    via = "tracepath";
  } else {
    cmd = ttlSweepCmd(dst, maxHops);
    via = "ping TTL sweep";
  }
  const r = await sshExec(conn, cmd, { timeoutMs: Math.max(30000, maxHops * 4000) });
  return { via, hops: parseTraceroute(r.stdout), raw: r.stdout.trim().slice(0, 4000) };
}

module.exports = {
  collectNode,
  probeAdjacency,
  probeRouteGet,
  probePing,
  probeTraceroute,
  // parsers (unit-tested)
  parseIpLink,
  parseIpAddr,
  parseIpRoute,
  parseIpNeigh,
  parseRouteGet,
  parsePing,
  parseTraceroute,
  parseIptables,
  parseSysctlDump,
  normMac,
};
