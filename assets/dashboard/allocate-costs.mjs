// Lists the cost accounts that are NOT yet assigned to a product line, so they
// can be walked through one at a time.
//
//   node allocate-costs.mjs
//
// Ranked by amount, and split by variable vs fixed - because those are two
// different conversations:
//
//   VARIABLE cost that is unassigned is genuinely missing information. It
//   varies with volume, so something drove it; that something is a product
//   line. Leaving it shared hides which line the money followed.
//
//   FIXED cost that is unassigned is usually correct. Rent and admin salary
//   do not belong to a product line, and inventing a split for them is the
//   allocation problem in a different coat.
//
// So the walkthrough should start with variable, and should not push hard on
// fixed. Cumulative share is shown so the user can stop once the tail stops
// mattering rather than grinding through 200 accounts.
import { readFileSync, existsSync } from "node:fs";

const need = (f) => { if (!existsSync(f)) { console.error("找不到 " + f); process.exit(2); } };
need("dashboard-data.json"); need("cost-rules.json");

const data = JSON.parse(readFileSync("dashboard-data.json", "utf8"));
const rules = JSON.parse(readFileSync("cost-rules.json", "utf8"));
const pmap = JSON.parse(
  existsSync("project-map.json") ? readFileSync("project-map.json", "utf8")
  : existsSync("project-map.example.json") ? readFileSync("project-map.example.json", "utf8")
  : '{"companies":{}}');

const bucketOf = (acc, name, type) => {
  for (const r of rules.rules || []) {
    if (r.acc && String(r.acc).toUpperCase() === String(acc).toUpperCase()) return r.bucket;
    if (r.keyword && String(name).toUpperCase().includes(String(r.keyword).toUpperCase())) return r.bucket;
  }
  return (rules.fallback || {})[type] || "?";
};
const rm = (n) => Math.round(n).toLocaleString();

for (const c of (data.companies || []).filter((x) => !x.failed)) {
  const cfg = (pmap.companies || {})[c.short];
  if (!cfg) { console.log(c.short + ": 还没设 project-map，先跑分产品设定流程。"); continue; }
  const assigned = new Set(Object.keys(cfg.cost || {}));
  const lines = Object.keys(cfg.revenue || {}).map((k) => cfg.revenue[k]);
  const projects = [...new Set(lines)];

  const rows = (c.expenses || [])
    .filter((e) => !assigned.has(e.acc) && e.total !== 0)
    .map((e) => ({ ...e, bucket: bucketOf(e.acc, e.name, e.type) }))
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));

  const V = rows.filter((r) => r.bucket.startsWith("V"));
  const F = rows.filter((r) => !r.bucket.startsWith("V"));
  const sum = (a) => a.reduce((s, r) => s + r.total, 0);

  console.log("\n" + "=".repeat(66));
  console.log("  " + c.name + "   可选产品线: " + projects.join(" / "));
  console.log("=".repeat(66));
  console.log("未指定归属：变动 " + rm(sum(V)) + " (" + V.length + " 个科目)  ·  固定 " +
              rm(sum(F)) + " (" + F.length + " 个科目)");

  const show = (title, arr, note) => {
    if (!arr.length) return;
    const tot = sum(arr);
    console.log("\n" + title + "   " + note);
    let cum = 0;
    arr.slice(0, 12).forEach((r, i) => {
      cum += r.total;
      console.log("  " + String(i + 1).padStart(2) + ". " + r.acc.padEnd(12) +
        String(Math.round(r.total)).padStart(10) +
        "  累计 " + ((cum / tot) * 100).toFixed(0).padStart(3) + "%   " + r.name);
    });
    if (arr.length > 12)
      console.log("      ...其余 " + (arr.length - 12) + " 个科目，合计 " +
                  rm(tot - arr.slice(0, 12).reduce((s, r) => s + r.total, 0)));
  };

  show("【变动成本】优先处理 —— 随量发生，应该找得到驱动它的产品线", V,
       "一个一个问，从最大的开始");
  show("【固定成本】通常不该硬分 —— 除非有实际依据（坪数 / 人天 / 堂数）", F,
       "预设留在共用池");

  // Where the effort actually pays: how far do the top few get you?
  const top5 = V.slice(0, 5);
  if (top5.length) {
    const covered = sum(top5) / (sum(V) || 1);
    console.log("\n→ 只处理变动成本前 " + top5.length + " 大，就涵盖其中 " +
                (covered * 100).toFixed(0) + "%。剩下的可以先不碰。");
  }
}
console.log("\n把上面每个科目做成一题 AskUserQuestion：选项 = 各产品线 / 按比例拆 / 留在共用 / 停止。");
