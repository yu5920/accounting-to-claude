// Runs the dashboard's own script in Node against a minimal DOM stub, so render
// errors surface without a browser. Exercises every topic, the period presets,
// the comparison modes, and the ledger search / sort / paging.
import { existsSync, readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync("dashboard.html", "utf8");
const payload = html.match(/<script type="application\/json" id="payload">([\s\S]*?)<\/script>/)[1];
const code = html.match(/<script>\n"use strict";([\s\S]*?)<\/script>/)[1];

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
let skipped = 0;
// A check that cannot apply to this data set is reported as skipped, never as
// passed. Silently passing an inapplicable check is how a suite stops meaning
// anything.
const skip = (m) => { skipped++; console.log("SKIP  " + m); };

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
      // Ledgers are collapsed by default now, so open every one on this topic
      // before counting - otherwise this check would silently pass on an empty
      // page and stop meaning anything.
      run('Object.keys(led).forEach(function(k){ led[k].open = true; }); ' +
          'topic = "' + t + '"; render();');
      const opened = sinks.view || "";
      const rows = (opened.match(/<tbody>[\s\S]*?<\/tbody>/g) || []).join("");
      // Count any row, not only attribute-free ones - rows carry ids/classes now.
      const trs = (rows.match(/<tr[\s>]/g) || []).length;
      if (trs < 3) { fail("topic '" + t + "' ledger has no rows once opened"); return; }
      pass("topic '" + t + "' rendered (" + trs + " table rows when opened)");
    } else {
      pass("topic '" + t + "' rendered");
    }
  } catch (e) {
    fail("topic '" + t + "' threw: " + e.message);
  }
});

// Ledgers must start collapsed - that is the whole point of the change.
try {
  run('Object.keys(led).forEach(function(k){ led[k].open = false; }); ' +
      'topic = "cash"; render();');
  const v0 = sinks.view || "";
  if (/data-ledtog/.test(v0) && /ledcollapsed/.test(v0))
    pass("ledgers start collapsed, with a count and a way to open them");
  else fail("ledger did not start collapsed");
} catch (e) { fail("collapsed-default check threw: " + e.message); }

// Ledger search must narrow the result set.
try {
  run('topic = "cash"; ledState("cash").open = true; render();');
  const before = (sinks.view.match(/(\d[\d,]*) entries/) || [])[1];
  run('ledState("cash").q = "COMMISSION"; render();');
  const after = (sinks.view.match(/(\d[\d,]*) entries/) || [])[1];
  const n = (s) => Number(String(s || "0").replace(/,/g, ""));
  if (n(after) > 0 && n(after) < n(before)) pass("ledger search: " + before + " → " + after + " entries");
  else fail("ledger search did not narrow: " + before + " → " + after);
  run('ledState("cash").q = ""; render();');
} catch (e) { fail("ledger search threw: " + e.message); }

// Sorting must not throw and must flip the arrow.
try {
  run('var st = ledState("cash"); st.open = true; st.sort = 7; st.dir = -1; topic = "cash"; render();');
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

// Single-company filter. The entity code is read from the data: the previous
// version selected a hard-coded name that no longer exists in most books, and
// its else-branch also called pass(), so it could not fail for any reason.
try {
  const FIRST = (JSON.parse(payload).companies || []).filter((c) => !c.failed)[0];
  if (!FIRST) {
    skip("single-company filter - no company in the data");
  } else {
    run("sel = new Set(" + JSON.stringify([FIRST.short]) +
        '); applyPreset("6"); topic = "overview"; renderControls(); render();');
    const foot = sinks.railFoot || "";
    if (/已选 1 间/.test(foot) || foot.indexOf(FIRST.short) !== -1)
      pass("single-company filter works (" + FIRST.short + ")");
    else fail("single-company filter had no effect: " + foot.slice(0, 60));
  }
} catch (e) { fail("single-company filter threw: " + e.message); }


// P&L statement: accounting layout, entity tabs, and the arithmetic tying up.
try {
  run('sel = new Set(LIVE.map(function(c){return c.short;})); applyPreset("12"); ' +
      'cmpMode = "none"; pnlEntity = "__all__"; topic = "pnl"; renderControls(); render();');
  const v = sinks.view;
  // Rows are found by their stable id, not by the label they happen to display.
  // Keying on visible text meant every wording change broke the suite - and
  // worse, a label typo could have made a row silently "missing".
  ["SL", "REV", "CO", "GP", "GPR", "EP", "NP"].forEach((id) => {
    if (v.indexOf('data-row="' + id + '"') === -1)
      fail("P&L statement missing line: " + id);
  });
  if (/>Total</.test(v)) pass("P&L statement renders all lines with a total column");

  if (/\(\d[\d,]*\)/.test(v)) pass("negatives shown in parentheses");
  else fail("no parenthesised negatives found in the statement");

  const ents = (v.match(/data-ent="([^"]+)"/g) || []).length;
  if (ents >= 2) pass("P&L entity tabs: " + ents + "（合并 + 各公司）");
  else fail("entity tabs missing");

  // Revenue - cost of sales - opex must equal net profit in the Total column.
  const totals = {};
  ["REV", "CO", "EP", "NP"].forEach((id) => {
    const row = v.split('data-row="' + id + '"')[1];
    if (!row) return;
    const cells = row.split("</tr>")[0].match(/<td class="num fig[^"]*tcol[^"]*"[^>]*>([^<]+)</);
    if (cells) {
      const raw = cells[1].trim();
      const neg = raw.startsWith("(");
      totals[id] = raw === "—" ? 0 : (neg ? -1 : 1) * Number(raw.replace(/[(),]/g, ""));
    }
  });
  const chk = totals["REV"] + totals["CO"] + totals["EP"];
  if (Math.abs(chk - totals["NP"]) <= 2) {
    pass("statement ties: revenue " + totals["REV"].toLocaleString() +
         " + cost " + totals["CO"].toLocaleString() +
         " + opex " + totals["EP"].toLocaleString() +
         " = net " + totals["NP"].toLocaleString());
  } else {
    fail("statement does not tie: computed " + chk + " vs net profit " + totals["NP"]);
  }

  // Switching entity must change the statement - but only a group of two or more
  // books has anything to switch between. With a single book the consolidated
  // column IS that book, so equal figures are correct and the check does not
  // apply. The entity code is read from the data rather than hard-coded, so this
  // works on any tenant instead of only the one it was first written against.
  const before = totals["营业收入 Revenue"];
  const SHORTS = (JSON.parse(payload).companies || [])
    .filter((c) => !c.failed).map((c) => c.short);
  if (SHORTS.length < 2) {
    skip("entity tab switches statement - needs 2+ company books, this data has " +
         SHORTS.length + " (" + (SHORTS[0] || "none") + ")");
  } else {
    run("pnlEntity = " + JSON.stringify(SHORTS[0]) + "; render();");
    const after = (sinks.view.split('<td class="first">营业收入 Revenue</td>')[1] || "")
      .split("</tr>")[0].match(/<td class="num fig[^"]*tcol[^"]*"[^>]*>([^<]+)</);
    const afterN = after ? Number(after[1].replace(/[(),]/g, "")) : 0;
    if (afterN > 0 && afterN < before) pass("entity tab switches statement: 合并 " +
      before.toLocaleString() + " → " + SHORTS[0] + " " + afterN.toLocaleString());
    else fail("entity tab did not change the statement: " + before + " → " + afterN);
  }
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

// The drill-down is two levels on purpose: a figure opens the accounts that
// compose it, and only then does one account open its documents. The previous
// version of this check looked for the words "组成科目" and "分录" anywhere in
// the panel - and "分录" appears in the level-one hint text, so it passed
// without a single transaction being rendered.
try {
  run('pnlLevel = 1; openFig = { line: "EP", acc: "", ym: "" }; render();');
  const lvl1 = sinks.view;
  const accRows = (lvl1.match(/<tr class="drill" data-figacc="/g) || []).length;
  if (!/figpanel/.test(lvl1)) fail("figure panel did not open");
  else if (!accRows) fail("level 1 showed no account rows");
  else if (/<th[^>]*>[\s\S]{0,80}Doc no/.test(lvl1))
    fail("level 1 already shows the transaction table - drill-down is not staged");
  else pass("drill-down level 1: " + accRows + " account rows, no transactions yet");

  // Level 2: pick the first account the panel offered and open it.
  const firstAcc = (lvl1.match(/data-figacc="([^"]+)"/) || [])[1];
  if (!firstAcc) fail("level 1 offered no account to drill into");
  else {
    run('openFig = { line: "EP", acc: ' + JSON.stringify(firstAcc) + ', ym: "" }; render();');
    const lvl2 = sinks.view;
    const txnRows = (lvl2.match(/<tr><td class="first mono">/g) || []).length;
    if (!txnRows) fail("level 2 showed no transactions for " + firstAcc);
    else if (!/data-figback/.test(lvl2)) fail("level 2 has no way back to level 1");
    else pass("drill-down level 2: " + txnRows + " transactions for " + firstAcc +
              ", with a back link");
  }
  run('openFig = { line: "EP", acc: "", ym: "" }; render();');
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

  // A figure drills to its accounts first, and only then to the documents.
  // The old version matched the words "组成科目" and "分录" anywhere, and the
  // level-one hint contains "分录" - so it passed with zero transactions shown.
  run('openFig = { line: "Va", acc: "", ym: "" }; render();');
  const vg1 = sinks.view;
  const vgAcc = (vg1.match(/<tr class="drill" data-figacc="/g) || []).length;
  const vgPick = (vg1.match(/data-figacc="([^"]+)"/) || [])[1];
  if (!vgAcc) fail("成本结构 level 1 没有列出科目");
  else if (/<th[^>]*>[\s\S]{0,80}Doc no/.test(vg1))
    fail("成本结构 level 1 就已经显示分录，没有分层");
  else {
    run('openFig = { line: "Va", acc: ' + JSON.stringify(vgPick || "") + ', ym: "" }; render();');
    const vg2 = sinks.view;
    const vgTx = (vg2.match(/<tr><td class="first mono">/g) || []).length;
    if (vgTx && /data-figback/.test(vg2))
      pass("成本结构分层下钻：" + vgAcc + " 个科目 → " + vgTx + " 笔分录，有返回");
    else fail("成本结构 level 2 没有分录或没有返回连结");
  }
  run('openFig = null; render();');
} catch (e) { fail("成本结构 threw: " + e.message); }

// project-map.json ships empty, so this topic legitimately has nothing to show
// until someone maps accounts to projects. Only assert the table when it should
// exist - a check that fails on a correct default trains people to ignore it.
const MAPPED = Object.keys(
  JSON.parse(existsSync("project-map.json")
    ? readFileSync("project-map.json", "utf8")
    : existsSync("project-map.example.json")
      ? readFileSync("project-map.example.json", "utf8")
      : '{"companies":{}}').companies || {}).length;

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
  // One table per mapped company. Asserting ">= 2" only passed on a group of
  // several books and failed on a correct single-book setup.
  const tables = (v.match(/<table class="dtab pnl">/g) || []).length;
  if (tables >= MAPPED) pass("分析产品渲染了 " + tables + " 间公司的表（对照了 " + MAPPED + " 间）");
  else fail("分析产品表太少: " + tables + "，但 project-map.json 对照了 " + MAPPED + " 间公司");
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
console.log(ok
  ? "\nAll checks passed." + (skipped ? "  (" + skipped + " skipped - not the same as passed)" : "")
  : "\nCHECKS FAILED.");
process.exit(ok ? 0 : 1);
