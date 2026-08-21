#!/usr/bin/env node
/**
 * Runs on the OTHER computer. Lets Claude Desktop reach an accounting MCP server
 * that lives on a private address.
 *
 * Claude Desktop's custom connectors are fetched by Anthropic's servers, so the
 * URL has to be publicly resolvable — a LAN or ZeroTier address is invisible to
 * them. But Claude Desktop also starts local stdio servers, and a local process
 * can reach a private address perfectly well. So: be that local process, and
 * forward everything over HTTP.
 *
 * In claude_desktop_config.json on the other computer:
 *
 *   {
 *     "mcpServers": {
 *       "accounting": {
 *         "command": "C:\\Program Files\\nodejs\\node.exe",
 *         "args": ["C:\\path\\to\\bridge.mjs"],
 *         "env": {
 *           "ACCT_MCP_URL": "http://10.243.39.206:8790/mcp",
 *           "ACCT_MCP_TOKEN": "the token make-token.mjs printed"
 *         }
 *       }
 *     }
 *   }
 *
 * Only this file and Node are needed on that machine — no database client, no
 * credentials for the accounting system, nothing but the token.
 */

import { createInterface } from "node:readline";

const URL_ = process.env.ACCT_MCP_URL || "";
const TOKEN = process.env.ACCT_MCP_TOKEN || "";

// Diagnostics go to stderr. Anything on stdout has to be valid JSON-RPC or the
// transport breaks, and the failure looks like "the server crashed".
const note = (m) => process.stderr.write("[bridge] " + m + "\n");

if (!URL_ || !TOKEN) {
  note("ACCT_MCP_URL and ACCT_MCP_TOKEN must both be set. See the top of bridge.mjs.");
  process.exit(1);
}
note(`forwarding to ${URL_}`);

/** JSON-RPC error shaped so Claude shows the reason instead of hanging. */
function errorFor(id, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code: -32000, message } };
}

async function forward(payload) {
  const res = await fetch(URL_, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer " + TOKEN,
    },
    body: JSON.stringify(payload),
  });

  if (res.status === 401) throw new Error("The server rejected the token. Check ACCT_MCP_TOKEN, and that the line is still in remote-tokens.txt.");

  const text = await res.text();
  if (!text) return null;                       // notification, nothing to relay

  // A streamable-HTTP reply may be SSE; the JSON sits on a data: line.
  if (/^\s*(event|id|data):/m.test(text)) {
    const data = text.split(/\r?\n/).filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim()).join("");
    return data ? JSON.parse(data) : null;
  }
  return JSON.parse(text);
}

const rl = createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  const raw = line.trim();
  if (!raw) return;

  let msg;
  try { msg = JSON.parse(raw); }
  catch { note("ignoring a line that is not JSON"); return; }

  // A notification has no id and expects no reply — relay it and stay quiet,
  // because an unexpected response on stdout confuses the client.
  const id = Array.isArray(msg) ? undefined : msg.id;

  try {
    const reply = await forward(msg);
    if (reply !== null && reply !== undefined) process.stdout.write(JSON.stringify(reply) + "\n");
  } catch (err) {
    note(err.message);
    if (id !== undefined && id !== null) {
      process.stdout.write(JSON.stringify(errorFor(id,
        "Could not reach the accounting server at " + URL_ + " — " + err.message)) + "\n");
    }
  }
});

rl.on("close", () => process.exit(0));
