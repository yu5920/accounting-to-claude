// Serves dashboard.html on this machine and gives its refresh button something
// to call. A published copy of the page has no route back to SQL Server, so the
// button only does real work when the page is opened from here.
//
//   node serve.mjs            → http://localhost:8787
//   node serve.mjs 9000       → a different port
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DIR = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2]) || 8787;
const PAGE = join(DIR, "dashboard.html");

// One refresh at a time; the page polls this while it runs.
let job = { running: false, step: "", log: [], startedAt: null, finishedAt: null, error: null };

function runStep(cmd, args, label) {
  return new Promise((resolve, reject) => {
    job.step = label;
    job.log.push("▶ " + label);
    const p = spawn(cmd, args, { cwd: DIR, windowsHide: true });
    const take = (buf) => {
      String(buf).split(/\r?\n/).forEach((l) => {
        const t = l.trim();
        if (t) job.log.push(t.length > 160 ? t.slice(0, 160) + "…" : t);
      });
      if (job.log.length > 400) job.log.splice(0, job.log.length - 400);
    };
    p.stdout.on("data", take);
    p.stderr.on("data", take);
    p.on("error", reject);
    p.on("close", (code) => code === 0
      ? resolve()
      : reject(new Error(label + " 失败（exit ${code}）".replace("${code}", code))));
  });
}

async function refresh() {
  if (job.running) return;
  job = { running: true, step: "启动", log: [], startedAt: new Date().toISOString(),
          finishedAt: null, error: null };
  try {
    await runStep(process.execPath, ["build-data.mjs"], "从 AutoCount 重新抓资料");
    await runStep(process.execPath, ["render-dashboard.mjs"], "重新产生页面");
    await runStep(process.execPath, ["build-site.mjs", "--lock"], "更新 Netlify 部署资料夹（加密）");
    job.log.push("✔ 完成");
  } catch (e) {
    job.error = String(e.message);
    job.log.push("✖ " + job.error);
  } finally {
    job.running = false;
    job.step = "";
    job.finishedAt = new Date().toISOString();
  }
}

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8",
                        "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");

  if (url.pathname === "/api/refresh" && req.method === "POST") {
    if (job.running) return json(res, 409, { running: true, step: job.step });
    refresh();                       // deliberately not awaited
    return json(res, 202, { started: true });
  }

  if (url.pathname === "/api/status") {
    let built = null;
    try { built = (await stat(PAGE)).mtime.toISOString(); } catch { /* not built yet */ }
    return json(res, 200, {
      local: true, running: job.running, step: job.step,
      log: job.log.slice(-40), error: job.error,
      startedAt: job.startedAt, finishedAt: job.finishedAt, builtAt: built,
    });
  }

  if (url.pathname === "/" || url.pathname === "/dashboard.html") {
    try {
      const html = await readFile(PAGE, "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8",
                           "cache-control": "no-store" });
      // Tells the page its refresh button has a server to talk to.
      return res.end('<script>window.__AUTOCOUNT_LOCAL__=true;</script>\n' + html);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return res.end("找不到 dashboard.html —— 先跑 node build-data.mjs 再跑 node render-dashboard.mjs");
    }
  }

  res.writeHead(404).end();
}).listen(PORT, () => {
  console.log("AutoCount dashboard: http://localhost:" + PORT);
  console.log("页面上的「更新资料」按钮会重跑 build-data.mjs + render-dashboard.mjs。");
  console.log("按 Ctrl+C 停止。");
});
