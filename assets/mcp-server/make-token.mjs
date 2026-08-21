#!/usr/bin/env node
/**
 * Issues one access token for one device and appends it to remote-tokens.txt.
 *
 *   node make-token.mjs "boss laptop"
 *
 * One token per device rather than one shared secret, because that is what makes
 * revocation possible: delete the line, restart, and only that device loses
 * access. A shared password can only be changed for everybody at once, which in
 * practice means it never gets changed.
 *
 * The audit log records which name made each query, so the names are worth
 * choosing properly — "boss laptop" tells you something later; "token2" does not.
 */

import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, "remote-tokens.txt");

const who = process.argv.slice(2).join(" ").trim();
if (!who) {
  console.error(`
  Give the device a name, so the audit log means something later:

      node make-token.mjs "boss laptop"
      node make-token.mjs "accounts office PC"
`);
  process.exit(1);
}

if (existsSync(FILE)) {
  const taken = readFileSync(FILE, "utf8").split(/\r?\n/)
    .map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split(/\s+/).slice(1).join(" "));
  if (taken.includes(who)) {
    console.error(`\n  "${who}" already has a token. Delete its line from\n  ${FILE}\n  first if you want to replace it.\n`);
    process.exit(1);
  }
} else {
  appendFileSync(FILE,
    "# One line per device: <token>  <name>\n" +
    "# Revoke a device by deleting its line and restarting the server.\n" +
    "# This file is secrets. It is in .gitignore; keep it that way.\n\n", "utf8");
}

const token = randomBytes(32).toString("base64url");
appendFileSync(FILE, `${token}  ${who}\n`, "utf8");

console.log(`
  Token for "${who}":

      ${token}

  Written to remote-tokens.txt. Restart the server so it picks it up.

  Give this to that one device only. Anyone holding it can read the books —
  not change them, the guard still refuses everything but SELECT, but read
  every posting, balance and customer name.
`);
