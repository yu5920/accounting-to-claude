#!/usr/bin/env node
/**
 * Accounting → Claude : READ-ONLY MCP server, remote (HTTP) transport.
 *
 * Same server as index.js — same read-only guard, same engine layer, same four
 * tools, all imported from core.js — but reachable over the network so Claude on
 * another computer can ask questions about the books.
 *
 * That is a genuinely different risk profile from the stdio version, so this
 * file also implements the lock on the door:
 *
 *   - OAuth 2.0 with Dynamic Client Registration and PKCE (S256). This is what
 *     Claude supports out of the box; a fixed bearer token in a header is still
 *     beta and gated, so DCR is the path that works today.
 *   - A login page. Nobody reaches the tools without a username and password
 *     that you set.
 *   - Every tool call is written to an audit log with the user and the SQL.
 *   - Optional company allowlist, so a remote session can be narrower than a
 *     local one.
 *
 * What it does NOT do, and cannot: make this safe to leave running unattended
 * on a public URL forever. The books are real. Start it when you need it.
 *
 * Environment:
 *   ACCT_PUBLIC_URL        REQUIRED. The https URL Claude will reach, no trailing
 *                          slash, e.g. https://books.example.com
 *   ACCT_REMOTE_USERS      REQUIRED. "alice:password1,bob:password2"
 *   ACCT_REMOTE_PORT       Local port to listen on (default 8790)
 *   ACCT_ALLOW_DATABASES   Optional comma list; omit to allow every book
 *   ACCT_ALLOW_CIDR        Optional. Set to 160.79.104.0/21 to accept only
 *                          Anthropic's egress range — this locks out Claude Code
 *                          running on another computer, which connects directly.
 *   ...plus whatever the engine needs (ACCT_ENGINE, ACCT_SQL_INSTANCE, ...)
 */

import { createServer as createMcpServer } from "./core.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpServer } from "node:http";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PUBLIC_URL = (process.env.ACCT_PUBLIC_URL || "").replace(/\/+$/, "");
const PORT = Number(process.env.ACCT_REMOTE_PORT) || 8790;
const STATE_FILE = join(HERE, "remote-state.json");
const AUDIT_FILE = join(HERE, "remote-audit.log");

const ALLOW_DATABASES = (process.env.ACCT_ALLOW_DATABASES || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const ALLOW_CIDR = (process.env.ACCT_ALLOW_CIDR || "").trim();

const USERS = new Map(
  (process.env.ACCT_REMOTE_USERS || "").split(",").map((pair) => {
    const i = pair.indexOf(":");
    return i === -1 ? null : [pair.slice(0, i).trim(), pair.slice(i + 1)];
  }).filter((p) => p && p[0] && p[1])
);

function die(msg) {
  console.error("\n  " + msg + "\n");
  process.exit(1);
}

if (!PUBLIC_URL) {
  die("ACCT_PUBLIC_URL is not set. It must be the https URL Claude will reach,\n" +
      "  for example https://books-abc123.trycloudflare.com (no trailing slash).\n" +
      "  Claude checks that this matches the URL you type into the connector.");
}
if (!/^https:\/\//.test(PUBLIC_URL) && !/^http:\/\/localhost/.test(PUBLIC_URL)) {
  die("ACCT_PUBLIC_URL must be https. Claude will not send credentials over http.");
}
if (!USERS.size) {
  die('ACCT_REMOTE_USERS is not set. Set it to "name:password", for example\n' +
      '  ACCT_REMOTE_USERS=alice:a-long-passphrase\n' +
      "  There is no default account on purpose: this exposes real books.");
}
for (const [name, pw] of USERS) {
  if (pw.length < 12) {
    die(`The password for "${name}" is ${pw.length} characters. This server is\n` +
        "  reachable from the internet, so use at least 12 — a short one is\n" +
        "  guessable in the time it takes you to read this message.");
  }
}

const MCP_URL = PUBLIC_URL + "/mcp";
const SCOPE = "accounting.read";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const b64url = (buf) => buf.toString("base64")
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sha256 = (s) => createHash("sha256").update(s).digest();
const hash = (s) => sha256(s).toString("hex");
const secret = () => b64url(randomBytes(32));
const now = () => Math.floor(Date.now() / 1000);

/** Constant-time compare that does not leak length through an early return. */
function sameSecret(a, b) {
  const ha = sha256(String(a)), hb = sha256(String(b));
  return timingSafeEqual(ha, hb);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function sendJson(res, code, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

function sendHtml(res, code, body) {
  res.writeHead(code, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("Request body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function clientIp(req) {
  // cloudflared and most tunnels put the real client here. Only the tunnel can
  // reach our localhost port, so trusting the header is reasonable — but that
  // is exactly why the port must stay bound to 127.0.0.1.
  const fwd = req.headers["cf-connecting-ip"] ||
    String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.socket.remoteAddress || "";
}

function ipInCidr(ip, cidr) {
  const [range, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  const toInt = (s) => {
    const p = s.replace(/^::ffff:/, "").split(".");
    if (p.length !== 4) return null;
    return p.reduce((a, o) => (a << 8 >>> 0) + (Number(o) & 255), 0) >>> 0;
  };
  const a = toInt(ip), b = toInt(range);
  if (a === null || b === null || !Number.isFinite(bits)) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

function audit(event, detail) {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...detail }) + "\n";
  try { appendFileSync(AUDIT_FILE, line, "utf8"); } catch { /* never break a request over logging */ }
  console.log(line.trimEnd());
}

// ---------------------------------------------------------------------------
// State: registered clients and live tokens
//
// Persisted so restarting the server does not force everyone to reconnect.
// Only hashes are stored, so the file cannot be replayed to impersonate anyone.
// ---------------------------------------------------------------------------

const state = { clients: {}, refresh: {} };
if (existsSync(STATE_FILE)) {
  try { Object.assign(state, JSON.parse(readFileSync(STATE_FILE, "utf8"))); }
  catch { console.error("remote-state.json unreadable; starting fresh."); }
}
function saveState() {
  try { writeFileSync(STATE_FILE, JSON.stringify(state), "utf8"); }
  catch (e) { console.error("Could not write remote-state.json: " + e.message); }
}

const codes = new Map();   // short-lived, memory only
const access = new Map();  // access-token hash -> { user, exp, scope }

setInterval(() => {
  const t = now();
  for (const [k, v] of codes) if (v.exp < t) codes.delete(k);
  for (const [k, v] of access) if (v.exp < t) access.delete(k);
}, 60_000).unref();

// ---------------------------------------------------------------------------
// OAuth: redirect URI rules
// ---------------------------------------------------------------------------

/**
 * Claude Code is a native client: it listens on a loopback port that changes
 * every session, so an exact match is impossible and RFC 8252 §7.3 requires the
 * port to be ignored. Everything else must match exactly.
 */
function redirectAllowed(registered, candidate) {
  if (registered.includes(candidate)) return true;
  let c;
  try { c = new URL(candidate); } catch { return false; }
  if (c.hostname !== "localhost" && c.hostname !== "127.0.0.1") return false;
  return registered.some((r) => {
    try {
      const u = new URL(r);
      return (u.hostname === "localhost" || u.hostname === "127.0.0.1") &&
             u.pathname === c.pathname;
    } catch { return false; }
  });
}

function verifyPkce(verifier, challenge) {
  if (!verifier || !challenge) return false;
  return b64url(sha256(verifier)) === challenge;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const protectedResourceMetadata = () => ({
  resource: MCP_URL,
  authorization_servers: [PUBLIC_URL],
  scopes_supported: [SCOPE],
  bearer_methods_supported: ["header"],
});

const authServerMetadata = () => ({
  issuer: PUBLIC_URL,
  authorization_endpoint: PUBLIC_URL + "/authorize",
  token_endpoint: PUBLIC_URL + "/token",
  registration_endpoint: PUBLIC_URL + "/register",
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  scopes_supported: [SCOPE, "offline_access"],
});

function loginPage({ clientName, params, error }) {
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("\n");
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in — accounting</title>
<style>
:root{color-scheme:light dark}
body{font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;
  min-height:100vh;display:grid;place-items:center;background:#f4f5f7;color:#1b1f23}
@media (prefers-color-scheme:dark){body{background:#14171a;color:#e8ecef}}
form{background:#fff;padding:28px 30px;border-radius:12px;width:min(380px,92vw);
  box-shadow:0 1px 2px rgba(0,0,0,.06),0 12px 30px -18px rgba(0,0,0,.4)}
@media (prefers-color-scheme:dark){form{background:#1e2226}}
h1{font-size:17px;margin:0 0 4px}
p.sub{margin:0 0 18px;font-size:13px;opacity:.7}
label{display:block;font-size:12px;font-weight:600;margin:12px 0 5px;opacity:.85}
input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:9px 11px;
  border:1px solid rgba(128,128,128,.4);border-radius:7px;font-size:14px;
  background:transparent;color:inherit}
button{width:100%;margin-top:20px;padding:10px;border:0;border-radius:7px;
  background:#1d6fa5;color:#fff;font-size:14px;font-weight:600;cursor:pointer}
.err{margin:14px 0 0;padding:9px 11px;border-radius:7px;background:#fdeceb;
  color:#9e2a21;font-size:13px}
@media (prefers-color-scheme:dark){.err{background:#3a1e1b;color:#f0a9a2}}
.note{margin:18px 0 0;font-size:12px;opacity:.65;line-height:1.5}
</style>
<form method="post" action="/authorize">
${hidden}
<h1>Sign in to the accounts</h1>
<p class="sub">${esc(clientName || "An MCP client")} is asking for read-only access.</p>
<label for="u">Username</label>
<input id="u" name="username" type="text" autocomplete="username" autocapitalize="off"
       autocorrect="off" spellcheck="false" required autofocus>
<label for="p">Password</label>
<input id="p" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Allow read-only access</button>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<p class="note">Read-only. This grant cannot change, delete or post anything —
the server refuses every statement that is not a SELECT. Every query is logged
with your username.</p>
</form>`;
}

function statusPage() {
  return `<!doctype html><meta charset="utf-8">
<title>accounting MCP</title>
<style>body{font:15px/1.6 system-ui,sans-serif;margin:44px auto;max-width:34rem;padding:0 1rem}
code{background:rgba(128,128,128,.16);padding:1px 5px;border-radius:4px}</style>
<h1>Accounting MCP server</h1>
<p>Running. This page holds no data.</p>
<p>To connect, add this URL as a custom connector in Claude:</p>
<p><code>${esc(MCP_URL)}</code></p>
<p>You will be asked to sign in. Access is read-only.</p>`;
}

// ---------------------------------------------------------------------------
// The MCP endpoint
// ---------------------------------------------------------------------------

function unauthorized(res, description) {
  const params = [
    `resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`,
    `scope="${SCOPE}"`,
  ];
  if (description) params.push(`error="invalid_token"`, `error_description="${description}"`);
  res.writeHead(401, {
    "WWW-Authenticate": "Bearer " + params.join(", "),
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify({ error: "unauthorized", error_description: description || "Sign in required." }));
}

function bearerUser(req) {
  const h = String(req.headers.authorization || "");
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  const rec = access.get(hash(m[1]));
  if (!rec || rec.exp < now()) return null;
  return rec;
}

/** Names every tool call in the audit log, and blocks books outside the allowlist. */
function inspectRpc(body, user, ip) {
  const msgs = Array.isArray(body) ? body : [body];
  for (const m of msgs) {
    if (!m || m.method !== "tools/call") continue;
    const p = m.params || {};
    const a = p.arguments || {};
    audit("tool", { user, ip, tool: p.name, database: a.database, sql: a.sql, max_rows: a.max_rows });
    if (ALLOW_DATABASES.length && a.database && !ALLOW_DATABASES.includes(a.database)) {
      return `The book "${a.database}" is not available over the remote connection. ` +
             `Allowed: ${ALLOW_DATABASES.join(", ")}.`;
    }
  }
  return null;
}

async function handleMcp(req, res) {
  const user = bearerUser(req);
  if (!user) return unauthorized(res);

  let body;
  if (req.method === "POST") {
    const raw = await readBody(req);
    try { body = raw ? JSON.parse(raw) : undefined; }
    catch { return sendJson(res, 400, { error: "invalid_json" }); }

    const refusal = inspectRpc(body, user.user, clientIp(req));
    if (refusal) {
      const id = (Array.isArray(body) ? body[0] : body)?.id ?? null;
      return sendJson(res, 200, {
        jsonrpc: "2.0", id,
        result: { content: [{ type: "text", text: "Error: " + refusal }], isError: true },
      });
    }
  }

  // Stateless: one server and transport per request. Simpler than session
  // bookkeeping, and it means a restart never strands a half-open session.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createMcpServer();
  res.on("close", () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const httpServer = createHttpServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  try {
    if (ALLOW_CIDR && !ipInCidr(clientIp(req), ALLOW_CIDR)) {
      audit("blocked-ip", { ip: clientIp(req), path });
      res.writeHead(403, { "Content-Type": "text/plain" });
      return res.end("Forbidden\n");
    }

    // --- discovery -------------------------------------------------------
    if (req.method === "GET" && path.startsWith("/.well-known/oauth-protected-resource")) {
      return sendJson(res, 200, protectedResourceMetadata());
    }
    if (req.method === "GET" && (path.startsWith("/.well-known/oauth-authorization-server") ||
                                 path.startsWith("/.well-known/openid-configuration"))) {
      return sendJson(res, 200, authServerMetadata());
    }

    // --- dynamic client registration (RFC 7591, application/json) ---------
    if (req.method === "POST" && path === "/register") {
      let reg;
      try { reg = JSON.parse(await readBody(req) || "{}"); }
      catch { return sendJson(res, 400, { error: "invalid_client_metadata" }); }

      const redirect_uris = Array.isArray(reg.redirect_uris) ? reg.redirect_uris : [];
      if (!redirect_uris.length) {
        return sendJson(res, 400, {
          error: "invalid_redirect_uri",
          error_description: "redirect_uris is required.",
        });
      }
      const client_id = "c_" + b64url(randomBytes(18));
      state.clients[client_id] = {
        client_id,
        redirect_uris,
        client_name: String(reg.client_name || "").slice(0, 120),
        created: now(),
      };
      saveState();
      audit("register", { client_id, client_name: state.clients[client_id].client_name, redirect_uris });
      return sendJson(res, 201, {
        client_id,
        client_id_issued_at: now(),
        redirect_uris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      });
    }

    // --- authorize: show the login form ----------------------------------
    if (req.method === "GET" && path === "/authorize") {
      const q = Object.fromEntries(url.searchParams);
      const client = state.clients[q.client_id];
      if (!client) return sendHtml(res, 400, "<p>Unknown client. Remove the connector in Claude and add it again.</p>");
      if (!redirectAllowed(client.redirect_uris, q.redirect_uri || "")) {
        return sendHtml(res, 400, "<p>That redirect address is not registered for this client.</p>");
      }
      if (q.response_type !== "code") return sendHtml(res, 400, "<p>Only response_type=code is supported.</p>");
      if (q.code_challenge_method !== "S256" || !q.code_challenge) {
        return sendHtml(res, 400, "<p>PKCE with S256 is required.</p>");
      }
      return sendHtml(res, 200, loginPage({ clientName: client.client_name, params: q }));
    }

    // --- authorize: check the password, hand back a code ------------------
    if (req.method === "POST" && path === "/authorize") {
      const form = new URLSearchParams(await readBody(req));
      const q = Object.fromEntries(form);
      const client = state.clients[q.client_id];
      if (!client || !redirectAllowed(client.redirect_uris, q.redirect_uri || "")) {
        return sendHtml(res, 400, "<p>This sign-in request is no longer valid. Start again from Claude.</p>");
      }
      const stored = USERS.get(q.username || "");
      const okUser = stored !== undefined && sameSecret(stored, q.password || "");
      if (!okUser) {
        audit("login-failed", { ip: clientIp(req), username: q.username, client_id: q.client_id });
        // Same delay whether the username exists or not, so failures do not
        // reveal which half was wrong.
        await new Promise((r) => setTimeout(r, 700));
        const { username, password, ...rest } = q;
        return sendHtml(res, 401, loginPage({
          clientName: client.client_name, params: rest,
          error: "That username and password did not match.",
        }));
      }

      const code = secret();
      codes.set(code, {
        user: q.username, client_id: q.client_id, redirect_uri: q.redirect_uri,
        challenge: q.code_challenge, exp: now() + 300,
      });
      audit("login-ok", { ip: clientIp(req), user: q.username, client_id: q.client_id });

      const to = new URL(q.redirect_uri);
      to.searchParams.set("code", code);
      if (q.state) to.searchParams.set("state", q.state);
      res.writeHead(302, { Location: to.toString(), "Cache-Control": "no-store" });
      return res.end();
    }

    // --- token (form-urlencoded, per RFC 6749 §4.1.3) ---------------------
    if (req.method === "POST" && path === "/token") {
      const form = new URLSearchParams(await readBody(req));
      const grant = form.get("grant_type");

      const issue = (user, scope) => {
        const at = secret(), rt = secret();
        const expiresIn = 3600;
        access.set(hash(at), { user, scope, exp: now() + expiresIn });
        // Public clients must get a rotating refresh token; the old one dies in
        // the same response that issues the new one.
        state.refresh[hash(rt)] = { user, scope, created: now() };
        saveState();
        return sendJson(res, 200, {
          access_token: at, token_type: "Bearer", expires_in: expiresIn,
          refresh_token: rt, scope,
        });
      };

      if (grant === "authorization_code") {
        const rec = codes.get(form.get("code") || "");
        codes.delete(form.get("code") || "");          // single use, always
        if (!rec || rec.exp < now()) {
          return sendJson(res, 400, { error: "invalid_grant", error_description: "Authorization code expired or already used." });
        }
        if (rec.client_id !== form.get("client_id") || rec.redirect_uri !== form.get("redirect_uri")) {
          return sendJson(res, 400, { error: "invalid_grant", error_description: "Code was issued to a different client or redirect." });
        }
        if (!verifyPkce(form.get("code_verifier"), rec.challenge)) {
          return sendJson(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed." });
        }
        audit("token", { user: rec.user, client_id: rec.client_id, grant });
        return issue(rec.user, SCOPE);
      }

      if (grant === "refresh_token") {
        const key = hash(form.get("refresh_token") || "");
        const rec = state.refresh[key];
        if (!rec) {
          return sendJson(res, 400, { error: "invalid_grant", error_description: "Refresh token is no longer valid." });
        }
        delete state.refresh[key];
        audit("token", { user: rec.user, grant });
        return issue(rec.user, rec.scope || SCOPE);
      }

      return sendJson(res, 400, { error: "unsupported_grant_type" });
    }

    // --- the MCP endpoint itself -----------------------------------------
    if (path === "/mcp") return await handleMcp(req, res);

    if (req.method === "GET" && path === "/") return sendHtml(res, 200, statusPage());

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found\n");
  } catch (err) {
    audit("error", { path, message: err.message });
    if (!res.headersSent) sendJson(res, 500, { error: "server_error", error_description: err.message });
    else res.end();
  }
});

// Bind to loopback only. The tunnel is the single way in, which is also what
// makes it safe to trust its forwarded-IP header.
httpServer.listen(PORT, "127.0.0.1", () => {
  console.log(`
  Accounting MCP (remote) is listening on http://127.0.0.1:${PORT}

  Public URL   ${PUBLIC_URL}
  Connector    ${MCP_URL}
  Accounts     ${[...USERS.keys()].join(", ")}
  Books        ${ALLOW_DATABASES.length ? ALLOW_DATABASES.join(", ") : "all"}
  IP allowlist ${ALLOW_CIDR || "off"}
  Audit log    ${AUDIT_FILE}

  Read-only: every statement is checked before it runs.
  Stop with Ctrl+C. Nothing is reachable once this window closes.
`);
});
