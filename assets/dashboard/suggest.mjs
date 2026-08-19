// Looks at what THIS company's books actually contain, and reports which extra
// dashboard topics the data can genuinely support.
//
//   node suggest.mjs
//
// The point is to suggest from evidence rather than from a checklist. Every
// finding carries the numbers behind it, so the person choosing can see why it
// is being offered - and anything the data cannot support is reported as
// unavailable WITH the reason, never quietly dropped. A boss deciding not to
// add a topic should be deciding, not left unaware it existed.
import { readFileSync, existsSync } from "node:fs";

if (!existsSync("dashboard-data.json")) {
  console.error("找不到 dashboard-data.json —— 先跑 build-data-cloud.mjs");
  process.exit(2);
}
const data = JSON.parse(readFileSync("dashboard-data.json", "utf8"));
const pmap = existsSync("project-map.json")
  ? JSON.parse(readFileSync("project-map.json", "utf8")) : { companies: {} };

const rm = (n) => Math.round(n).toLocaleString();
const pct = (n) => (n * 100).toFixed(1) + "%";
const out = [];
const add = (o) => out.push(o);

for (const c of (data.companies || []).filter((x) => !x.failed)) {
  const tag = (data.companies.length > 1 ? c.short + ": " : "");
  const months = (c.pnlByMonth || []).length;
  const rev = (c.revenueAccounts || []).reduce((s, r) => s + r.total, 0);
  const cost = (c.expenses || []).reduce((s, r) => s + r.total, 0);

  // ---- 1. product / project margin -------------------------------------
  const mapped = Object.keys((pmap.companies || {})[c.short] || {}).length > 0;
  const revAccts = (c.revenueAccounts || []).filter((r) => Math.abs(r.total) > rev * 0.01);
  if (!mapped && revAccts.length >= 2) {
    add({ id: "product-gp", ok: true, title: tag + "分产品 / 分服务线看毛利",
      why: "营收分散在 " + revAccts.length + " 个科目，可以切成产品线分别看。",
      evidence: revAccts.slice(0, 4).map((r) => r.acc + " " + r.name + " " + rm(r.total)).join("；"),
      how: "用 finance-dashboard-product-gp skill 设定 project-map.json" });
  }

  // ---- 2. department -----------------------------------------------------
  // Needs deptNo actually filled on transactions, not merely a department list
  // to exist. Counted from the data rather than assumed.
  const dc = c.deptCoverage;
  if (!dc) {
    add({ id: "dept", ok: false, title: tag + "分部门损益",
      why: "这份资料没有记录部门栏位的填写率，无法判断。",
      evidence: "dashboard-data.json 里没有 deptCoverage —— 请重跑 build-data-cloud.mjs。",
      how: "重跑后再看这一项。" });
  } else if (dc.share >= 0.5) {
    add({ id: "dept", ok: true, title: tag + "分部门损益",
      why: "交易上的部门栏位填得够完整（" + pct(dc.share) + "），可以按部门拆损益。",
      evidence: dc.filled + " / " + dc.lines + " 笔明细有填 deptNo",
      how: "把 deptNo 拉进 build-data-cloud 的分组，加「各部门 P&L」主题。" });
  } else if (dc.filled > 0) {
    add({ id: "dept", ok: false, title: tag + "分部门损益",
      why: "部门栏位只填了 " + pct(dc.share) + "，做出来会以偏概全。",
      evidence: dc.filled + " / " + dc.lines + " 笔明细有填 deptNo",
      how: "填写率拉到五成以上才有意义。要不要做，看你愿不愿意补填历史资料。" });
  } else {
    add({ id: "dept", ok: false, title: tag + "分部门损益",
      why: "交易上完全没填部门栏位，所以做不了。",
      evidence: "0 / " + dc.lines + " 笔明细有填 deptNo",
      how: "要做的话，得从今天起在会计软体开单时填部门，累积几个月后才有资料。" });
  }

  // ---- 3. AR collection efficiency ---------------------------------------
  const ar = c.ar || {};
  if (ar.total > 0) {
    const overdueShare = ar.total ? ar.overdue / ar.total : 0;
    add({ id: "ar-chase", ok: true, title: tag + "催收清单 / 收款效率",
      why: "有未清应收，其中 " + pct(overdueShare) + " 已逾期。",
      evidence: "未清 " + rm(ar.total) + "，逾期 " + rm(ar.overdue) +
                "（90 天以上 " + rm(ar.over90 || 0) + "）",
      how: "加一个按客户排序的催收表 + DSO 趋势。资料已经在 openInvoices 里。" });
  } else {
    add({ id: "ar-chase", ok: false, title: tag + "催收清单",
      why: "目前没有未清应收，做出来会是空表。", evidence: "AR 未清 0。",
      how: "等有欠款再加。" });
  }

  // ---- 4. customer concentration ----------------------------------------
  const cust = (c.customers || []).slice().sort((a, b) => b.total - a.total);
  if (cust.length >= 3) {
    const top = cust[0], totC = cust.reduce((s, x) => s + x.total, 0);
    const share = totC ? top.total / totC : 0;
    add({ id: "concentration", ok: true, title: tag + "客户集中度 / 流失预警",
      why: share > 0.2
        ? "最大客户占 " + pct(share) + " 的开票，集中度值得盯。"
        : "有 " + cust.length + " 个客户，可以看谁在成长、谁停单了。",
      evidence: "最大客户 " + rm(top.total) + "（" + pct(share) + "），共 " + cust.length + " 个客户",
      how: "加「前 10 大客户逐月」+「上季有单、这季没单」两张表。" });
  }

  // ---- 5. seasonality ----------------------------------------------------
  if (months >= 12) {
    const rs = c.pnlByMonth.map((m) => m.rev).filter((v) => v > 0);
    const avg = rs.reduce((s, v) => s + v, 0) / (rs.length || 1);
    const hi = Math.max(...rs), lo = Math.min(...rs);
    if (avg && hi / (lo || 1) >= 2) {
      add({ id: "seasonality", ok: true, title: tag + "淡旺季 / 现金跑道预警",
        why: "月营收落差很大（最高 " + rm(hi) + "、最低 " + rm(lo) + "），淡季现金压力值得先看到。",
        evidence: months + " 个月，平均 " + rm(avg),
        how: "加「月营收 vs 固定成本」叠图，标出入不敷出的月份。" });
    }
  }

  // ---- 6. AP -------------------------------------------------------------
  const apDocs = (c.apDocs || []).length;
  if (apDocs === 0) {
    add({ id: "ap", ok: false, title: tag + "应付帐款 / 供应商帐龄",
      why: "没有采购发票 —— 成本是直接记在付款单上的，所以没有「欠供应商多少」这件事可算。",
      evidence: "采购发票 0 张。",
      how: "要看应付，得改成先开采购发票再付款。这是记帐流程的改变，不是报表问题。" });
  } else if (((c.ap || {}).total || 0) > 0) {
    add({ id: "ap", ok: true, title: tag + "供应商帐龄 / 付款排程",
      why: "有 " + apDocs + " 张采购发票且有未付余额，可以看该付谁、什么时候付。",
      evidence: "AP 未清 " + rm(c.ap.total) + "，逾期 " + rm(c.ap.overdue || 0),
      how: "加供应商帐龄表 + 未来 30/60 天应付排程。" });
  } else {
    add({ id: "ap", ok: false, title: tag + "供应商帐龄 / 付款排程",
      why: "有 " + apDocs + " 张采购发票，但全部已付清，帐龄表会是空的。",
      evidence: "采购发票 " + apDocs + " 张，AP 未清 0。",
      how: "等有未付款项再加。" });
  }

  // ---- 7. bank accounts that look wrong ---------------------------------
  const neg = (c.cashAccounts || []).filter((a) => a.bal < 0);
  if (neg.length) {
    add({ id: "bank-negative", ok: true, title: tag + "⚠ 银行户负余额，值得查",
      why: "有银行户在帐上是负的。可能是透支，也可能是有笔入帐没记。",
      evidence: neg.map((a) => a.acc + " " + a.name + " " + rm(a.bal)).join("；"),
      how: "这不是加主题，是请会计核对那个户口的完整流水。" });
  }

  // ---- 8. cost attribution headroom -------------------------------------
  if (mapped) {
    const cfg = pmap.companies[c.short] || {};
    const mappedCost = Object.keys(cfg.cost || {});
    const direct = (c.expenses || [])
      .filter((e) => mappedCost.indexOf(e.acc) !== -1).reduce((s, e) => s + e.total, 0);
    const share = cost ? direct / cost : 0;
    if (share < 0.5) {
      add({ id: "attribution", ok: true, title: tag + "提高成本归属比例",
        why: "只有 " + pct(share) + " 的成本能直接归到产品线，其余是共用的。" +
             "这个比例就是产品毛利表可信度的上限。",
        evidence: "直接归属 " + rm(direct) + " / 总成本 " + rm(cost),
        how: "把大额共用科目拆细，或在会计软体开单时就分科目。" });
    }
  }

  // ---- 9. billings vs revenue gap ---------------------------------------
  const billed = (c.billingsByMonth || []).reduce((s, m) => s + m.amt, 0);
  if (billed && Math.abs(billed - rev) / billed > 0.01) {
    add({ id: "billing-gap", ok: true, title: tag + "开票 vs 营收差异说明",
      why: "开票总额和确认营收差 " + rm(billed - rev) + "，老板看到两个数字会问。",
      evidence: "开票 " + rm(billed) + "，营收 " + rm(rev),
      how: "加一张桥接表：开票 → 扣代收代缴 / 递延 → 营收。" });
  }

  // ---- 10. locked-in future revenue -------------------------------------
  const deferred = (c.liabilities || []).filter((l) => l.isDeferred);
  if (deferred.length) {
    add({ id: "backlog", ok: true, title: tag + "已收未交付（未来已锁定收入）",
      why: "有预收/押金性质的负债科目，代表钱收了、服务还没交付。老板通常最在意这个。",
      evidence: deferred.map((l) => l.acc + " " + l.name + " " + rm(l.bal)).join("；"),
      how: "加「已锁定收入」卡片 + 预计交付月份分布。" });
  }
}

// ------------------------------------------------------------------ report
const yes = out.filter((o) => o.ok), no = out.filter((o) => !o.ok);
console.log("=== 这套帐目前『做得到』的加值项目 (" + yes.length + ") ===");
yes.forEach((o, i) => {
  console.log("\n" + (i + 1) + ". " + o.title + "   [" + o.id + "]");
  console.log("   为什么: " + o.why);
  console.log("   证据:   " + o.evidence);
  console.log("   怎么做: " + o.how);
});
console.log("\n\n=== 做不到的 (" + no.length + ")，原因要讲给使用者听，不要静默略过 ===");
no.forEach((o) => {
  console.log("\n· " + o.title + "   [" + o.id + "]");
  console.log("   做不到: " + o.why);
  console.log("   要能做: " + o.how);
});
console.log("\n提示：把上面每一项做成 AskUserQuestion 的选项让使用者挑，一次问一题。");
