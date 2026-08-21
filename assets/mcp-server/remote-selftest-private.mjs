#!/usr/bin/env node
/**
 * Checks the private (token) mode — the one you use over a LAN or ZeroTier,
 * where there is no public URL and no OAuth.
 *
 *   node remote-selftest-private.mjs
 *
 * remote-selftest.mjs covers the public/OAuth mode. Both exist because they are
 * different doors: proving one is locked says nothing about the other.
 *
 * Starts its own server on a spare port with a throwaway token, so it does not
 * disturb a running one or touch remote-tokens.txt.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 8794;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = randomBytes(32).toString("base64url");

let pass = 0, fail = 0;
const ok = (m, x) => { pass++; console.log("PASS  " + m + (x ? "  -- " + x : "")); };
const bad = (m) => { fail++; console.log("FAIL  " + m); };

const child = spawn(process.execPath, ["remote.js"], {
  cwd: HERE,
  env: {
    ...process.env,
    ACCT_PUBLIC_URL: "",
    ACCT_REMOTE_PORT: String(PORT),
    ACCT_BIND: "127.0.0.1",             // do not actually open a port to the LAN in a test
    ACCT_REMOTE_TOKENS: `selftest-device:${TOKEN}`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (d) => { log += d; });
child.stderr.on("data", (d) => { log += d; });

function finish() {
  child.kill();
  console.log(`\n${fail === 0 ? "All checks passed. The token door holds." : fail + " check(s) failed."}`);
  process.exit(fail === 0 ? 0 : 1);
}

let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { await fetch(BASE + "/"); up = true; } catch { await new Promise((r) => setTimeout(r, 100)); }
}
if (!up) { console.log("FAIL  server did not start\n" + log); finish(); }

async function rpc(method, params, token = TOKEN) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (token) headers.Authorization = "Bearer " + token;
  const r = await fetch(BASE + "/mcp", {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const text = await r.text();
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  let body;
  try { body = JSON.parse(line ? line.slice(5).trim() : text); } catch { body = { raw: text }; }
  return { status: r.status, body, headers: r.headers };
}

console.log("--- the door ---");
{
  const none = await rpc("tools/list", {}, null);
  none.status === 401 ? ok("no token is refused", "401") : bad("expected 401, got " + none.status);

  const wrong = await rpc("tools/list", {}, randomBytes(32).toString("base64url"));
  wrong.status === 401 ? ok("a wrong token of the right shape is refused") : bad("wrong token got " + wrong.status);

  const truncated = await rpc("tools/list", {}, TOKEN.slice(0, -1));
  truncated.status === 401 ? ok("a token missing its last character is refused") : bad("truncated token accepted");

  const good = await rpc("tools/list", {});
  const names = (good.body.result?.tools || []).map((t) => t.name);
  names.length ? ok("the right token gets the tools", names.join(", "))
               : bad("valid token failed: " + JSON.stringify(good.body).slice(0, 200));
}

console.log("\n--- no OAuth surface in private mode ---");
{
  for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server", "/authorize", "/token"]) {
    const r = await fetch(BASE + p);
    if (r.status === 404) ok("no OAuth endpoint at " + p);
    else bad(p + " answered " + r.status + " — an unreachable authorization server is a liability");
  }
  const reg = await fetch(BASE + "/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://evil.example.com/cb"] }),
  });
  reg.status === 404 ? ok("nobody can register a client in private mode")
                     : bad("registration is open in private mode: " + reg.status);
}

console.log("\n--- still read-only ---");
{
  const w = await rpc("tools/call", { name: "query", arguments: { database: "master", sql: "DROP TABLE Debtor" } });
  const t = w.body.result?.content?.[0]?.text || "";
  /not allowed|Only SELECT|system database|refused/i.test(t)
    ? ok("a write over the token connection is refused")
    : bad("guard did not fire: " + t.slice(0, 120));
}

console.log("\n--- the bridge, as another computer would use it ---");
{
  const bridge = spawn(process.execPath, ["bridge.mjs"], {
    cwd: HERE,
    env: { ...process.env, ACCT_MCP_URL: BASE + "/mcp", ACCT_MCP_TOKEN: TOKEN },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  bridge.stdout.on("data", (d) => { out += d; });

  const send = (o) => bridge.stdin.write(JSON.stringify(o) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bridge-test", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

  await new Promise((r) => setTimeout(r, 1500));
  bridge.kill();

  const lines = out.trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });
  const listed = lines.find((m) => m && m.id === 2);
  listed?.result?.tools?.length
    ? ok("the bridge relays tools/list over stdio", listed.result.tools.length + " tools")
    : bad("bridge did not relay: " + out.slice(0, 200));
  lines.some((m) => m && m.id === undefined && m.result)
    ? bad("the bridge answered a notification — that breaks the stdio transport")
    : ok("the bridge stays silent on notifications");
}

console.log("\n--- audit ---");
{
  const f = join(HERE, "remote-audit.log");
  if (!existsSync(f)) bad("no audit log");
  else {
    const tail = readFileSync(f, "utf8").trim().split("\n").slice(-30);
    tail.some((l) => l.includes("selftest-device"))
      ? ok("queries are logged against the device name, not just an IP")
      : bad("the device name is not in the audit log");
  }
}

finish();
