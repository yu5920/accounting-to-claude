#!/usr/bin/env node
/**
 * Starts the remote MCP server and the tunnel that puts it on an https URL, in
 * the right order, and prints the one line you paste into Claude.
 *
 * The ordering is the whole reason this script exists. remote.js has to know its
 * own public URL before it starts, because that URL goes into the OAuth
 * metadata and Claude checks it matches. With a quick tunnel the URL does not
 * exist until cloudflared is running. So: tunnel first, read the URL, then the
 * server.
 *
 *   node start-remote.mjs
 *
 * Configure it with environment variables (ACCT_REMOTE_USERS, ACCT_ENGINE and so
 * on). If ACCT_PUBLIC_URL is already set — a named tunnel or your own domain —
 * the tunnel step is skipped entirely.
 *
 * You do not need this for a LAN or ZeroTier setup. See references/remote-mcp.md.
 *
 * Stop with Ctrl+C. Both processes go down together, and nothing is reachable
 * from outside afterwards.
 */

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// Public mode only. Everything comes from the environment; remote.js validates
// it. Private mode does not need this script at all - there is no tunnel and no
// ordering problem, so you just run remote.js.
const env = { ...process.env };

const PORT = Number(env.ACCT_REMOTE_PORT) || 8790;
env.ACCT_REMOTE_PORT = String(PORT);

if (!env.ACCT_REMOTE_USERS && !env.ACCT_REMOTE_TOKENS) {
  console.error(`
  Nobody could sign in. Set ACCT_REMOTE_USERS ("name:a-long-passphrase") for the
  login page, or issue a device token with make-token.mjs.

  If you only need another computer on your LAN or ZeroTier network, you do not
  want this script at all - run remote.js instead, and read
  references/remote-mcp.md.
`);
  process.exit(1);
}

let child = null;
let tunnel = null;
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const p of [child, tunnel]) { try { p?.kill(); } catch { /* already gone */ } }
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

function startServer(publicUrl) {
  console.log("\n" + "=".repeat(66));
  console.log("  Paste this into Claude as a custom connector:\n");
  console.log("      " + publicUrl + "/mcp\n");
  console.log("  Then sign in with the username and password you configured.");
  console.log("=".repeat(66) + "\n");

  child = spawn(process.execPath, ["remote.js"], {
    cwd: HERE,
    env: { ...env, ACCT_PUBLIC_URL: publicUrl },
    stdio: "inherit",
  });
  child.on("exit", (c) => shutdown(c ?? 0));
}

if (env.ACCT_PUBLIC_URL) {
  console.log("Using the public URL you configured: " + env.ACCT_PUBLIC_URL);
  console.log("(Not starting a tunnel — something else must be routing that name here.)");
  startServer(env.ACCT_PUBLIC_URL.replace(/\/+$/, ""));
} else {
  console.log(`Starting a Cloudflare quick tunnel to http://127.0.0.1:${PORT} ...`);
  console.log("(A quick tunnel gets a NEW address every time it starts. For daily use,");
  console.log(" set up a named tunnel and set ACCT_PUBLIC_URL to its address.)\n");

  tunnel = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${PORT}`], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  tunnel.on("error", (e) => {
    console.error(`
  Could not start cloudflared: ${e.message}

  Install it first:      winget install Cloudflare.cloudflared
  Then close this window, open a new one, and run this again — a new terminal
  is needed for the PATH change to take effect.
`);
    shutdown(1);
  });

  let found = false;
  const scan = (buf) => {
    const s = String(buf);
    process.stderr.write(s);
    if (found) return;
    const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (m) { found = true; startServer(m[0]); }
  };
  tunnel.stdout.on("data", scan);
  tunnel.stderr.on("data", scan);

  tunnel.on("exit", (c) => {
    if (!found) {
      console.error("\n  cloudflared exited (code " + c + ") before giving out a URL.");
      shutdown(1);
    }
  });

  setTimeout(() => {
    if (!found) {
      console.error("\n  No tunnel URL after 60 seconds. Check the cloudflared output above.");
      shutdown(1);
    }
  }, 60_000).unref();
}
