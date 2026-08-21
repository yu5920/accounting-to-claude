#!/usr/bin/env node
// Read-only MCP server for AutoCount Cloud, over stdio (local Claude).
//
//   ACCT_CLOUD_KEY_ID / ACCT_CLOUD_API_KEY / ACCT_CLOUD_BOOKS
//
// The tools themselves live in cloud-tools.js, shared with cloud-server.js so a
// local and a remote user always get the same surface and the same guards.
//
// Run `node cloud-selftest.mjs` before pointing this at live books.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, runTool } from "./cloud-tools.js";

const server = new Server(
  { name: "autocount-cloud", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema })),
}));

server.setRequestHandler(CallToolRequestSchema, (req) =>
  runTool(req.params.name, req.params.arguments || {}));

await server.connect(new StdioServerTransport());
