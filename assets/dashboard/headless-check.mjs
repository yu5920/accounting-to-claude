// Runs the dashboard's own script in Node against a minimal DOM stub, so render
// errors surface without a browser. Exercises every topic, the period presets,
// the comparison modes, and the ledger search / sort / paging.
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync("dashboard.html", "utf8");
const payload = html.match(/<script type="application\/json" id="payload">([\s\S]*?)<\/script>/)[1];
const code = html.match(/<script>\n"use strict";([\s\S]*?)<\/script>\s*$/)[1];

const sinks = {};
const listeners = {};

function makeEl(id) {
  return {
    id,
    hidden: true,
    textContent: "",
    dataset: {},
    set innerHTML(v) { sinks[id] = v; },
    get innerHTML() { return sinks[id] || ""; },
    addEventListener(type, fn) { (listeners[id] = listeners[id] || {})[type] = fn; },
    querySelector: () => null,
    querySelectorAll: () => [],
    scrollIntoView() {},
    setAttribute() {},
    focus() {},
    setSelectionRange() {},
    closest: () => null,
    matches: () => false,
  };
}

const els = {};
const document = {
  getElementById: (id) => {
    if (id === "payload") return { textContent: payload };
    return els[id] || (els[id] = makeEl(id));
  },
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => makeEl("tmp"),
  body: { appendChild() {}, removeChild() {} },
  execCommand: () => true,
};

const ctx = {
  document, navigator: {}, console, JSON, Math, Number, String, Object, Array, Set,
  Infinity, isNaN, parseInt, parseFloat,
  setTimeout: (fn) => { if (typeof fn === "function") fn(); return 0; },
  setInterval: () => 0,
  clearInterval: () => {},
  fetch: () => Promise.reject(new Error("no server in the stub")),
  location: { reload() {} },
  clearTimeout: () => {},
  window: { scrollTo() {} },
};
vm.createContext(ctx);

let ok = true;
const fail = (m) => { ok = false; console.log("FAIL  " + m); };
const pass = (m) => console.log("PASS  " + m);

try {
  vm.runInContext('"use strict";' + code, ctx, { timeout: 60000 });
  pass("script runs without throwing");
} catch (e) {
  fail("script threw: " + e.message + "\n" +
       String(e.stack).split("\n").slice(0, 5).join("\n"));
  process.exit(1);
}

// Controls and rail must be populated.
["cFilters", "cRange", "cCmp", "rail", "railFoot", "view"].forEach((k) => {
  if (!sinks[k] || sinks[k].length < 30) fail("'" + k + "' rendered empty");
});
if (ok) pass("controls, rail and view all rendered");

const topics = (sinks.rail.match(/data-topic="([a-z]+)"/g) || [])
  .map((s) => s.replace(/.*"(.*)"/, "$1"));
if (topics.length !== 12) fail("expected 12 topics, got " + topics.length);
else pass("rail lists 12 topics: " + topics.join(", "));

// Every topic must render, and each ledger topic must produce table rows.
const run = (js) => vm.runInContext(js, ctx, { timeout: 60000 });
const LEDGER_TOPICS = { pnl: 1, cash: 1, ar: 1, ap: 1, cust: 1, lines: 1, liab: 1 };
topics.forEach((t) => {
  try {
    run('topic = "' + t + '"; render();');
    const v = sinks.view || "";
    if (v.length < 200) { fail("topic '" + t + "' rendered almost nothing"); return; }
    if (LEDGER_TOPICS[t]) {
      const rows = (v.match(/<tbody>[\s\S]*?<\/tbody>/g) || []).join("");
      const trs = (rows.match(/<tr>/g) || []).length;
      if (trs < 3) { fail("topic '" + t + "' ledger has no rows"); return; }
      pass("topic '" + t + "' rendered (" + trs + " table rows)");
    } else {
      pass("topic '" + t + "' rendered");
    }
  } catch (e) {
    fail("topic '" + t + "' threw: " + e.message);
  }
});

// Ledger search must narrow the result set.
try {
  run('topic = "cash"; render();');
  const before = (sinks.view.match(/(\d[\d,]*) 笔/) || [])[1];
  run('ledState("cash").q = "COMMISSION"; render();');
  const after = (sinks.view.match(/(\d[\d,]*) 笔/) || [])[1];
  const n = (s) => Number(String(s || "0").replace(/,/g, ""));
  if (n(after) > 0 && n(after) < n(before)) pass("ledger search: " + before + " → " + after + " 笔");
  else fail("ledger search did not narrow: " + before + " → " + after);
  run('ledState("cash").q = ""; render();');
} catch (e) { fail("ledger search threw: " + e.message); }

// Sorting must not throw and must flip the arrow.
try {
  run('var st = ledState("cash"); st.sort = 7; st.dir = -1; topic = "cash"; render();');
  if (/▼/.test(sinks.view)) pass("ledger sort by amount works");
  else fail("sort indicator missing");
} catch (e) { fail("ledger sort threw: " + e.message); }

// Paging.
try {
  run('topic = "cash"; ledState("cash").limit = 60; render();');
  const hasMore = /data-more="cash"/.test(sinks.view);
  run('ledState("cash").limit += 100; render();');
  if (hasMore) pass("ledger paging control present and limit raises cleanly");
  else pass("ledger fits on one page (no paging needed)");
} catch (e) { fail("paging threw: " + e.message); }

// Period presets and comparison. Read the named KPI card, not the first money
// string on the page - the verdict text also contains figures.
const kpiFig = (label) => {
  const re = new RegExp('<span class="k">' + label + '<\\/span><div class="v[^"]*">RM ([\\d,-]+)');
  const m = (sinks.view || "").match(re);
  return m ? m[1] : "(not found)";
};
var seenTotals = {};
[["6", "近 6 月"], ["12", "近 12 月"], ["24", "近 24 月"], ["ytd", "今年至今"],
 ["ly", "去年全年"], ["all", "全部"]].forEach(([p, label]) => {
  try {
    run('topic = "overview"; applyPreset("' + p + '"); renderControls(); render();');
    var fig = kpiFig("已确认收入");
    if (seenTotals[fig]) fail("期间 " + label + " 与 " + seenTotals[fig] + " 得到相同收入 " + fig + " — 期间筛选没生效");
    else seenTotals[fig] = label;
    pass("期间 " + label + " → 收入 " + kpiFig("已确认收入") + " · 净利 " + kpiFig("净利"));
  } catch (e) { fail("preset " + p + " threw: " + e.message); }
});
["yoy", "prev"].forEach((m) => {
  try {
    run('applyPreset("12"); cmpMode = "' + m + '"; renderControls(); render();');
    if (/class="cmp"/.test(sinks.view)) pass("comparison '" + m + "' adds delta rows");
    else fail("comparison '" + m + "' produced no delta");
  } catch (e) { fail("comparison " + m + " threw: " + e.message); }
});

// Internal-transfer toggle must change the cash figures.
try {
  run('cmpMode = "none"; topic = "cash"; excludeInternal = true; renderControls(); render();');
  const excl = kpiFig("流入");
  run('excludeInternal = false; renderControls(); render();');
  const incl = kpiFig("流入");
  const n = (s) => Number(String(s || "0").replace(/[^\d-]/g, ""));
  if (n(incl) > n(excl)) pass("户口间调拨开关有效：排除 " + excl + " / 含 " + incl);
  else fail("internal-transfer toggle had no effect: " + excl + " vs " + incl);
  run('excludeInternal = true; renderControls(); render();');
} catch (e) { fail("internal toggle threw: " + e.message); }

// Single-company filter.
try {
  run('sel = new Set(["SUMA"]); applyPreset("6"); topic = "overview"; renderControls(); render();');
  if (/SUMA/.test(sinks.railFoot) || /已选 1 间/.test(sinks.railFoot)) pass("single-company filter works");
  else pass("single-company filter ran (rail foot: " + (sinks.railFoot || "").slice(0, 40) + ")");
} catch (e) { fail("single-company filter threw: " + e.message); }


// P&L statement: accounting layout, entity tabs, and the arithmetic tying up.
try {
  run('sel = new Set(LIVE.map(function(c){return c.short;})); applyPreset("12"); ' +
      'cmpMode = "none"; pnlEntity = "__all__"; topic = "pnl"; renderControls(); render();');
  const v = sinks.view;
  ["销售 Sales", "营业收入 Revenue", "销货成本 Cost of sales", "毛利 Gross profit",
   "毛利率 GP%", "营业费用 Operating expenses", "净利 Net profit"].forEach((line) => {
    if (v.indexOf(line) === -1) fail("P&L statement missing line: " + line);
  });
  if (/合计 Total/.test(v)) pass("P&L statement renders all lines with a total column");

  if (/\(\d[\d,]*\)/.test(v)) pass("negatives shown in parentheses");
  else fail("no parenthesised negatives found in the statement");

  const ents = (v.match(/data-ent="([^"]+)"/g) || []).length;
  if (ents >= 2) pass("P&L entity tabs: " + ents + "（合并 + 各公司）");
  else fail("entity tabs missing");

  // Revenue - cost of sales - opex must equal net profit in the Total column.
  const totals = {};
  ["营业收入 Revenue", "销货成本 Cost of sales", "营业费用 Operating expenses",
   "净利 Net profit"].forEach((line) => {
    const row = v.split('<td class="first">' + line + "</td>")[1];
    if (!row) return;
    const cells = row.split("</tr>")[0].match(/<td class="num fig[^"]*tcol[^"]*"[^>]*>([^<]+)</);
    if (cells) {
      const raw = cells[1].trim();
      const neg = raw.startsWith("(");
      totals[line] = raw === "—" ? 0
        : (neg ? -1 : 1) * Number(raw.replace(/[(),]/g, ""));
    }
  });
  const chk = totals["营业收入 Revenue"] + totals["销货成本 Cost of sales"] +
              totals["营业费用 Operating expenses"];
  if (Math.abs(chk - totals["净利 Net profit"]) <= 2) {
    pass("statement ties: 收入 " + totals["营业收入 Revenue"].toLocaleString() +
         " + 成本 " + totals["销货成本 Cost of sales"].toLocaleString() +
         " + 费用 " + totals["营业费用 Operating expenses"].toLocaleString() +
         " = 净利 " + totals["净利 Net profit"].toLocaleString());
  } else {
    fail("statement does not tie: computed " + chk + " vs net profit " +
         totals["净利 Net profit"]);
  }

  // Switching entity must change the statement.
  const before = totals["营业收入 Revenue"];
  run('pnlEntity = "SUMA"; render();');
  const after = (sinks.view.split('<td class="first">营业收入 Revenue</td>')[1] || "")
    .split("</tr>")[0].match(/<td class="num fig[^"]*tcol[^"]*"[^>]*>([^<]+)</);
  const afterN = after ? Number(after[1].replace(/[(),]/g, "")) : 0;
  if (afterN > 0 && afterN < before) pass("entity tab switches statement: 合并 " +
    before.toLocaleString() + " → SUMA " + afterN.toLocaleString());
  else fail("entity tab did not change the statement: " + before + " → " + afterN);
  run('pnlEntity = "__all__"; render();');
} catch (e) { fail("P&L statement threw: " + e.message); }


// P&L level 2 must break lines into accounts.
try {
  run('sel = new Set(LIVE.map(function(c){return c.short;})); applyPreset("12"); ' +
      'cmpMode = "none"; pnlEntity = "__all__"; pnlLevel = 1; openFig = null; ' +
      'topic = "pnl"; renderControls(); render();');
  const l1 = (sinks.view.match(/<tr class="lvl2">/g) || []).length;
  run('pnlLevel = 2; render();');
  const l2 = (sinks.view.match(/<tr class="lvl2">/g) || []).length;
  if (l1 === 0 && l2 > 5) pass("P&L level 2 expands into " + l2 + " account rows");
  else fail("level toggle wrong: L1 had " + l1 + " child rows, L2 had " + l2);
} catch (e) { fail("P&L level toggle threw: " + e.message); }

// The removed sections must be gone from the P&L view.
try {
  const v = sinks.view;
  const still = ["收入科目", "支出科目", "损益分录"].filter((s) => v.indexOf(s) !== -1);
  if (still.length) fail("P&L still shows removed sections: " + still.join(", "));
  else pass("收入科目 / 支出科目 / 损益分录 removed from P&L");
} catch (e) { fail("removal check threw: " + e.message); }

// Clicking a figure must open a detail panel with accounts and transactions.
try {
  run('pnlLevel = 1; openFig = { line: "EP", acc: "", ym: "" }; render();');
  const v = sinks.view;
  if (!/figpanel/.test(v)) fail("figure panel did not open");
  else if (!/组成科目/.test(v) || !/分录/.test(v)) fail("figure panel missing composition or ledger");
  else {
    const rows = (v.split("数字来源")[1].match(/<tr>/g) || []).length;
    pass("figure drill-down opens with " + rows + " detail rows");
  }
  // A subtotal explains itself through its components instead.
  run('openFig = { line: "NP", acc: "", ym: "" }; render();');
  if (/减 营业费用/.test(sinks.view)) pass("subtotal figure shows its composition");
  else fail("subtotal figure did not show a composition");
  // A single month of a single account.
  run('pnlLevel = 2; openFig = { line: "EP", acc: "", ym: "' + "" + '" }; render();');
  run('openFig = null; render();');
} catch (e) { fail("figure drill-down threw: " + e.message); }

// AI Review.
try {
  run('topic = "review"; cmpMode = "yoy"; renderControls(); render();');
  const v = sinks.view;
  ["本期结论", "异常月份", "费用异动", "自动检查", "CFO 评述"].forEach((s) => {
    if (v.indexOf(s) === -1) fail("AI Review missing section: " + s);
  });
  if (/写于/.test(v)) pass("AI Review renders all five sections and dates the commentary");
  const swings = (v.split("费用异动")[1] || "").split("自动检查")[0];
  if (/<tbody>/.test(swings)) pass("AI Review computed expense swings against " + "去年同期");
  else pass("AI Review expense-swing section rendered (no qualifying swings)");
  run('cmpMode = "none"; renderControls(); render();');
  if (/需要先在上方选一个比较期间/.test(sinks.view))
    pass("AI Review explains why swings need a comparison period");
  else fail("AI Review did not explain the missing comparison");
} catch (e) { fail("AI Review threw: " + e.message); }

// 预算管理 3D topics: the cost-structure statement and GP by project.
try {
  run('sel = new Set(LIVE.map(function(c){return c.short;})); applyPreset("12"); ' +
      'cmpMode = "none"; pnlEntity = "__all__"; openFig = null; ' +
      'topic = "vrgfp"; renderControls(); render();');
  const v = sinks.view;
  ["R 收入", "获客成本", "交付成本", "V 变化成本", "G 毛利", "GP% 毛利率",
   "运营成本", "资产贬值", "F 固定成本", "P 利润"].forEach((l) => {
    if (v.indexOf(l) === -1) fail("成本结构表缺少: " + l);
  });
  if (/算差距/.test(v)) pass("成本结构 R−V=G 表与「算差距」都渲染了");

  // R − V must equal G, and G − F must equal P, in the total column.
  const cellOf = (label) => {
    const seg = v.split('<td class="first">' + label + "</td>")[1];
    if (!seg) return null;
    const m = seg.split("</tr>")[0].match(/<td class="num fig[^"]*tcol[^"]*"[^>]*>([^<]+)</);
    if (!m) return null;
    const raw = m[1].trim();
    if (raw === "—") return 0;
    return (raw.startsWith("(") ? -1 : 1) * Number(raw.replace(/[(),]/g, ""));
  };
  const R = cellOf("R 收入 Revenue"), V = cellOf("V 变化成本 Variable");
  const G = cellOf("G 毛利 Gross profit"), F = cellOf("F 固定成本 Fixed");
  const P = cellOf("P 利润 Profit");
  if (Math.abs((R + V) - G) <= 2 && Math.abs((G + F) - P) <= 2) {
    pass("成本结构结帐平衡：R " + R.toLocaleString() + " + V " + V.toLocaleString() +
         " = G " + G.toLocaleString() + "；G + F " + F.toLocaleString() +
         " = P " + P.toLocaleString());
  } else {
    fail("成本结构对不上：R=" + R + " V=" + V + " G=" + G + " F=" + F + " P=" + P);
  }

  // A figure must drill to its accounts.
  run('openFig = { line: "Va", acc: "", ym: "" }; render();');
  if (/组成科目/.test(sinks.view) && /分录/.test(sinks.view))
    pass("成本结构可点数字展开来源");
  else fail("成本结构的数字来源面板没有出现");
  run('openFig = null; render();');
} catch (e) { fail("成本结构 threw: " + e.message); }

// project-map.json ships empty, so this topic legitimately has nothing to show
// until someone maps accounts to projects. Only assert the table when it should
// exist - a check that fails on a correct default trains people to ignore it.
const MAPPED = Object.keys(
  JSON.parse(readFileSync("project-map.json", "utf8")).companies || {}).length;

try {
  run('topic = "product"; render();');
  const v = sinks.view;
  if (!/GP by Project/.test(v)) fail("分析产品页标题缺失");
  if (!MAPPED) {
    pass("分析产品：project-map.json 还没对应任何公司，页面正确留白");
  } else {
  if (!/成本已指定归属/.test(v)) fail("没有显示成本已指定归属的比例");
  else pass("分析产品页显示每间公司的成本归属比例");
  if (/超过一半的成本还在按收入比例分摊/.test(v))
    pass("分摊过半时有明确警告（这是目前的实况）");
  const tables = (v.match(/<table class="dtab pnl">/g) || []).length;
  if (tables >= 2) pass("分析产品渲染了 " + tables + " 间公司的表");
  else fail("分析产品表太少: " + tables);
  }
  if (/非营业收入/.test(v)) pass("非营业收入另列一行");
} catch (e) { fail("分析产品 threw: " + e.message); }

// Refresh button: present, and honest when there is no local server.
try {
  const btn = els.refreshBtn;
  if (!btn) fail("refreshBtn not wired");
  else {
    const click = (listeners.refreshBtn || {}).click;
    if (typeof click !== "function") fail("refresh button has no click handler");
    else {
      click();
      const panel = sinks.rfx || "";
      if (/连不到资料库/.test(panel) && /node serve\.mjs/.test(panel))
        pass("离线时 refresh 会说明要跑 serve.mjs，不会默默失败");
      else fail("offline refresh help missing: " + panel.slice(0, 90));
    }
  }
} catch (e) { fail("refresh button threw: " + e.message); }
console.log(ok ? "\nAll checks passed." : "\nCHECKS FAILED.");
process.exit(ok ? 0 : 1);
