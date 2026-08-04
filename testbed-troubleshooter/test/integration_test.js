#!/usr/bin/env node
/**
 * Offline integration test: drives the real engine — ESXi collectors, guest
 * collectors, probes, decision engine, report writer — against a faked SSH
 * surface, so the whole pipeline is exercised without a lab.
 *
 * lib/ssh is patched before lib/guest and lib/esxi destructure from it, which
 * is why the require order below matters.
 *
 *   node test/integration_test.js
 */

"use strict";

const assert = require("assert");
const fs = require("fs");
const ssh = require("../lib/ssh");

/* ------------------------------------------------ the fake testbed's shell */

const ESXI = "172.16.226.10";

/** Reference wiring; the scenario may move the spoke's client-facing vNIC. */
function esxiShell({ spokeNearPortgroup = "PG-CS", spokeNearVswitch = "vSwitch1" } = {}) {
  const vswitches = [
    { Name: "vSwitch0", MTU: 1500, Uplinks: ["vmnic0"], Portgroups: ["MGMT"] },
    { Name: "vSwitch1", MTU: 1500, Uplinks: [], Portgroups: ["PG-CS", "PG-SN", "PG-HS"] },
    { Name: "vSwitch2", MTU: 1500, Uplinks: [], Portgroups: ["PG-ORPHAN"] },
  ];
  const portgroups = [
    { Name: "MGMT", VirtualSwitch: "vSwitch0", VLANID: 0, ActiveClients: 4 },
    { Name: "PG-CS", VirtualSwitch: "vSwitch1", VLANID: 10, ActiveClients: 2 },
    { Name: "PG-SN", VirtualSwitch: "vSwitch1", VLANID: 20, ActiveClients: 2 },
    { Name: "PG-HS", VirtualSwitch: "vSwitch1", VLANID: 30, ActiveClients: 2 },
    { Name: "PG-ORPHAN", VirtualSwitch: "vSwitch2", VLANID: 0, ActiveClients: 1 },
  ];
  // world id -> vNIC ports, rendered as the plain-text `vm port list` output
  const vmPorts = {
    1001: [["MGMT", "vSwitch0", "00:50:56:ff:00:01"], ["PG-CS", "vSwitch1", "00:50:56:00:00:01"]],
    1002: [["MGMT", "vSwitch0", "00:50:56:ff:00:02"],
      [spokeNearPortgroup, spokeNearVswitch, "00:50:56:00:00:02"],
      ["PG-SN", "vSwitch1", "00:50:56:00:00:03"]],
    1003: [["MGMT", "vSwitch0", "00:50:56:ff:00:03"], ["PG-SN", "vSwitch1", "00:50:56:00:00:06"],
      ["PG-HS", "vSwitch1", "00:50:56:00:00:07"]],
    1004: [["MGMT", "vSwitch0", "00:50:56:ff:00:04"], ["PG-HS", "vSwitch1", "00:50:56:00:00:08"]],
  };

  return (cmd) => {
    // esxcli JSON formatter: supported for the switch/portgroup/security calls
    if (/--formatter=json/.test(cmd)) {
      if (/system version get/.test(cmd)) {
        return ok(JSON.stringify({ Product: "VMware ESXi", Version: "7.0.3", Build: "20328353" }));
      }
      if (/network vswitch standard list/.test(cmd)) return ok(JSON.stringify(vswitches));
      if (/network vswitch dvs vmware list/.test(cmd)) return fail("Not supported");
      if (/portgroup policy security get -p '([^']+)'/.test(cmd)) {
        return ok(JSON.stringify({ AllowPromiscuous: false, AllowMACAddressChange: true, AllowForgedTransmits: true }));
      }
      if (/policy security get -v/.test(cmd)) {
        return ok(JSON.stringify({ AllowPromiscuous: false, AllowMACAddressChange: true, AllowForgedTransmits: true }));
      }
      if (/network vswitch standard portgroup list/.test(cmd)) return ok(JSON.stringify(portgroups));
      // the VM and NIC namespaces answer only in plain text on this host,
      // so the table parser is exercised too
      return fail("Unknown formatter option");
    }
    if (/^esxcli network vm list/.test(cmd)) {
      return ok(`World ID  Name        Num Ports  Networks
--------  ----------  ---------  --------------
1001      client-vm           2  MGMT, PG-CS
1002      spoke-vm            3  MGMT, PG-CS
1003      hub-vm              3  MGMT, PG-SN
1004      server-vm           2  MGMT, PG-HS
`);
    }
    const vp = cmd.match(/^esxcli network vm port list -w (\d+)/);
    if (vp) {
      const rows = vmPorts[vp[1]] || [];
      return ok(rows.map(([pg, vs, mac], i) => `   Port ID: ${33554430 + i}
   vSwitch: ${vs}
   Portgroup: ${pg}
   DVPort ID:
   MAC Address: ${mac}
   IP Address: 0.0.0.0
   Team Uplink: void
   Uplink Port ID: 0
   Active Filters:
`).join("\n"));
    }
    if (/^esxcli network nic list/.test(cmd)) {
      return ok(`Name    PCI Device    Driver  Admin Status  Link Status  Speed  Duplex  MAC Address         MTU  Description
------  ------------  ------  ------------  -----------  -----  ------  -----------------  ----  -----------
vmnic0  0000:03:00.0  ixgben  Up            Up           10000  Full    aa:bb:cc:dd:ee:ff  1500  Intel X540
`);
    }
    if (/^vim-cmd vmsvc\/getallvms/.test(cmd)) {
      return ok(`Vmid   Name        File                            Guest OS        Version
1      client-vm   [ds1] client-vm/client-vm.vmx        rhel8_64Guest   vmx-17
2      spoke-vm    [ds1] spoke-vm/spoke-vm.vmx          rhel8_64Guest   vmx-17
3      hub-vm      [ds1] hub-vm/hub-vm.vmx              rhel8_64Guest   vmx-17
4      server-vm   [ds1] server-vm/server-vm.vmx        rhel8_64Guest   vmx-17
`);
    }
    return fail(`unexpected ESXi command: ${cmd}`);
  };
}

const ok = (stdout) => ({ code: 0, stdout, stderr: "", timedOut: false });
const fail = (stderr) => ({ code: 1, stdout: "", stderr, timedOut: false });

/** A Linux guest in the chain. */
function guestShell(spec) {
  const { hostname, ifaces, routes, neigh, ipForward, reachablePeers } = spec;
  return (cmd) => {
    if (cmd === "hostname") return ok(hostname + "\n");
    if (cmd === "uname -sr") return ok("Linux 5.14.0-427.el9.x86_64\n");
    if (cmd === "ip -o -d link show") {
      return ok(ifaces.map((i, n) =>
        `${n + 2}: ${i.name}: <${i.down ? "BROADCAST,MULTICAST" : "BROADCAST,MULTICAST,UP,LOWER_UP"}> mtu ${i.mtu || 1500} ` +
        `qdisc mq state ${i.down ? "DOWN" : "UP"} mode DEFAULT group default \\    link/ether ${i.mac} brd ff:ff:ff:ff:ff:ff`)
        .join("\n") + "\n");
    }
    if (cmd === "ip -o -4 addr show") {
      return ok(ifaces.filter((i) => i.ip).map((i, n) =>
        `${n + 2}: ${i.name}    inet ${i.ip}/${i.prefix} brd 10.0.0.255 scope global ${i.name}\\       valid_lft forever`)
        .join("\n") + "\n");
    }
    if (cmd === "ip -4 route show") return ok((routes || []).join("\n") + "\n");
    if (cmd === "ip -4 neigh show") {
      return ok(Object.entries(neigh || {})
        .map(([ip2, v]) => `${ip2} dev ${v.dev} ${v.mac ? `lladdr ${v.mac} ` : ""}${v.state}`).join("\n") + "\n");
    }
    if (cmd === "cat /proc/sys/net/ipv4/ip_forward") return ok(`${ipForward ? 1 : 0}\n`);
    if (/rp_filter/.test(cmd)) {
      return ok(ifaces.map((i) => `/proc/sys/net/ipv4/conf/${i.name}/rp_filter=0`).join("\n") +
        "\n/proc/sys/net/ipv4/conf/all/rp_filter=0\n");
    }
    if (/^tc -s qdisc show/.test(cmd)) return ok("qdisc mq 0: dev ens192 root\n");
    if (/^bridge link show/.test(cmd)) return ok("");
    if (/iptables -S/.test(cmd)) return ok("-P INPUT ACCEPT\n-P FORWARD ACCEPT\n-P OUTPUT ACCEPT\n");
    if (/command -v \$b/.test(cmd)) return ok("ping\ntraceroute\n");

    const png = cmd.match(/^ping .*'([\d.]+)' 2>&1$/);
    if (png) {
      const target = png[1];
      const alive = (reachablePeers || []).includes(target);
      return ok(alive
        ? `PING ${target} 56(84) bytes of data.\n64 bytes from ${target}: icmp_seq=1 ttl=64 time=0.4 ms\n\n` +
          `--- ${target} ping statistics ---\n3 packets transmitted, 3 received, 0% packet loss, time 2003ms\n` +
          `rtt min/avg/max/mdev = 0.300/0.400/0.500/0.100 ms\n`
        : `PING ${target} 56(84) bytes of data.\n\n--- ${target} ping statistics ---\n` +
          `3 packets transmitted, 0 received, 100% packet loss, time 2050ms\n`);
    }
    const ns = cmd.match(/^ip -4 neigh show '([\d.]+)'$/);
    if (ns) {
      const v = (neigh || {})[ns[1]];
      return ok(v ? `${ns[1]} dev ${v.dev} ${v.mac ? `lladdr ${v.mac} ` : ""}${v.state}\n` : "");
    }
    if (/arping/.test(cmd)) return { code: 127, stdout: "", stderr: "sudo: arping: command not found", timedOut: false };
    const rg = cmd.match(/^ip -4 route get '([\d.]+)'/);
    if (rg) {
      const r = (spec.routeGet || {})[rg[1]];
      return ok(r || "RTNETLINK answers: Network is unreachable\n");
    }
    if (/^traceroute/.test(cmd)) return ok(spec.traceroute || " 1  * * *\n");
    return ok("");
  };
}

/* ------------------------------------------------------------ SSH patching */

/**
 * The collectors destructure lib/ssh at load time, so the fakes are installed
 * once, up front, and dispatch through this mutable table. Swapping the table
 * per scenario would leave the collectors holding the previous closure.
 */
let HOSTS = {};

ssh.sshConnect = async ({ host }) => {
  if (!HOSTS[host]) throw new Error(`SSH ${host}: connect EHOSTUNREACH ${host}:22`);
  return { host, end() {} };
};
ssh.sshExec = async (conn, command) => HOSTS[conn.host](command);
ssh.sudoExec = async (conn, creds, command) => HOSTS[conn.host](`sudo ${command}`);

// required only after the patch above, so the collectors pick up the fakes
const engine = require("../lib/engine");

/* ------------------------------------------------------------- the testbed */

const IF = (name, mac, ip, prefix, extra = {}) => ({ name, mac, ip, prefix, ...extra });

function testbed(scenario) {
  return {
    [ESXI]: esxiShell(scenario.esxi || {}),
    "172.16.226.50": guestShell({
      hostname: "client",
      ifaces: [IF("ens160", "00:50:56:ff:00:01", "172.16.226.50", 24),
        IF("ens192", "00:50:56:00:00:01", "10.10.1.2", 24)],
      routes: ["default via 172.16.226.1 dev ens160", "10.10.1.0/24 dev ens192 proto kernel scope link src 10.10.1.2",
        "10.10.3.0/24 via 10.10.1.1 dev ens192"],
      neigh: scenario.clientNeigh || { "10.10.1.1": { dev: "ens192", mac: "00:50:56:00:00:02", state: "REACHABLE" } },
      ipForward: false,
      reachablePeers: scenario.clientReaches || ["10.10.1.1", "10.10.3.2"],
      routeGet: { "10.10.3.2": "10.10.3.2 via 10.10.1.1 dev ens192 src 10.10.1.2 uid 0 \n    cache",
        "10.10.1.2": "local 10.10.1.2 dev lo src 10.10.1.2 uid 0" },
      traceroute: scenario.clientTraceroute ??
        " 1  10.10.1.1  0.401 ms\n 2  10.10.2.2  0.712 ms\n 3  10.10.3.2  0.930 ms\n",
    }),
    "172.16.226.113": guestShell({
      hostname: "spoke",
      ifaces: [IF("ens160", "00:50:56:ff:00:02", "172.16.226.113", 24),
        IF("ens192", "00:50:56:00:00:02", "10.10.1.1", 24),
        IF("ens224", "00:50:56:00:00:03", "10.10.2.1", 24)],
      routes: ["10.10.1.0/24 dev ens192 proto kernel scope link", "10.10.2.0/24 dev ens224 proto kernel scope link",
        "10.10.3.0/24 via 10.10.2.2 dev ens224"],
      neigh: { "10.10.2.2": { dev: "ens224", mac: "00:50:56:00:00:06", state: "REACHABLE" } },
      ipForward: scenario.spokeForwarding !== false,
      reachablePeers: ["10.10.2.2", "10.10.1.2"],
      routeGet: { "10.10.3.2": "10.10.3.2 via 10.10.2.2 dev ens224 src 10.10.2.1 uid 0",
        "10.10.1.2": "10.10.1.2 dev ens192 src 10.10.1.1 uid 0" },
    }),
    "172.16.226.120": guestShell({
      hostname: "hub",
      ifaces: [IF("ens160", "00:50:56:ff:00:03", "172.16.226.120", 24),
        IF("ens192", "00:50:56:00:00:06", "10.10.2.2", 24),
        IF("ens224", "00:50:56:00:00:07", "10.10.3.1", 24)],
      routes: ["10.10.2.0/24 dev ens192 proto kernel scope link", "10.10.3.0/24 dev ens224 proto kernel scope link",
        "10.10.1.0/24 via 10.10.2.1 dev ens192"],
      neigh: { "10.10.3.2": { dev: "ens224", mac: "00:50:56:00:00:08", state: "REACHABLE" } },
      ipForward: true,
      reachablePeers: ["10.10.3.2", "10.10.2.1"],
      routeGet: { "10.10.3.2": "10.10.3.2 dev ens224 src 10.10.3.1 uid 0",
        "10.10.1.2": "10.10.1.2 via 10.10.2.1 dev ens192 src 10.10.2.2 uid 0" },
    }),
    "172.16.226.60": guestShell({
      hostname: "server",
      ifaces: [IF("ens160", "00:50:56:ff:00:04", "172.16.226.60", 24),
        IF("ens192", "00:50:56:00:00:08", "10.10.3.2", 24)],
      routes: ["10.10.3.0/24 dev ens192 proto kernel scope link", "10.10.1.0/24 via 10.10.3.1 dev ens192"],
      neigh: { "10.10.3.1": { dev: "ens192", mac: "00:50:56:00:00:07", state: "REACHABLE" } },
      ipForward: false,
      reachablePeers: ["10.10.3.1", "10.10.1.2"],
      routeGet: { "10.10.1.2": "10.10.1.2 via 10.10.3.1 dev ens192 src 10.10.3.2 uid 0",
        "10.10.3.2": "local 10.10.3.2 dev lo src 10.10.3.2 uid 0" },
    }),
  };
}

const CONFIG = {
  esxi: { host: ESXI, user: "root", pass: "secret" },
  nodes: {
    client: { host: "172.16.226.50", user: "root", pass: "p", vmName: "client-vm", dataIp: "10.10.1.2" },
    spoke: { host: "172.16.226.113", user: "root", pass: "p", vmName: "spoke-vm" },
    hub: { host: "172.16.226.120", user: "root", pass: "p", vmName: "hub-vm" },
    server: { host: "172.16.226.60", user: "root", pass: "p", vmName: "server-vm", dataIp: "10.10.3.2" },
  },
  options: { maxHops: 6, mtuBytes: 1500, activeProbes: true },
};

/* --------------------------------------------------------------- the tests */

let pass = 0;
const failures = [];

async function scenario(name, hosts, check) {
  HOSTS = hosts;
  try {
    const result = await engine.runDiagnosis(JSON.parse(JSON.stringify(CONFIG)));
    check(result);
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push({ name, e });
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}

/** Point the fake SSH surface at a different testbed (used by main + tooling). */
function useHosts(hosts) { HOSTS = hosts; }

async function main() {
  await scenario("healthy testbed, end to end", testbed({}), (r) => {
    assert.strictEqual(r.verdict, "HEALTHY", `findings: ${r.findings.map((f) => f.id).join(", ")}`);
    assert.deepStrictEqual(r.topo.l3Chain, ["client", "spoke", "hub", "server"]);
    assert.deepStrictEqual(r.segments.map((s) => s.status), ["ok", "ok", "ok"]);
    // proves the esxcli text-table parser fed real MACs into the port match
    assert.strictEqual(r.segments[0].portA.portgroup, "PG-CS");
    assert.strictEqual(r.segments[0].portB.portgroup, "PG-CS");
    assert.ok(fs.existsSync(r.reportPaths.html) && fs.existsSync(r.reportPaths.json));
  });

  await scenario("portgroup mismatch on the client segment",
    testbed({
      esxi: { spokeNearPortgroup: "PG-ORPHAN", spokeNearVswitch: "vSwitch2" },
      clientNeigh: { "10.10.1.1": { dev: "ens192", mac: "", state: "FAILED" } },
      clientReaches: [],
      clientTraceroute: " 1  * * *\n",
    }),
    (r) => {
      assert.strictEqual(r.verdict, "L2");
      assert.strictEqual(r.primary.id, "l2.portgroup-mismatch");
      assert.match(r.primary.detail, /PG-CS/);
      assert.match(r.primary.detail, /PG-ORPHAN/);
      assert.strictEqual(r.segments[0].status, "l2");
      // one cause: the dead traceroute is evidence for it, not a second fault
      assert.strictEqual(r.findings.filter((f) => f.severity === "critical").length, 1,
        r.findings.map((f) => `${f.id}/${f.severity}`).join(", "));
      const trunc = r.findings.find((f) => f.id === "l3.path-truncated");
      assert.strictEqual(trunc.layer, "info");
    });

  await scenario("forwarding disabled on the spoke",
    testbed({ spokeForwarding: false, clientReaches: ["10.10.1.1"], clientTraceroute: " 1  10.10.1.1  0.4 ms\n 2  * * *\n" }),
    (r) => {
      assert.strictEqual(r.verdict, "L3");
      const idsList = r.findings.map((f) => f.id);
      assert.ok(idsList.includes("l3.forwarding-disabled"), idsList.join(", "));
      assert.ok(idsList.includes("l3.path-truncated"), idsList.join(", "));
      // L2 must stay clean: every segment resolved ARP
      assert.deepStrictEqual(r.segments.map((s) => s.status), ["ok", "ok", "ok"]);
    });

  await scenario("ESXi unreachable — degrades to guest-only evidence",
    (() => { const h = testbed({}); delete h[ESXI]; return h; })(),
    (r) => {
      assert.strictEqual(r.verdict, "HEALTHY");
      assert.ok(r.findings.some((f) => f.id === "info.no-esxi"));
      assert.ok(r.segments.every((s) => s.sameL2Domain === null));
    });

  console.log("");
  if (failures.length) {
    console.log(`${pass} passed, ${failures.length} FAILED`);
    for (const f of failures) console.log(`\n--- ${f.name}\n${f.e.stack}`);
    process.exit(1);
  }
  console.log(`${pass} passed`);
}

module.exports = { testbed, esxiShell, guestShell, useHosts, CONFIG, ESXI };

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
