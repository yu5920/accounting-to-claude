// Serves the site/ folder exactly as a static host would, so the locked build
// can be tried before it goes to Netlify. localhost is a secure context, which
// crypto.subtle requires - the same as https in production.
//
//   node serve-site.mjs        -> http://localhost:8788
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "site");
const PORT = Number(process.argv[2]) || 8788;
const TYPES = { ".html": "text/html; charset=utf-8", ".txt": "text/plain; charset=utf-8" };

createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  const file = path === "/" ? "index.html" : path.replace(/^\/+/, "");
  if (file.includes("..")) { res.writeHead(400).end(); return; }
  try {
    const body = await readFile(join(DIR, file));
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found: " + file);
  }
}).listen(PORT, () => {
  console.log("site/ preview: http://localhost:" + PORT);
  console.log("Ctrl+C to stop.");
});
