#!/usr/bin/env node
/**
 * Tests for the parsers and the L2/L3 decision engine, run against synthetic
 * facts so the logic can be verified without a lab. No test framework, in
 * keeping with the rest of the repo:  node test/run_tests.js
 */

"use strict";

const assert = require("assert");
const esxi = require("../lib/esxi");
const guest = require("../lib/guest");
const diagnose = require("../lib/diagnose");
const ip = require("../lib/ipmath");

let pass = 0;
const failures = [];

function test(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { failures.push({ name, e }); console.log(`FAIL  ${name}\n      ${e.message}`); }
}

/* ==================================================== parsers: esxcli text */

test("parseDashTable slices by the dash row, keeping spaces in values", () => {
  const rows = esxi.parseDashTable(`
Name                 Virtual Switch   Active Clients  VLAN ID
-------------------  ---------------  --------------  -------
VM Network           vSwitch0                      2        0
Client-Seg           vSwitch1                      1       10
`);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].name, "VM Network");
  assert.strictEqual(rows[0].virtualSwitch, "vSwitch0");
  assert.strictEqual(rows[1].name, "Client-Seg");
  assert.strictEqual(rows[1].vLANID, "10");
});

test("parseIndentedBlocks reads esxcli vswitch list records", () => {
  const rows = esxi.parseIndentedBlocks(`vSwitch0
   Name: vSwitch0
   Num Ports: 2560
   MTU: 1500
   Uplinks: vmnic0
   Portgroups: Management Network, VM Network
vSwitch1
   Name: vSwitch1
   MTU: 9000
   Uplinks:
   Portgroups: Client-Seg, Spoke-Seg
`);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].mTU, "1500");
  assert.deepStrictEqual(esxi.csvList(rows[0].portgroups), ["Management Network", "VM Network"]);
  assert.deepStrictEqual(esxi.csvList(rows[1].uplinks), []);
});

test("parseIndentedBlocks splits `vm port list` blocks on blank lines", () => {
  // every vNIC is an indented block with no title line — merging them would
  // lose the portgroup/MAC pairing the whole L2 verdict rests on
  const rows = esxi.parseIndentedBlocks(`   Port ID: 33554438
   vSwitch: vSwitch1
   Portgroup: PG-CS
   DVPort ID:
   MAC Address: 00:50:56:00:00:01
   IP Address: 0.0.0.0
   Team Uplink: void
   Uplink Port ID: 0
   Active Filters:

   Port ID: 33554439
   vSwitch: vSwitch1
   Portgroup: PG-SN
   DVPort ID:
   MAC Address: 00:50:56:00:00:03
   IP Address: 0.0.0.0
   Team Uplink: void
   Uplink Port ID: 0
   Active Filters:
`);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].portgroup, "PG-CS");
  assert.strictEqual(rows[0].mACAddress, "00:50:56:00:00:01");
  assert.strictEqual(rows[1].portgroup, "PG-SN");
  assert.strictEqual(rows[1].mACAddress, "00:50:56:00:00:03");
});

test("parseIndentedBlocks starts a new record when a key repeats", () => {
  const rows = esxi.parseIndentedBlocks(`   Port ID: 1
   Portgroup: A
   Port ID: 2
   Portgroup: B
`);
  assert.deepStrictEqual(rows.map((r) => r.portgroup), ["A", "B"]);
});

test("boolish maps ESXi allow/reject wording", () => {
  assert.strictEqual(esxi.boolish("Reject"), false);
  assert.strictEqual(esxi.boolish("true"), true);
  assert.strictEqual(esxi.boolish("weird"), null);
});

/* ===================================================== parsers: guest text */

test("parseIpLink picks up MAC, state, master and bridge kind", () => {
  const links = guest.parseIpLink(
    `1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN \\    link/ether 00:00:00:00:00:00
2: ens192: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq master br0 state UP \\    link/ether 00:50:56:aa:bb:01 brd ff:ff:ff:ff:ff:ff promiscuity 1 \\    bridge_slave state forwarding
3: ens224: <BROADCAST,MULTICAST> mtu 1500 qdisc noop state DOWN \\    link/ether 00:50:56:aa:bb:02
4: br0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP \\    link/ether 00:50:56:aa:bb:01 \\    bridge forward_delay 200`);
  assert.strictEqual(links.length, 3, "lo is dropped");
  assert.strictEqual(links[0].iface, "ens192");
  assert.strictEqual(links[0].mac, "00:50:56:aa:bb:01");
  assert.strictEqual(links[0].master, "br0");
  assert.strictEqual(links[0].kind, "bridge_slave");
  assert.strictEqual(links[1].state, "DOWN");
  assert.strictEqual(links[1].up, false);
  assert.strictEqual(links[2].kind, "bridge");
});

test("parseIpLink flags NO-CARRIER as no carrier", () => {
  const [l] = guest.parseIpLink(
    "2: ens192: <NO-CARRIER,BROADCAST,MULTICAST,UP> mtu 1500 qdisc mq state DOWN \\    link/ether 00:50:56:aa:bb:01");
  assert.strictEqual(l.carrier, false);
});

test("parseIpAddr / parseIpNeigh / parseRouteGet", () => {
  const addrs = guest.parseIpAddr(
    `2: ens192    inet 10.10.1.2/24 brd 10.10.1.255 scope global ens192\\       valid_lft forever
1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever`);
  assert.deepStrictEqual(addrs, [{ iface: "ens192", ip: "10.10.1.2", prefix: 24, cidr: "10.10.1.0/24" }]);

  const neigh = guest.parseIpNeigh(
    `10.10.1.1 dev ens192 lladdr 00:50:56:aa:bb:10 REACHABLE
10.10.1.9 dev ens192  FAILED`);
  assert.strictEqual(neigh[0].mac, "00:50:56:aa:bb:10");
  assert.strictEqual(neigh[0].state, "REACHABLE");
  assert.strictEqual(neigh[1].state, "FAILED");
  assert.strictEqual(neigh[1].mac, "");

  const rg = guest.parseRouteGet("10.10.9.2 via 10.10.1.1 dev ens192 src 10.10.1.2 uid 0 \n    cache");
  assert.strictEqual(rg.via, "10.10.1.1");
  assert.strictEqual(rg.dev, "ens192");
  assert.strictEqual(rg.unreachable, false);
  assert.strictEqual(guest.parseRouteGet("RTNETLINK answers: Network is unreachable").unreachable, true);
});

test("parsePing extracts loss and average RTT", () => {
  const p = guest.parsePing(`PING 10.10.9.2 (10.10.9.2) 56(84) bytes of data.
64 bytes from 10.10.9.2: icmp_seq=1 ttl=62 time=31.2 ms

--- 10.10.9.2 ping statistics ---
4 packets transmitted, 3 received, 25% packet loss, time 3005ms
rtt min/avg/max/mdev = 30.100/31.400/32.900/1.100 ms`);
  assert.strictEqual(p.sent, 4);
  assert.strictEqual(p.received, 3);
  assert.strictEqual(p.lossPct, 25);
  assert.strictEqual(p.rttAvgMs, 31.4);
  assert.strictEqual(p.ok, true);

  const dead = guest.parsePing("4 packets transmitted, 0 received, 100% packet loss, time 3050ms");
  assert.strictEqual(dead.ok, false);
  assert.strictEqual(dead.lossPct, 100);
});

test("parseTraceroute handles traceroute and the TTL-sweep fallback", () => {
  const hops = guest.parseTraceroute(` 1  10.10.1.1  0.412 ms
 2  *
 3  10.10.9.2  31.8 ms`);
  assert.strictEqual(hops.length, 3);
  assert.strictEqual(hops[0].ip, "10.10.1.1");
  assert.strictEqual(hops[1].timeout, true);
  assert.strictEqual(hops[2].ip, "10.10.9.2");

  const sweep = guest.parseTraceroute(`TTL=1
From 10.10.1.1 icmp_seq=1 Time to live exceeded
TTL=2
From 10.10.2.1 icmp_seq=1 Time to live exceeded
TTL=3
`);
  assert.deepStrictEqual(sweep.map((h) => h.ip), ["10.10.1.1", "10.10.2.1"]);
});

test("parseIptables separates policies from drop rules", () => {
  const fw = guest.parseIptables(`-P INPUT ACCEPT
-P FORWARD DROP
-P OUTPUT ACCEPT
-A FORWARD -s 10.10.1.0/24 -j DROP
-A INPUT -p icmp -j ACCEPT`);
  assert.strictEqual(fw.policies.FORWARD, "DROP");
  assert.strictEqual(fw.dropRules.length, 1);
});

/* ============================================================== ip maths */

test("sameSubnet is symmetric and mask-aware", () => {
  assert.ok(ip.sameSubnet({ ip: "10.10.1.2", prefix: 24 }, { ip: "10.10.1.3", prefix: 24 }));
  assert.ok(!ip.sameSubnet({ ip: "10.10.1.2", prefix: 24 }, { ip: "10.10.2.3", prefix: 24 }));
  // /24 vs /25: .200 is outside the peer's /25, so they are not adjacent
  assert.ok(!ip.sameSubnet({ ip: "10.10.1.200", prefix: 24 }, { ip: "10.10.1.3", prefix: 25 }));
  assert.ok(ip.sameSubnet({ ip: "10.10.1.100", prefix: 24 }, { ip: "10.10.1.3", prefix: 25 }));
});

/* ======================================================= synthetic testbed */

const MAC = {
  client: "00:50:56:00:00:01",
  spokeA: "00:50:56:00:00:02",
  spokeB: "00:50:56:00:00:03",
  netemA: "00:50:56:00:00:04",
  netemB: "00:50:56:00:00:05",
  hubA: "00:50:56:00:00:06",
  hubB: "00:50:56:00:00:07",
  server: "00:50:56:00:00:08",
};
// management vNICs — every VM really does have one, and the engine relies on
// matching them to keep the positional fallback honest
const MGMT = {
  client: "00:50:56:ff:00:01",
  spoke: "00:50:56:ff:00:02",
  hub: "00:50:56:ff:00:03",
  server: "00:50:56:ff:00:04",
  netem: "00:50:56:ff:00:05",
};

function port(pg, vswitch, mac, portId) {
  return { portId: String(portId), vswitch, portgroup: pg, mac, ip: "", teamUplink: "", uplinkPortId: "", filters: "" };
}

/** ESXi facts for the reference wiring; `over` lets a test bend one thing. */
function esxiFacts(over = {}) {
  const pgs = over.portgroups || [
    { name: "MGMT", vswitch: "vSwitch0", vlan: 0, activeClients: 5, kind: "standard" },
    { name: "PG-CS", vswitch: "vSwitch1", vlan: 10, activeClients: 2, kind: "standard" },
    { name: "PG-SN", vswitch: "vSwitch1", vlan: 20, activeClients: 2, kind: "standard" },
    { name: "PG-NH", vswitch: "vSwitch1", vlan: 30, activeClients: 2, kind: "standard" },
    { name: "PG-HS", vswitch: "vSwitch1", vlan: 40, activeClients: 2, kind: "standard" },
  ];
  const vms = over.vms || [
    { name: "client-vm", worldId: "1001", networks: [],
      ports: [port("MGMT", "vSwitch0", MGMT.client, 33554401), port("PG-CS", "vSwitch1", MAC.client, 33554433)] },
    { name: "spoke-vm", worldId: "1002", networks: [],
      ports: [port("MGMT", "vSwitch0", MGMT.spoke, 33554402), port("PG-CS", "vSwitch1", MAC.spokeA, 33554434),
        port("PG-SN", "vSwitch1", MAC.spokeB, 33554435)] },
    { name: "hub-vm", worldId: "1003", networks: [],
      ports: [port("MGMT", "vSwitch0", MGMT.hub, 33554403), port("PG-SN", "vSwitch1", MAC.hubA, 33554436),
        port("PG-HS", "vSwitch1", MAC.hubB, 33554437)] },
    { name: "server-vm", worldId: "1004", networks: [],
      ports: [port("MGMT", "vSwitch0", MGMT.server, 33554404), port("PG-HS", "vSwitch1", MAC.server, 33554438)] },
  ];
  const security = over.security || Object.fromEntries(
    pgs.map((p) => [p.name, { promiscuous: false, macChanges: true, forgedTransmits: true }]));
  return {
    ok: true,
    host: "172.16.226.10",
    version: { product: "VMware ESXi", version: "7.0.3", build: "12345" },
    vswitches: over.vswitches || [
      { name: "vSwitch0", kind: "standard", mtu: 1500, uplinks: ["vmnic0"], portgroups: ["MGMT"] },
      { name: "vSwitch1", kind: "standard", mtu: 1500, uplinks: [], portgroups: pgs.filter((p) => p.name !== "MGMT").map((p) => p.name) },
    ],
    portgroups: pgs,
    security,
    pnics: [{ name: "vmnic0", mac: "aa:bb:cc:dd:ee:ff", mtu: 1500, linkUp: true, speed: "10000", driver: "ixgben" }],
    inventory: vms.map((v, i) => ({ vmid: String(i + 1), name: v.name })),
    vms,
  };
}

function node(role, host, vmName, ifaces, extra = {}) {
  return {
    role, host, user: "root", vmName, dataIp: extra.dataIp || "", reachable: true, error: null,
    hostname: role, kernel: "Linux 5.15",
    links: ifaces.map((i) => ({
      iface: i.iface, mac: i.mac, state: i.down ? "DOWN" : "UP", mtu: i.mtu || 1500,
      master: i.master || null, kind: i.kind || "device", flags: i.down ? ["BROADCAST"] : ["BROADCAST", "UP", "LOWER_UP"],
      carrier: i.carrier !== false, up: !i.down,
    })),
    addrs: ifaces.filter((i) => i.ip).map((i) => ({
      iface: i.iface, ip: i.ip, prefix: i.prefix, cidr: ip.cidrOf(i.ip, i.prefix),
    })),
    routes: extra.routes || [],
    neigh: extra.neigh || [],
    ipForward: extra.ipForward !== undefined ? extra.ipForward : false,
    rpFilter: extra.rpFilter || { all: "0", default: "0" },
    tcQdisc: extra.tcQdisc || "",
    netemActive: !!extra.netemActive,
    bridges: extra.bridges || [],
    firewall: extra.firewall || { policies: { INPUT: "ACCEPT", FORWARD: "ACCEPT", OUTPUT: "ACCEPT" }, dropRules: [], raw: "" },
    tools: ["ping", "traceroute"],
    creds: { role, host, user: "root", pass: "x" },
  };
}

/** The reference testbed: client -10.10.1- spoke -10.10.2- hub -10.10.3- server */
function baseFacts(mods = {}) {
  const nodes = {
    client: node("client", "172.16.226.50", "client-vm",
      [{ iface: "ens160", mac: "00:50:56:ff:00:01", ip: "172.16.226.50", prefix: 24 },
       { iface: "ens192", mac: MAC.client, ip: "10.10.1.2", prefix: 24 }],
      { neigh: [{ ip: "10.10.1.1", dev: "ens192", mac: MAC.spokeA, state: "REACHABLE" }] }),
    spoke: node("spoke", "172.16.226.113", "spoke-vm",
      [{ iface: "ens160", mac: "00:50:56:ff:00:02", ip: "172.16.226.113", prefix: 24 },
       { iface: "ens192", mac: MAC.spokeA, ip: "10.10.1.1", prefix: 24 },
       { iface: "ens224", mac: MAC.spokeB, ip: "10.10.2.1", prefix: 24 }],
      { ipForward: true }),
    hub: node("hub", "172.16.226.120", "hub-vm",
      [{ iface: "ens160", mac: "00:50:56:ff:00:03", ip: "172.16.226.120", prefix: 24 },
       { iface: "ens192", mac: MAC.hubA, ip: "10.10.2.2", prefix: 24 },
       { iface: "ens224", mac: MAC.hubB, ip: "10.10.3.1", prefix: 24 }],
      { ipForward: true }),
    server: node("server", "172.16.226.60", "server-vm",
      [{ iface: "ens160", mac: "00:50:56:ff:00:04", ip: "172.16.226.60", prefix: 24 },
       { iface: "ens192", mac: MAC.server, ip: "10.10.3.2", prefix: 24 }]),
  };
  const facts = {
    esxi: mods.esxi || esxiFacts(),
    nodes: mods.nodes ? mods.nodes(nodes) : nodes,
    probes: {},
    options: { maxHops: 12, mtuBytes: 1500, activeProbes: true },
  };
  diagnose.attachEsxiPorts(facts);
  const topo = diagnose.buildTopology(facts);
  facts.probes = mods.probes ? mods.probes(topo, facts) : goodProbes(topo, facts);
  return { facts, topo };
}

/** Every segment resolves ARP and pings; end to end works. */
function goodProbes(topo, facts, over = {}) {
  const segments = {};
  for (const seg of topo.segments) {
    if (!seg.aAddr || !seg.bAddr) continue;
    const peerMac = (facts.nodes[seg.b].links.find((l) => l.iface === seg.bAddr.iface) || {}).mac || "";
    segments[seg.key] = {
      iface: seg.aAddr.iface, srcIp: seg.aAddr.ip, peerIp: seg.bAddr.ip,
      ping: { sent: 3, received: 3, lossPct: 0, rttAvgMs: 0.4, ok: true, frag: false, unreachable: false, raw: "" },
      neigh: { ip: seg.bAddr.ip, dev: seg.aAddr.iface, mac: peerMac, state: "REACHABLE" },
      arping: { ok: true, mac: peerMac, raw: "" },
    };
  }
  // realistic `ip route get` answers: each hop points at the next node's address
  // on their shared segment, and drops the `via` once the target is on-link
  const { srcIp, dstIp } = topo.target;
  const routeGets = {};
  topo.l3Chain.forEach((role, i) => {
    const segNext = topo.segments.find((s) => s.a === role && s.b === topo.l3Chain[i + 1]);
    const segPrev = topo.segments.find((s) => s.a === topo.l3Chain[i - 1] && s.b === role);
    const hop = (seg, peerAddr, target) => {
      if (!seg || !peerAddr) return { unreachable: false, via: null, dev: null, src: null, local: true, raw: "local" };
      const onLink = peerAddr.ip === target;
      const dev = seg.a === role ? seg.aAddr.iface : seg.bAddr.iface;
      return {
        unreachable: false,
        via: onLink ? null : peerAddr.ip,
        dev,
        src: null,
        local: false,
        raw: `${target}${onLink ? "" : ` via ${peerAddr.ip}`} dev ${dev}`,
      };
    };
    routeGets[role] = {
      toDst: hop(segNext, segNext && segNext.bAddr, dstIp),
      toSrc: hop(segPrev, segPrev && segPrev.aAddr, srcIp),
    };
  });
  return {
    segments,
    routeGets,
    endToEnd: {
      forward: { sent: 4, received: 4, lossPct: 0, rttAvgMs: 31, ok: true, frag: false, unreachable: false, raw: "" },
      reverse: { sent: 3, received: 3, lossPct: 0, rttAvgMs: 31, ok: true, frag: false, unreachable: false, raw: "" },
      traceroute: { via: "traceroute", hops: [
        { ttl: 1, ip: "10.10.1.1" }, { ttl: 2, ip: "10.10.2.2" }, { ttl: 3, ip: "10.10.3.2" }], raw: "" },
    },
    mtu: null,
    ...over,
  };
}

const ids = (r) => r.findings.map((f) => f.id);
const critical = (r) => r.findings.filter((f) => f.severity === "critical");

/* =============================================== engine: the healthy case */

test("reference testbed is reported healthy", () => {
  const { facts, topo } = baseFacts();
  const r = diagnose.analyze(facts, topo);
  assert.strictEqual(r.verdict, "HEALTHY", `findings: ${ids(r).join(", ")}`);
  assert.deepStrictEqual(r.segments.map((s) => s.status), ["ok", "ok", "ok"]);
  assert.ok(r.segments.every((s) => s.sameL2Domain === true));
});

test("management-only adjacency is flagged, not silently accepted", () => {
  const { facts, topo } = baseFacts({
    nodes: (n) => {
      // strip the data NICs from client and spoke: only the mgmt subnet is left
      n.client.links = n.client.links.filter((l) => l.iface === "ens160");
      n.client.addrs = n.client.addrs.filter((a) => a.iface === "ens160");
      return n;
    },
  });
  const r = diagnose.analyze(facts, topo);
  assert.ok(ids(r).includes("info.mgmt-segment"), ids(r).join(", "));
});

/* ============================================================= L2 verdicts */

test("L2: portgroup mismatch — same subnet, different vSwitch", () => {
  const e = esxiFacts();
  // move the spoke's client-facing vNIC onto an isolated vSwitch2
  e.portgroups.push({ name: "PG-ORPHAN", vswitch: "vSwitch2", vlan: 0, activeClients: 1, kind: "standard" });
  e.vswitches.push({ name: "vSwitch2", kind: "standard", mtu: 1500, uplinks: [], portgroups: ["PG-ORPHAN"] });
  e.security["PG-ORPHAN"] = { promiscuous: false, macChanges: true, forgedTransmits: true };
  e.vms[1].ports[1] = port("PG-ORPHAN", "vSwitch2", MAC.spokeA, 33554434);

  const { facts, topo } = baseFacts({ esxi: e, probes: (t, f) => {
    const p = goodProbes(t, f);
    p.segments["client->spoke"].ping = { sent: 3, received: 0, lossPct: 100, ok: false, raw: "" };
    p.segments["client->spoke"].neigh = { ip: "10.10.1.1", dev: "ens192", mac: "", state: "FAILED" };
    p.segments["client->spoke"].arping = { ok: false, mac: "", raw: "" };
    p.endToEnd.forward = { sent: 4, received: 0, lossPct: 100, ok: false, raw: "" };
    return p;
  } });
  const r = diagnose.analyze(facts, topo);
  assert.strictEqual(r.verdict, "L2");
  assert.strictEqual(r.primary.id, "l2.portgroup-mismatch");
  assert.match(r.primary.detail, /PG-CS/);
  assert.match(r.primary.detail, /PG-ORPHAN/);
  assert.strictEqual(r.segments[0].status, "l2");
  assert.strictEqual(r.segments[0].sameL2Domain, false);
});

test("an L2 fault demotes the traceroute and next-hop-ARP findings to evidence", () => {
  const e = esxiFacts();
  e.portgroups.push({ name: "PG-ORPHAN", vswitch: "vSwitch2", vlan: 0, activeClients: 1, kind: "standard" });
  e.vswitches.push({ name: "vSwitch2", kind: "standard", mtu: 1500, uplinks: [], portgroups: ["PG-ORPHAN"] });
  e.security["PG-ORPHAN"] = { promiscuous: false, macChanges: true, forgedTransmits: true };
  e.vms[1].ports[1] = port("PG-ORPHAN", "vSwitch2", MAC.spokeA, 33554434);

  const { facts, topo } = baseFacts({
    esxi: e,
    // the client's ARP for its gateway fails, exactly as the split L2 predicts
    nodes: (n) => {
      n.client.neigh = [{ ip: "10.10.1.1", dev: "ens192", mac: "", state: "FAILED" }];
      return n;
    },
    probes: (t, f) => {
      const p = goodProbes(t, f);
      p.endToEnd.forward = { sent: 4, received: 0, lossPct: 100, ok: false, raw: "" };
      p.endToEnd.traceroute = { via: "traceroute", hops: [{ ttl: 1, ip: null, timeout: true }], raw: "" };
      return p;
    },
  });
  const r = diagnose.analyze(facts, topo);
  assert.strictEqual(r.verdict, "L2");
  // one cause, not three: the ARP-failing next hop is the same fault
  assert.ok(!ids(r).includes("l2.nexthop-arp"), ids(r).join(", "));
  const trunc = r.findings.find((f) => f.id === "l3.path-truncated");
  assert.ok(trunc, "the traceroute result should still be reported");
  assert.strictEqual(trunc.layer, "info");
  assert.strictEqual(trunc.severity, "info");
  assert.strictEqual(critical(r).length, 1, critical(r).map((f) => f.id).join(", "));
});

test("with no L2 fault the same traceroute stays a critical L3 finding", () => {
  const { facts, topo } = baseFacts({ probes: (t, f) => {
    const p = goodProbes(t, f);
    p.endToEnd.forward = { sent: 4, received: 0, lossPct: 100, ok: false, raw: "" };
    p.endToEnd.traceroute = { via: "traceroute", hops: [{ ttl: 1, ip: "10.10.1.1" }, { ttl: 2, ip: null, timeout: true }], raw: "" };
    return p;
  } });
  const r = diagnose.analyze(facts, topo);
  const trunc = r.findings.find((f) => f.id === "l3.path-truncated");
  assert.strictEqual(trunc.layer, "L3");
  assert.strictEqual(trunc.severity, "critical");
  assert.strictEqual(r.verdict, "L3");
});

test("L2: VLAN mismatch is named as such when both are on one vSwitch", () => {
  const e = esxiFacts();
  // client stays on VLAN 10; put the spoke's near-side port on a VLAN 99 portgroup
  e.portgroups.push({ name: "PG-CS-V99", vswitch: "vSwitch1", vlan: 99, activeClients: 1, kind: "standard" });
  e.security["PG-CS-V99"] = { promiscuous: false, macChanges: true, forgedTransmits: true };
  e.vms[1].ports[1] = port("PG-CS-V99", "vSwitch1", MAC.spokeA, 33554434);

  const { facts, topo } = baseFacts({ esxi: e });
  const r = diagnose.analyze(facts, topo);
  assert.strictEqual(r.verdict, "L2");
  assert.strictEqual(r.primary.id, "l2.vlan-mismatch");
  assert.match(r.primary.title, /VLAN 10 vs VLAN 99/);
});

test("L2: same VLAN on the same vSwitch counts as one broadcast domain", () => {
  const e = esxiFacts();
  // two differently named portgroups, both VLAN 10 -> still adjacent
  e.portgroups.push({ name: "PG-CS-ALT", vswitch: "vSwitch1", vlan: 10, activeClients: 1, kind: "standard" });
  e.security["PG-CS-ALT"] = { promiscuous: false, macChanges: true, forgedTransmits: true };
  e.vms[1].ports[1] = port("PG-CS-ALT", "vSwitch1", MAC.spokeA, 33554434);

  const { facts, topo } = baseFacts({ esxi: e });
  const r = diagnose.analyze(facts, topo);
  assert.strictEqual(r.verdict, "HEALTHY", ids(r).join(", "));
  assert.strictEqual(r.segments[0].sameL2Domain, true);
});

test("L2: MAC mismatch — guest spoofs a MAC and the portgroup rejects changes", () => {
  const e = esxiFacts();
  e.security["PG-CS"] = { promiscuous: false, macChanges: false, forgedTransmits: false };
  const { facts, topo } = baseFacts({
    esxi: e,
    nodes: (n) => {
      n.client.links.find((l) => l.iface === "ens192").mac = "02:aa:bb:cc:dd:ee"; // rewritten in the guest
      return n;
    },
    probes: (t, f) => {
      const p = goodProbes(t, f);
      p.segments["client->spoke"].neigh = { ip: "10.10.1.1", dev: "ens192", mac: "", state: "INCOMPLETE" };
      p.segments["client->spoke"].ping = { sent: 3, received: 0, lossPct: 100, ok: false, raw: "" };
      p.segments["client->spoke"].arping = { ok: false, mac: "", raw: "" };
      return p;
    },
  });
  const r = diagnose.analyze(facts, topo);
  assert.strictEqual(r.verdict, "L2");
  assert.ok(ids(r).includes("l2.mac-mismatch-policy"), ids(r).join(", "));
  assert.match(critical(r)[0].remediation, /MAC address changes = Accept/);
});

test("L2: ARP resolves to a MAC that is not the peer's — duplicate IP", () => {
  const { facts, topo } = baseFacts({ probes: (t, f) => {
    const p = goodProbes(t, f);
    p.segments["client->spoke"].neigh =
      { ip: "10.10.1.1", dev: "ens192", mac: "00:0c:29:de:ad:be", state: "REACHABLE" };
    p.segments["client->spoke"].arping = { ok: true, mac: "00:0c:29:de:ad:be", raw: "" };
    p.segments["client->spoke"].ping = { sent: 3, received: 3, lossPct: 0, ok: true, raw: "" };
    return p;
  } });
  const r = diagnose.analyze(facts, topo);
  assert.strictEqual(r.verdict, "L2");
  assert.strictEqual(r.primary.id, "l2.wrong-mac");
});

test("L2: peer interface down is named as the ARP sub-cause", () => {
  const { facts, topo } = baseFacts({
    nodes: (n) => {
      const l = n.spoke.links.find((x) => x.iface === "ens192");
      l.state = "DOWN"; l.carrier = false; l.up = false; l.flags = ["BROADCAST", "MULTICAST"];
      return n;
    },
    probes: (t, f) => {
      const p = goodProbes(t, f);
      p.segments["client->spoke"].neigh = { ip: "10.10.1.1", dev: "ens192", mac: "", state: "FAILED" };
      p.segments["client->spoke"].arping = { ok: false, mac: "", raw: "" };
      p.segments["client->spoke"].ping = { sent: 3, received: 0, lossPct: 100, ok: false, raw: "" };
      return p;
    },
  });
  const r = diagnose.analyze(facts, topo);
  assert.strictEqual(r.verdict, "L2");
  assert.ok(ids(r).includes("l2.link-down"), ids(r).join(", "));
  const arp = r.findings.find((f) => f.id === "l2.arp-unresolved");
  assert.ok(arp && /ens192 is down/.test(arp.detail), arp && arp.detail);
});

test("L2: duplicate MAC across two VMs is reported", () => {
  const e = esxiFacts();
  e.vms[3].ports[1] = port("PG-HS", "vSwitch1", MAC.client, 33554438); // server reuses the client MAC
  const { facts, topo } = baseFacts({ esxi: e });
  const r = diagnose.analyze(facts, topo);
  assert.ok(ids(r).includes("l2.duplicate-mac"), ids(r).join(", "));
});

/* =============================================================== netem VM */

test("netem in bridge mode is collapsed out of the L3 chain and bridges the domains", () => {
  const e = esxiFacts();
  // spoke <-> netem <-> hub all live in 10.10.2.0/24; netem bridges PG-SN and PG-NH
  e.vms.push({ name: "netem-vm", worldId: "1005", networks: [],
    ports: [port("MGMT", "vSwitch0", MGMT.netem, 33554405),
      port("PG-SN", "vSwitch1", MAC.netemA, 33554440), port("PG-NH", "vSwitch1", MAC.netemB, 33554441)] });
  e.inventory.push({ vmid: "5", name: "netem-vm" });
  for (const pg of ["PG-SN", "PG-NH"]) {
    e.security[pg] = { promiscuous: true, macChanges: true, forgedTransmits: true };
  }

  const { facts, topo } = baseFacts({
    esxi: e,
    nodes: (n) => {
      n.netem = node("netem", "172.16.226.199", "netem-vm",
        [{ iface: "ens160", mac: "00:50:56:ff:00:05", ip: "172.16.226.199", prefix: 24 },
         { iface: "ens192", mac: MAC.netemA, master: "br0", kind: "bridge_slave" },
         { iface: "ens224", mac: MAC.netemB, master: "br0", kind: "bridge_slave" },
         { iface: "br0", mac: MAC.netemA, kind: "bridge" }],
        { bridges: [{ name: "br0", mtu: 1500, state: "UP", members: ["ens192", "ens224"] }],
          netemActive: true, tcQdisc: "qdisc netem 8001: dev ens192 root delay 200ms" });
      // hub's near side now shares the spoke's subnet, through the bridge
      n.hub.addrs.find((a) => a.iface === "ens192").ip = "10.10.2.2";
      return n;
    },
  });

  assert.strictEqual(facts.nodes.netem.kind, "bridge");
  assert.deepStrictEqual(topo.l3Chain, ["client", "spoke", "hub", "server"]);
  assert.deepStrictEqual(topo.present, ["client", "spoke", "netem", "hub", "server"]);
  const spokeHub = topo.segments.find((s) => s.key === "spoke->hub");
  assert.deepStrictEqual(spokeHub.viaBridge, ["netem"]);

  const r = diagnose.analyze(facts, topo);
  assert.strictEqual(r.verdict, "HEALTHY", ids(r).join(", "));
  // PG-SN and PG-NH are different portgroups on different VLANs, joined only by
  // the guest bridge — the fabric model has to see that
  assert.strictEqual(spokeHub.sameL2Domain, true);
  assert.ok(r.fabric.some((m) => /bridged by netem br0/.test(m)), r.fabric.join(" | "));
});

test("netem bridge with forged transmits rejected is an L2 fault", () => {
  const e = esxiFacts();
  e.vms.push({ name: "netem-vm", worldId: "1005", networks: [],
    ports: [port("PG-SN", "vSwitch1", MAC.netemA, 33554440), port("PG-NH", "vSwitch1", MAC.netemB, 33554441)] });
  e.security["PG-SN"] = { promiscuous: false, macChanges: true, forgedTransmits: false };

  const { facts, topo } = baseFacts({
    esxi: e,
    nodes: (n) => {
      n.netem = node("netem", "172.16.226.199", "netem-vm",
        [{ iface: "ens192", mac: MAC.netemA, master: "br0", kind: "bridge_slave" },
         { iface: "ens224", mac: MAC.netemB, master: "br0", kind: "bridge_slave" },
         { iface: "br0", mac: MAC.netemA, kind: "bridge" }],
        { bridges: [{ name: "br0", mtu: 1500, state: "UP", members: ["ens192", "ens224"] }] });
      n.hub.addrs.find((a) => a.iface === "ens192").ip = "10.10.2.2";
      return n;
    },
  });
  const r = diagnose.analyze(facts, topo);
  assert.strictEqual(r.verdict, "L2");
  assert.ok(ids(r).includes("l2.bridge-policy"), ids(r).join(", "));
});

/* ============================================================= L3 verdicts */

test("L3: same L2 domain but no shared subnet is an addressing fault", () => {
  const { facts, topo } = baseFacts({
    nodes: (n) => {
      n.spoke.addrs.find((a) => a.iface === "ens192").ip = "10.99.1.1"; // wrong subnet
      n.spoke.addrs.find((a) => a.iface === "ens192").cidr = "10.99.1.0/24";
      return n;
    },
  });
  const r = diagnose.analyze(facts, topo);
  assert.strictEqual(r.verdict, "L3");
  assert.strictEqual(r.primary.id, "l3.subnet-mismatch");
  assert.match(r.primary.detail, /10\.10\.1\.0\/24|10\.99\.1\.0\/24/);
});

test("L3: forwarding disabled on the spoke", () => {
  const { facts, topo } = baseFacts({
    nodes: (n) => { n.spoke.ipForward = false; return n; },
    probes: (t, f) => {
      const p = goodProbes(t, f);
      p.endToEnd.forward = { sent: 4, received: 0, lossPct: 100, ok: false, raw: "" };
      p.endToEnd.traceroute = { via: "traceroute", hops: [{ ttl: 1, ip: "10.10.1.1" }, { ttl: 2, ip: null, timeout: true }], raw: "" };
      return p;
    },
  });
  const r = diagnose.analyze(facts, topo);
  assert.strictEqual(r.verdict, "L3");
  assert.ok(ids(r).includes("l3.forwarding-disabled"), ids(r).join(", "));
  // and the traceroute finding must point at the node after the last live hop
  const trunc = r.findings.find((f) => f.id === "l3.path-truncated");
  assert.ok(trunc, "expected a path-truncated finding");
  assert.match(trunc.title, /10\.10\.1\.1/);
});

test("L3: no route to the destination on the client", () => {
  const { facts, topo } = baseFacts({ probes: (t, f) => {
    const p = goodProbes(t, f);
    p.routeGets.client.toDst = { unreachable: true, via: null, dev: null, src: null, local: false,
      raw: "RTNETLINK answers: Network is unreachable" };
    p.endToEnd.forward = { sent: 4, received: 0, lossPct: 100, ok: false, raw: "" };
    return p;
  } });
  const r = diagnose.analyze(facts, topo);
  assert.strictEqual(r.verdict, "L3");
  assert.ok(ids(r).includes("l3.no-route"), ids(r).join(", "));
});

test("L3: next hop outside every local subnet", () => {
  const { facts, topo } = baseFacts({ probes: (t, f) => {
    const p = goodProbes(t, f);
    p.routeGets.client.toDst = { unreachable: false, via: "192.168.77.1", dev: "ens192", src: null,
      local: false, raw: "10.10.3.2 via 192.168.77.1 dev ens192" };
    p.endToEnd.forward = { sent: 4, received: 0, lossPct: 100, ok: false, raw: "" };
    return p;
  } });
  const r = diagnose.analyze(facts, topo);
  assert.ok(ids(r).includes("l3.nexthop-offlink"), ids(r).join(", "));
});

test("L3: missing return route on the server", () => {
  const { facts, topo } = baseFacts({ probes: (t, f) => {
    const p = goodProbes(t, f);
    p.routeGets.server.toSrc = { unreachable: true, via: null, dev: null, src: null, local: false,
      raw: "RTNETLINK answers: Network is unreachable" };
    p.endToEnd.forward = { sent: 4, received: 0, lossPct: 100, ok: false, raw: "" };
    return p;
  } });
  const r = diagnose.analyze(facts, topo);
  assert.strictEqual(r.verdict, "L3");
  assert.ok(ids(r).includes("l3.no-return-route"), ids(r).join(", "));
});

test("L3: FORWARD policy DROP on a transit node", () => {
  const { facts, topo } = baseFacts({
    nodes: (n) => {
      n.hub.firewall = { policies: { INPUT: "ACCEPT", FORWARD: "DROP", OUTPUT: "ACCEPT" }, dropRules: [], raw: "-P FORWARD DROP" };
      return n;
    },
    probes: (t, f) => {
      const p = goodProbes(t, f);
      p.endToEnd.forward = { sent: 4, received: 0, lossPct: 100, ok: false, raw: "" };
      return p;
    },
  });
  const r = diagnose.analyze(facts, topo);
  assert.strictEqual(r.verdict, "L3");
  assert.ok(ids(r).includes("l3.forward-policy-drop"), ids(r).join(", "));
});

test("ARP fine but ICMP filtered is NOT called an L2 fault", () => {
  const { facts, topo } = baseFacts({
    nodes: (n) => {
      n.spoke.firewall = { policies: { INPUT: "DROP", FORWARD: "ACCEPT", OUTPUT: "ACCEPT" },
        dropRules: ["-A INPUT -p icmp -j DROP"], raw: "-P INPUT DROP" };
      return n;
    },
    probes: (t, f) => {
      const p = goodProbes(t, f);
      p.segments["client->spoke"].ping = { sent: 3, received: 0, lossPct: 100, ok: false, raw: "" };
      return p;
    },
  });
  const r = diagnose.analyze(facts, topo);
  assert.strictEqual(r.verdict, "L3");
  assert.strictEqual(r.segments[0].status, "filtered");
  assert.ok(ids(r).includes("l3.segment-filtered"), ids(r).join(", "));
});

test("PMTU black hole is reported as a warning, path still healthy", () => {
  const { facts, topo } = baseFacts({ probes: (t, f) => {
    const p = goodProbes(t, f);
    p.mtu = {
      size: 1500,
      small: { sent: 2, received: 2, lossPct: 0, ok: true, raw: "" },
      large: { sent: 2, received: 0, lossPct: 100, ok: false, frag: true, raw: "" },
    };
    return p;
  } });
  const r = diagnose.analyze(facts, topo);
  assert.strictEqual(r.verdict, "HEALTHY_WARN");
  assert.ok(ids(r).includes("l3.pmtu-blackhole"), ids(r).join(", "));
});

/* ========================================================= degraded inputs */

test("unreachable node yields an access verdict, not a bogus L2 call", () => {
  const { facts, topo } = baseFacts({
    nodes: (n) => {
      n.hub = { role: "hub", host: "172.16.226.120", vmName: "hub-vm", reachable: false,
        error: "SSH root@172.16.226.120: All configured authentication methods failed" };
      return n;
    },
    probes: (t, f) => goodProbes(t, f),
  });
  const r = diagnose.analyze(facts, topo);
  assert.strictEqual(r.verdict, "ACCESS");
  assert.strictEqual(r.primary.id, "access.unreachable");
});

test("without ESXi data the L2 domain is unknown and the tool says so", () => {
  const { facts, topo } = baseFacts({ esxi: { ok: false, error: "SSH refused" } });
  const r = diagnose.analyze(facts, topo);
  assert.ok(ids(r).includes("info.no-esxi"), ids(r).join(", "));
  assert.ok(r.segments.every((s) => s.sameL2Domain === null));
  assert.strictEqual(r.verdict, "HEALTHY"); // probes all passed; the note is informational
});

test("no shared subnet and no shared portgroup: link does not exist yet", () => {
  const e = esxiFacts();
  e.portgroups.push({ name: "PG-ORPHAN", vswitch: "vSwitch2", vlan: 0, activeClients: 1, kind: "standard" });
  e.vswitches.push({ name: "vSwitch2", kind: "standard", mtu: 1500, uplinks: [], portgroups: ["PG-ORPHAN"] });
  e.security["PG-ORPHAN"] = { promiscuous: false, macChanges: true, forgedTransmits: true };
  e.vms[1].ports[1] = port("PG-ORPHAN", "vSwitch2", MAC.spokeA, 33554434);
  const { facts, topo } = baseFacts({
    esxi: e,
    nodes: (n) => {
      const a = n.spoke.addrs.find((x) => x.iface === "ens192");
      a.ip = "10.55.5.1"; a.cidr = "10.55.5.0/24";
      return n;
    },
  });
  const r = diagnose.analyze(facts, topo);
  assert.strictEqual(r.verdict, "L2");
  assert.strictEqual(r.primary.id, "l2.no-adjacency");
});

/* ============================================================== reporting */

test("report writer produces HTML + JSON and scrubs credentials", () => {
  const os = require("os");
  const fsx = require("fs");
  const pathx = require("path");
  const report = require("../lib/report");
  const { facts, topo } = baseFacts();
  const r = diagnose.analyze(facts, topo);
  const dir = fsx.mkdtempSync(pathx.join(os.tmpdir(), "tbt-report-"));
  try {
    const paths = report.write(dir, facts, topo, r);
    const html = fsx.readFileSync(paths.html, "utf8");
    assert.match(html, /NO FAULT FOUND/);
    assert.match(html, /PG-CS/);
    assert.match(html, /<table/);
    assert.ok(!/"pass"/.test(html));
    const saved = JSON.parse(fsx.readFileSync(paths.json, "utf8"));
    assert.strictEqual(saved.verdict, "HEALTHY");
    assert.strictEqual(saved.facts.nodes.client.creds.pass, "***", "the SSH password must never be written out");
    assert.deepStrictEqual(saved.topology.l3Chain, ["client", "spoke", "hub", "server"]);
  } finally {
    fsx.rmSync(dir, { recursive: true, force: true });
  }
});

test("report escapes markup coming out of a finding", () => {
  const report = require("../lib/report");
  const { facts, topo } = baseFacts();
  const r = diagnose.analyze(facts, topo);
  r.findings.push({ id: "x", layer: "L2", severity: "warning", where: "<img src=x>",
    title: "<script>alert(1)</script>", detail: "a & b", evidence: "", remediation: "" });
  const html = report.html(facts, topo, r);
  assert.ok(!/<script>alert/.test(html));
  assert.match(html, /&lt;script&gt;/);
});

/* ------------------------------------------------------------------ result */

console.log("");
if (failures.length) {
  console.log(`${pass} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`\n--- ${f.name}\n${f.e.stack}`);
  process.exit(1);
}
console.log(`${pass} passed`);
