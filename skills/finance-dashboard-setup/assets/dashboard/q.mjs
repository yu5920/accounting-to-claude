// Ad-hoc query helper: node q.mjs <database> "<sql>"
// Avoids shell quoting problems when exploring from the terminal.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [db, sql] = process.argv.slice(2);
if (!db || !sql) {
  console.error('usage: node q.mjs <database> "<sql>"');
  process.exit(2);
}

const client = new Client({ name: "q", version: "1.0.0" }, { capabilities: {} });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["index.js"] }));
const r = await client.callTool({ name: "query", arguments: { database: db, sql } });
const text = r.content.map((c) => c.text).join("\n");
if (r.isError) {
  console.error(text);
  await client.close();
  process.exit(1);
}
const i = text.indexOf("[");
const rows = i === -1 ? [] : JSON.parse(text.slice(i));
if (rows.length === 0) console.log("(no rows)");
else console.table(rows);
await client.close();
