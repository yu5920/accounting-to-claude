#!/usr/bin/env node
/**
 * Accounting → Claude : READ-ONLY MCP server, stdio transport.
 *
 * This is the local entry point: Claude Desktop starts it as a child process on
 * the machine that can reach the accounting database. Nothing listens on a
 * port, so nothing outside this machine can reach it.
 *
 * Everything real lives in core.js — the read-only guard, the engine layer and
 * the four tools. remote.js is the other entry point, serving the same server
 * over HTTP for Claude on another computer.
 *
 * Configure with environment variables; see references/autocount-desktop.md or
 * references/sql-accounting-firebird.md for which ones your system needs.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./core.js";

await createServer().connect(new StdioServerTransport());
