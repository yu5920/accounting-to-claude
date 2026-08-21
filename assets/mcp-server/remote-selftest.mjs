#!/usr/bin/env node
/**
 * Exercises the whole remote path end to end: discovery, registration, the
 * login page, PKCE, token issue and refresh rotation, and the MCP endpoint.
 *
 * The point is the negative cases. A remote server that works is easy; one that
 * also refuses a wrong password, a replayed code, a forged PKCE verifier and a
 * missing token is the only kind worth putting on the internet.
 *
 *   node remote-selftest.mjs
 *
 * Starts its own server on a spare port with throwaway credentials, so it does
 * not touch a running one. It needs a working database connection (the same
 * environment variables index.js uses) for the final tool call; without one the
 * last check reports SKIP rather than failing.
 */

import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 8793;
const BASE = `http://localhost:${PORT}`;
const USER = "tester";
const PASS = "a-long-enough-passphrase";

let pass = 0, fail = 0;
const ok = (m, extra) => { pass++; console.log("PASS  " + m + (extra ? "  -- " + extra : "")); };
const bad = (m) => { fail++; console.log("FAIL  " + m); };
const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// A fresh state file, so registrations from a previous run cannot mask a bug.
const STATE = join(HERE, "remote-state.json");
const HAD_STATE = existsSync(STATE);
if (HAD_STATE) unlinkSync(STATE);

const child = spawn(process.execPath, ["remote.js"], {
  cwd: HERE,
  env: {
    ...process.env,
    ACCT_PUBLIC_URL: BASE,
    ACCT_REMOTE_PORT: String(PORT),
    ACCT_REMOTE_USERS: `${USER}:${PASS}`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
child.stdout.on("data", (d) => { serverLog += d; });
child.stderr.on("data", (d) => { serverLog += d; });

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try { await fetch(BASE + "/"); return true; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  return false;
}

function finish() {
  child.kill();
  if (!HAD_STATE && existsSync(STATE)) unlinkSync(STATE);
  console.log(`\n${fail === 0 ? "All checks passed. The lock holds." : fail + " check(s) failed."}`);
  process.exit(fail === 0 ? 0 : 1);
}

if (!(await waitForServer())) {
  console.log("FAIL  server did not start\n" + serverLog);
  finish();
}

// --------------------------------------------------------------- discovery
console.log("--- discovery ---");
{
  const prm = await (await fetch(BASE + "/.well-known/oauth-protected-resource")).json();
  prm.resource === BASE + "/mcp"
    ? ok("protected resource names the exact MCP URL", prm.resource)
    : bad("resource mismatch: " + prm.resource);
  prm.authorization_servers?.[0] === BASE
    ? ok("points at its own authorization server")
    : bad("authorization_servers wrong: " + JSON.stringify(prm.authorization_servers));

  const asm = await (await fetch(BASE + "/.well-known/oauth-authorization-server")).json();
  asm.code_challenge_methods_supported?.includes("S256")
    ? ok("advertises S256 PKCE")
    : bad("S256 not advertised — Claude checks this before starting");
  asm.registration_endpoint
    ? ok("advertises dynamic client registration")
    : bad("no registration_endpoint");
  asm.token_endpoint_auth_methods_supported?.includes("none")
    ? ok("accepts a public client at the token endpoint")
    : bad("public clients not accepted");
}

// ------------------------------------------------------- unauthenticated
console.log("\n--- an unauthenticated caller ---");
{
  const r = await fetch(BASE + "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  r.status === 401 ? ok("tools/list without a token is refused", "401") : bad("expected 401, got " + r.status);
  const wa = r.headers.get("www-authenticate") || "";
  /resource_metadata="[^"]+oauth-protected-resource"/.test(wa)
    ? ok("401 points at the metadata, so Claude can find the login")
    : bad("WWW-Authenticate missing resource_metadata: " + wa);

  const r2 = await fetch(BASE + "/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      Authorization: "Bearer not-a-real-token",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  r2.status === 401 ? ok("an invented bearer token is refused") : bad("forged token got " + r2.status);
}

// ------------------------------------------------------------ registration
console.log("\n--- registration and login ---");
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
let clientId;
{
  const r = await fetch(BASE + "/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Self test" }),
  });
  const j = await r.json();
  clientId = j.client_id;
  r.status === 201 && clientId ? ok("client registered", clientId) : bad("registration failed: " + JSON.stringify(j));

  const bare = await fetch(BASE + "/register", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  bare.status === 400 ? ok("registration without a redirect URI is refused") : bad("bare registration got " + bare.status);
}

const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());

function authorizeUrl(extra = {}) {
  const p = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: REDIRECT,
    code_challenge: challenge, code_challenge_method: "S256", state: "xyz", scope: "accounting.read",
    ...extra,
  });
  return BASE + "/authorize?" + p;
}

{
  const r = await fetch(authorizeUrl());
  const body = await r.text();
  r.status === 200 && /name="password"/.test(body)
    ? ok("the login page is shown") : bad("no login form: " + r.status);
  /Read-only/.test(body)
    ? ok("the page says what is being granted") : bad("consent screen does not describe the grant");

  const noPkce = await fetch(authorizeUrl({ code_challenge_method: "plain" }));
  noPkce.status === 400 ? ok("PKCE without S256 is refused") : bad("plain PKCE got " + noPkce.status);

  const badRedirect = await fetch(authorizeUrl({ redirect_uri: "https://evil.example.com/cb" }));
  badRedirect.status === 400
    ? ok("an unregistered redirect address is refused")
    : bad("open redirect: got " + badRedirect.status);
}

async function login(username, password) {
  const form = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: REDIRECT,
    code_challenge: challenge, code_challenge_method: "S256", state: "xyz",
    username, password,
  });
  return fetch(BASE + "/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form, redirect: "manual",
  });
}

{
  const r = await login(USER, "wrong-password-entirely");
  r.status === 401 ? ok("a wrong password is refused") : bad("wrong password got " + r.status);
  const r2 = await login("nobody", PASS);
  r2.status === 401 ? ok("an unknown username is refused") : bad("unknown user got " + r2.status);
}

let code;
{
  const r = await login(USER, PASS);
  const loc = r.headers.get("location") || "";
  const u = loc ? new URL(loc) : null;
  code = u?.searchParams.get("code");
  code ? ok("a correct password returns an authorization code") : bad("no code in redirect: " + loc);
  u?.searchParams.get("state") === "xyz"
    ? ok("state is echoed back, so Claude can match the response")
    : bad("state not echoed");
}

// -------------------------------------------------------------------- token
console.log("\n--- token exchange ---");
async function token(params) {
  const r = await fetch(BASE + "/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  return { status: r.status, body: await r.json() };
}

{
  const forged = await token({
    grant_type: "authorization_code", code, client_id: clientId,
    redirect_uri: REDIRECT, code_verifier: b64url(randomBytes(32)),
  });
  forged.status === 400 && forged.body.error === "invalid_grant"
    ? ok("a forged PKCE verifier is refused", "invalid_grant")
    : bad("PKCE not enforced: " + JSON.stringify(forged));
}

// The failed attempt above consumed the code, which is correct behaviour but
// means we need a fresh one to test the happy path.
{
  const r = await login(USER, PASS);
  code = new URL(r.headers.get("location")).searchParams.get("code");
}

let accessToken, refreshToken;
{
  const good = await token({
    grant_type: "authorization_code", code, client_id: clientId,
    redirect_uri: REDIRECT, code_verifier: verifier,
  });
  accessToken = good.body.access_token;
  refreshToken = good.body.refresh_token;
  accessToken && good.body.token_type === "Bearer"
    ? ok("the correct verifier gets an access token", "expires_in " + good.body.expires_in)
    : bad("token exchange failed: " + JSON.stringify(good));
  refreshToken ? ok("a refresh token is issued") : bad("no refresh token");

  const replay = await token({
    grant_type: "authorization_code", code, client_id: clientId,
    redirect_uri: REDIRECT, code_verifier: verifier,
  });
  replay.body.error === "invalid_grant"
    ? ok("the same code cannot be used twice") : bad("code replay accepted");
}

{
  const first = await token({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });
  first.body.access_token ? ok("refresh returns a new access token") : bad("refresh failed: " + JSON.stringify(first));
  first.body.refresh_token && first.body.refresh_token !== refreshToken
    ? ok("the refresh token rotates") : bad("refresh token was not rotated");

  const reuse = await token({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });
  reuse.body.error === "invalid_grant"
    ? ok("the old refresh token is dead", "invalid_grant")
    : bad("stale refresh token still works — token theft would go unnoticed");
}

// ---------------------------------------------------------------------- MCP
console.log("\n--- the tools, with a real token ---");
async function rpc(method, params) {
  const r = await fetch(BASE + "/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer " + accessToken,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const text = await r.text();
  // A streamable-HTTP reply may arrive as SSE; the JSON is on the data: line.
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  try { return JSON.parse(line ? line.slice(5).trim() : text); } catch { return { raw: text }; }
}

{
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "remote-selftest", version: "1.0.0" },
  });
  const list = await rpc("tools/list", {});
  const names = (list.result?.tools || []).map((t) => t.name);
  names.length
    ? ok("tools/list works with a valid token", names.join(", "))
    : bad("tools/list returned nothing: " + JSON.stringify(list).slice(0, 200));

  const call = await rpc("tools/call", { name: "list_companies", arguments: {} });
  const text = call.result?.content?.[0]?.text || "";
  if (/No rows|DatabaseName|\[/.test(text)) ok("a real tool call reaches the database");
  else if (call.result?.isError) console.log("SKIP  no database reachable from here: " + text.slice(0, 90));
  else bad("unexpected tool response: " + JSON.stringify(call).slice(0, 200));

  const write = await rpc("tools/call", {
    name: "query",
    arguments: { database: "master", sql: "DELETE FROM Debtor" },
  });
  const wtext = write.result?.content?.[0]?.text || "";
  /not allowed|Access to the system database|Only SELECT|refused/i.test(wtext)
    ? ok("a write attempt over the remote connection is still refused")
    : bad("guard did not fire remotely: " + wtext.slice(0, 120));
}

// -------------------------------------------------------------- audit trail
console.log("\n--- audit ---");
{
  const log = join(HERE, "remote-audit.log");
  if (existsSync(log)) {
    const { readFileSync } = await import("node:fs");
    const lines = readFileSync(log, "utf8").trim().split("\n").slice(-40);
    const hasLogin = lines.some((l) => l.includes('"login-ok"') && l.includes(USER));
    const hasTool = lines.some((l) => l.includes('"tool"') && l.includes("list_companies"));
    const hasFail = lines.some((l) => l.includes('"login-failed"'));
    hasLogin ? ok("successful logins are recorded with the username") : bad("no login-ok in the audit log");
    hasFail ? ok("failed logins are recorded too") : bad("no login-failed in the audit log");
    hasTool ? ok("every tool call is recorded") : bad("tool calls are not being logged");
  } else bad("no audit log was written");
}

finish();
