/**
 * SSH helpers (ssh2) — password or private-key auth.
 *
 * Same shape as latency-test-automation/run_latency_tests.js so the two tools
 * behave identically against the lab VMs (accept whatever host key they
 * present, retry transient connect failures, feed the sudo prompt).
 */

"use strict";

const fs = require("fs");
const { Client } = require("ssh2");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isValidIp(s) {
  const parts = String(s ?? "").trim().split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** Accepts an IP or a hostname (lab VMs are sometimes reached by name). */
function isValidHost(s) {
  const h = String(s ?? "").trim();
  if (!h) return false;
  return isValidIp(h) || /^[A-Za-z0-9]([A-Za-z0-9._-]{0,251}[A-Za-z0-9])?$/.test(h);
}

async function withRetry(fn, { attempts = 3, delayMs = 2000, label = "operation", onWarn = null } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
      if (i < attempts) {
        if (onWarn) onWarn(`${label} failed (attempt ${i}/${attempts}): ${e.message} — retrying`);
        await sleep(delayMs * i);
      }
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${lastErr.message}`);
}

function sshConnectOnce({ host, user, pass, keyPath, readyTimeout = 20000 }) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const opts = {
      host,
      username: user,
      readyTimeout,
      // lab VMs / ESXi hosts — accept whatever host key they present
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

function sshConnect(creds, opts = {}) {
  return withRetry(() => sshConnectOnce(creds), {
    attempts: opts.attempts ?? 2,
    label: `SSH connect ${creds.host}`,
    onWarn: opts.onWarn ?? null,
  });
}

/**
 * Run a command. Never rejects on a non-zero exit — the caller decides whether
 * a failed probe is a finding or just missing tooling.
 */
function sshExec(conn, command, { sudoPass = null, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    conn.exec(command, { pty: !!sudoPass }, (err, stream) => {
      if (err) return reject(err);
      let stdout = "";
      let stderr = "";
      let fedPassword = false;
      const feed = () => {
        if (!sudoPass || fedPassword) return;
        fedPassword = true;
        try { stream.write(sudoPass + "\n"); } catch { /* stream gone */ }
      };
      const promptRe = /\[sudo\] password|password for|:\s*$/i;
      const timer = setTimeout(() => {
        stream.close();
        resolve({ code: 124, stdout, stderr: stderr + `\n(timed out after ${timeoutMs} ms)`, timedOut: true });
      }, timeoutMs);
      if (sudoPass) setTimeout(feed, 800);
      stream
        .on("close", (code) => {
          clearTimeout(timer);
          resolve({ code: code ?? 0, stdout, stderr, timedOut: false });
        })
        .on("data", (data) => {
          stdout += data.toString();
          if (sudoPass && !fedPassword && promptRe.test(stdout)) feed();
        })
        .stderr.on("data", (data) => {
          stderr += data.toString();
          if (sudoPass && !fedPassword && promptRe.test(stderr)) feed();
        });
    });
  });
}

/** sudo wrapper. Key auth assumes NOPASSWD; password auth feeds the prompt. */
function sudoExec(conn, creds, command, opts = {}) {
  if (creds && creds.pass) {
    return sshExec(conn, `sudo -S -p '[sudo] password:' ${command}`, { ...opts, sudoPass: creds.pass });
  }
  return sshExec(conn, `sudo -n ${command}`, opts);
}

module.exports = { isValidIp, isValidHost, withRetry, sshConnect, sshExec, sudoExec, sleep };
