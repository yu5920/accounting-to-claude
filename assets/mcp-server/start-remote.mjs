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
 * Reads remote-config.json if present (see remote-config.example.json), and
 * environment variables override it. If ACCT_PUBLIC_URL is already set — a named
 * tunnel or your own domain — the tunnel step is skipped entirely.
 *
 * Stop with Ctrl+C. Both processes go down together, and nothing is reachable
 * from outside afterwards.
 */

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(HERE, "remote-config.json");

let config = {};
if (existsSync(CONFIG_FILE)) {
  try { config = JSON.parse(readFileSync(CONFIG_FILE, "utf8")); }
  catch (e) { console.error("remote-config.json is not valid JSON: " + e.message); process.exit(1); }
}

// Environment wins over the file, so a one-off run can override without editing.
const env = { ...process.env };
const fromConfig = {
  ACCT_ENGINE: config.engine,
  ACCT_SQL_INSTANCE: config.sqlInstance,
  ACCT_FB_DIR: config.firebirdDir,
  ACCT_FB_USER: config.firebirdUser,
  ACCT_FB_PASSWORD: config.firebirdPassword,
  ACCT_REMOTE_PORT: config.port,
  ACCT_PUBLIC_URL: config.publicUrl,
  ACCT_ALLOW_DATABASES: Array.isArray(config.allowBooks) ? config.allowBooks.join(",") : config.allowBooks,
  ACCT_ALLOW_CIDR: config.allowCidr,
  ACCT_REMOTE_USERS: config.users
    ? Object.entries(config.users).map(([u, p]) => `${u}:${p}`).join(",")
    : undefined,
};
for (const [k, v] of Object.entries(fromConfig)) {
  if (v !== undefined && v !== null && v !== "" && !env[k]) env[k] = String(v);
}

const PORT = Number(env.ACCT_REMOTE_PORT) || 8790;
env.ACCT_REMOTE_PORT = String(PORT);

if (!env.ACCT_REMOTE_USERS) {
  console.error(`
  No accounts are configured, so nobody could sign in.

  Copy remote-config.example.json to remote-config.json and put a username and
  a long password in it. That file is in .gitignore — keep it that way.
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
  console.log("  Then sign in with the username and password from remote-config.json.");
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
  console.log(" set up a named tunnel and put its URL in remote-config.json.)\n");

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
