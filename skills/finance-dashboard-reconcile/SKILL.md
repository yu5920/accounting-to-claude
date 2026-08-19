---
name: finance-dashboard-reconcile
description: 把 dashboard 的数字，跟会计软体自己出的 Profit & Loss Statement 和 Trial Balance 逐行对帐验证，确认重构的总帐没算错。每次改动取数逻辑、换月份、或数字看起来怪的时候都要跑。触发词：对帐 / 对数 / 核对 / 验证数字 / reconcile / cross check / P&L 对不上 / 数字不对 / dashboard 数字怪怪的。
---

# AutoCount Cloud 对帐验证

## 先找到工作目录

这个 skill 里的 `$DASH` 和 `$MCP` 是变数，不是字面路径 —— 每个客户装的位置不一样。

```bash
DASH=$(dirname "$(find ~ -name dashboard-data.json -not -path '*/node_modules/*' 2>/dev/null | head -1)")
MCP=$(cd "$DASH/../mcp-server" 2>/dev/null && pwd)
echo "dashboard: $DASH"; echo "mcp-server: $MCP"
```

找不到就代表还没建过 —— 改用 `finance-dashboard-setup` skill 从头做。
公司名、帐本、系统类型都记在 `$DASH/profile.json` 里。


dashboard 的数字**不是**从会计软体的报表来的，是从 API 抓单据自己重构总帐算出来的。
AutoCount Cloud **没有 ledger 端点**，所以没有捷径 —— 只能拿它自己出的 P&L 来验。

**这一步不能省。** 算错的 dashboard 照样画得漂漂亮亮，不会报错。

## 档案位置

工作目录 `$PROJ`：

| 路径 | 内容 |
|---|---|
| `assets/dashboard/build-data-cloud.mjs` | 从 API 重构总帐 → `dashboard-data.json` |
| `assets/dashboard/reconciliation.md` | 对帐表（每次跑重新生成，已 gitignore） |
| `assets/mcp-server/cloud-api.js` | 只读 HTTP 客户端，32 条读端点白名单 |
| `assets/mcp-server/.env` | 凭证（gitignore，**不要贴进聊天**） |

## 铁律：先预测，再验证

**不准先看 AutoCount 的数字再调参数。** 那样对上了也证明不了什么 —— 只是把自己的
数字调成跟对方一样。正确顺序：

1. 先算出我方数字
2. **先说出预期 AutoCount 会显示多少**，以及任何已知差异的来源和金额
3. 才去看 AutoCount
4. 对上 → 差异已被解释；对不上 → 差额指向真问题

**也不准用同一个月调参数再验证。** 至少留一个月完全没碰过的当独立验证点。

## 步骤

### 1. 重跑管线

```bash
cd "$DASH"
node build-data-cloud.mjs --refresh     # 不加 --refresh 会用 cloud-cache/ 的快取
node render-dashboard.mjs
node headless-check.mjs
```

`headless-check.mjs` 抓的是「页面照常画出来、数字已经错了」这种故障，必须过。
单一帐本时「entity tab switches statement」会 SKIP，那是正常的，**SKIP 不等于 PASS**。

### 2. 先扫已知会造成差异的科目

跑对帐前先检查这几类科目当月有没有动静，**避免浪费一轮来回**：

| AccType | 说明 | 处理 |
|---|---|---|
| `SA` | Sales Adjustment（客户退款 `REFUND`） | **算进营收当减项** —— AutoCount 的 P&L 也这样放 |
| `TX` | Taxation | 不进营业损益 |
| `CL` | 开在销售发票行上的负债科目（`2700 HRDF FUND`、`SST-4030`） | **不是营收**，但会造成「开票总额 ≠ 营收」 |

### 3. 出 AutoCount 的 P&L

AutoCount Cloud 网页版 → **Reports → Financial Report → Profit & Loss Statement**，
日期区间设该月 1 日至月底。

### 4. 对三个数

营收、成本、净利。**要对到分**，不是「差不多」。

对上 → 收工。对不上 → 进下面的排查。

## 余额也要对 —— 对试算表，不是 P&L

现金和负债余额**不是从 API 读的**（API 根本没有余额端点，整份 spec 里唯一跟 balance
有关的是 `product/balancequantity`，那是存货数量）。它们是**从开帐累加所有分录算出来的**。

这只在「抓取起点早于帐本第一笔交易」时才成立。`build-data-cloud.mjs` 会自己检查
（`windowCoversInception`）：

- 成立 → 算出真实余额，`limitations` 说明是累加来的
- 不成立 → `cashAccounts` 留空，只报「期间变动」，并提示要调大 `MONTHS`

〔实测案例：一家培训顾问公司 · AutoCount Cloud〕第一笔是 `JV-000001`（2025-01-25 Paid Up Capital），
抓取从 2023-08 开始，所以期初确实是 0。**每家公司都要各自确认，不能套用。**

**对法**：AutoCount Cloud → Reports → Financial Report → **Trial Balance**（或 Balance Sheet），
日期设到今天，比对 `1101`~`1105` 五个银行现金科目。

⚠️ 银行户出现**负余额**不一定是程式错。〔实测案例：一家培训顾问公司 · AutoCount Cloud〕的 `11xx 某银行户` 是 −6,300，
因为那个户从开帐到现在**只有一笔付款**（2025-02-28 付 某关联公司 6,300），
帐上从来没有钱进去过。AutoCount 的试算表会显示同样的数字。
遇到负余额先查该户的完整 movement 再下结论。

## ⚠️ 排查：已经踩过的坑，先查这几个

下面每一条都是在真实帐本上撞到的。**科目号和金额是那家公司的，别照抄** ——
要看的是「差额长什么样 → 对应哪一类原因」。



差额通常不是随机的。按顺序对号入座：

### 差额恰好等于某张单的税额 → 金额字段用错

**这个坑踩过一次，差 612.50。**

`localSubTotal` 是**含税**金额，税额属于税务控制科目，永远不该进营收。
一律用 **`localSubTotalExTax`**（fallback 到 `localSubTotal`）。

⚠️ **`inclusiveTax` 字段在 listing 端点根本不返回**（永远是 `undefined`），
所以没办法逐条判断哪些行含税 —— 只能全部用 ex-tax 字段。

同一本帐里两张贷记单税制可以不同：`CN-000006` 的 subTotal 是不含税的 99，
`CN-YYMM-01` 的是含税的 10,000。

`build-data-cloud.mjs` 里的 `lineAmount()` 就是干这个的。收付款单（CashBookEntry）
的 `localAmount` 不受影响，实测 3,965 行零差异。

### AR 虚高好几倍 → 作废发票仍带未清余额

**〔实测案例：一家培训顾问公司 · AutoCount Cloud〕：3 张已作废发票保留全额未清共 76,500**（customer change mind /
Sales cancelled / duplicate）。不过滤 `cancelled` 的话 AR 会显示 94,900 而不是真实的 18,400。

所有单据一律先过 `.filter(r => !r.master.cancelled)`。

### 某几个月营收忽高忽低 → 跨月收入应计 + 次日冲回

〔实测案例：一家培训顾问公司 · AutoCount Cloud〕用 **`2xxx 预收/押金科目`** 做月底切割：

```
JV-YYMM31-0006  3/31  Dr 2301  128,400.00 / Cr 4101,4201,4401   ← 跨月课程收入拉进 3 月
JV-YYMM02-0002   4/2  完全反向冲回                                ← 4 月初冲掉
```

**不要拿开票金额当营收** —— 3~5 月每个月都会错。正确算法是「过帐到 `SL`/`OI`/`SA`
科目的净贷方，按 docDate 归月」，应计和冲回会自动落在对的月份。

### 营收整体偏高一倍 → journalentry 重复计算

`/journalentry` 在〔实测案例：一家培训顾问公司 · AutoCount Cloud〕只返回**手工日记帐**（journalType `GENERAL` / `D & A`），
不含发票自动过帐，所以总帐用「发票 + 采购发票 + 贷记单 + 收付款 + 日记帐」拼起来不会重复。

⚠️ **换一本帐本时必须重验这一点**。跑 `node cloud-probe.mjs`，看 Q1 VERDICT。
如果那本帐的 journalentry 也含单据过帐，每一笔销售都会算两遍，而图照样画。

### 开票总额 ≠ 营收

正常，不是错。差额是开在负债科目上的发票行（HRDF 代收代缴、SST）。
`build-data-cloud.mjs` 会把它算出来放进 `limitations`。

## 成本分类（变动 vs 固定）也会算错

`cost-rules.json` 的规则是**由上往下、第一个命中生效**，所以一条宽松的关键字会盖掉后面所有更精确的。

**实测踩过**：`keyword: "TRAINING"`（本意抓「员工培训」这类营运费用）先命中了
`5601 Course - Training Space`（236,800，AccType `CO`），把课程场地费算成**固定成本**。
连同 `5P01-T011` 和 `5707` 共 255,100 归错边，损益两平营收因此从 3,180,400 被高估成 3,297,600。

已修：在 `TRAINING` 之前加了 `TRAINING SPACE` / `TRAINING VENUE` → `V_deliver`。

### ⚠️ 关键字是**子字串**比对，短词会大规模误伤

`"OT"` 会命中 `Other`、`Promotion`、`Promotional`、`Total`。
`"TRAINING"` 会命中 `Training Space`。**加规则前先算一次会改到哪些科目**，
不要只看想抓的那几个：

```bash
cd "$DASH" && node -e '
const j=JSON.parse(require("fs").readFileSync("cost-rules.json","utf8"));
const c=JSON.parse(require("fs").readFileSync("dashboard-data.json","utf8")).companies[0];
const b=(rules,acc,nm,typ)=>{for(const r of rules){if(r.acc&&String(r.acc).toUpperCase()===acc.toUpperCase())return r.bucket;if(r.keyword&&nm.toUpperCase().includes(String(r.keyword).toUpperCase()))return r.bucket;}return j.fallback[typ]||"?";};
for(const e of c.expenses) console.log(e.acc.padEnd(12)+b(j.rules,e.acc,e.name,e.type).padEnd(11)+e.name);'
```

### 员工成本不该因为部门名而变成变动成本

`Marketing Department Staff Salary` 命中 `MARKETING` → 被算成变动获客成本。
但薪资不管开几班都要发，是固定成本。**修法是把员工成本关键字整组排到最前面**
（薪资 / EPF / SOCSO / 花红 / 津贴…），让它盖过部门名关键字。

〔实测：这一改让 9 个 Marketing 员工成本科目从变动转固定，
V 从 1,894,300 降到 1,655,800，损益两平营收从 3,180,400 变成 3,281,900。〕

**检查方法**：拿 `AccType=CO`（销货成本）却被分到 `F_*` 的科目出来看 —— CO 照定义就该随量变动，
落在固定桶通常代表被某条关键字误伤。

## 已知边界（不是 bug，不用查）

| 项目 | 状况 |
|---|---|
| 银行**余额** | 可以算，但是**累加出来的**不是 API 读的 → 必须对试算表验证。抓取起点若晚于开帐日则自动留空 |
| 分部门损益 | `deptNo` 在发票 / 收付款 / 日记帐全空 → 做不了。**不要按营收比例分摊**，那会让每个部门毛利率必然等于公司整体 |
| AP 帐龄 | 空的 —— 3,523 笔收付款 vs 12 张采购发票，成本直接记在付款单上 |
| 帐龄起算 | 只涵盖 `START` 之后开立的发票，更早还没清的看不到 |

## 收工

对帐通过后更新 `reconciliation.md`，写明：核对的月份、AutoCount 的数字、我方数字、
差异、以及**这次有没有改过算法**。改过算法的话，下次要用一个没碰过的月份重验。
