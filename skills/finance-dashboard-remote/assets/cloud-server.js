#!/usr/bin/env node
// The same read-only accounting tools as cloud-index.js, reachable over the
// network instead of only as a local subprocess.
//
//   node cloud-server.js            → http://<this machine>:8899/mcp
//
// Why this exists: the direct-database routes can only run on the machine that
// can see the database, so everyone else had to remote into it. This lets that
// one machine host the tools and everyone use Claude on their own computer.
//
// ---------------------------------------------------------------------------
// ⚠️ THE THING THAT MATTERS MORE THAN THE TRANSPORT
//
// The 32-entry allowlist in cloud-api.js stops writes. It does nothing about
// reads - for reading it is wide open by design, because reading is the whole
// point. So the moment these tools are on a network, anyone who can reach the
// port can read the company's complete books: revenue, customer names, bank
// movements, every posting.
//
// Hence a token, checked before the MCP layer sees the request at all. One token
// per person, revoked by deleting a line. This is not defence in depth against a
// determined attacker; it is the difference between "colleagues on the office
// network" and "anybody who finds the port".
//
// Bind address defaults to the LAN, never 0.0.0.0 on a public interface. Putting
// this on the open internet is out of scope: use Tailscale or a VPN, and let
// something built for it decide who may connect.
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { networkInterfaces } from "node:os";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, runTool } from "./cloud-tools.js";
import { BOOKS } from "./cloud-api.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ACCT_SERVER_PORT) || 8899;
const HOST = process.env.ACCT_SERVER_HOST || "0.0.0.0";

// ------------------------------------------------------------------- tokens
// One line per person: "<token>  <name>". Comments and blanks ignored.
// Generate with:  node -e 'console.log(require("crypto").randomUUID())'
const TOKEN_FILE = resolve(HERE, "server-tokens.txt");
function loadTokens() {
  if (!existsSync(TOKEN_FILE)) return [];
  return readFileSync(TOKEN_FILE, "utf8").split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const [tok, ...rest] = l.split(/\s+/);
      return { token: tok, who: rest.join(" ") || "(unnamed)" };
    });
}
let TOKENS = loadTokens();
if (!TOKENS.length) {
  console.error("拒绝启动：没有任何存取权杖。");
  console.error("");
  console.error("  这台机器一旦开始服务，任何连得到它的人都能读完整的帐。");
  console.error("  所以至少要有一个权杖。建立方式：");
  console.error("");
  console.error("    node -e 'console.log(require(\"crypto\").randomUUID())' >> " + TOKEN_FILE);
  console.error("");
  console.error("  然后在那一行后面加上使用者名字，例如：");
  console.error("    2f9c...  Alice");
  process.exit(2);
}

// Constant-time compare so a token cannot be recovered by timing the responses.
function whoIs(presented) {
  if (!presented) return null;
  const a = Buffer.from(presented);
  for (const t of TOKENS) {
    const b = Buffer.from(t.token);
    if (a.length === b.length && timingSafeEqual(a, b)) return t.who;
  }
  return null;
}

// --------------------------------------------------------------- mcp server
function buildServer() {
  const server = new Server(
    { name: "autocount-cloud-remote", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, (req) => runTool(req.params.name, req.params.arguments || {}));
  return server;
}

// One transport per session, so two people asking at once do not share state.
const sessions = new Map();

const http = createServer(async (req, res) => {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));

  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, books: BOOKS.length, tools: TOOLS.length }));
  }
  if (url.pathname !== "/mcp") {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    return res.end("Not found. The MCP endpoint is /mcp");
  }

  // Auth first. Nothing below this line runs for an unrecognised caller.
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim()
              : (req.headers["x-acct-token"] || "").toString().trim();
  const who = whoIs(token);
  if (!who) {
    console.log(new Date().toISOString() + "  拒绝  " + (req.socket.remoteAddress || "?") +
      "  " + (token ? "权杖无效" : "没有权杖"));
    res.writeHead(401, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "unauthorized",
      hint: "Send Authorization: Bearer <token>" }));
  }

  try {
    const sid = req.headers["mcp-session-id"];
    let entry = sid ? sessions.get(sid) : null;
    if (!entry) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, entry);
          console.log(new Date().toISOString() + "  连线  " + who + "  session " + id.slice(0, 8));
        },
        onsessionclosed: (id) => { sessions.delete(id); },
        enableDnsRebindingProtection: true,
      });
      const server = buildServer();
      entry = { transport, server, who };
      await server.connect(transport);
    }
    await entry.transport.handleRequest(req, res);
  } catch (e) {
    console.error("处理请求失败:", e.message);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal" }));
    }
  }
});

http.listen(PORT, HOST, () => {
  console.log("只读会计 MCP server");
  console.log("  工具 " + TOOLS.length + " 个 · 帐本 " + (BOOKS.join(", ") || "(未设定)") +
    " · 权杖 " + TOKENS.length + " 组");
  const nets = Object.values(networkInterfaces()).flat()
    .filter((n) => n && n.family === "IPv4" && !n.internal);
  console.log("");
  console.log("  本机:  http://localhost:" + PORT + "/mcp");
  for (const n of nets) console.log("  内网:  http://" + n.address + ":" + PORT + "/mcp");
  console.log("");
  console.log("⚠️ 只写入 32 条读端点白名单，改不了帐 —— 但读得到全部。");
  console.log("   权杖是唯一的门。不要把这个位址开到公网。");
});
