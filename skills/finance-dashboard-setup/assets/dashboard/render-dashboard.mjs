// Renders dashboard-data.json into a self-contained dashboard.html.
//
// Layout: a global control bar (companies, period, comparison), a topic rail on
// the left, and one topic in view at a time. Every topic ends with its own
// transaction ledger - searchable, sortable, paged - so any figure on screen
// can be traced to the documents behind it.
import { readFileSync, writeFileSync } from "node:fs";

const IN = process.argv[2] || "dashboard-data.json";
const OUT = process.argv[3] || "dashboard.html";
const DATA = readFileSync(IN, "utf8");
// The 预算管理 3D model needs two pieces of judgement that are not in the
// ledger: which costs vary with volume, and which project each cost belongs to.
// Both live in editable JSON so they can be corrected without touching code.
const COST_RULES = readFileSync("cost-rules.json", "utf8");
const PROJECT_MAP = readFileSync("project-map.json", "utf8");
const parsed = JSON.parse(DATA);
const liveCount = parsed.companies.filter((c) => !c.failed).length;
const txnCount = parsed.companies.reduce((s, c) => s + ((c.txns || []).length), 0);
const genStr = new Date(parsed.generatedAt)
  .toLocaleString("en-MY", { dateStyle: "medium", timeStyle: "short" });

// Written commentary, embedded at build time. A published page cannot reach the
// database or call a model, so this is dated and clearly separated from the
// findings that recompute in the browser.
const REVIEW_DATE = new Date(parsed.generatedAt).toLocaleDateString("en-MY",
  { dateStyle: "medium" });
// Written commentary, optional. Put it in review.html next to this script and it
// is embedded at build time; leave the file out and the panel explains itself.
// It lives outside the code because it is dated judgement, not a computed figure -
// a published page cannot reach the database or call a model, so it cannot refresh.
let REVIEW_HTML;
try {
  REVIEW_HTML = readFileSync("review.html", "utf8");
} catch {
  REVIEW_HTML =
    '<p style="margin:0">No written review yet. Ask Claude on the machine that can ' +
    'reach the books for a read of these numbers, save it as ' +
    '<code>review.html</code> next to <code>render-dashboard.mjs</code>, and it ' +
    'appears here on the next build. Everything else on this page recomputes ' +
    'from the data; this panel does not, so it carries its date.</p>';
}

// Starter questions for the Ask panel. Override with questions.json - an array of
// strings. The good ones name a figure the reader just saw, so the answer lands
// on the same number they were looking at.
let QUESTIONS;
try {
  QUESTIONS = JSON.parse(readFileSync("questions.json", "utf8"));
} catch {
  QUESTIONS = [
    "Which month in the last two years was the worst, and what drove it?",
    "List the 20 largest expense entries of the current year.",
    "Which receivables are over 90 days, and who owes them?",
    "How much revenue would remain if the largest customer left?",
    "Which bank accounts moved the most this month, and against what?",
    "What is sitting in deferred revenue, and when does it become income?",
    "Compare this year to last year by expense account, largest change first.",
    "Which companies in the group invoice each other, and what is unsettled?",
  ];
}

// Company name in the header. BRAND in the environment wins, then profile.json,
// then a neutral placeholder - so a fresh copy renders without being branded as
// somebody else's company.
const { brand: PROFILE_BRAND } = await import("./profile.mjs");
const BRAND = process.env.BRAND || PROFILE_BRAND || "FINANCE";

// A real HTML document, not a fragment. Without <meta charset> a browser opening
// this from the filesystem falls back to the system code page - on a Chinese
// Windows machine that is GBK, and every Chinese label renders as mojibake. It
// looked fine over HTTP only because serve.mjs sends the charset in a header,
// which a double-clicked file never gets. The viewport tag is what makes it
// readable on a phone.
const html = `<!DOCTYPE html>
<html lang="zh-Hans">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${BRAND ? BRAND + " · " : ""}集团财务分析</title>
<style>
:root{
  --ground:#F6F1E8;--surface:#FFFFFF;--surface-2:#EFE8D9;--surface-3:#E5DCC8;
  --ink:#22312E;--ink-2:#4A5A55;--ink-3:#6B7672;
  --rule:#DED5C0;--rule-soft:#EBE4D5;
  --brand:#12413F;--on-brand:#F6F1E8;--tan:#BDAF94;
  --accent:#1D6FA5;--accent-wash:#E3EDF5;--on-accent:#FFFFFF;
  --bill:#eb6834;--rev:#2a78d6;--cmp:#A79B84;
  --pos:#2a78d6;--negb:#e34948;
  --age0:#6da7ec;--age1:#3987e5;--age2:#256abf;--age3:#184f95;--age4:#0d366b;
  --ok:#186B49;--ok-wash:#E2EFE4;
  --warn:#8E5C0B;--warn-wash:#F6EAD2;
  --serious:#A25710;--serious-wash:#F6E4CE;
  --critical:#9E2A21;--critical-wash:#F7E3DF;
  --shadow:0 1px 2px rgba(34,49,46,.05),0 8px 22px -16px rgba(34,49,46,.28);
  --font:"Noto Sans SC","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,-apple-system,"Segoe UI",sans-serif;
  --mono:ui-monospace,"Cascadia Mono",Consolas,"DejaVu Sans Mono",monospace;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --ground:#101E1C;--surface:#172926;--surface-2:#1F3733;--surface-3:#28443F;
  --ink:#E9EFE9;--ink-2:#B4C5BE;--ink-3:#87988F;
  --rule:#2C4641;--rule-soft:#213531;
  --brand:#0B2A28;--on-brand:#E9EFE9;--tan:#8C8064;
  --accent:#7FB6DC;--accent-wash:#13303F;--on-accent:#101E1C;
  --bill:#d95926;--rev:#3987e5;--cmp:#6E6754;
  --pos:#3987e5;--negb:#e66767;
  --age0:#9ec5f4;--age1:#6da7ec;--age2:#3987e5;--age3:#256abf;--age4:#184f95;
  --ok:#5FC08C;--ok-wash:#12301F;
  --warn:#DFA654;--warn-wash:#33280E;
  --serious:#E39A5E;--serious-wash:#37250F;
  --critical:#EC8078;--critical-wash:#351B16;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 22px -16px rgba(0,0,0,.75);
}}
:root[data-theme="dark"]{
  --ground:#101E1C;--surface:#172926;--surface-2:#1F3733;--surface-3:#28443F;
  --ink:#E9EFE9;--ink-2:#B4C5BE;--ink-3:#87988F;
  --rule:#2C4641;--rule-soft:#213531;
  --brand:#0B2A28;--on-brand:#E9EFE9;--tan:#8C8064;
  --accent:#7FB6DC;--accent-wash:#13303F;--on-accent:#101E1C;
  --bill:#d95926;--rev:#3987e5;--cmp:#6E6754;
  --pos:#3987e5;--negb:#e66767;
  --age0:#9ec5f4;--age1:#6da7ec;--age2:#3987e5;--age3:#256abf;--age4:#184f95;
  --ok:#5FC08C;--ok-wash:#12301F;
  --warn:#DFA654;--warn-wash:#33280E;
  --serious:#E39A5E;--serious-wash:#37250F;
  --critical:#EC8078;--critical-wash:#351B16;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 22px -16px rgba(0,0,0,.75);
}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--font);
  font-size:14.5px;line-height:1.6;-webkit-font-smoothing:antialiased}
.num,b,.v,td.num,th.num,.mono,select,input{font-variant-numeric:tabular-nums}
h1,h2,h3,h4,h5{text-wrap:balance;margin:0}
.neg{color:var(--critical)}.pos{color:var(--ok)}
button{font-family:inherit}
.shell{max-width:1440px;margin:0 auto;padding:0 20px 70px}

/* ---------- brand band + controls ---------- */
.brandbar{background:var(--brand);color:var(--on-brand)}
.brandin{max-width:1440px;margin:0 auto;padding:13px 20px;display:flex;
  justify-content:space-between;align-items:center;gap:18px;flex-wrap:wrap}
.brandin h1{font-size:19px;letter-spacing:.02em;font-weight:700}
.brandin .sub{font-size:11.5px;opacity:.72;margin-top:1px}
.brandin .stamp{font-family:var(--mono);font-size:11px;opacity:.72;text-align:right;line-height:1.5}
.bractions{display:flex;align-items:center;gap:16px;flex-wrap:wrap;justify-content:flex-end}
.aibtn{background:var(--tan);border:none;color:#22312E;font-size:12.5px;font-weight:600;
  padding:6px 14px;border-radius:5px;cursor:pointer;white-space:nowrap}
.aibtn:hover{filter:brightness(1.07)}
.aibtn[aria-pressed="true"]{background:var(--on-brand)}
.aibtn:focus-visible{outline:2px solid var(--on-brand);outline-offset:2px}
.aibtn.ghost{background:transparent;color:var(--on-brand);border:1px solid rgba(255,255,255,.35)}
.aibtn.ghost:hover{background:rgba(255,255,255,.12);filter:none}
.aibtn[disabled]{opacity:.55;cursor:progress}
.rfx{position:fixed;right:18px;bottom:18px;z-index:60;width:min(440px,calc(100vw - 36px));
  background:var(--surface);border:1px solid var(--accent);border-radius:8px;
  box-shadow:0 10px 34px -12px rgba(0,0,0,.45);padding:14px 16px}
.rfx[hidden]{display:none}
.rfx h4{font-size:13.5px;display:flex;justify-content:space-between;align-items:center;margin-bottom:7px}
.rfx .close{border:none;background:var(--surface-2);color:var(--ink-2);border-radius:5px;
  font-size:11.5px;padding:3px 9px;cursor:pointer}
.rfx p{margin:0 0 8px;font-size:12.5px;color:var(--ink-2);line-height:1.55}
.rfx code{display:block;background:var(--ink);color:var(--ground);padding:7px 9px;
  border-radius:5px;font-size:11.5px;margin:6px 0;white-space:pre-wrap;word-break:break-all}
.rfxlog{max-height:170px;overflow:auto;background:var(--surface-2);border-radius:5px;
  padding:8px 10px;font-family:var(--mono);font-size:11px;line-height:1.6;color:var(--ink-2)}
.rfxlog div{white-space:pre-wrap;word-break:break-all}
.rulebar{background:var(--surface-2);border-bottom:1px solid var(--rule)}
.rulein{max-width:1440px;margin:0 auto;padding:6px 20px;font-size:11.5px;color:var(--ink-3)}
.top{position:sticky;top:0;z-index:30;background:var(--ground);
  border-bottom:1px solid var(--rule);padding:11px 0 9px}
.crow{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:5px}
.crow:last-child{margin-bottom:0}
.clab{font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--ink-3);
  font-weight:700;min-width:34px}
.pill{font-size:12px;padding:3px 10px;border-radius:14px;cursor:pointer;line-height:1.5;
  border:1px solid var(--rule);background:var(--surface);color:var(--ink-2);white-space:nowrap}
.pill:hover{border-color:var(--accent);color:var(--ink)}
.pill[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);
  color:var(--on-accent);font-weight:600}
.pill:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.pill.quick{background:transparent;border-style:dashed}
.csep{width:1px;height:17px;background:var(--rule);margin:0 3px}
select,input[type=search]{font-family:var(--mono);font-size:12px;padding:3px 7px;
  border-radius:5px;border:1px solid var(--rule);background:var(--surface);color:var(--ink)}
select:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.cnote{font-size:11.5px;color:var(--ink-3)}

/* ---------- rail + main ---------- */
.body{display:grid;grid-template-columns:196px minmax(0,1fr);gap:24px;padding-top:18px;
  align-items:start}
.rail{position:sticky;top:118px}
.rail ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:1px}
.rnav{width:100%;text-align:left;display:flex;justify-content:space-between;align-items:center;
  gap:8px;padding:7px 11px;border:none;background:transparent;color:var(--ink-2);
  border-radius:5px;cursor:pointer;font-size:13.5px;border-left:3px solid transparent}
.rnav .rlab{display:block;line-height:1.25}
.rnav .ren{display:block;font-size:10.5px;color:var(--ink-3);letter-spacing:.02em}
.rnav:hover{background:var(--surface-2);color:var(--ink)}
.rnav[aria-current="true"]{background:var(--brand);color:var(--on-brand);font-weight:600;
  border-left-color:var(--tan)}
.rnav[aria-current="true"] .ren{color:var(--on-brand);opacity:.7}
.rnav:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.rnav .rc{font-size:10.5px;color:var(--ink-3);font-variant-numeric:tabular-nums;flex:0 0 auto}
.rnav[aria-current="true"] .rc{color:var(--on-brand);opacity:.75}
.rnav .rc.alert{color:var(--critical);font-weight:700}
.railfoot{margin-top:14px;padding-top:11px;border-top:1px solid var(--rule);
  font-size:11px;color:var(--ink-3);line-height:1.5}

main{min-width:0}
.vhead{margin-bottom:14px}
.vhead h2{font-size:19px;letter-spacing:-.01em}
.vhead p{margin:3px 0 0;color:var(--ink-3);font-size:13px;max-width:76ch}
.asat{display:inline-block;font-size:10px;font-weight:700;letter-spacing:.05em;
  background:var(--surface-2);color:var(--ink-3);padding:2px 7px;border-radius:3px;
  margin-left:7px;vertical-align:2px}

/* ---------- cards ---------- */
.card{background:var(--surface);border:1px solid var(--rule);border-radius:8px;
  padding:14px 16px;box-shadow:var(--shadow)}
.card+.card,.card+.grid,.grid+.card,.grid+.grid{margin-top:13px}
.card h3{font-size:14px;margin-bottom:2px}
.card .hint{font-size:12px;color:var(--ink-3);margin:0 0 9px}
.grid{display:grid;gap:13px}
.g2{grid-template-columns:repeat(auto-fit,minmax(340px,1fr))}
.g3{grid-template-columns:repeat(auto-fit,minmax(230px,1fr))}
.g4{grid-template-columns:repeat(auto-fit,minmax(190px,1fr))}

.kpi{background:var(--surface);border:1px solid var(--rule);border-radius:8px;
  padding:12px 14px;box-shadow:var(--shadow);position:relative}
.kpi .k{display:block;font-size:11px;letter-spacing:.04em;color:var(--ink-3);
  margin-bottom:2px;padding-right:20px}
.kpi .v{font-size:21px;font-weight:700;letter-spacing:-.02em;line-height:1.2}
.kpi .sub{font-size:11.5px;color:var(--ink-3);margin-top:2px}
.kpi .cmp{font-size:11.5px;margin-top:4px;padding-top:4px;border-top:1px dashed var(--rule)}
.src{position:absolute;top:7px;right:7px;width:18px;height:18px;border-radius:50%;
  border:1px solid var(--rule);background:var(--surface-2);color:var(--ink-3);
  font-size:10.5px;font-weight:700;cursor:pointer;display:grid;place-items:center;padding:0}
.src:hover{border-color:var(--accent);color:var(--accent)}
.src[aria-expanded="true"]{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}

.lin{margin-top:13px;background:var(--surface);border:1px solid var(--accent);
  border-radius:8px;padding:14px 16px;box-shadow:var(--shadow)}
.lin[hidden]{display:none}
.lin h4{font-size:13.5px;display:flex;justify-content:space-between;align-items:center;
  margin-bottom:10px}
.lin .close{border:none;background:var(--surface-2);color:var(--ink-2);border-radius:5px;
  font-size:11.5px;padding:3px 9px;cursor:pointer}
.lgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-bottom:11px}
.lbox{background:var(--surface-2);border-radius:5px;padding:8px 10px}
.lbox .lk{display:block;font-size:10px;letter-spacing:.06em;text-transform:uppercase;
  color:var(--ink-3);font-weight:700;margin-bottom:2px}
.lbox .lv{font-size:12px;color:var(--ink-2);font-family:var(--mono);line-height:1.5;word-break:break-word}

/* ---------- verdict ---------- */
.vitem{display:flex;gap:10px;align-items:flex-start}
.vmark{flex:0 0 auto;width:21px;height:21px;border-radius:50%;display:grid;place-items:center;
  font-size:11.5px;font-weight:700;margin-top:1px}
.vmark.good{background:var(--ok-wash);color:var(--ok)}
.vmark.bad{background:var(--critical-wash);color:var(--critical)}
.vmark.watch{background:var(--warn-wash);color:var(--warn)}
.vitem b{display:block;font-size:13.5px;margin-bottom:1px}
.vitem span{font-size:12.5px;color:var(--ink-2);line-height:1.5}

/* ---------- charts ---------- */
.legend{display:flex;gap:12px;font-size:12px;color:var(--ink-2);margin-bottom:6px;flex-wrap:wrap}
.sw{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.sw.bill{background:var(--bill)}.sw.rev{background:var(--rev)}
.sw.up{background:var(--pos)}.sw.dn{background:var(--negb)}.sw.cmp{background:var(--cmp)}
.chartwrap{position:relative}
.mchart{width:100%;height:158px;display:block}
.mchart .base{stroke:var(--rule);stroke-width:1}
.mchart .zero{stroke:var(--ink-3);stroke-width:1;stroke-dasharray:2 2}
.bar.bill{fill:var(--bill)}.bar.rev{fill:var(--rev)}
.bar.up{fill:var(--pos)}.bar.dn{fill:var(--negb)}.bar.cmp{fill:var(--cmp)}
.hit{fill:transparent}
.mgrp:hover .hit{fill:var(--surface-3);opacity:.55}
.xlab{font-size:8.5px;fill:var(--ink-3);font-family:var(--mono)}
.tip{position:absolute;pointer-events:none;background:var(--ink);color:var(--ground);
  border-radius:5px;padding:6px 9px;font-size:11.5px;line-height:1.5;white-space:pre;
  z-index:8;box-shadow:0 4px 14px rgba(0,0,0,.3);font-variant-numeric:tabular-nums}

/* ---------- tables ---------- */
.tscroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
.dtab{width:100%;border-collapse:collapse;font-size:12.5px}
.dtab th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.05em;
  color:var(--ink-3);padding:0 9px 6px 0;border-bottom:1px solid var(--rule);white-space:nowrap}
.dtab td{padding:5px 9px 5px 0;border-bottom:1px solid var(--rule-soft);vertical-align:middle}
.dtab td.num,.dtab th.num{text-align:right;white-space:nowrap}
.dtab tr.late td{background:var(--critical-wash)}
.dtab tr.tot td{border-top:2px solid var(--rule);border-bottom:none;font-weight:700;padding-top:7px}
.dtab td.first,.dtab th.first{position:sticky;left:0;background:var(--surface);z-index:1;
  min-width:180px;max-width:280px}
.dtab th.sortable{cursor:pointer;user-select:none}
.dtab th.sortable:hover{color:var(--accent)}
.dtab th .ar{font-size:9px;margin-left:3px}
.nm{font-weight:600}
.sub2{display:block;font-family:var(--mono);font-size:10px;color:var(--ink-3)}
.barcell{width:70px;min-width:70px}
.lbar{display:block;height:6px;background:var(--rev);border-radius:3px;min-width:2px}
.lbar.cost{background:var(--bill)}
.tag{font-size:9.5px;font-weight:700;padding:1px 5px;border-radius:3px;margin-left:5px;white-space:nowrap}
.tag.deferred{background:var(--warn-wash);color:var(--warn)}
.tag.recharge{background:var(--surface-2);color:var(--ink-3)}
.tag.grp{background:var(--accent-wash);color:var(--accent)}
.delta.up{color:var(--ok)}.delta.down{color:var(--serious)}
.spark{display:block;height:18px;width:88px}
.spark rect{fill:var(--rev)}
.risk{font-weight:700}
.risk.hi{color:var(--critical)}.risk.mid{color:var(--serious)}.risk.lo{color:var(--ok)}
.inflow{color:var(--ok)}.outflow{color:var(--critical)}
.zerocell{color:var(--ink-3)}

/* ---------- P&L statement ---------- */
.enttabs{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:12px}
.ent{font-size:12.5px;padding:5px 13px;border:1px solid var(--rule);background:var(--surface);
  color:var(--ink-2);cursor:pointer;border-radius:5px}
.ent:hover{border-color:var(--brand);color:var(--ink)}
.ent[aria-pressed="true"]{background:var(--brand);border-color:var(--brand);
  color:var(--on-brand);font-weight:600}
.ent:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.dtab.pnl td,.dtab.pnl th{padding-left:0;padding-right:11px}
.dtab.pnl tr.sub td{background:var(--surface-2);font-weight:600}
.dtab.pnl tr.sub td.first{background:var(--surface-2)}
.dtab.pnl tr.ratio td{color:var(--ink-3);font-size:11.5px}
.dtab.pnl th.cur{color:var(--brand)}
.dtab.pnl .tcol{border-left:2px solid var(--rule);font-weight:700;padding-left:11px}

.dtab.pnl td.fig{cursor:pointer}
.dtab.pnl td.fig:hover{background:var(--accent-wash);box-shadow:inset 0 0 0 1px var(--accent)}
.dtab.pnl td.figon{background:var(--accent);color:var(--on-accent);font-weight:700}
.dtab.pnl tr.lvl2 td{font-size:11.5px;color:var(--ink-2)}
.dtab.pnl tr.lvl2 td.first{padding-left:14px}
.dtab.pnl tr.lvl2 .l2n{font-weight:400}
.figpanel{border-color:var(--accent)}
.figpanel .close{border:none;background:var(--surface-2);color:var(--ink-2);border-radius:5px;
  font-size:11.5px;padding:3px 9px;cursor:pointer;height:fit-content}
.dmeta{margin:0 0 10px;font-size:12.5px;color:var(--ink-2);font-weight:600}
.dsub{margin:14px 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;
  color:var(--ink-3);font-weight:700}

/* ---------- ledger ---------- */
.ledger{margin-top:13px}
.lhead{display:flex;flex-wrap:wrap;gap:9px;align-items:flex-start;justify-content:space-between;
  margin-bottom:9px}
.lhead h3{font-size:14px}
.ltools{display:flex;gap:7px;align-items:center;flex-wrap:wrap}
input[type=search]{min-width:190px}
.lcount{font-size:11.5px;color:var(--ink-3)}
.more{margin-top:9px;text-align:center}
/* The openable tail of the cash-flow tables. Styled as an inline control rather
   than a button block, because it sits in a table cell alongside figures. */
.lnk{background:none;border:0;padding:0;font:inherit;color:var(--accent);cursor:pointer;text-align:left}
.lnk:hover{text-decoration:underline}
.cfrest td{background:var(--rowalt,transparent)}
.moreb{font-size:12px;padding:5px 16px;border-radius:6px;border:1px solid var(--rule);
  background:var(--surface-2);color:var(--ink-2);cursor:pointer}
.moreb:hover{border-color:var(--accent);color:var(--ink)}

/* ---------- misc ---------- */
.agebar{display:flex;height:17px;border-radius:4px;overflow:hidden;background:var(--surface-2);gap:2px}
.agebar .seg{display:block;min-width:3px}
.seg.s0{background:var(--age0)}.seg.s1{background:var(--age1)}.seg.s2{background:var(--age2)}
.seg.s3{background:var(--age3)}.seg.s4{background:var(--age4)}
.agelegend{display:flex;flex-wrap:wrap;gap:11px;margin-top:7px;font-size:11px;color:var(--ink-3)}
.agelegend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px}
.alist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.alist li{display:grid;grid-template-columns:9px auto 1fr;gap:8px;align-items:start;font-size:12.5px}
.sevdot{width:9px;height:9px;border-radius:50%;margin-top:5px}
.sev-critical .sevdot{background:var(--critical)}.sev-serious .sevdot{background:var(--serious)}
.sev-warning .sevdot{background:var(--warn)}.sev-info .sevdot{background:var(--accent)}
.acomp{font-family:var(--mono);font-size:10.5px;color:var(--ink-3);padding-top:1px;white-space:nowrap}
.atext{color:var(--ink-2)}
.acount{background:var(--surface-2);color:var(--ink-2);font-size:11px;font-weight:700;
  border-radius:12px;padding:1px 8px;margin-left:6px}
.qlist{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:9px}
.q{display:flex;gap:9px;align-items:flex-start;background:var(--surface);
  border:1px solid var(--rule);border-radius:6px;padding:10px 12px;font-size:12.5px;
  color:var(--ink-2);text-align:left;cursor:pointer;line-height:1.5}
.q:hover{border-color:var(--accent);color:var(--ink)}
.q .qi{color:var(--accent);font-weight:700;flex:0 0 auto}
.q.copied{border-color:var(--ok);color:var(--ok)}
.notes ul{margin:0;padding-left:18px;color:var(--ink-2);font-size:12.5px}
.notes li{margin-bottom:6px}
.notes code,.mono{font-family:var(--mono);font-size:.9em;background:var(--surface-2);
  padding:1px 4px;border-radius:3px}
.muted,.empty{color:var(--ink-3);font-size:12.5px}

@media (max-width:900px){
  .body{grid-template-columns:minmax(0,1fr);gap:14px}
  .rail{position:static}
  .rail ol{flex-direction:row;flex-wrap:wrap;gap:5px}
  .rnav{width:auto;border-left:none;border:1px solid var(--rule);padding:5px 10px}
  .rnav[aria-current="true"]{border-color:var(--tan)}
  .railfoot{display:none}
  .top{position:static}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style>
</head>
<body>

<div class="brandbar"><div class="brandin">
  <div>
    <h1>${BRAND}</h1>
    <div class="sub">集团财务分析 · Group Finance Cockpit</div>
  </div>
  <div class="bractions">
    <button class="aibtn ghost" type="button" id="refreshBtn">↻ 更新资料</button>
    <button class="aibtn" type="button" id="aiBtn">AI Review ▸</button>
    <div class="stamp">资料截至 ${genStr}<br>${parsed.months[0]} → ${parsed.months[parsed.months.length - 1]} · ${txnCount.toLocaleString()} 笔分录</div>
  </div>
</div></div>
<div class="rulebar"><div class="rulein">负数以括号显示 · 标示「当下」的区块不随期间变动 · 成本无法拆到服务线，损益只到公司层级</div></div>

<div class="shell">
<div class="top">
  <div class="crow" id="cFilters"></div>
  <div class="crow" id="cRange"></div>
  <div class="crow" id="cCmp"></div>
</div>

<div class="rfx" id="rfx" hidden></div>

<div class="body">
  <nav class="rail" aria-label="主题">
    <ol id="rail"></ol>
    <div class="railfoot" id="railFoot"></div>
  </nav>
  <main id="view"></main>
</div>
</div>

<script type="application/json" id="payload">${DATA.replace(/</g, "\\u003c")}</script>
<script>
"use strict";
var D = JSON.parse(document.getElementById("payload").textContent);
var QUESTIONS = ${JSON.stringify(QUESTIONS)};
var REVIEW_DATE = ${JSON.stringify(REVIEW_DATE)};
var REVIEW_HTML = ${JSON.stringify(REVIEW_HTML)};
var RULES = ${COST_RULES};
var PMAP = ${PROJECT_MAP};
var LIVE = D.companies.filter(function (c) { return !c.failed; });
var ALLM = D.months;
var sel = new Set(LIVE.map(function (c) { return c.short; }));
var LASTFULL = ALLM.length > 1 ? ALLM[ALLM.length - 2] : ALLM[ALLM.length - 1];
var range = { from: shift(LASTFULL, -11), to: LASTFULL };
var cmpMode = "none";
var excludeInternal = true;
var topic = "overview";
var openSrc = null;
var pnlEntity = "__all__";
var pnlLevel = 1;
var openFig = null;   // {line, acc, ym} whose detail panel is showing
// Which cash-flow matrices have had their "其他 N 个科目" row opened up.
// Keyed "in"/"out" so the two tables expand independently.
var cfOpen = {};
var led = {};

function ledState(k) { return led[k] || (led[k] = { q: "", sort: 0, dir: -1, limit: 60 }); }

function shift(ym, n) {
  var y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1 + n;
  y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
  return y + "-" + String(m + 1).padStart(2, "0");
}
function monthsBetween(a, b) {
  var out = [], cur = a;
  while (cur <= b) { out.push(cur); cur = shift(cur, 1); if (out.length > 200) break; }
  return out;
}
function rm(n) {
  var s = Math.abs(Math.round(n)).toLocaleString("en-MY");
  return (n < 0 ? "-" : "") + s;
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
  });
}
function mlab(ym) { return ym.slice(2).replace("-", "/"); }
function sum(a, f) { return a.reduce(function (s, x) { return s + f(x); }, 0); }
function picked() { return LIVE.filter(function (c) { return sel.has(c.short); }); }
function curMonths() { return monthsBetween(range.from, range.to); }
function cmpMonths() {
  var cur = curMonths();
  if (cmpMode === "yoy") return cur.map(function (m) { return shift(m, -12); });
  if (cmpMode === "prev") return cur.map(function (m) { return shift(m, -cur.length); });
  return null;
}
function cmpLabel() { return cmpMode === "yoy" ? "去年同期" : cmpMode === "prev" ? "前一期" : ""; }
function overM(map, months) {
  if (!map) return 0;
  return months.reduce(function (s, m) { return s + (map[m] || 0); }, 0);
}
function overRows(rows, months, field) {
  var set = {}; months.forEach(function (m) { set[m] = 1; });
  return (rows || []).reduce(function (s, r) { return set[r.ym] ? s + (r[field] || 0) : s; }, 0);
}
function revenueOf(c, m) { return overRows(c.pnlByMonth, m, "rev"); }
function costOf(c, m) { return overRows(c.pnlByMonth, m, "cost"); }
function profitOf(c, m) { return revenueOf(c, m) - costOf(c, m); }
function billingsOf(c, m) { return overRows(c.billingsByMonth, m, "amt"); }
function deferredOf(c) {
  return sum((c.liabilities || []).filter(function (l) { return l.isDeferred; }),
             function (l) { return l.bal; });
}
function dsoOf(c, m) {
  var r = revenueOf(c, m);
  if (r <= 0 || !m.length) return null;
  return c.ar.total / (r / (m.length * 30.44));
}
function burnOf(c, m) { return m.length ? (costOf(c, m) - revenueOf(c, m)) / m.length : 0; }
function runwayOf(c, m) {
  var b = burnOf(c, m);
  if (b <= 0) return Infinity;
  return c.cash > 0 ? c.cash / b : 0;
}
function cfRows(c) {
  if (c._cf) return c._cf;
  var banks = c.cfBanks || [], contra = c.cfContra || [];
  c._cf = (c.cashFlow || []).map(function (r) {
    var b = banks[r[0]] || { a: "", n: "" };
    var k = contra[r[2]] || { a: "", n: "(无对方科目)", t: "?" };
    return { bank: b.a, bankName: b.n, ym: r[1], contra: k.a, name: k.n,
             type: k.t, internal: k.x === 1, in: r[3], out: r[4], lines: r[5] };
  });
  return c._cf;
}
function cfOf(c, months) {
  var set = {}; months.forEach(function (m) { set[m] = 1; });
  return cfRows(c).filter(function (r) {
    return set[r.ym] && (!excludeInternal || !r.internal); });
}
function groupMonthly(list, months) {
  return months.map(function (ym) {
    var rev = 0, cost = 0;
    list.forEach(function (c) {
      (c.pnlByMonth || []).forEach(function (x) {
        if (x.ym === ym) { rev += x.rev; cost += x.cost; } });
    });
    return { ym: ym, rev: rev, cost: cost, profit: rev - cost };
  });
}

// txn row: [date, ref, description, accIdx, contraIdx, amount, kind, journalType]
function txnsOf(list, months, kinds) {
  var lo = months[0], hi = months[months.length - 1] + "-99";
  var out = [];
  list.forEach(function (c) {
    var accs = c.accs || [];
    (c.txns || []).forEach(function (t) {
      if (t[0] < lo || t[0] > hi) return;
      if (kinds.indexOf(t[6]) === -1) return;
      var a = accs[t[3]] || { a: "", n: "?", t: "?" };
      var k = accs[t[4]] || { a: "", n: "", t: "" };
      out.push({ co: c.short, date: t[0], ref: t[1], desc: t[2],
                 acc: a.a, accName: a.n, accType: a.t,
                 ctr: k.a, ctrName: k.n, amt: t[5], jt: t[7] });
    });
  });
  return out;
}
function docsOf(list, months, field) {
  var lo = months[0], hi = months[months.length - 1] + "-99";
  var out = [];
  list.forEach(function (c) {
    var parties = c.parties || [];
    (c[field] || []).forEach(function (d) {
      if (d[0] < lo || d[0] > hi) return;
      out.push({ co: c.short, date: d[0], doc: d[1], party: parties[d[2]] || "",
                 due: d[3], total: d[4], outs: d[5], late: d[6], desc: d[7] });
    });
  });
  return out;
}
function slDocsOf(list, months) {
  var lo = months[0], hi = months[months.length - 1] + "-99";
  var out = [];
  list.forEach(function (c) {
    var accs = c.accs || [], parties = c.parties || [];
    (c.slDocs || []).forEach(function (d) {
      if (d[0] < lo || d[0] > hi) return;
      var a = accs[d[2]] || { a: "", n: "?" };
      out.push({ co: c.short, date: d[0], doc: d[1], acc: a.a, accName: a.n,
                 party: parties[d[3]] || "", desc: d[4], amt: d[5] });
    });
  });
  return out;
}

function ledger(key, title, hint, cols, rows) {
  var st = ledState(key);
  var q = st.q.trim().toLowerCase();
  var filtered = q ? rows.filter(function (r) {
    return cols.some(function (col) {
      return String(col.raw ? col.raw(r) : "").toLowerCase().indexOf(q) !== -1; });
  }) : rows;
  var sc = cols[st.sort] || cols[0];
  var sorted = filtered.slice().sort(function (x, y) {
    var a = sc.sortVal ? sc.sortVal(x) : sc.raw(x);
    var b = sc.sortVal ? sc.sortVal(y) : sc.raw(y);
    if (a === b) return 0;
    return (a > b ? 1 : -1) * st.dir;
  });
  var shown = sorted.slice(0, st.limit);
  var total = sum(filtered, function (r) { return Number(r.amt || r.total || 0); });

  return '<section class="card ledger"><div class="lhead">' +
    '<div><h3>' + esc(title) + '</h3><p class="hint" style="margin:2px 0 0">' + esc(hint) + '</p></div>' +
    '<div class="ltools"><input type="search" data-led="' + esc(key) +
      '" placeholder="搜寻单号、摘要、科目…" value="' + esc(st.q) + '">' +
    '<span class="lcount">' + filtered.length.toLocaleString() + ' 笔' +
      (q ? "（全部 " + rows.length.toLocaleString() + "）" : "") +
      ' · 合计 RM ' + rm(total) + '</span></div></div>' +
    '<div class="tscroll"><table class="dtab"><thead><tr>' +
    cols.map(function (col, i) {
      return '<th class="sortable' + (col.num ? " num" : "") + (i === 0 ? " first" : "") +
        '" data-led="' + esc(key) + '" data-col="' + i + '">' + esc(col.label) +
        (i === st.sort ? '<span class="ar">' + (st.dir > 0 ? "▲" : "▼") + '</span>' : "") + '</th>';
    }).join("") + '</tr></thead><tbody>' +
    (shown.length ? shown.map(function (r) {
      return '<tr>' + cols.map(function (col, i) {
        return '<td class="' + (col.num ? "num " : "") + (i === 0 ? "first" : "") + '">' +
          col.cell(r) + '</td>'; }).join("") + '</tr>';
    }).join("") : '<tr><td class="empty" colspan="' + cols.length + '">没有符合的分录。</td></tr>') +
    '</tbody></table></div>' +
    (sorted.length > st.limit
      ? '<div class="more"><button class="moreb" type="button" data-more="' + esc(key) +
        '">再显示 100 笔（还有 ' + (sorted.length - st.limit).toLocaleString() + ' 笔）</button></div>'
      : "") + '</section>';
}

var COLS = {
  date: { label: "日期", raw: function (r) { return r.date; },
          cell: function (r) { return '<span class="mono">' + esc(r.date) + '</span>'; } },
  co: { label: "公司", raw: function (r) { return r.co; },
        cell: function (r) { return '<span class="mono">' + esc(r.co) + '</span>'; } },
  ref: { label: "单号", raw: function (r) { return r.ref || r.doc; },
         cell: function (r) { return '<span class="mono">' + esc(r.ref || r.doc || "—") + '</span>'; } },
  doc: { label: "单号", raw: function (r) { return r.doc; },
         cell: function (r) { return '<span class="mono">' + esc(r.doc || "—") + '</span>'; } },
  desc: { label: "摘要", raw: function (r) { return r.desc; },
          cell: function (r) { return esc(r.desc || "—"); } },
  acc: { label: "科目", raw: function (r) { return r.accName + " " + r.acc; },
         cell: function (r) { return '<span class="nm">' + esc(r.accName) + '</span>' +
           '<span class="sub2">' + esc(r.acc) + '</span>'; } },
  ctr: { label: "对方科目", raw: function (r) { return r.ctrName; },
         cell: function (r) { return esc(r.ctrName || "—") +
           (r.ctr ? '<span class="sub2">' + esc(r.ctr) + '</span>' : ""); } },
  party: { label: "对象", raw: function (r) { return r.party; },
           cell: function (r) { return esc(r.party || "—"); } },
  amt: { label: "金额", num: true, raw: function (r) { return r.amt; },
         sortVal: function (r) { return r.amt; },
         cell: function (r) { return '<b class="' + (r.amt < 0 ? "neg" : "") + '">' + rm(r.amt) + '</b>'; } },
  flow: { label: "金额", num: true, raw: function (r) { return r.amt; },
          sortVal: function (r) { return r.amt; },
          cell: function (r) { return '<b class="' + (r.amt >= 0 ? "inflow" : "outflow") + '">' +
            (r.amt >= 0 ? "+" : "") + rm(r.amt) + '</b>'; } },
  jt: { label: "来源", raw: function (r) { return r.jt; },
        cell: function (r) { return '<span class="mono">' + esc(r.jt || "—") + '</span>'; } },
  total: { label: "单据金额", num: true, raw: function (r) { return r.total; },
           sortVal: function (r) { return r.total; },
           cell: function (r) { return rm(r.total); } },
  outs: { label: "未结", num: true, raw: function (r) { return r.outs; },
          sortVal: function (r) { return r.outs; },
          cell: function (r) { return r.outs > 0 ? '<b class="neg">' + rm(r.outs) + '</b>' :
            '<span class="muted">已结清</span>'; } },
  due: { label: "到期日", raw: function (r) { return r.due; },
         cell: function (r) { return '<span class="mono">' + esc(r.due) + '</span>'; } },
  late: { label: "逾期", num: true, raw: function (r) { return r.late; },
          sortVal: function (r) { return r.outs > 0 ? r.late : -99999; },
          cell: function (r) { return r.outs <= 0 ? '<span class="muted">—</span>'
            : r.late > 0 ? '<span class="neg">' + r.late + ' 天</span>' : "未到期"; } },
};

function barChart(rows, opts) {
  if (!rows.length) return '<p class="empty">期间内没有资料。</p>';
  var W = 680, H = 158, padB = 20, gap = 5;
  var vals = [];
  rows.forEach(function (r) { opts.series.forEach(function (s) { vals.push(r[s.key] || 0); }); });
  var max = Math.max.apply(null, vals.map(Math.abs).concat([1]));
  var div = opts.diverging;
  var zeroY = div ? (H - padB) / 2 : H - padB;
  var usable = div ? (H - padB) / 2 - 5 : H - padB - 7;
  var slot = W / rows.length;
  var barW = Math.max(3, (slot - gap) / opts.series.length);
  var bars = rows.map(function (r, i) {
    var x0 = i * slot + gap / 2;
    var g = opts.series.map(function (s, j) {
      var v = r[s.key] || 0;
      var h = Math.max(v === 0 ? 0 : 1, (Math.abs(v) / max) * usable);
      return '<rect class="bar ' + (s.cls || (v >= 0 ? "up" : "dn")) + '" x="' +
        (x0 + j * (barW + 2)) + '" y="' + (v >= 0 ? zeroY - h : zeroY) +
        '" width="' + barW + '" height="' + h + '" rx="2"></rect>';
    }).join("");
    var t = mlab(r.ym) + "\\n" + opts.series.map(function (s) {
      return s.label + " RM " + rm(r[s.key] || 0); }).join("\\n");
    return '<g class="mgrp"><rect class="hit" x="' + (x0 - gap / 2) + '" y="0" width="' + slot +
      '" height="' + (H - padB) + '" data-t="' + esc(t) + '"></rect>' + g + '</g>';
  }).join("");
  var step = rows.length > 18 ? 3 : rows.length > 9 ? 2 : 1;
  var labels = rows.map(function (r, i) {
    if (i % step !== 0 && i !== rows.length - 1) return "";
    return '<text class="xlab" x="' + (i * slot + slot / 2) + '" y="' + (H - 5) +
      '" text-anchor="middle">' + esc(mlab(r.ym)) + '</text>';
  }).join("");
  return '<div class="chartwrap"><svg viewBox="0 0 ' + W + ' ' + H +
    '" preserveAspectRatio="none" class="mchart" role="img" aria-label="' + esc(opts.aria) + '">' +
    '<line class="' + (div ? "zero" : "base") + '" x1="0" y1="' + zeroY + '" x2="' + W +
    '" y2="' + zeroY + '"></line>' + bars + labels + '</svg><div class="tip" hidden></div></div>';
}
var AGE = [["notDue", "未到期"], ["d30", "1-30 天"], ["d60", "31-60 天"],
            ["d90", "61-90 天"], ["over90", "90 天以上"]];
function ageBar(a) {
  if (!a || a.total <= 0) return '<span class="muted">无未结余额</span>';
  return '<div class="agebar">' + AGE.map(function (p, i) {
    var v = a[p[0]];
    return v > 0 ? '<span class="seg s' + i + '" style="width:' + ((v / a.total) * 100) +
      '%" title="' + esc(p[1]) + ': RM ' + rm(v) + '"></span>' : ""; }).join("") +
    '</div><div class="agelegend">' + AGE.map(function (p, i) {
    var v = a[p[0]];
    return v > 0 ? '<span><i class="seg s' + i + '" style="background:var(--age' + i + ')"></i>' +
      esc(p[1]) + ' RM ' + rm(v) + '</span>' : ""; }).join("") + '</div>';
}
function sparkline(map, months) {
  var vals = months.map(function (m) { return (map || {})[m] || 0; });
  if (vals.length < 2) return '<span class="muted">—</span>';
  var max = Math.max.apply(null, vals.map(Math.abs).concat([1]));
  var w = 88 / vals.length;
  return '<svg class="spark" viewBox="0 0 88 18" aria-hidden="true">' + vals.map(function (v, i) {
    var h = Math.max(1, (Math.abs(v) / max) * 16);
    return '<rect x="' + (i * w) + '" y="' + (18 - h) + '" width="' + Math.max(1, w - 1) +
      '" height="' + h + '" rx="1"></rect>'; }).join("") + '</svg>';
}
function accTable(rows, months, cm, opts) {
  if (!rows.length) return '<p class="empty">期间内没有资料。</p>';
  var max = Math.max.apply(null, rows.map(function (r) { return Math.abs(r.cur); }).concat([1]));
  var grand = sum(rows, function (r) { return r.cur; });
  return '<div class="tscroll"><table class="dtab"><thead><tr><th class="first">' + esc(opts.head) +
    '</th><th class="num">本期</th><th></th><th>走势</th><th class="num">占比</th>' +
    (cm ? '<th class="num">' + esc(cmpLabel()) + '</th><th class="num">变化</th>' : "") +
    '</tr></thead><tbody>' + rows.map(function (r) {
      var d = cm && r.cmp ? ((r.cur - r.cmp) / Math.abs(r.cmp)) * 100 : null;
      return '<tr><td class="first"><span class="nm">' + esc(r.name) + '</span>' + (r.tag || "") +
        '<span class="sub2">' + esc(r.acc || "") + '</span></td>' +
        '<td class="num' + (r.cur < 0 ? " pos" : "") + '">' + rm(r.cur) + '</td>' +
        '<td class="barcell"><span class="lbar ' + (opts.cost ? "cost" : "") + '" style="width:' +
          ((Math.abs(r.cur) / max) * 100) + '%"></span></td>' +
        '<td>' + sparkline(r.m, months) + '</td>' +
        '<td class="num">' + (grand ? ((r.cur / grand) * 100).toFixed(0) : 0) + '%</td>' +
        (cm ? '<td class="num muted">' + rm(r.cmp) + '</td><td class="num">' +
          (d === null ? '<span class="delta">—</span>'
            : '<span class="delta ' + (d >= 0 ? "up" : "down") + '">' +
              (d >= 0 ? "+" : "") + d.toFixed(0) + '%</span>') + '</td>' : "") + '</tr>';
    }).join("") + '<tr class="tot"><td class="first">合计</td><td class="num">' + rm(grand) +
    '</td><td></td><td></td><td class="num">100%</td>' +
    (cm ? '<td class="num">' + rm(sum(rows, function (r) { return r.cmp; })) + '</td><td></td>' : "") +
    '</tr></tbody></table></div>';
}
function accRows(src, months, cm, tagFn) {
  return (src || []).map(function (a) {
    return { name: a.name, acc: a.acc, m: a.m, cur: overM(a.m, months),
             cmp: cm ? overM(a.m, cm) : 0, tag: tagFn ? tagFn(a) : "" };
  }).filter(function (r) { return r.cur !== 0 || r.cmp !== 0; })
    .sort(function (x, y) { return Math.abs(y.cur) - Math.abs(x.cur); });
}
function cfMatrix(list, months, dir, title, hint) {
  var by = {};
  list.forEach(function (c) {
    cfOf(c, months).forEach(function (r) {
      var v = r[dir];
      if (!v) return;
      var k = r.contra + "|" + r.name;
      var e = by[k] || (by[k] = { name: r.name, acc: r.contra, typ: r.type,
                                  internal: r.internal, m: {}, total: 0 });
      e.m[r.ym] = (e.m[r.ym] || 0) + v; e.total += v;
    });
  });
  var rows = Object.keys(by).map(function (k) { return by[k]; })
    .sort(function (x, y) { return y.total - x.total; });
  if (!rows.length) return '<section class="card"><h3>' + esc(title) +
    '</h3><p class="empty">期间内没有资料。</p></section>';
  // The tail is collapsed by default because these tables are already wide, but
  // it must be openable: "其他 34 个科目" hides real money, and a figure you
  // cannot break down is a figure you cannot check.
  var open = cfOpen[dir] === true;
  var shown = open ? rows : rows.slice(0, 15), rest = open ? [] : rows.slice(15);
  var hidden = rows.slice(15);
  var restTotal = sum(rest, function (r) { return r.total; });
  var grand = sum(rows, function (r) { return r.total; });
  var cls = dir === "in" ? "inflow" : "outflow";
  var body = shown.map(function (r) {
    return '<tr><td class="first"><span class="nm">' + esc(r.name) + '</span>' +
      (r.internal ? '<span class="tag recharge">户口间调拨</span>' : "") +
      '<span class="sub2">' + esc(r.acc) + " · " + esc(r.typ) + '</span></td>' +
      months.map(function (m) {
        var v = r.m[m] || 0;
        return '<td class="num ' + (v ? cls : "zerocell") + '">' + (v ? rm(v) : "·") + '</td>';
      }).join("") + '<td class="num"><b>' + rm(r.total) + '</b></td>' +
      '<td class="num">' + (grand ? ((r.total / grand) * 100).toFixed(0) : 0) + '%</td></tr>';
  }).join("");
  if (rest.length) {
    body += '<tr class="cfrest"><td class="first">' +
      '<button class="lnk cfmore" type="button" data-cfmore="' + dir +
      '" aria-expanded="false">▸ 其他 ' + rest.length + ' 个科目（点开看明细）</button></td>' +
      months.map(function (m) {
        var v = sum(rest, function (r) { return r.m[m] || 0; });
        return '<td class="num ' + (v ? cls : "zerocell") + '">' + (v ? rm(v) : "·") + '</td>';
      }).join("") + '<td class="num"><b>' + rm(restTotal) + '</b></td><td class="num">' +
      (grand ? ((restTotal / grand) * 100).toFixed(0) : 0) + '%</td></tr>';
  }
  if (open && hidden.length) {
    body += '<tr class="cfrest"><td class="first">' +
      '<button class="lnk cfmore" type="button" data-cfmore="' + dir +
      '" aria-expanded="true">▾ 收起后面 ' + hidden.length + ' 个科目</button></td>' +
      months.map(function () { return '<td class="num zerocell">·</td>'; }).join("") +
      '<td class="num"></td><td class="num"></td></tr>';
  }
  body += '<tr class="tot"><td class="first">合计</td>' + months.map(function (m) {
    var v = sum(rows, function (r) { return r.m[m] || 0; });
    return '<td class="num">' + (v ? rm(v) : "·") + '</td>'; }).join("") +
    '<td class="num">' + rm(grand) + '</td><td class="num">100%</td></tr>';
  return '<section class="card"><h3>' + esc(title) + '</h3><p class="hint">' + esc(hint) + '</p>' +
    '<div class="tscroll"><table class="dtab"><thead><tr><th class="first">' +
    (dir === "in" ? "来源科目" : "去向科目") + '</th>' + months.map(function (m) {
      return '<th class="num">' + esc(mlab(m)) + '</th>'; }).join("") +
    '<th class="num">合计</th><th class="num">占比</th></tr></thead><tbody>' + body +
    '</tbody></table></div></section>';
}
function cfMonthly(list, months) {
  return months.map(function (ym) {
    var i = 0, o = 0;
    list.forEach(function (c) { cfOf(c, [ym]).forEach(function (r) { i += r.in; o += r.out; }); });
    return { ym: ym, inflow: i, outflow: -o, net: i - o };
  });
}

function linTable(headers, rowsHtml, totalLabel, totalVal) {
  return '<div class="tscroll"><table class="dtab"><thead><tr>' +
    headers.map(function (h, i) {
      return '<th' + (i ? ' class="num"' : ' class="first"') + '>' + esc(h) + '</th>'; }).join("") +
    '</tr></thead><tbody>' + rowsHtml + (totalLabel
      ? '<tr class="tot"><td class="first">' + esc(totalLabel) + '</td><td class="num" colspan="' +
        (headers.length - 1) + '">' + rm(totalVal) + '</td></tr>' : "") + '</tbody></table></div>';
}
var LINEAGE = {
  cash: function (list) {
    var rows = [];
    list.forEach(function (c) {
      (c.cashAccounts || []).forEach(function (a) {
        rows.push({ co: c.short, name: a.name, acc: a.acc,
                    kind: a.kind === "SBK" ? "银行" : "现金", v: a.bal }); });
    });
    rows.sort(function (x, y) { return x.v - y.v; });
    return { formula: "Σ (HomeDR − HomeCR)，全期累计，不受期间筛选影响",
      tables: "GLMast · GLDTL", filters: "GLMast.SpecialAccType IN ('SBK','SCH')",
      note: "负数是贷方余额，可能是透支额度，也可能是有款项未入账。",
      html: linTable(["公司 · 户口", "余额"], rows.map(function (r) {
        return '<tr><td class="first"><span class="mono">' + esc(r.co) + '</span> ' + esc(r.name) +
          '<span class="sub2">' + esc(r.acc) + " · " + esc(r.kind) + '</span></td>' +
          '<td class="num ' + (r.v < 0 ? "neg" : "") + '">' + rm(r.v) + '</td></tr>';
      }).join(""), "合计", sum(rows, function (r) { return r.v; })) };
  },
  revenue: function (list, months) {
    var rows = [];
    list.forEach(function (c) {
      (c.revenueAccounts || []).forEach(function (a) {
        var v = overM(a.m, months);
        if (v !== 0) rows.push({ co: c.short, name: a.name, acc: a.acc, typ: a.type, v: v }); });
    });
    rows.sort(function (x, y) { return y.v - x.v; });
    return { formula: "Σ (HomeCR − HomeDR)，期间内", tables: "GLMast · GLDTL",
      filters: "AccType IN ('SL','OI') 且 TransDate 落在 " + range.from + " ~ " + range.to,
      note: "SL＝销售，OI＝其他收入。开在 CL（负债）科目的预收款不算在内。",
      html: linTable(["公司 · 科目", "金额"], rows.slice(0, 80).map(function (r) {
        return '<tr><td class="first"><span class="mono">' + esc(r.co) + '</span> ' + esc(r.name) +
          '<span class="sub2">' + esc(r.acc) + " · " + esc(r.typ) + '</span></td>' +
          '<td class="num">' + rm(r.v) + '</td></tr>';
      }).join(""), "合计", sum(rows, function (r) { return r.v; })) };
  },
  cost: function (list, months) {
    var rows = [];
    list.forEach(function (c) {
      (c.expenses || []).forEach(function (a) {
        var v = overM(a.m, months);
        if (v !== 0) rows.push({ co: c.short, name: a.name, acc: a.acc, v: v }); });
    });
    rows.sort(function (x, y) { return y.v - x.v; });
    return { formula: "Σ (HomeDR − HomeCR)，期间内", tables: "GLMast · GLDTL",
      filters: "AccType IN ('EP','CO') 且 TransDate 落在 " + range.from + " ~ " + range.to,
      note: "EP＝费用，CO＝成本。负数是费用冲回，已计入合计。",
      html: linTable(["公司 · 科目", "金额"], rows.slice(0, 80).map(function (r) {
        return '<tr><td class="first"><span class="mono">' + esc(r.co) + '</span> ' + esc(r.name) +
          '<span class="sub2">' + esc(r.acc) + '</span></td>' +
          '<td class="num' + (r.v < 0 ? " pos" : "") + '">' + rm(r.v) + '</td></tr>';
      }).join(""), "合计（含冲回）", sum(rows, function (r) { return r.v; })) };
  },
  billings: function (list, months) {
    var rows = list.map(function (c) { return { co: c.short, v: billingsOf(c, months) }; })
      .filter(function (r) { return r.v !== 0; }).sort(function (x, y) { return y.v - x.v; });
    return { formula: "Σ ARInvoice.LocalNetTotal，期间内", tables: "ARInvoice",
      filters: "Cancelled = 'F' 且 DocDate 落在 " + range.from + " ~ " + range.to,
      note: "含开在负债科目的预收款，所以会大于已确认收入。",
      html: linTable(["公司", "开单额"], rows.map(function (r) {
        return '<tr><td class="first nm">' + esc(r.co) + '</td><td class="num">' + rm(r.v) +
          '</td></tr>'; }).join(""), "合计", sum(rows, function (r) { return r.v; })) };
  },
  deferred: function (list) {
    var rows = [];
    list.forEach(function (c) {
      (c.liabilities || []).filter(function (l) { return l.isDeferred; })
        .forEach(function (l) { rows.push({ co: c.short, name: l.name, acc: l.acc, v: l.bal }); });
    });
    rows.sort(function (x, y) { return y.v - x.v; });
    return { formula: "Σ (HomeCR − HomeDR)，全期累计", tables: "GLMast · GLDTL",
      filters: "AccType = 'CL' 且科目名称含 UNRECOGNISED / UNEARNED / DEFERRED / DEPOSIT / ADVANCE",
      note: "以科目名称关键字辨识，属推测分类 —— 请核对有无漏抓或误抓。",
      html: rows.length ? linTable(["公司 · 科目", "余额"], rows.map(function (r) {
        return '<tr><td class="first"><span class="mono">' + esc(r.co) + '</span> ' + esc(r.name) +
          '<span class="sub2">' + esc(r.acc) + '</span></td><td class="num">' + rm(r.v) +
          '</td></tr>'; }).join(""), "合计", sum(rows, function (r) { return r.v; }))
        : '<p class="empty">选中的公司没有递延收入科目。</p>' };
  },
  cashin: function (l, m) { return cfLineage(l, m, "in"); },
  cashout: function (l, m) { return cfLineage(l, m, "out"); },
  ar: function (list, months) {
    var rows = list.map(function (c) {
      return { co: c.short, total: c.ar.total, over: c.ar.overdue, o90: c.ar.over90,
               d: dsoOf(c, months) };
    }).filter(function (r) { return r.total > 0; }).sort(function (x, y) { return y.over - x.over; });
    return { formula: "Σ ARInvoice.Outstanding；账龄以 DueDate 与今天相差天数分组",
      tables: "ARInvoice", filters: "Cancelled = 'F' 且 Outstanding > 0（当下位置）",
      note: "DSO ＝ 未收 ÷ (期间收入 ÷ 期间天数)。",
      html: linTable(["公司", "未收", "其中逾期", "90天以上", "DSO"], rows.map(function (r) {
        return '<tr><td class="first nm">' + esc(r.co) + '</td><td class="num">' + rm(r.total) +
          '</td><td class="num">' + rm(r.over) + '</td><td class="num ' + (r.o90 > 0 ? "neg" : "") +
          '">' + rm(r.o90) + '</td><td class="num">' +
          (r.d === null ? "—" : Math.round(r.d) + " 天") + '</td></tr>'; }).join("")) };
  },
};
function cfLineage(list, months, dir) {
  var by = {};
  list.forEach(function (c) {
    cfOf(c, months).forEach(function (r) {
      var v = r[dir];
      if (!v) return;
      var k = c.short + "|" + r.contra;
      (by[k] = by[k] || { co: c.short, name: r.name, acc: r.contra, typ: r.type, v: 0, lines: 0 });
      by[k].v += v; by[k].lines += r.lines;
    });
  });
  var rows = Object.keys(by).map(function (k) { return by[k]; })
    .sort(function (x, y) { return y.v - x.v; });
  return { formula: dir === "in" ? "Σ HomeDR（钱进银行），期间内" : "Σ HomeCR（钱出银行），期间内",
    tables: "GLDTL · GLMast",
    filters: "银行科目 SpecialAccType IN ('SBK','SCH')，依 DEAccNo 分组，" +
             range.from + " ~ " + range.to + (excludeInternal ? "，已排除户口间调拨" : ""),
    note: "对方科目就是钱的来源或去向。AutoCount 每一笔银行分录都有填 DEAccNo。",
    html: rows.length ? linTable(["公司 · 对方科目", "金额"], rows.slice(0, 80).map(function (r) {
      return '<tr><td class="first"><span class="mono">' + esc(r.co) + '</span> ' + esc(r.name) +
        '<span class="sub2">' + esc(r.acc) + " · " + esc(r.typ) + " · " + r.lines +
        ' 笔</span></td><td class="num ' + (dir === "in" ? "inflow" : "outflow") + '">' + rm(r.v) +
        '</td></tr>'; }).join(""), "合计", sum(rows, function (r) { return r.v; }))
      : '<p class="empty">期间内没有现金流动。</p>' };
}
function kpi(label, value, cls, sub, srcKey, cmpVal) {
  var c = "";
  if (cmpVal !== undefined && cmpVal !== null) {
    var d = value - cmpVal;
    var p = cmpVal !== 0 ? " (" + (d >= 0 ? "+" : "") + ((d / Math.abs(cmpVal)) * 100).toFixed(0) + "%)" : "";
    c = '<div class="cmp"><span class="muted">' + esc(cmpLabel()) + ' ' + rm(cmpVal) + '</span> ' +
      '<span class="' + (d >= 0 ? "pos" : "neg") + '" style="font-weight:700">' +
      (d >= 0 ? "+" : "") + rm(d) + p + '</span></div>';
  }
  return '<div class="kpi">' + (srcKey ? '<button class="src" type="button" data-src="' + srcKey +
    '" data-label="' + esc(label) + '" aria-expanded="false">i</button>' : "") +
    '<span class="k">' + esc(label) + '</span><div class="v ' + cls + '">RM ' + rm(value) + '</div>' +
    '<div class="sub">' + esc(sub) + '</div>' + c + '</div>';
}

function buildAlerts(list, months) {
  var a = { collect: [], cash: [], trend: [], conc: [] };
  list.forEach(function (c) {
    if (c.ar.over90 > 0) {
      var w = (c.topDebtors || []).filter(function (d) { return d.oldestLate > 90; });
      a.collect.push({ company: c.short, amount: c.ar.over90,
        detail: w.length ? w.slice(0, 3).map(function (d) {
          return d.name + " RM " + rm(d.owing) + "（" + d.oldestLate + " 天）"; }).join(" · ")
          : rm(c.ar.over90) + " 逾期超过 90 天",
        severity: c.ar.over90 > 100000 ? "critical" : "serious" });
    }
    var dd = dsoOf(c, months);
    if (dd !== null && dd > 120) a.collect.push({ company: c.short, amount: c.ar.total,
      detail: "DSO " + Math.round(dd) + " 天 — 收款周期过长，未收 RM " + rm(c.ar.total),
      severity: dd > 365 ? "critical" : "warning" });
    (c.topDebtors || []).forEach(function (d) {
      if (d.overLimit) a.collect.push({ company: c.short, amount: d.owing,
        detail: d.name + " 欠 RM " + rm(d.owing) + "，超过信用额度 RM " + rm(d.limit),
        severity: "warning" }); });
    (c.cashAccounts || []).forEach(function (x) {
      if (x.bal < 0) a.cash.push({ company: c.short, amount: x.bal,
        detail: x.name + " 余额 RM " + rm(x.bal) + " — 贷方余额，需确认是透支额度还是有款项未入账",
        severity: x.bal < -100000 ? "critical" : "serious" }); });
    var r = runwayOf(c, months);
    if (r < 6) a.cash.push({ company: c.short, amount: c.cash,
      detail: r <= 0 ? "现金已见底（RM " + rm(c.cash) + "），月烧 RM " + rm(burnOf(c, months))
        : "runway 只剩 " + r.toFixed(1) + " 个月（现金 RM " + rm(c.cash) + "）",
      severity: r <= 0 ? "critical" : "serious" });
    var third = Math.max(1, Math.round(months.length / 3));
    if (months.length >= 4) {
      var l3 = profitOf(c, months.slice(-third)), p3 = profitOf(c, months.slice(-third * 2, -third));
      if (l3 < p3 && l3 < 0) a.trend.push({ company: c.short, amount: l3 - p3,
        detail: "最近 " + third + " 个月净利 RM " + rm(l3) + "，比前 " + third + " 个月 RM " +
          rm(p3) + " 更差", severity: "warning" });
    }
    var cr = (c.customers || []).map(function (x) {
      return { name: x.name, amt: overM(x.m, months) }; })
      .filter(function (x) { return x.amt > 0; }).sort(function (x, y) { return y.amt - x.amt; });
    var tot = sum(cr, function (x) { return x.amt; });
    if (tot > 0 && cr.length && cr[0].amt / tot > 0.5) a.conc.push({ company: c.short,
      amount: cr[0].amt,
      detail: cr[0].name + " 占收入 " + Math.round((cr[0].amt / tot) * 100) + "%（RM " +
        rm(cr[0].amt) + "）",
      severity: cr[0].amt / tot > 0.8 ? "critical" : "serious" });
  });
  var o = { critical: 0, serious: 1, warning: 2, info: 3 };
  Object.keys(a).forEach(function (k) {
    a[k].sort(function (x, y) {
      return (o[x.severity] - o[y.severity]) || (Math.abs(y.amount) - Math.abs(x.amount)); }); });
  return a;
}
function alertCard(title, items, hint) {
  if (!items.length) return '<section class="card"><h3>' + esc(title) +
    '</h3><p style="margin:6px 0 0;color:var(--ok);font-weight:600;font-size:13px">没有发现问题。</p>' +
    '<p class="hint" style="margin-top:9px">' + esc(hint) + '</p></section>';
  return '<section class="card"><h3>' + esc(title) + '<span class="acount">' + items.length +
    '</span></h3><ul class="alist" style="margin-top:9px">' + items.map(function (x) {
      return '<li class="sev-' + x.severity + '"><span class="sevdot"></span>' +
        '<span class="acomp">' + esc(x.company) + '</span><span class="atext">' +
        esc(x.detail) + '</span></li>'; }).join("") +
    '</ul><p class="hint" style="margin-top:10px">' + esc(hint) + '</p></section>';
}

var TOPICS = [
  { id: "overview", label: "总览",      en: "Overview" },
  { id: "pnl",      label: "损益",      en: "P&L" },
  { id: "cash",     label: "现金流",    en: "Cash Flow" },
  { id: "ar",       label: "应收",      en: "Receivables" },
  { id: "ap",       label: "应付",      en: "Payables" },
  { id: "cust",     label: "客户",      en: "Customers" },
  { id: "vrgfp",    label: "成本结构",  en: "R−V=G, G−F=P" },
  { id: "product",  label: "分析产品",  en: "GP by Project" },
  { id: "lines",    label: "服务线",    en: "Service Lines" },
  { id: "liab",     label: "负债与递延", en: "Liabilities" },
  { id: "alerts",   label: "风险预警",  en: "Alerts" },
  { id: "source",   label: "资料来源",  en: "Data Source" },
];

function vhead(title, desc, asat) {
  return '<div class="vhead"><h2>' + esc(title) +
    (asat ? '<span class="asat">当下</span>' : "") + '</h2><p>' + esc(desc) + '</p></div>';
}

function viewOverview(list, months, cm) {
  var mm = groupMonthly(list, months);
  var third = Math.max(1, Math.round(mm.length / 3));
  var pN = sum(mm.slice(-third), function (x) { return x.profit; });
  var ppN = sum(mm.slice(-third * 2, -third), function (x) { return x.profit; });
  var streak = 0;
  for (var i = mm.length - 1; i >= 0 && mm[i].profit > 0; i--) streak++;
  var worst = mm.reduce(function (a, b) { return b.profit < a.profit ? b : a; },
                        mm[0] || { profit: 0, ym: "" });
  var cash = sum(list, function (c) { return c.cash; });
  var def = sum(list, function (c) { return deferredOf(c); });
  var ar90 = sum(list, function (c) { return c.ar.over90; });
  var dying = list.filter(function (c) { return runwayOf(c, months) < 6; });
  var conc = list.map(function (c) {
    var rows = (c.customers || []).map(function (x) { return overM(x.m, months); })
      .filter(function (v) { return v > 0; }).sort(function (a, b) { return b - a; });
    var tot = rows.reduce(function (s, v) { return s + v; }, 0);
    return tot > 0 && rows.length && rows[0] / tot > 0.5 ? { co: c.short, share: rows[0] / tot } : null;
  }).filter(Boolean);

  var dir = streak >= 3 ? "good" : (pN > ppN ? "watch" : "bad");
  var dirText = streak >= 3
    ? "连续 " + streak + " 个月获利，最近 " + third + " 个月合计 RM " + rm(pN) + "。"
    : (pN > ppN ? "最近 " + third + " 个月 RM " + rm(pN) + "，比前 " + third + " 个月 RM " +
        rm(ppN) + " 改善，但还不稳定。"
      : "最近 " + third + " 个月 RM " + rm(pN) + "，比前 " + third + " 个月 RM " + rm(ppN) + " 更差。");
  if (worst.ym && worst.profit < 0) dirText += " 期间最差是 " + worst.ym + "（RM " +
    rm(worst.profit) + "）—— 单月异常会把合计拉歪。";

  var items = [
    { m: dir, t: "方向", x: dirText },
    { m: def > 0 ? "good" : "watch", t: "已锁定的未来收入",
      x: def > 0 ? "递延收入 RM " + rm(def) + " —— 钱已收、服务还没交付完。"
                 : "没有递延收入余额，收入全靠当期新签。" },
    { m: dying.length ? "bad" : "good", t: "现金安全",
      x: dying.length ? dying.map(function (c) { return c.short; }).join("、") +
          " 的 runway 不到 6 个月。集团现金 RM " + rm(cash) + "。"
        : "所有公司 runway 都在 6 个月以上，集团现金 RM " + rm(cash) + "。" },
    { m: conc.length ? "bad" : "good", t: "集中度",
      x: conc.length ? conc.length + " 间公司有单一客户占收入超过一半：" +
          conc.map(function (x) { return x.co + " " + Math.round(x.share * 100) + "%"; }).join("、") + "。"
        : "没有单一客户占某间公司收入超过一半。" },
    { m: ar90 > 100000 ? "bad" : (ar90 > 0 ? "watch" : "good"), t: "收款",
      x: ar90 > 0 ? "逾期超过 90 天的应收有 RM " + rm(ar90) + "。" : "没有逾期超过 90 天的应收。" },
  ];

  var rev = sum(list, function (c) { return revenueOf(c, months); });
  var cost = sum(list, function (c) { return costOf(c, months); });
  var cfA = cfMonthly(list, months);
  var gin = sum(cfA, function (x) { return x.inflow; });
  var gout = -sum(cfA, function (x) { return x.outflow; });
  var cRev = cm ? sum(list, function (c) { return revenueOf(c, cm); }) : null;
  var cCost = cm ? sum(list, function (c) { return costOf(c, cm); }) : null;

  return vhead("总览", "期间 " + range.from + " → " + range.to + "（" + months.length + " 个月）" +
      (cm ? "，对比" + cmpLabel() : "") + "。左侧每个主题都能钻到分录。") +
    '<section class="card"><h3>这份报表说了什么</h3>' +
    '<div class="grid g2" style="margin-top:10px">' + items.map(function (it) {
      return '<div class="vitem"><span class="vmark ' + it.m + '">' +
        (it.m === "good" ? "✓" : it.m === "bad" ? "!" : "~") + '</span><div><b>' + esc(it.t) +
        '</b><span>' + esc(it.x) + '</span></div></div>'; }).join("") + '</div></section>' +
    '<div class="grid g4">' +
      kpi("现金", cash, cash < 0 ? "neg" : "", "银行 + 现金（当下）", "cash") +
      kpi("已确认收入", rev, "", months.length + " 个月合计", "revenue", cRev) +
      kpi("支出", cost, "", "费用 + 成本科目", "cost", cCost) +
      kpi("净利", rev - cost, rev - cost < 0 ? "neg" : "pos", "收入 − 支出", null,
          cm ? cRev - cCost : null) +
      kpi("现金流入", gin, "", "期间进银行", "cashin") +
      kpi("现金流出", gout, "", "期间出银行", "cashout") +
      kpi("递延收入", def, "", "已收钱、未交付（当下）", "deferred") +
      kpi("未收应收", sum(list, function (c) { return c.ar.total; }), ar90 > 0 ? "neg" : "",
          "90 天以上 " + rm(ar90) + "（当下）", "ar") +
    '</div><div class="lin" id="lineage" hidden></div>' +
    '<div class="grid g2"><section class="card"><h3>月度净利</h3>' +
    '<p class="hint">零线以上获利，以下亏损。</p><div class="legend">' +
    '<span><i class="sw up"></i>获利</span><span><i class="sw dn"></i>亏损</span></div>' +
    barChart(mm.map(function (m) { return { ym: m.ym, profit: m.profit }; }),
      { series: [{ key: "profit", label: "净利" }], diverging: true, aria: "月度净利" }) +
    '</section><section class="card"><h3>月度现金进出</h3>' +
    '<p class="hint">零线以上流入，以下流出。' +
    (excludeInternal ? "已排除户口间调拨。" : "含户口间调拨。") + '</p><div class="legend">' +
    '<span><i class="sw up"></i>流入</span><span><i class="sw dn"></i>流出</span></div>' +
    barChart(cfA, { series: [{ key: "inflow", label: "流入", cls: "up" },
                             { key: "outflow", label: "流出", cls: "dn" }],
                    diverging: true, aria: "月度现金进出" }) + '</section></div>';
}

// Accounting presentation: negatives in parentheses, zero as a dash.
function acct(n) {
  if (!n) return "—";
  var s = Math.abs(Math.round(n)).toLocaleString("en-MY");
  return n < 0 ? "(" + s + ")" : s;
}
function pct1(n) { return (n === null || !isFinite(n)) ? "—" : (n * 100).toFixed(1) + "%"; }

// Splits the ledger into statement lines for one set of companies.
// SL = sales, OI = other income, CO = cost of sales, EP = operating expense.
function pnlSeries(list, months) {
  var z = function () { return months.map(function () { return 0; }); };
  var sl = z(), oi = z(), co = z(), ep = z();
  list.forEach(function (c) {
    (c.revenueAccounts || []).forEach(function (a) {
      months.forEach(function (m, i) {
        var v = (a.m || {})[m] || 0;
        if (!v) return;
        if (a.type === "SL") sl[i] += v; else oi[i] += v;
      });
    });
    (c.expenses || []).forEach(function (a) {
      months.forEach(function (m, i) {
        var v = (a.m || {})[m] || 0;
        if (!v) return;
        if (a.type === "CO") co[i] += v; else ep[i] += v;
      });
    });
  });
  var rev = months.map(function (_, i) { return sl[i] + oi[i]; });
  var gp = months.map(function (_, i) { return rev[i] - co[i]; });
  var np = months.map(function (_, i) { return gp[i] - ep[i]; });
  return { sl: sl, oi: oi, co: co, ep: ep, rev: rev, gp: gp, np: np };
}

// Per-account monthly series for one statement line, so level 2 can break it out.
function pnlAccounts(list, months, kind) {
  var byAcc = {};
  list.forEach(function (c) {
    var src = (kind === "SL" || kind === "OI") ? c.revenueAccounts : c.expenses;
    (src || []).forEach(function (a) {
      if (a.type !== kind) return;
      var k = a.acc + "|" + a.name;
      var e = byAcc[k] || (byAcc[k] = { acc: a.acc, name: a.name, v: months.map(function () { return 0; }) });
      months.forEach(function (m, i) { e.v[i] += (a.m || {})[m] || 0; });
    });
  });
  return Object.keys(byAcc).map(function (k) { return byAcc[k]; })
    .filter(function (e) { return e.v.some(function (x) { return x !== 0; }); })
    .sort(function (x, y) {
      var sx = x.v.reduce(function (a, b) { return a + b; }, 0);
      var sy = y.v.reduce(function (a, b) { return a + b; }, 0);
      return Math.abs(sy) - Math.abs(sx);
    });
}

// The statement: lines down, months across, totals at the right.
// Every figure carries the coordinates needed to open its own detail panel.
function pnlStatement(list, months, title, level) {
  var s = pnlSeries(list, months);
  var tot = function (a) { return a.reduce(function (x, y) { return x + y; }, 0); };
  var ratio = function (num, den, i) { return den[i] ? num[i] / den[i] : null; };

  var LINES = [
    { id: "SL", k: "销售 Sales", v: s.sl, kind: "SL" },
    { id: "OI", k: "其他收入 Other income", v: s.oi, kind: "OI" },
    { id: "REV", k: "营业收入 Revenue", v: s.rev, strong: true },
    { id: "CO", k: "销货成本 Cost of sales", v: s.co, negate: true, kind: "CO" },
    { id: "GP", k: "毛利 Gross profit", v: s.gp, strong: true },
    { id: "GPR", k: "毛利率 GP%", ratioOf: ["gp", "rev"] },
    { id: "EP", k: "营业费用 Operating expenses", v: s.ep, negate: true, kind: "EP" },
    { id: "NP", k: "净利 Net profit", v: s.np, strong: true },
    { id: "NPR", k: "净利率 Net margin", ratioOf: ["np", "rev"] },
  ];

  var head = '<tr><th class="first">' + esc(title) + '</th>' +
    months.map(function (m) {
      return '<th class="num' + (m === LASTFULL ? " cur" : "") + '">' + esc(mlab(m)) +
        (m === ALLM[ALLM.length - 1] ? " ·" : "") + '</th>'; }).join("") +
    '<th class="num tcol">合计 Total</th></tr>';

  // A clickable figure. line/acc/month identify what to show in the panel.
  var cell = function (txt, lineId, acc, ym, extra) {
    var on = openFig && openFig.line === lineId && openFig.acc === (acc || "") &&
             openFig.ym === (ym || "");
    return '<td class="num fig' + (extra || "") + (on ? " figon" : "") + '" data-line="' + lineId +
      '" data-acc="' + esc(acc || "") + '" data-ym="' + esc(ym || "") + '">' + txt + '</td>';
  };

  var body = "";
  LINES.forEach(function (L) {
    if (L.ratioOf) {
      var num = s[L.ratioOf[0]], den = s[L.ratioOf[1]];
      body += '<tr class="ratio"><td class="first">' + esc(L.k) + '</td>' +
        months.map(function (m, i) {
          return cell(pct1(ratio(num, den, i)), L.id, "", m); }).join("") +
        cell(pct1(tot(den) ? tot(num) / tot(den) : null), L.id, "", "", " tcol") + '</tr>';
      return;
    }
    var vals = L.negate ? L.v.map(function (x) { return -x; }) : L.v;
    body += '<tr' + (L.strong ? ' class="sub"' : "") + '><td class="first">' + esc(L.k) + '</td>' +
      vals.map(function (x, i) { return cell(acct(x), L.id, "", months[i]); }).join("") +
      cell(acct(tot(vals)), L.id, "", "", " tcol") + '</tr>';

    // Level 2 expands each detail line into the accounts that make it up.
    if (level === 2 && L.kind) {
      pnlAccounts(list, months, L.kind).forEach(function (a) {
        var av = L.negate ? a.v.map(function (x) { return -x; }) : a.v;
        body += '<tr class="lvl2"><td class="first"><span class="l2n">' + esc(a.name) +
          '</span><span class="sub2">' + esc(a.acc) + '</span></td>' +
          av.map(function (x, i) { return cell(acct(x), L.id, a.acc, months[i]); }).join("") +
          cell(acct(tot(av)), L.id, a.acc, "", " tcol") + '</tr>';
      });
    }
  });

  return '<div class="tscroll"><table class="dtab pnl"><thead>' + head + '</thead><tbody>' +
    body + '</tbody></table></div>';
}

// What sits behind one figure: the accounts, then the documents.
var LINE_META = {
  SL:  { label: "销售 Sales", kinds: ["R"], types: ["SL"] },
  OI:  { label: "其他收入 Other income", kinds: ["R"], types: ["OI"] },
  CO:  { label: "销货成本 Cost of sales", kinds: ["E"], types: ["CO"] },
  EP:  { label: "营业费用 Operating expenses", kinds: ["E"], types: ["EP"] },
  REV: { label: "营业收入 Revenue", kinds: ["R"], types: ["SL", "OI"] },
  GP:  { label: "毛利 Gross profit", composed: ["REV", "CO"] },
  NP:  { label: "净利 Net profit", composed: ["REV", "CO", "EP"] },
  GPR: { label: "毛利率 GP%", ratio: ["GP", "REV"] },
  NPR: { label: "净利率 Net margin", ratio: ["NP", "REV"] },
};

function figureDetail(list, months, lineId, acc, ym) {
  var M = LINE_META[lineId];
  if (!M) return "<p class='empty'>没有这个项目的明细。</p>";
  var scope = ym ? [ym] : months;
  var period = ym ? ym : (range.from + " → " + range.to);

  // Ratios and subtotals explain themselves through their components.
  if (M.ratio || M.composed) {
    var s = pnlSeries(list, scope);
    var t = function (k) { return s[k].reduce(function (a, b) { return a + b; }, 0); };
    var parts;
    if (M.ratio) {
      var numK = M.ratio[0] === "GP" ? "gp" : "np";
      parts = [["分子 " + LINE_META[M.ratio[0]].label, t(numK)],
               ["分母 " + LINE_META[M.ratio[1]].label, t("rev")],
               ["＝ 比率", t("rev") ? (t(numK) / t("rev")) : null]];
    } else if (lineId === "GP") {
      parts = [["营业收入 Revenue", t("rev")], ["减 销货成本 Cost of sales", -t("co")],
               ["＝ 毛利 Gross profit", t("gp")]];
    } else {
      parts = [["营业收入 Revenue", t("rev")], ["减 销货成本 Cost of sales", -t("co")],
               ["减 营业费用 Operating expenses", -t("ep")], ["＝ 净利 Net profit", t("np")]];
    }
    return '<p class="dmeta">' + esc(M.label) + ' · ' + esc(period) + '</p>' +
      '<div class="tscroll"><table class="dtab"><tbody>' + parts.map(function (p, i) {
        var last = i === parts.length - 1;
        return '<tr' + (last ? ' class="sub"' : "") + '><td class="first">' + esc(p[0]) + '</td>' +
          '<td class="num">' + (typeof p[1] === "number" && String(p[0]).indexOf("比率") >= 0
            ? pct1(p[1]) : acct(p[1])) + '</td></tr>';
      }).join("") + '</tbody></table></div>' +
      '<p class="hint">小计与比率由上列组成 —— 点上面的明细列可以看到分录。</p>';
  }

  // Detail lines: which accounts, then the transactions themselves.
  var accs = [];
  M.types.forEach(function (ty) {
    pnlAccounts(list, scope, ty).forEach(function (a) {
      if (acc && a.acc !== acc) return;
      accs.push({ acc: a.acc, name: a.name, v: a.v.reduce(function (x, y) { return x + y; }, 0) });
    });
  });
  var total = accs.reduce(function (s2, a) { return s2 + a.v; }, 0);

  var wanted = {};
  accs.forEach(function (a) { wanted[a.acc] = 1; });
  var txns = txnsOf(list, scope, M.kinds)
    .filter(function (t) { return wanted[t.acc]; })
    .sort(function (x, y) { return Math.abs(y.amt) - Math.abs(x.amt); });

  return '<p class="dmeta">' + esc(M.label) + (acc ? " · " + esc(acc) : "") +
    ' · ' + esc(period) + ' · 合计 RM ' + rm(total) + '</p>' +
    (accs.length > 1
      ? '<h5 class="dsub">组成科目</h5><div class="tscroll"><table class="dtab"><tbody>' +
        accs.map(function (a) {
          return '<tr><td class="first"><span class="nm">' + esc(a.name) + '</span>' +
            '<span class="sub2">' + esc(a.acc) + '</span></td><td class="num">' + acct(a.v) +
            '</td></tr>'; }).join("") +
        '<tr class="sub"><td class="first">合计</td><td class="num">' + acct(total) +
        '</td></tr></tbody></table></div>' : "") +
    '<h5 class="dsub">分录 ' + txns.length.toLocaleString() + ' 笔' +
      (txns.length > 200 ? '（金额最大的 200 笔）' : "") + '</h5>' +
    '<div class="tscroll"><table class="dtab"><thead><tr><th class="first">日期</th><th>公司</th>' +
    '<th>单号</th><th>摘要</th><th>科目</th><th>对方科目</th><th class="num">金额</th>' +
    '</tr></thead><tbody>' + (txns.length ? txns.slice(0, 200).map(function (t) {
      return '<tr><td class="first mono">' + esc(t.date) + '</td>' +
        '<td class="mono">' + esc(t.co) + '</td><td class="mono">' + esc(t.ref || "—") + '</td>' +
        '<td>' + esc(t.desc || "—") + '</td>' +
        '<td>' + esc(t.accName) + '<span class="sub2">' + esc(t.acc) + '</span></td>' +
        '<td>' + esc(t.ctrName || "—") + '</td>' +
        '<td class="num"><b>' + rm(t.amt) + '</b></td></tr>';
    }).join("") : '<tr><td class="empty" colspan="7">这个期间没有分录。</td></tr>') +
    '</tbody></table></div>';
}

function viewPnl(list, months, cm) {
  // Entity tabs: each company is its own P&L unit, plus the consolidated total.
  var ents = [{ id: "__all__", label: "合并 Consolidated", list: list }].concat(
    list.map(function (c) { return { id: c.short, label: c.short, list: [c] }; }));
  var ent = ents.filter(function (e) { return e.id === pnlEntity; })[0] || ents[0];

  var mm = groupMonthly(ent.list, months);
  var rows = mm.map(function (m, i) {
    var o = { ym: m.ym, profit: m.profit, rev: m.rev, cost: m.cost };
    if (cm) o.cmpProfit = groupMonthly(ent.list, [cm[i]])[0].profit;
    return o;
  });
  var series = [{ key: "profit", label: "净利" }];
  if (cm) series.push({ key: "cmpProfit", label: cmpLabel(), cls: "cmp" });

  return vhead("损益 P&L", "各公司独立损益，合并是全部加总。负数以括号显示。" +
      "点任何一个数字就会跳出它的来源。成本无法拆到服务线，所以损益只到公司层级。") +
    '<div class="enttabs">' + ents.map(function (e) {
      return '<button class="ent" type="button" data-ent="' + esc(e.id) + '" aria-pressed="' +
        (e.id === ent.id) + '">' + esc(e.label) + '</button>'; }).join("") + '</div>' +
    '<section class="card"><div class="lhead"><div>' +
    '<h3>损益表 · ' + esc(ent.label) + '</h3>' +
    '<p class="hint" style="margin:2px 0 0">内部往来未冲销 · 最后一个月未过完（标 ·）· ' +
      esc(range.from) + " → " + esc(range.to) + '</p></div>' +
    '<div class="ltools"><span class="cnote">层级</span>' +
    [[1, "Level 1 汇总"], [2, "Level 2 明细科目"]].map(function (l) {
      return '<button class="pill" type="button" data-lvl="' + l[0] + '" aria-pressed="' +
        (pnlLevel === l[0]) + '">' + esc(l[1]) + '</button>'; }).join("") + '</div></div>' +
    pnlStatement(ent.list, months, ent.id === "__all__" ? "合并 (RM)" : ent.label + " (RM)",
      pnlLevel) +
    '<p class="hint" style="margin:10px 0 0">点任一数字 → 展开该数字的组成科目与分录。</p>' +
    '</section>' +
    (openFig
      ? '<section class="card figpanel" id="figpanel"><div class="lhead">' +
        '<h3>数字来源 · ' + esc((LINE_META[openFig.line] || {}).label || openFig.line) +
        (openFig.ym ? " · " + esc(openFig.ym) : " · 期间合计") + '</h3>' +
        '<button class="close" type="button" id="figClose">关闭</button></div>' +
        figureDetail(ent.list, months, openFig.line, openFig.acc, openFig.ym) + '</section>'
      : '<div id="figpanel"></div>') +
    '<div class="grid g2"><section class="card"><h3>月度净利</h3>' +
    '<div class="legend"><span><i class="sw up"></i>获利</span><span><i class="sw dn"></i>亏损</span>' +
    (cm ? '<span><i class="sw cmp"></i>' + esc(cmpLabel()) + '</span>' : "") + '</div>' +
    barChart(rows, { series: series, diverging: true, aria: "月度净利" }) + '</section>' +
    '<section class="card"><h3>月度收入与支出</h3><p class="hint">两条拉开就是获利。</p>' +
    '<div class="legend"><span><i class="sw rev"></i>收入</span><span><i class="sw bill"></i>支出</span></div>' +
    barChart(mm, { series: [{ key: "rev", label: "收入", cls: "rev" },
                            { key: "cost", label: "支出", cls: "bill" }], aria: "收入与支出" }) +
    '</section></div>';
}

function viewCash(list, months) {
  var cfA = cfMonthly(list, months);
  var gin = sum(cfA, function (x) { return x.inflow; });
  var gout = -sum(cfA, function (x) { return x.outflow; });
  var bankRows = [];
  list.forEach(function (c) {
    (c.cashAccounts || []).forEach(function (a) { bankRows.push({ c: c, a: a }); }); });
  var txns = txnsOf(list, months, ["C"]);
  if (excludeInternal) {
    var bankNames = {};
    list.forEach(function (c) {
      (c.cfBanks || []).forEach(function (b) { bankNames[b.a] = 1; }); });
    txns = txns.filter(function (t) { return !bankNames[t.ctr]; });
  }

  return vhead("现金流", "以银行分录的对方科目判定钱的来源与去向。" +
      (excludeInternal ? "已排除自家户口之间的调拨。" : "目前含户口间调拨，流入流出两边会被灌大。")) +
    '<div class="grid g3">' +
      kpi("流入", gin, "", "期间进银行", "cashin") +
      kpi("流出", gout, "", "期间出银行", "cashout") +
      kpi("净额", gin - gout, gin - gout < 0 ? "neg" : "pos", "流入 − 流出", null) +
    '</div><div class="lin" id="lineage" hidden></div>' +
    '<section class="card"><h3>月度现金进出</h3><div class="legend">' +
    '<span><i class="sw up"></i>流入</span><span><i class="sw dn"></i>流出</span></div>' +
    barChart(cfA, { series: [{ key: "inflow", label: "流入", cls: "up" },
                             { key: "outflow", label: "流出", cls: "dn" }],
                    diverging: true, aria: "月度现金进出" }) + '</section>' +
    cfMatrix(list, months, "in", "钱从哪里进来",
      "以对方科目分组，逐月列出。预设显示前 15 大，其余可点开。") +
    cfMatrix(list, months, "out", "钱花到哪里去",
      "以对方科目分组，逐月列出。预设显示前 15 大，其余可点开。") +
    '<section class="card"><h3>各户口逐月净流</h3>' +
    '<p class="hint">余额是当下的，不受期间筛选影响。</p>' +
    (bankRows.length ? '<div class="tscroll"><table class="dtab"><thead><tr>' +
      '<th class="first">公司 · 户口</th><th class="num">当下余额</th>' +
      months.map(function (m) { return '<th class="num">' + esc(mlab(m)) + '</th>'; }).join("") +
      '<th class="num">期间净流</th></tr></thead><tbody>' + bankRows.map(function (b) {
        var nets = months.map(function (m) {
          return sum(cfOf(b.c, [m]).filter(function (r) { return r.bank === b.a.acc; }),
                     function (r) { return r.in - r.out; }); });
        return '<tr><td class="first"><span class="mono">' + esc(b.c.short) + '</span> ' +
          esc(b.a.name) + '<span class="sub2">' + esc(b.a.acc) + '</span></td>' +
          '<td class="num ' + (b.a.bal < 0 ? "neg" : "") + '"><b>' + rm(b.a.bal) + '</b></td>' +
          nets.map(function (v) {
            return '<td class="num ' + (v > 0 ? "inflow" : v < 0 ? "outflow" : "zerocell") + '">' +
              (v ? rm(v) : "·") + '</td>'; }).join("") + '<td class="num"><b>' +
          rm(nets.reduce(function (s, v) { return s + v; }, 0)) + '</b></td></tr>';
      }).join("") + '</tbody></table></div>' : '<p class="empty">没有银行或现金户口。</p>') +
    '</section>' +
    ledger("cash", "现金分录", "每一笔进出银行的分录。正数是进，负数是出。" +
      (excludeInternal ? "户口间调拨已排除。" : ""),
      [COLS.date, COLS.co, COLS.ref, COLS.desc, COLS.acc, COLS.ctr, COLS.jt, COLS.flow], txns);
}

function viewAr(list, months) {
  return vhead("应收", "账龄与 DSO 是当下的位置；下面的单据表依期间筛选。", true) +
    '<div class="grid g4">' +
      kpi("未收合计", sum(list, function (c) { return c.ar.total; }), "", "当下", "ar") +
      kpi("其中逾期", sum(list, function (c) { return c.ar.overdue; }), "neg", "已过到期日", null) +
      kpi("90 天以上", sum(list, function (c) { return c.ar.over90; }), "neg", "回收机率低", null) +
      kpi("期间开单额", sum(list, function (c) { return billingsOf(c, months); }), "", "含预收", "billings") +
    '</div><div class="lin" id="lineage" hidden></div>' +
    '<section class="card"><h3>各公司账龄</h3>' +
    '<div class="grid g2" style="margin-top:10px">' + list.filter(function (c) {
      return c.ar.total > 0; }).map(function (c) {
        var d = dsoOf(c, months);
        return '<div><h5 style="font-size:12.5px;margin-bottom:6px">' + esc(c.short) +
          ' <span class="muted">未收 RM ' + rm(c.ar.total) + ' · DSO ' +
          (d === null ? "—" : Math.round(d) + " 天") + '</span></h5>' + ageBar(c.ar) + '</div>';
      }).join("") + '</div></section>' +
    ledger("ar", "销售单据", "期间内开出的所有发票，含已结清的。未结的用红字标出。",
      [COLS.date, COLS.co, COLS.doc, COLS.party, COLS.desc, COLS.due, COLS.total,
       COLS.outs, COLS.late], docsOf(list, months, "arDocs"));
}

function viewAp(list, months) {
  return vhead("应付", "未付余额是当下的位置；下面的单据表依期间筛选。", true) +
    '<div class="grid g3">' +
      kpi("未付合计", sum(list, function (c) { return c.ap.total; }), "", "当下", null) +
      kpi("其中逾期", sum(list, function (c) { return c.ap.overdue; }), "neg", "已过到期日", null) +
      kpi("90 天以上", sum(list, function (c) { return c.ap.over90; }), "neg", "拖欠已久", null) +
    '</div>' +
    '<section class="card"><h3>各公司账龄</h3><div class="grid g2" style="margin-top:10px">' +
    list.filter(function (c) { return c.ap.total > 0; }).map(function (c) {
      return '<div><h5 style="font-size:12.5px;margin-bottom:6px">' + esc(c.short) +
        ' <span class="muted">未付 RM ' + rm(c.ap.total) + '</span></h5>' + ageBar(c.ap) + '</div>';
    }).join("") + '</div></section>' +
    '<section class="card"><h3>供应商未付排行</h3><div class="tscroll"><table class="dtab">' +
    '<thead><tr><th class="first">公司 · 供应商</th><th class="num">未付</th><th class="num">张数</th>' +
    '<th class="num">最久逾期</th></tr></thead><tbody>' +
    [].concat.apply([], list.map(function (c) {
      return (c.topCreditors || []).map(function (r) { return { co: c.short, r: r }; }); }))
      .sort(function (x, y) { return y.r.owing - x.r.owing; }).map(function (x) {
        return '<tr class="' + (x.r.late > 90 ? "late" : "") + '"><td class="first">' +
          '<span class="mono">' + esc(x.co) + '</span> ' + esc(x.r.name) + '</td>' +
          '<td class="num"><b>' + rm(x.r.owing) + '</b></td><td class="num">' + x.r.docs + '</td>' +
          '<td class="num ' + (x.r.late > 0 ? "neg" : "") + '">' +
          (x.r.late > 0 ? x.r.late + " 天" : "未到期") + '</td></tr>'; }).join("") +
    '</tbody></table></div></section>' +
    ledger("ap", "采购单据", "期间内收到的所有供应商发票，含已付清的。",
      [COLS.date, COLS.co, COLS.doc, COLS.party, COLS.desc, COLS.due, COLS.total,
       COLS.outs, COLS.late], docsOf(list, months, "apDocs"));
}

function viewCust(list, months, cm) {
  var conc = list.map(function (c) {
    var rows = (c.customers || []).map(function (x) {
      return { name: x.name, amt: overM(x.m, months) }; })
      .filter(function (x) { return x.amt > 0; }).sort(function (a, b) { return b.amt - a.amt; });
    var tot = sum(rows, function (x) { return x.amt; });
    if (!rows.length || tot <= 0) return null;
    return { co: c.short, top: rows[0], share: rows[0].amt / tot,
             top3: sum(rows.slice(0, 3), function (x) { return x.amt; }) / tot, n: rows.length };
  }).filter(Boolean).sort(function (x, y) { return y.share - x.share; });

  var custRows = [];
  list.forEach(function (c) {
    var owed = {};
    (c.topDebtors || []).forEach(function (d) { owed[d.name] = d; });
    (c.customers || []).forEach(function (a) {
      var cur = overM(a.m, months);
      if (!cur && !(cm && overM(a.m, cm))) return;
      custRows.push({ name: c.short + " · " + a.name, acc: "", m: a.m, cur: cur,
        cmp: cm ? overM(a.m, cm) : 0,
        tag: (a.group ? '<span class="tag grp">疑似关联</span>' : "") +
             (owed[a.name] && owed[a.name].owing > 0
               ? '<span class="tag deferred">未收 ' + rm(owed[a.name].owing) + '</span>' : "") });
    });
  });
  custRows.sort(function (a, b) { return b.cur - a.cur; });

  return vhead("客户", "集中度依期间开单额计算。单一客户超过 50% 视为高风险。") +
    '<section class="card"><h3>集中度</h3><div class="tscroll"><table class="dtab"><thead><tr>' +
    '<th class="first">公司</th><th>最大客户</th><th class="num">金额</th><th class="num">占比</th>' +
    '<th class="num">前三大</th><th class="num">客户数</th></tr></thead><tbody>' +
    (conc.length ? conc.map(function (r) {
      return '<tr><td class="first nm">' + esc(r.co) + '</td><td>' + esc(r.top.name) + '</td>' +
        '<td class="num">' + rm(r.top.amt) + '</td><td class="num risk ' +
        (r.share > 0.5 ? "hi" : r.share > 0.3 ? "mid" : "lo") + '">' +
        Math.round(r.share * 100) + '%</td><td class="num">' + Math.round(r.top3 * 100) + '%</td>' +
        '<td class="num">' + r.n + '</td></tr>'; }).join("")
      : '<tr><td class="empty">期间内没有开单记录。</td></tr>') + '</tbody></table></div></section>' +
    '<section class="card"><h3>客户开单排行</h3>' + accTable(custRows, months, cm, { head: "公司 · 客户" }) +
    '</section>' +
    ledger("cust", "客户单据", "期间内开给客户的每一张发票。",
      [COLS.date, COLS.co, COLS.doc, COLS.party, COLS.desc, COLS.total, COLS.outs, COLS.late],
      docsOf(list, months, "arDocs"));
}

function viewLines(list, months, cm) {
  var rows = [];
  list.forEach(function (c) {
    rows = rows.concat(accRows(c.serviceLines, months, cm, function (a) {
      return a.deferred ? '<span class="tag deferred">预收</span>'
           : a.recharge ? '<span class="tag recharge">成本回收</span>' : "";
    }).map(function (r) { r.name = c.short + " · " + r.name; return r; }));
  });
  rows.sort(function (a, b) { return Math.abs(b.cur) - Math.abs(a.cur); });
  return vhead("服务线", "以发票明细的会计科目分类。标「预收」的进了负债科目，不是当期收入；" +
      "标「成本回收」的是把成本转嫁给客户。成本无法拆到服务线，所以这里只有收入。") +
    '<section class="card"><h3>各服务线开单额</h3>' + accTable(rows, months, cm, { head: "公司 · 服务线" }) +
    '</section>' +
    ledger("lines", "发票明细行", "期间内每一行开单明细，含客户与所属科目。",
      [COLS.date, COLS.co, COLS.doc, COLS.party, COLS.desc, COLS.acc, COLS.amt],
      slDocsOf(list, months));
}

function viewLiab(list, months) {
  var rows = [];
  list.forEach(function (c) {
    (c.liabilities || []).filter(function (l) { return !l.isControl; }).forEach(function (l) {
      rows.push({ co: c.short, l: l }); }); });
  rows.sort(function (x, y) { return y.l.bal - x.l.bal; });
  var def = sum(list, function (c) { return deferredOf(c); });
  return vhead("负债与递延", "递延收入是已收钱、还没交付的服务 —— 既是负债，也是已锁定的未来收入。", true) +
    '<div class="grid g3">' +
      kpi("递延收入", def, "", "已收钱、未交付", "deferred") +
      kpi("流动负债合计", sum(rows, function (r) { return r.l.bal; }), "", "已排除 AP 控制科目", null) +
      kpi("未付应付", sum(list, function (c) { return c.ap.total; }), "", "供应商欠款", null) +
    '</div><div class="lin" id="lineage" hidden></div>' +
    '<section class="card"><h3>负债科目</h3><p class="hint">已隐藏应付账款控制科目（SCR），那是 AP 分类账的汇总。</p>' +
    '<div class="tscroll"><table class="dtab"><thead><tr><th class="first">公司 · 科目</th>' +
    '<th class="num">余额</th></tr></thead><tbody>' + rows.map(function (r) {
      return '<tr><td class="first"><span class="mono">' + esc(r.co) + '</span> ' +
        '<span class="nm">' + esc(r.l.name) + '</span>' +
        (r.l.isDeferred ? '<span class="tag deferred">递延收入</span>' : "") +
        '<span class="sub2">' + esc(r.l.acc) + '</span></td><td class="num">' + rm(r.l.bal) +
        '</td></tr>'; }).join("") + '</tbody></table></div></section>' +
    ledger("liab", "负债分录", "期间内所有流动负债科目的分录。正数代表负债增加（例如收到预收款）。",
      [COLS.date, COLS.co, COLS.ref, COLS.desc, COLS.acc, COLS.ctr, COLS.jt, COLS.amt],
      txnsOf(list, months, ["L"]));
}

function viewAlerts(list, months) {
  var a = buildAlerts(list, months);
  return vhead("风险预警", "只统计选中的公司，按严重程度排序。红点最紧急。") +
    '<div class="grid g2">' +
    alertCard("收不回的钱", a.collect, "逾期 90 天以上、DSO 过长、或超过信用额度。") +
    alertCard("现金压力", a.cash, "银行贷方余额，或 runway 不足 6 个月。") +
    alertCard("获利在恶化", a.trend, "期间后段净利比前段更差且为负。") +
    alertCard("集中度风险", a.conc, "单一客户占该公司期间收入超过一半。") + '</div>' +
    '<section class="card"><h3>各公司 runway</h3><div class="tscroll"><table class="dtab">' +
    '<thead><tr><th class="first">公司</th><th class="num">现金</th><th class="num">月均净烧</th>' +
    '<th class="num">Runway</th><th class="num">期间净利</th></tr></thead><tbody>' +
    list.slice().sort(function (x, y) { return runwayOf(x, months) - runwayOf(y, months); })
      .map(function (c) {
        var r = runwayOf(c, months), b = burnOf(c, months);
        return '<tr><td class="first nm">' + esc(c.short) + '</td>' +
          '<td class="num ' + (c.cash < 0 ? "neg" : "") + '">' + rm(c.cash) + '</td>' +
          '<td class="num">' + (b > 0 ? rm(b) : "—") + '</td>' +
          '<td class="num risk ' + (r < 6 ? "hi" : r < 18 ? "mid" : "lo") + '">' +
          (r === Infinity ? "正现金流" : r <= 0 ? "已见底" : r.toFixed(1) + " 个月") + '</td>' +
          '<td class="num ' + (profitOf(c, months) < 0 ? "neg" : "pos") + '">' +
          rm(profitOf(c, months)) + '</td></tr>'; }).join("") + '</tbody></table></div></section>';
}

// AI Review has two halves, and the page is honest about which is which:
// the findings recompute from whatever is on screen; the commentary was written
// when the snapshot was built and is dated.
function viewReview(list, months, cm) {
  var mm = groupMonthly(list, months);
  var profits = mm.map(function (x) { return x.profit; });
  var sorted = profits.slice().sort(function (a, b) { return a - b; });
  var median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  var spread = sorted.length
    ? Math.sqrt(profits.reduce(function (s, p) { return s + (p - median) * (p - median); }, 0) /
        profits.length)
    : 0;

  // 1. Months that sit far from the middle of the period.
  var odd = mm.map(function (x) { return { ym: x.ym, profit: x.profit,
      z: spread ? (x.profit - median) / spread : 0 }; })
    .filter(function (x) { return Math.abs(x.z) >= 1.5; })
    .sort(function (a, b) { return Math.abs(b.z) - Math.abs(a.z); }).slice(0, 5);

  // 2. Expense accounts that moved hardest against the comparison period.
  var swings = [];
  if (cm) {
    list.forEach(function (c) {
      (c.expenses || []).forEach(function (a) {
        var cur = overM(a.m, months), prev = overM(a.m, cm);
        if (Math.abs(cur) < 20000 && Math.abs(prev) < 20000) return;
        if (!prev) { if (cur > 20000) swings.push({ co: c.short, name: a.name, acc: a.acc,
          cur: cur, prev: 0, pct: null }); return; }
        var pct = ((cur - prev) / Math.abs(prev)) * 100;
        if (Math.abs(pct) >= 40) swings.push({ co: c.short, name: a.name, acc: a.acc,
          cur: cur, prev: prev, pct: pct });
      });
    });
    swings.sort(function (x, y) { return Math.abs(y.cur - y.prev) - Math.abs(x.cur - x.prev); });
  }

  // 3. Revenue concentration and collection, reused from the alert engine.
  var a = buildAlerts(list, months);
  var findings = [].concat(
    a.cash.map(function (x) { return { g: "现金", x: x }; }),
    a.collect.map(function (x) { return { g: "收款", x: x }; }),
    a.conc.map(function (x) { return { g: "集中度", x: x }; }),
    a.trend.map(function (x) { return { g: "获利", x: x }; }));

  var s = pnlSeries(list, months);
  var t = function (k) { return s[k].reduce(function (x, y) { return x + y; }, 0); };
  var np = t("np"), rev = t("rev");

  return vhead("AI Review", "上半部是自动检查，跟着上面的公司与期间即时重算；" +
      "下半部是快照建立时写下的评述，会标注日期。") +
    '<section class="card"><h3>本期结论</h3>' +
    '<p class="dmeta">' + esc(range.from) + " → " + esc(range.to) + "（" + months.length +
      " 个月）· 已选 " + list.length + " 间公司" + (cm ? " · 对比" + cmpLabel() : "") + '</p>' +
    '<div class="tscroll"><table class="dtab"><tbody>' +
    [["营业收入", acct(rev)], ["净利", acct(np)],
     ["净利率", pct1(rev ? np / rev : null)],
     ["获利月数", mm.filter(function (x) { return x.profit > 0; }).length + " / " + mm.length],
     ["单月最佳", mm.length ? mm.reduce(function (p, q) { return q.profit > p.profit ? q : p; }).ym +
        "（" + acct(Math.max.apply(null, profits)) + "）" : "—"],
     ["单月最差", mm.length ? mm.reduce(function (p, q) { return q.profit < p.profit ? q : p; }).ym +
        "（" + acct(Math.min.apply(null, profits)) + "）" : "—"],
    ].map(function (r) {
      return '<tr><td class="first nm">' + esc(r[0]) + '</td><td class="num">' + r[1] +
        '</td></tr>'; }).join("") + '</tbody></table></div></section>' +

    '<section class="card"><h3>异常月份 <span class="acount">' + odd.length + '</span></h3>' +
    '<p class="hint">与期间中位数（' + acct(median) + '）相差 1.5 个标准差以上的月份。' +
    '单月异常会把整段合计拉歪，先看这里。</p>' +
    (odd.length ? '<div class="tscroll"><table class="dtab"><thead><tr><th class="first">月份</th>' +
      '<th class="num">净利</th><th class="num">偏离</th><th>判读</th></tr></thead><tbody>' +
      odd.map(function (o) {
        return '<tr><td class="first nm">' + esc(o.ym) + '</td><td class="num ' +
          (o.profit < 0 ? "neg" : "pos") + '"><b>' + acct(o.profit) + '</b></td>' +
          '<td class="num">' + (o.z > 0 ? "+" : "") + o.z.toFixed(1) + 'σ</td>' +
          '<td>' + (o.z < 0 ? "远低于常态 — 查当月大额费用或冲销"
                            : "远高于常态 — 查是否一次性收入或调整") + '</td></tr>';
      }).join("") + '</tbody></table></div>'
      : '<p class="empty">这段期间没有明显偏离的月份。</p>') + '</section>' +

    '<section class="card"><h3>费用异动 <span class="acount">' + swings.length + '</span></h3>' +
    '<p class="hint">' + (cm
      ? "与" + cmpLabel() + "相比变动 40% 以上、且金额达 20,000 的费用科目，按变动金额排序。"
      : "需要先在上方选一个比较期间（去年同期或前一期）才能算异动。") + '</p>' +
    (cm ? (swings.length ? '<div class="tscroll"><table class="dtab"><thead><tr>' +
      '<th class="first">公司 · 科目</th><th class="num">本期</th><th class="num">' +
      esc(cmpLabel()) + '</th><th class="num">差额</th><th class="num">变化</th>' +
      '</tr></thead><tbody>' + swings.slice(0, 12).map(function (w) {
        return '<tr><td class="first"><span class="mono">' + esc(w.co) + '</span> ' +
          '<span class="nm">' + esc(w.name) + '</span><span class="sub2">' + esc(w.acc) +
          '</span></td><td class="num">' + acct(w.cur) + '</td><td class="num muted">' +
          acct(w.prev) + '</td><td class="num ' + (w.cur > w.prev ? "neg" : "pos") + '"><b>' +
          acct(w.cur - w.prev) + '</b></td><td class="num">' +
          (w.pct === null ? "新增" : (w.pct >= 0 ? "+" : "") + w.pct.toFixed(0) + "%") +
          '</td></tr>'; }).join("") + '</tbody></table></div>'
      : '<p class="empty">没有变动幅度达标的费用科目。</p>') : "") + '</section>' +

    '<section class="card"><h3>自动检查 <span class="acount">' + findings.length + '</span></h3>' +
    '<p class="hint">现金、收款、集中度、获利四个方向的规则检查。</p>' +
    (findings.length ? '<ul class="alist" style="margin-top:9px">' + findings.map(function (f) {
      return '<li class="sev-' + f.x.severity + '"><span class="sevdot"></span>' +
        '<span class="acomp">' + esc(f.x.company) + " · " + esc(f.g) + '</span>' +
        '<span class="atext">' + esc(f.x.detail) + '</span></li>'; }).join("") + '</ul>'
      : '<p class="empty">没有触发任何规则。</p>') + '</section>' +

    '<section class="card"><h3>CFO 评述 <span class="asat">写于 ' + esc(REVIEW_DATE) + '</span></h3>' +
    '<p class="hint">以下是快照建立时的人工判读，<b>不会随筛选变动</b>。资料更新后需要重新产生。</p>' +
    '<div class="notes" style="margin-top:10px">' + REVIEW_HTML + '</div></section>';
}

// ---------------------------------------------------------- 预算管理 3D model
// R − V = G,  G − F = P.  V varies with volume, F does not.
function costBucket(acc, name, type) {
  var up = String(name || "").toUpperCase();
  for (var i = 0; i < RULES.rules.length; i++) {
    var r = RULES.rules[i];
    if (r.acc && r.acc === acc) return r.bucket;
    if (r.keyword && up.indexOf(r.keyword) !== -1) return r.bucket;
  }
  return (RULES.fallback || {})[type] || "F_operate";
}
function isNonOp(name) {
  var up = String(name || "").toUpperCase();
  return (RULES.nonOperating || []).some(function (k) { return up.indexOf(k) !== -1; });
}

// Monthly series for each line of the cost model.
function vrgfpSeries(list, months) {
  var z = function () { return months.map(function () { return 0; }); };
  var s = { R: z(), Va: z(), Vd: z(), Fo: z(), Fa: z() };
  list.forEach(function (c) {
    (c.revenueAccounts || []).forEach(function (a) {
      months.forEach(function (m, i) { s.R[i] += (a.m || {})[m] || 0; });
    });
    (c.expenses || []).forEach(function (a) {
      var b = costBucket(a.acc, a.name, a.type);
      var k = b === "V_acquire" ? "Va" : b === "V_deliver" ? "Vd"
            : b === "F_asset" ? "Fa" : "Fo";
      months.forEach(function (m, i) { s[k][i] += (a.m || {})[m] || 0; });
    });
  });
  s.V = months.map(function (_, i) { return s.Va[i] + s.Vd[i]; });
  s.G = months.map(function (_, i) { return s.R[i] - s.V[i]; });
  s.F = months.map(function (_, i) { return s.Fo[i] + s.Fa[i]; });
  s.P = months.map(function (_, i) { return s.G[i] - s.F[i]; });
  return s;
}

function vrgfpStatement(list, months, title) {
  var s = vrgfpSeries(list, months);
  var tot = function (a) { return a.reduce(function (x, y) { return x + y; }, 0); };
  var LINES = [
    { id: "R",  k: "R 收入 Revenue", v: s.R, strong: true },
    { id: "Va", k: "　获客成本 Acquire", v: s.Va, negate: true, indent: true },
    { id: "Vd", k: "　交付成本 Deliver", v: s.Vd, negate: true, indent: true },
    { id: "V",  k: "V 变化成本 Variable", v: s.V, negate: true, strong: true },
    { id: "G",  k: "G 毛利 Gross profit", v: s.G, strong: true },
    { id: "GPR", k: "　GP% 毛利率", ratio: ["G", "R"] },
    { id: "Fo", k: "　运营成本 Operating", v: s.Fo, negate: true, indent: true },
    { id: "Fa", k: "　资产贬值 Depreciation", v: s.Fa, negate: true, indent: true },
    { id: "F",  k: "F 固定成本 Fixed", v: s.F, negate: true, strong: true },
    { id: "P",  k: "P 利润 Profit", v: s.P, strong: true },
    { id: "NPR", k: "　NP% 净利率", ratio: ["P", "R"] },
  ];
  var cell = function (txt, id, ym, extra) {
    var on = openFig && openFig.line === id && openFig.acc === "" && openFig.ym === (ym || "");
    return '<td class="num fig' + (extra || "") + (on ? " figon" : "") + '" data-line="' + id +
      '" data-acc="" data-ym="' + esc(ym || "") + '">' + txt + '</td>';
  };
  var head = '<tr><th class="first">' + esc(title) + '</th>' +
    months.map(function (m) {
      return '<th class="num' + (m === LASTFULL ? " cur" : "") + '">' + esc(mlab(m)) + '</th>';
    }).join("") + '<th class="num tcol">合计 Total</th></tr>';
  var body = LINES.map(function (L) {
    if (L.ratio) {
      var n = s[L.ratio[0]], d = s[L.ratio[1]];
      return '<tr class="ratio"><td class="first">' + esc(L.k) + '</td>' +
        months.map(function (m, i) {
          return cell(pct1(d[i] ? n[i] / d[i] : null), L.id, m); }).join("") +
        cell(pct1(tot(d) ? tot(n) / tot(d) : null), L.id, "", " tcol") + '</tr>';
    }
    var vals = L.negate ? L.v.map(function (x) { return -x; }) : L.v;
    return '<tr' + (L.strong ? ' class="sub"' : L.indent ? ' class="lvl2"' : "") + '>' +
      '<td class="first">' + esc(L.k) + '</td>' +
      vals.map(function (x, i) { return cell(acct(x), L.id, months[i]); }).join("") +
      cell(acct(tot(vals)), L.id, "", " tcol") + '</tr>';
  }).join("");
  return '<div class="tscroll"><table class="dtab pnl"><thead>' + head + '</thead><tbody>' +
    body + '</tbody></table></div>';
}

var VRGFP_META = {
  R:  { label: "R 收入", kinds: ["R"], buckets: null, rev: true },
  Va: { label: "获客成本", kinds: ["E"], buckets: ["V_acquire"] },
  Vd: { label: "交付成本", kinds: ["E"], buckets: ["V_deliver"] },
  V:  { label: "V 变化成本", kinds: ["E"], buckets: ["V_acquire", "V_deliver"] },
  Fo: { label: "运营成本", kinds: ["E"], buckets: ["F_operate"] },
  Fa: { label: "资产贬值", kinds: ["E"], buckets: ["F_asset"] },
  F:  { label: "F 固定成本", kinds: ["E"], buckets: ["F_operate", "F_asset"] },
  G:  { label: "G 毛利", composed: true },
  P:  { label: "P 利润", composed: true },
  GPR: { label: "GP% 毛利率", ratioOf: ["G", "R"] },
  NPR: { label: "NP% 净利率", ratioOf: ["P", "R"] },
};

function vrgfpDetail(list, months, lineId, ym) {
  var M = VRGFP_META[lineId];
  if (!M) return '<p class="empty">没有这个项目的明细。</p>';
  var scope = ym ? [ym] : months;
  var period = ym || (range.from + " → " + range.to);
  var s = vrgfpSeries(list, scope);
  var t = function (k) { return s[k].reduce(function (a, b) { return a + b; }, 0); };

  if (M.composed || M.ratioOf) {
    var parts = M.ratioOf
      ? [["分子 " + VRGFP_META[M.ratioOf[0]].label, t(M.ratioOf[0])],
         ["分母 " + VRGFP_META[M.ratioOf[1]].label, t(M.ratioOf[1])],
         ["＝ 比率", t("R") ? t(M.ratioOf[0]) / t("R") : null, true]]
      : lineId === "G"
        ? [["R 收入", t("R")], ["减 V 变化成本", -t("V")], ["＝ G 毛利", t("G")]]
        : [["G 毛利", t("G")], ["减 F 固定成本", -t("F")], ["＝ P 利润", t("P")]];
    return '<p class="dmeta">' + esc(M.label) + ' · ' + esc(period) + '</p>' +
      '<div class="tscroll"><table class="dtab"><tbody>' + parts.map(function (p, i) {
        return '<tr' + (i === parts.length - 1 ? ' class="sub"' : "") + '>' +
          '<td class="first">' + esc(p[0]) + '</td><td class="num">' +
          (p[2] ? pct1(p[1]) : acct(p[1])) + '</td></tr>'; }).join("") +
      '</tbody></table></div>';
  }

  // Which accounts make up this line, then the entries behind them.
  var accs = [];
  list.forEach(function (c) {
    var src = M.rev ? (c.revenueAccounts || []) : (c.expenses || []);
    src.forEach(function (a) {
      if (!M.rev && M.buckets.indexOf(costBucket(a.acc, a.name, a.type)) === -1) return;
      var v = overM(a.m, scope);
      if (v) accs.push({ co: c.short, acc: a.acc, name: a.name, v: v });
    });
  });
  accs.sort(function (x, y) { return Math.abs(y.v) - Math.abs(x.v); });
  var total = accs.reduce(function (s2, a) { return s2 + a.v; }, 0);
  var want = {};
  accs.forEach(function (a) { want[a.acc] = 1; });
  var txns = txnsOf(list, scope, M.kinds).filter(function (t2) { return want[t2.acc]; })
    .sort(function (x, y) { return Math.abs(y.amt) - Math.abs(x.amt); });

  return '<p class="dmeta">' + esc(M.label) + ' · ' + esc(period) +
    ' · 合计 RM ' + rm(total) + '</p><h5 class="dsub">组成科目 ' + accs.length + ' 个</h5>' +
    '<div class="tscroll"><table class="dtab"><tbody>' + accs.slice(0, 40).map(function (a) {
      return '<tr><td class="first"><span class="mono">' + esc(a.co) + '</span> ' +
        '<span class="nm">' + esc(a.name) + '</span><span class="sub2">' + esc(a.acc) +
        '</span></td><td class="num">' + acct(a.v) + '</td></tr>'; }).join("") +
    '<tr class="sub"><td class="first">合计</td><td class="num">' + acct(total) +
    '</td></tr></tbody></table></div>' +
    '<h5 class="dsub">分录 ' + txns.length.toLocaleString() + ' 笔' +
      (txns.length > 200 ? '（金额最大的 200 笔）' : "") + '</h5>' +
    '<div class="tscroll"><table class="dtab"><thead><tr><th class="first">日期</th><th>公司</th>' +
    '<th>单号</th><th>摘要</th><th>科目</th><th class="num">金额</th></tr></thead><tbody>' +
    (txns.length ? txns.slice(0, 200).map(function (t2) {
      return '<tr><td class="first mono">' + esc(t2.date) + '</td><td class="mono">' + esc(t2.co) +
        '</td><td class="mono">' + esc(t2.ref || "—") + '</td><td>' + esc(t2.desc || "—") +
        '</td><td>' + esc(t2.accName) + '<span class="sub2">' + esc(t2.acc) + '</span></td>' +
        '<td class="num"><b>' + rm(t2.amt) + '</b></td></tr>'; }).join("")
      : '<tr><td class="empty" colspan="6">这个期间没有分录。</td></tr>') + '</tbody></table></div>';
}

function viewVrgfp(list, months, cm) {
  var ents = [{ id: "__all__", label: "合并 Consolidated", list: list }].concat(
    list.map(function (c) { return { id: c.short, label: c.short, list: [c] }; }));
  var ent = ents.filter(function (e) { return e.id === pnlEntity; })[0] || ents[0];
  var s = vrgfpSeries(ent.list, months);
  var t = function (k) { return s[k].reduce(function (a, b) { return a + b; }, 0); };
  var R = t("R"), G = t("G"), F = t("F"), P = t("P"), V = t("V");
  var gpm = R ? G / R : 0;
  // The course's own arithmetic: 目标收入 = (利润目标 + 固定成本) ÷ GP Margin
  var breakeven = gpm > 0 ? F / gpm : null;
  var gap = breakeven === null ? null : breakeven - R;

  var cmS = cm ? vrgfpSeries(ent.list, cm) : null;
  var ct = cmS ? function (k) { return cmS[k].reduce(function (a, b) { return a + b; }, 0); } : null;

  return vhead("成本结构 R−V=G，G−F=P",
      "课程的成本模型。V 变化成本按量变化（获客＋交付），F 固定成本按量不变（运营＋贬值）。" +
      "点任何数字看它由哪些科目、哪些分录组成。") +
    '<div class="enttabs">' + ents.map(function (e) {
      return '<button class="ent" type="button" data-ent="' + esc(e.id) + '" aria-pressed="' +
        (e.id === ent.id) + '">' + esc(e.label) + '</button>'; }).join("") + '</div>' +
    '<div class="grid g4">' +
      kpi("R 收入", R, "", months.length + " 个月", null, ct ? ct("R") : null) +
      kpi("V 变化成本", V, "", R ? "占收入 " + pct1(V / R) : "", null, ct ? ct("V") : null) +
      kpi("G 毛利", G, "", "GP% " + pct1(gpm), null, ct ? ct("G") : null) +
      kpi("F 固定成本", F, "", G ? "毛利覆盖率 " + pct1(G / F) : "", null, ct ? ct("F") : null) +
    '</div>' +
    '<section class="card"><h3>算差距 · 打平需要多少收入</h3>' +
    '<p class="hint">课程公式：目标收入 ＝ (利润目标 ＋ 固定成本) ÷ GP Margin。' +
    '这里以利润目标 0（打平）计算。</p>' +
    (breakeven === null
      ? '<p class="empty">毛利率为负或零，再多收入也补不平 —— 要先修成本结构。</p>'
      : '<div class="tscroll"><table class="dtab"><tbody>' +
        [["固定成本 F", acct(F)], ["÷ 毛利率 GP%", pct1(gpm)],
         ["＝ 打平所需收入", acct(breakeven)], ["目前收入 R", acct(R)],
         [gap > 0 ? "缺口 Gap" : "已超出打平点", acct(Math.abs(gap))]].map(function (r, i) {
          return '<tr' + (i >= 2 ? ' class="sub"' : "") + '><td class="first">' + esc(r[0]) +
            '</td><td class="num">' + r[1] + '</td></tr>'; }).join("") +
        '</tbody></table></div>' +
        '<p class="hint" style="margin-top:9px">' +
        (gap > 0
          ? "收入要再增加 RM " + rm(gap) + " 才打平 —— 或把固定成本降 RM " + rm(-P) +
            "，或把毛利率从 " + pct1(gpm) + " 拉到 " + pct1(R ? F / R : 0) + "。"
          : "毛利已覆盖固定成本，利润 RM " + rm(P) + "。") + '</p>') +
    '</section>' +
    '<section class="card"><h3>成本结构表 · ' + esc(ent.label) + '</h3>' +
    '<p class="hint">负数以括号显示 · 点任一数字展开来源</p>' +
    vrgfpStatement(ent.list, months, ent.id === "__all__" ? "合并 (RM)" : ent.label + " (RM)") +
    '</section>' +
    (openFig && VRGFP_META[openFig.line]
      ? '<section class="card figpanel" id="figpanel"><div class="lhead">' +
        '<h3>数字来源 · ' + esc(VRGFP_META[openFig.line].label) +
        (openFig.ym ? " · " + esc(openFig.ym) : " · 期间合计") + '</h3>' +
        '<button class="close" type="button" id="figClose">关闭</button></div>' +
        vrgfpDetail(ent.list, months, openFig.line, openFig.ym) + '</section>'
      : "") +
    '<div class="grid g2"><section class="card"><h3>月度 毛利 vs 固定成本</h3>' +
    '<p class="hint">毛利柱高过固定成本柱才有利润。</p>' +
    '<div class="legend"><span><i class="sw rev"></i>G 毛利</span>' +
    '<span><i class="sw bill"></i>F 固定成本</span></div>' +
    barChart(months.map(function (m, i) { return { ym: m, G: s.G[i], F: s.F[i] }; }),
      { series: [{ key: "G", label: "毛利", cls: "rev" }, { key: "F", label: "固定成本", cls: "bill" }],
        aria: "毛利与固定成本" }) + '</section>' +
    '<section class="card"><h3>月度 GP%</h3>' +
    '<p class="hint">毛利率的走势 —— 掉下去就是成本在吃掉利润。</p>' +
    barChart(months.map(function (m, i) {
      return { ym: m, gp: s.R[i] ? (s.G[i] / s.R[i]) * 100 : 0 }; }),
      { series: [{ key: "gp", label: "GP%" }], diverging: true, aria: "月度毛利率" }) +
    '</section></div>';
}

// ------------------------------------------------------------- GP by project
function projectRows(c, months) {
  var cfg = (PMAP.companies || {})[c.short];
  if (!cfg) return null;
  var proj = {}, nonOp = 0;
  (c.revenueAccounts || []).forEach(function (a) {
    var v = overM(a.m, months);
    if (!v) return;
    if (isNonOp(a.name)) { nonOp += v; return; }
    var p = cfg.revenue[a.acc] || a.name;
    (proj[p] = proj[p] || { R: 0, V: 0, F: 0 }).R += v;
  });
  var names = Object.keys(proj);
  var totR = names.reduce(function (s, p) { return s + proj[p].R; }, 0);
  if (!names.length || totR <= 0) return null;

  var sharedV = 0, sharedF = 0, directV = 0, directF = 0, pending = [];
  (c.expenses || []).forEach(function (a) {
    var v = overM(a.m, months);
    if (!v) return;
    var isV = costBucket(a.acc, a.name, a.type).indexOf("V_") === 0;
    var mp = cfg.cost[a.acc];
    var placed = false;
    if (mp) {
      if (typeof mp === "string") {
        if (proj[mp]) { proj[mp][isV ? "V" : "F"] += v; placed = true; }
      } else {
        var wt = Object.keys(mp).reduce(function (s, k) { return s + Number(mp[k] || 0); }, 0);
        if (wt) Object.keys(mp).forEach(function (k) {
          if (proj[k]) { proj[k][isV ? "V" : "F"] += v * (Number(mp[k]) / wt); placed = true; }
        });
      }
    }
    if (placed) { if (isV) directV += v; else directF += v; return; }
    if (isV) sharedV += v; else sharedF += v;
    if (v >= 10000) pending.push({ acc: a.acc, name: a.name, v: v, kind: isV ? "V" : "F" });
  });
  // "direct-only" leaves shared cost unallocated and shows it on its own line.
  // The default keeps the original revenue-share behaviour. This is the whole
  // point of the setting: allocating by revenue share forces every line to the
  // company GP%, so a book that wants real differences must not allocate.
  var allocate = PMAP._sharedCostMethod !== "direct-only";
  if (allocate) {
    names.forEach(function (p) {
      var sh = proj[p].R / totR;
      proj[p].V += sharedV * sh; proj[p].F += sharedF * sh;
    });
  }
  var alloc = (sharedV + sharedF) / (sharedV + sharedF + directV + directF || 1);
  pending.sort(function (x, y) { return y.v - x.v; });
  return {
    rows: names.map(function (p) {
      return { p: p, R: proj[p].R, V: proj[p].V, G: proj[p].R - proj[p].V,
               F: proj[p].F, P: proj[p].R - proj[p].V - proj[p].F };
    }).sort(function (x, y) { return y.R - x.R; }),
    nonOp: nonOp, direct: Math.max(0, Math.min(1, 1 - alloc)), pending: pending,
    projects: names, allocated: allocate, sharedV: sharedV, sharedF: sharedF,
  };
}

function viewProduct(list, months) {
  var blocks = list.map(function (c) {
    var d = projectRows(c, months);
    if (!d) return "";
    var W = d.direct;
    var T = d.rows.reduce(function (t, r) {
      return { R: t.R + r.R, V: t.V + r.V, G: t.G + r.G, F: t.F + r.F, P: t.P + r.P };
    }, { R: 0, V: 0, G: 0, F: 0, P: 0 });
    // With shared cost left unallocated the project rows no longer add up to the
    // company, so it is carried into the total explicitly. The 营业合计 line has
    // to tie to the P&L or the table cannot be checked against anything.
    if (!d.allocated) {
      T.V += d.sharedV; T.F += d.sharedF;
      T.G -= d.sharedV; T.P -= (d.sharedV + d.sharedF);
    }

    return '<section class="card"><div class="lhead"><div><h3>' + esc(c.name) + '</h3>' +
      '<p class="hint" style="margin:2px 0 0">营业收入 RM ' + rm(T.R) +
      (d.nonOp ? ' · 非营业收入 RM ' + rm(d.nonOp) + '（不进产品分析）' : "") + '</p></div>' +
      '<div class="ltools"><span class="lcount">成本已指定归属 <b class="' +
      (W < 0.5 ? "neg" : "pos") + '">' + pct1(W) + '</b></span></div></div>' +
      (!d.allocated
        ? '<p class="hint">共用成本不分摊，单独列在下表「共用成本」一行。每条产品线的数字'
          + '只含能直接归属的成本，所以是真的 —— 但不是全成本，别拿线间 GP% 当最终结论。</p>'
        : W < 0.5 ? '<p class="hint" style="color:var(--serious)">⚠ 超过一半的成本还在按收入比例分摊，' +
        '所以下表每条线的 GP% 会趋于相同 —— 那是分摊的结果，不是真实差异。' +
        '要让这张表有意义，需要指定下面那些科目属于哪个 project。</p>' : "") +
      '<div class="tscroll"><table class="dtab pnl"><thead><tr><th class="first">项目 Project</th>' +
      '<th class="num">收入 R</th><th class="num">变化成本 V</th><th class="num">毛利 G</th>' +
      '<th class="num">GP%</th><th class="num">固定成本 F</th><th class="num">净利 P</th>' +
      '<th class="num">NP%</th></tr></thead><tbody>' + d.rows.map(function (r) {
        return '<tr><td class="first nm">' + esc(r.p) + '</td>' +
          '<td class="num">' + acct(r.R) + '</td><td class="num">' + acct(-r.V) + '</td>' +
          '<td class="num">' + acct(r.G) + '</td>' +
          '<td class="num' + (r.G < 0 ? " neg" : "") + '"><b>' + pct1(r.R ? r.G / r.R : null) +
          '</b></td><td class="num">' + acct(-r.F) + '</td>' +
          '<td class="num' + (r.P < 0 ? " neg" : "") + '">' + acct(r.P) + '</td>' +
          '<td class="num">' + pct1(r.R ? r.P / r.R : null) + '</td></tr>';
      }).join("") +
      (!d.allocated && (d.sharedV || d.sharedF)
        ? '<tr class="ratio"><td class="first">共用成本（未分摊）</td>' +
          '<td class="num">·</td><td class="num">' + acct(-d.sharedV) + '</td>' +
          '<td class="num">' + acct(-d.sharedV) + '</td><td class="num">·</td>' +
          '<td class="num">' + acct(-d.sharedF) + '</td><td class="num">' +
          acct(-(d.sharedV + d.sharedF)) + '</td><td class="num">·</td></tr>'
        : "") +
      '<tr class="sub"><td class="first">营业合计</td>' +
      '<td class="num">' + acct(T.R) + '</td><td class="num">' + acct(-T.V) + '</td>' +
      '<td class="num">' + acct(T.G) + '</td><td class="num">' + pct1(T.R ? T.G / T.R : null) +
      '</td><td class="num">' + acct(-T.F) + '</td><td class="num">' + acct(T.P) + '</td>' +
      '<td class="num">' + pct1(T.R ? T.P / T.R : null) + '</td></tr>' +
      (d.nonOp ? '<tr class="ratio"><td class="first">非营业收入（另计）</td>' +
        '<td class="num">' + acct(d.nonOp) + '</td><td colspan="6"></td></tr>' : "") +
      '</tbody></table></div>' +
      (d.pending.length ? '<h5 class="dsub">待指定归属的科目（≥ 10,000）</h5>' +
        '<p class="hint">可选 project：' + esc(d.projects.join(" / ")) + '</p>' +
        '<div class="tscroll"><table class="dtab"><tbody>' + d.pending.slice(0, 10)
          .map(function (s) {
            return '<tr><td class="first"><span class="nm">' + esc(s.name) + '</span>' +
              '<span class="tag ' + (s.kind === "V" ? "deferred" : "recharge") + '">' +
              (s.kind === "V" ? "变化" : "固定") + '</span><span class="sub2">' + esc(s.acc) +
              '</span></td><td class="num">' + acct(s.v) + '</td></tr>'; }).join("") +
        '</tbody></table></div>' : "") + '</section>';
  }).join("");

  return vhead("分析产品 GP by Project", "课程 P33 的表。收入只算已确认、且排除非营业收入。" +
      (PMAP._sharedCostMethod === "direct-only"
        ? "成本只算能直接归属的，共用成本单独列一行、不分摊。"
        : "成本先看有没有指定归属，没有的按各 project 的收入比例分摊。")) +
    '<section class="card"><h3>为什么「成本已指定归属 %」是关键</h3>' +
    '<p class="hint" style="margin:6px 0 0">按收入比例分摊，数学上会让每条产品线的 GP% ' +
    '等于公司整体的 GP% —— 那张表好看，但看不出哪条线赚钱。只有直接归属的成本才会拉开差异。' +
    (PMAP._sharedCostMethod === "direct-only"
      ? '本表<b>不分摊</b>，所以线间的差异是真的；代价是每条线只看得到直接成本，'
        + '不是全成本。共用成本单独列一行，营业合计仍与损益表相符。'
      : '') +
    '要提高这个比例，就是把成本科目指定给 project（改 <code>project-map.json</code>），' +
    '或从今天起在 AutoCount 开单入账时填 <code>ProjNo</code>。</p></section>' +
    (blocks || '<p class="empty">选中的公司没有可分析的营业收入。</p>');
}

function viewSource() {
  var METRICS = [
    ["已确认收入", "Σ (HomeCR − HomeDR)，AccType IN ('SL','OI')", "GLDTL · GLMast"],
    ["支出", "Σ (HomeDR − HomeCR)，AccType IN ('EP','CO')", "GLDTL · GLMast"],
    ["净利", "已确认收入 − 支出（只到公司层级）", "GLDTL · GLMast"],
    ["开单额", "Σ ARInvoice.LocalNetTotal，Cancelled='F'", "ARInvoice"],
    ["现金余额", "Σ (HomeDR − HomeCR)，SpecialAccType IN ('SBK','SCH')", "GLDTL · GLMast"],
    ["现金流入 / 流出", "Σ HomeDR / Σ HomeCR 于银行科目，依 DEAccNo 分组", "GLDTL · GLMast"],
    ["递延收入", "Σ (HomeCR − HomeDR)，AccType='CL' 且名称含关键字", "GLDTL · GLMast"],
    ["未收应收", "Σ ARInvoice.Outstanding，Cancelled='F'", "ARInvoice"],
    ["DSO", "未收应收 ÷ (期间收入 ÷ 期间天数)", "ARInvoice · GLDTL"],
    ["Runway", "现金 ÷ 每月净烧（(支出−收入)÷月数）", "GLDTL · GLMast"],
    ["集中度", "最大客户开单额 ÷ 期间总开单额", "ARInvoice · Debtor"],
  ];
  var NOTES = [
    "「当下」标记的区块不随期间变动。应收应付账龄、银行余额、递延收入余额都是此刻的位置，不是期间流量。",
    "成本无法拆到服务线。ProjNo、DeptNo 全集团没有使用，费用只挂在科目上。要改变这点，得从今天起开单与入账时填 ProjNo；旧资料补不回来。",
    "最后一个月未过完，判断趋势时请忽略，或把结束月往前调一个月。",
    "集团合计未冲销关联交易。集团内部互相开单在合计里重复计算，客户页有标示「疑似关联」。",
    "户口间调拨预设排除。若对方科目本身也是银行或现金科目，那笔只是自家户口搬钱，会同时灌大流入与流出。",
    "递延收入以科目名称关键字辨识（UNRECOGNISED / UNEARNED / DEFERRED / DEPOSIT / ADVANCE），属推测分类，请核对。",
    "作废单据已排除（Cancelled='T'）。AutoCount 的作废单仍保留金额，不排除会虚增应收。",
    "账龄以到期日计算，不是开单日。",
  ];
  return vhead("资料来源", "每个数字的算法、来源表与筛选条件。各页 KPI 卡右上角的 ⓘ 会列出组成明细。") +
    '<section class="card"><h3>指标算法</h3><div class="tscroll"><table class="dtab"><thead><tr>' +
    '<th class="first">指标</th><th>公式</th><th>来源表</th></tr></thead><tbody>' +
    METRICS.map(function (r) {
      return '<tr><td class="first nm">' + esc(r[0]) + '</td><td class="mono" style="font-size:11.5px">' +
        esc(r[1]) + '</td><td class="mono" style="font-size:11.5px">' + esc(r[2]) + '</td></tr>';
    }).join("") + '</tbody></table></div></section>' +
    '<section class="card"><h3>口径与限制</h3><div class="notes" style="margin-top:8px"><ul>' +
    NOTES.map(function (n) { return "<li>" + esc(n) + "</li>"; }).join("") +
    '<li>资料范围：' + esc(ALLM[0]) + " 至 " + esc(ALLM[ALLM.length - 1]) + "，共 " + ALLM.length +
    ' 个月，' + D.companies.reduce(function (s, c) { return s + ((c.txns || []).length); }, 0)
      .toLocaleString() + ' 笔分录。</li></ul></div></section>' +
    '<section class="card"><h3>想追问什么</h3>' +
    '<p class="hint">这一页是快照。点一下复制问题，贴到这台电脑的 Claude 里，它会现场去查最新资料，' +
    '而且能查到 2019 年。</p><div class="qlist">' + QUESTIONS.map(function (q) {
      return '<button class="q" type="button" data-q="' + esc(q) + '"><span class="qi">?</span>' +
        '<span class="qt">' + esc(q) + '</span></button>'; }).join("") + '</div></section>';
}

function renderControls() {
  document.getElementById("cFilters").innerHTML = '<span class="clab">公司</span>' +
    LIVE.map(function (c) {
      return '<button class="pill" type="button" aria-pressed="' + sel.has(c.short) +
        '" data-co="' + esc(c.short) + '">' + esc(c.short) + '</button>'; }).join("") +
    '<span class="csep"></span>' +
    '<button class="pill quick" type="button" data-quick="all">全选</button>' +
    '<button class="pill quick" type="button" data-quick="active">只看活跃</button>' +
    '<button class="pill quick" type="button" data-quick="none">全不选</button>';

  var opts = function (s) {
    return ALLM.map(function (m) {
      return '<option value="' + m + '"' + (m === s ? " selected" : "") + '>' + m + '</option>';
    }).join("");
  };
  document.getElementById("cRange").innerHTML = '<span class="clab">期间</span>' +
    '<select id="fromSel">' + opts(range.from) + '</select><span class="cnote">到</span>' +
    '<select id="toSel">' + opts(range.to) + '</select><span class="csep"></span>' +
    [["6", "近 6 月"], ["12", "近 12 月"], ["24", "近 24 月"], ["ytd", "今年至今"],
     ["ly", "去年全年"], ["all", "全部"]].map(function (p) {
      return '<button class="pill quick" type="button" data-preset="' + p[0] + '">' + p[1] +
        '</button>'; }).join("") +
    '<span class="cnote">共 ' + curMonths().length + ' 个月</span>';

  document.getElementById("cCmp").innerHTML = '<span class="clab">比较</span>' +
    [["none", "不比较"], ["yoy", "去年同期"], ["prev", "前一期"]].map(function (p) {
      return '<button class="pill" type="button" aria-pressed="' + (cmpMode === p[0]) +
        '" data-cmp="' + p[0] + '">' + p[1] + '</button>'; }).join("") +
    (cmpMode !== "none" ? '<span class="cnote">' + cmpMonths()[0] + " → " +
      cmpMonths()[cmpMonths().length - 1] + '</span>' : "") +
    '<span class="csep"></span><button class="pill" type="button" aria-pressed="' + excludeInternal +
    '" id="intToggle">排除户口间调拨</button>';
}

function renderRail(list, months) {
  var a = buildAlerts(list, months);
  var arN = docsOf(list, months, "arDocs").length;
  var counts = {
    pnl: txnsOf(list, months, ["R", "E"]).length,
    cash: txnsOf(list, months, ["C"]).length,
    ar: arN, cust: arN,
    ap: docsOf(list, months, "apDocs").length,
    lines: slDocsOf(list, months).length,
    liab: txnsOf(list, months, ["L"]).length,
    vrgfp: txnsOf(list, months, ["R", "E"]).length,
    product: list.filter(function (c) { return projectRows(c, months); }).length,
    alerts: a.collect.length + a.cash.length + a.trend.length + a.conc.length,
  };
  document.getElementById("rail").innerHTML = TOPICS.map(function (t) {
    var n = counts[t.id];
    return '<li><button class="rnav" type="button" data-topic="' + t.id + '" aria-current="' +
      (topic === t.id) + '"><span class="rlab">' + esc(t.label) +
      '<span class="ren">' + esc(t.en) + '</span></span>' +
      (n ? '<span class="rc' + (t.id === "alerts" ? " alert" : "") + '">' +
        n.toLocaleString() + '</span>' : "") + '</button></li>';
  }).join("");
  var ab = document.getElementById("aiBtn");
  if (ab) ab.setAttribute("aria-pressed", topic === "review");
  document.getElementById("railFoot").innerHTML =
    "已选 " + list.length + " 间公司<br>" + range.from + " → " + range.to +
    "（" + months.length + " 个月）" + (cmpMode !== "none" ? "<br>对比" + cmpLabel() : "");
}

function render() {
  var list = picked();
  var months = curMonths();
  var cm = cmpMonths();
  renderRail(list, months);
  var v = document.getElementById("view");
  if (!list.length) { v.innerHTML = vhead("没有选中公司", "在上方挑一间公司来看。"); return; }
  if (topic === "overview") v.innerHTML = viewOverview(list, months, cm);
  else if (topic === "pnl") v.innerHTML = viewPnl(list, months, cm);
  else if (topic === "cash") v.innerHTML = viewCash(list, months);
  else if (topic === "ar") v.innerHTML = viewAr(list, months);
  else if (topic === "ap") v.innerHTML = viewAp(list, months);
  else if (topic === "vrgfp") v.innerHTML = viewVrgfp(list, months, cm);
  else if (topic === "product") v.innerHTML = viewProduct(list, months);
  else if (topic === "cust") v.innerHTML = viewCust(list, months, cm);
  else if (topic === "lines") v.innerHTML = viewLines(list, months, cm);
  else if (topic === "liab") v.innerHTML = viewLiab(list, months);
  else if (topic === "alerts") v.innerHTML = viewAlerts(list, months);
  else if (topic === "review") v.innerHTML = viewReview(list, months, cm);
  else v.innerHTML = viewSource();
  if (openSrc) {
    var b = document.querySelector('.src[data-src="' + openSrc + '"]');
    var k = openSrc; openSrc = null;
    if (b) showLineage(k, b.dataset.label);
  }
  wireCharts();
}

function showLineage(key, label) {
  var el = document.getElementById("lineage");
  if (!el) return;
  if (openSrc === key) { closeLineage(); return; }
  openSrc = key;
  var L = LINEAGE[key](picked(), curMonths());
  el.innerHTML = '<h4>' + esc(label) + ' — 这个数字怎么来的' +
    '<button class="close" type="button" id="linClose">关闭</button></h4><div class="lgrid">' +
    '<div class="lbox"><span class="lk">公式</span><span class="lv">' + esc(L.formula) + '</span></div>' +
    '<div class="lbox"><span class="lk">来源表</span><span class="lv">' + esc(L.tables) + '</span></div>' +
    '<div class="lbox"><span class="lk">筛选条件</span><span class="lv">' + esc(L.filters) + '</span></div>' +
    '</div>' + (L.note ? '<p class="muted" style="margin:0 0 11px">' + esc(L.note) + '</p>' : "") + L.html;
  el.hidden = false;
  var cb = document.getElementById("linClose");
  if (cb) cb.addEventListener("click", closeLineage);
  document.querySelectorAll(".src").forEach(function (b) {
    b.setAttribute("aria-expanded", b.dataset.src === key); });
}
function closeLineage() {
  openSrc = null;
  var el = document.getElementById("lineage");
  if (el) el.hidden = true;
  document.querySelectorAll(".src").forEach(function (b) { b.setAttribute("aria-expanded", "false"); });
}

function wireCharts() {
  document.querySelectorAll(".chartwrap").forEach(function (wrap) {
    var tip = wrap.querySelector(".tip");
    wrap.querySelectorAll(".hit").forEach(function (hit) {
      hit.addEventListener("mousemove", function (e) {
        var r = wrap.getBoundingClientRect();
        tip.textContent = hit.dataset.t;
        tip.hidden = false;
        var x = e.clientX - r.left + 12;
        if (x + 190 > r.width) x = Math.max(0, e.clientX - r.left - 190);
        tip.style.left = x + "px";
        tip.style.top = Math.max(0, e.clientY - r.top - 52) + "px";
      });
      hit.addEventListener("mouseleave", function () { tip.hidden = true; });
    });
  });
}

function applyPreset(p) {
  var last = LASTFULL;
  if (p === "all") { range = { from: ALLM[0], to: ALLM[ALLM.length - 1] }; return; }
  if (p === "ytd") { range = { from: last.slice(0, 4) + "-01", to: last }; return; }
  if (p === "ly") {
    var y = String(+last.slice(0, 4) - 1);
    range = { from: y + "-01", to: y + "-12" };
    if (range.from < ALLM[0]) range.from = ALLM[0];
    return;
  }
  range = { from: shift(last, -(+p - 1)), to: last };
  if (range.from < ALLM[0]) range.from = ALLM[0];
}

document.getElementById("cFilters").addEventListener("click", function (e) {
  var b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.quick === "all") LIVE.forEach(function (c) { sel.add(c.short); });
  else if (b.dataset.quick === "none") sel.clear();
  else if (b.dataset.quick === "active") {
    sel.clear();
    LIVE.forEach(function (c) { if (c.tier === "active") sel.add(c.short); });
  } else if (b.dataset.co) {
    if (sel.has(b.dataset.co)) sel.delete(b.dataset.co); else sel.add(b.dataset.co);
  } else return;
  renderControls(); render();
});
document.getElementById("cRange").addEventListener("click", function (e) {
  var b = e.target.closest("button[data-preset]");
  if (!b) return;
  applyPreset(b.dataset.preset);
  renderControls(); render();
});
document.getElementById("cRange").addEventListener("change", function (e) {
  if (e.target.id === "fromSel") range.from = e.target.value;
  else if (e.target.id === "toSel") range.to = e.target.value;
  else return;
  if (range.from > range.to) {
    if (e.target.id === "fromSel") range.to = range.from; else range.from = range.to;
  }
  renderControls(); render();
});
document.getElementById("cCmp").addEventListener("click", function (e) {
  var b = e.target.closest("button");
  if (!b) return;
  if (b.id === "intToggle") excludeInternal = !excludeInternal;
  else if (b.dataset.cmp) cmpMode = b.dataset.cmp;
  else return;
  renderControls(); render();
});
document.getElementById("rail").addEventListener("click", function (e) {
  var b = e.target.closest("button[data-topic]");
  if (!b) return;
  topic = b.dataset.topic;
  closeLineage();
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
});
document.getElementById("view").addEventListener("click", function (e) {
  var s = e.target.closest(".src");
  if (s) { showLineage(s.dataset.src, s.dataset.label); return; }
  var en = e.target.closest("button[data-ent]");
  if (en) { pnlEntity = en.dataset.ent; openFig = null; render(); return; }
  var lv = e.target.closest("button[data-lvl]");
  if (lv) { pnlLevel = Number(lv.dataset.lvl); render(); return; }
  var fg = e.target.closest("td.fig");
  if (fg) {
    var f = { line: fg.dataset.line, acc: fg.dataset.acc, ym: fg.dataset.ym };
    var same = openFig && openFig.line === f.line && openFig.acc === f.acc && openFig.ym === f.ym;
    openFig = same ? null : f;
    render();
    if (openFig) {
      var p = document.getElementById("figpanel");
      if (p) p.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    return;
  }
  if (e.target.closest("#figClose")) { openFig = null; render(); return; }
  var m = e.target.closest("button[data-more]");
  if (m) { ledState(m.dataset.more).limit += 100; render(); return; }
  var cf = e.target.closest("button[data-cfmore]");
  if (cf) { cfOpen[cf.dataset.cfmore] = !cfOpen[cf.dataset.cfmore]; render(); return; }
  var th = e.target.closest("th.sortable");
  if (th) {
    var st = ledState(th.dataset.led), col = +th.dataset.col;
    if (st.sort === col) st.dir = -st.dir; else { st.sort = col; st.dir = -1; }
    render();
    return;
  }
  var q = e.target.closest(".q");
  if (q) copyQ(q);
});
var searchTimer = null;
document.getElementById("view").addEventListener("input", function (e) {
  if (!e.target.matches("input[data-led]")) return;
  var key = e.target.dataset.led, val = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(function () {
    var st = ledState(key);
    st.q = val; st.limit = 60;
    render();
    var box = document.querySelector('input[data-led="' + key + '"]');
    if (box) { box.focus(); box.setSelectionRange(val.length, val.length); }
  }, 220);
});
function copyQ(btn) {
  var text = btn.dataset.q;
  var done = function () {
    btn.classList.add("copied");
    btn.querySelector(".qi").textContent = "✓";
    setTimeout(function () {
      btn.classList.remove("copied");
      btn.querySelector(".qi").textContent = "?";
    }, 1600);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, function () { legacy(text, done); });
  } else legacy(text, done);
}
function legacy(text, done) {
  try {
    var ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); document.body.removeChild(ta); done();
  } catch (e) { /* clipboard unavailable; text stays selectable by hand */ }
}

// ------------------------------------------------------------------ refresh
// Only the copy served by serve.mjs on this machine can reach SQL Server.
// Anywhere else the button explains what to run instead of failing silently.
var rfx = document.getElementById("rfx");
var refreshBtn = document.getElementById("refreshBtn");
var pollTimer = null;

function rfxShow(html) { rfx.innerHTML = html; rfx.hidden = false; }
function rfxClose() {
  rfx.hidden = true;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
function rfxHead(title) {
  return '<h4>' + esc(title) + '<button class="close" type="button" id="rfxClose">关闭</button></h4>';
}
function rfxBindClose() {
  var b = document.getElementById("rfxClose");
  if (b) b.addEventListener("click", rfxClose);
}

function showOfflineHelp() {
  rfxShow(rfxHead("这份页面连不到资料库") +
    '<p>你现在开的是<b>快照</b>，资料停在页首标示的时间。要读到最新的账目，' +
    '必须从那台装了 AutoCount 的电脑开这个页面。</p>' +
    '<p>在 <span class="mono">autocount-mcp</span> 资料夹执行：</p>' +
    '<code>node serve.mjs</code>' +
    '<p>然后开 <span class="mono">http://localhost:8787</span> —— 那边这颗按钮就会真的重跑查询。</p>');
  rfxBindClose();
}

function pollStatus() {
  fetch("/api/status", { cache: "no-store" }).then(function (r) { return r.json(); })
    .then(function (s) {
      var lines = (s.log || []).map(function (l) {
        return "<div>" + esc(l) + "</div>"; }).join("");
      if (s.running) {
        rfxShow(rfxHead("正在更新 · " + esc(s.step || "")) +
          '<p>正在重新查询 10 个账套，通常半分钟到一分钟。这个视窗可以关掉，更新会继续跑。</p>' +
          '<div class="rfxlog">' + lines + '</div>');
        rfxBindClose();
        return;
      }
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      refreshBtn.disabled = false;
      refreshBtn.textContent = "↻ 更新资料";
      if (s.error) {
        rfxShow(rfxHead("更新失败") + '<p>' + esc(s.error) + '</p>' +
          '<div class="rfxlog">' + lines + '</div>');
        rfxBindClose();
        return;
      }
      rfxShow(rfxHead("更新完成") +
        '<p>资料已重新抓取，页面即将重新载入。</p><div class="rfxlog">' + lines + '</div>');
      rfxBindClose();
      setTimeout(function () { location.reload(); }, 1200);
    })
    .catch(function () {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      refreshBtn.disabled = false;
      refreshBtn.textContent = "↻ 更新资料";
      showOfflineHelp();
    });
}

refreshBtn.addEventListener("click", function () {
  if (!window.__AUTOCOUNT_LOCAL__) { showOfflineHelp(); return; }
  refreshBtn.disabled = true;
  refreshBtn.textContent = "更新中…";
  rfxShow(rfxHead("正在更新") + '<p>启动中…</p>');
  rfxBindClose();
  fetch("/api/refresh", { method: "POST" })
    .then(function () {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(pollStatus, 1500);
      pollStatus();
    })
    .catch(function () {
      refreshBtn.disabled = false;
      refreshBtn.textContent = "↻ 更新资料";
      showOfflineHelp();
    });
});

document.getElementById("aiBtn").addEventListener("click", function () {
  topic = topic === "review" ? "overview" : "review";
  closeLineage();
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
});

renderControls();
render();
</script>
</body>
</html>
`;

writeFileSync(OUT, html, "utf8");
console.log("Wrote " + OUT + "  (" + Math.round(html.length / 1024) + " KB, " +
  liveCount + " companies, " + txnCount.toLocaleString() + " transactions)");
