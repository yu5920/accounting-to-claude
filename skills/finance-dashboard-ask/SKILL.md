---
name: finance-dashboard-ask
description: 用中文直接问公司的会计帐（营收、客户欠款、费用趋势、现金流），透过只读 MCP server 查真实帐本，不是查 dashboard 快照。也包含 MCP server 怎么挂载、重启后工具没出现怎么查。触发词：问帐 / 查帐 / 上个月营收 / 谁欠钱 / 客户欠款 / 费用多少 / 现金流 / 会计查询 / MCP 工具没出现 / 挂 MCP。
---

# 问 AutoCount 的帐

## 先确认你在哪条路线

```bash
node -e 'console.log(require("./dashboard-data.json").source)'   # 在 $DASH 里跑
```

| 输出 | 路线 |
|---|---|
| `file-import` | **汇出档**（Excel / CSV）—— 见下方「汇入路线」段 |
| `autocount-cloud-api` 或其他 | **直连**（API / 资料库） |

### 汇入路线用不了这个 skill

这个 skill 靠只读 MCP server 直接查会计软体。**汇出档路线没有连线可查** ——
资料是一份快照，不是活的帐。

汇入路线的使用者要看数字，就看 dashboard 本身（每个数字都能点开看到背后的分录），
或直接问关于 dashboard 上数字的问题。

---

## 先找到工作目录

这个 skill 里的 `$DASH` 和 `$MCP` 是变数，不是字面路径 —— 每个客户装的位置不一样。

```bash
DASH=$(dirname "$(find ~ -name dashboard-data.json -not -path '*/node_modules/*' 2>/dev/null | head -1)")
MCP=$(cd "$DASH/../mcp-server" 2>/dev/null && pwd)
echo "dashboard: $DASH"; echo "mcp-server: $MCP"
```

找不到就代表还没建过 —— 改用 `finance-dashboard-setup` skill 从头做。
公司名、帐本、系统类型都记在 `$DASH/profile.json` 里。


公司的帐透过只读 MCP server
`autocount` 直接查真实帐本，**不是查 dashboard 的快照**。

先跑 `list_account_books` 看有哪几本帐；公司名和系统类型记在 `$DASH/profile.json`。

## ⚠️ 先读这段：算错的问法

下面三个陷阱在真实帐本上都踩过 〔实测案例：一家培训顾问公司 · AutoCount Cloud〕。
换一家公司细节会不同，但**类型一样**，问法照样要先验证再回答。

这本帐有三个陷阱，用错问法会得到**看起来很合理但是错的**答案。

### 「上个月营收多少？」不能直接加发票金额

三个原因叠加：

1. **月底跨期应计** —— 用 `2xxx 预收/押金科目` 做切割，月底认列、次日全额冲回
   （例：`JV-YYMM31-0006` 3/31 认列 128,400.00，`JV-YYMM02-0002` 4/2 冲回）。
   拿开票金额当营收，3~5 月每个月都错。
2. **含税金额** —— 明细行的 `localSubTotal` 含税，要用 `localSubTotalExTax`。
   601 条发票明细里 53 条不一样，而 `inclusiveTax` 在 listing 里**不返回**，没法逐条判断。
3. **有些发票行开在负债科目** —— `2xxx` 某代收代缴基金科目（代收代缴）、`TAX-xxxx` 某税务控制科目，
   那不是营收。所以「开票总额」永远大于「营收」。

**正确算法**：营收 = 过帐到 `AccType` 为 `SL` / `OI` / `SA` 的科目的净贷方，按 `docDate` 归月。
（`SA` = `REFUND Customer Refund`，是减项。）

先 `list_accounts` 拿科目分类，再据此归类。

### 「客户欠我们多少？」必须过滤作废发票

**作废发票会保留全额未清余额。** 实测 3 张已作废发票（customer change mind /
Sales cancelled / duplicate）保留共 **76,500** —— 不过滤会说欠 94,900，实际只有 18,400。

一律先 `.filter(r => !r.master.cancelled)`。

帐龄要用 **`dueDate`** 不是 `docDate`（差一个信用期）。到期日当天不算逾期。

### 「日记帐里有哪些交易？」≠ 全部分录

`list_journal_entries` 在这本帐**只返回手工日记帐**（journalType `GENERAL` / `D & A`），
不含发票、收付款自动过帐。要看完整总帐得把五类单据合起来。

## 14 个工具

| 工具 | 用途 |
|---|---|
| `list_account_books` | 有哪些帐本。**每次开始先跑这个** |
| `get_company_profile` | 公司抬头资料 |
| `list_accounts` | **科目表 + `accType` + `specialAccType`。算任何东西之前先拿这个** |
| `list_departments` | 部门（⚠️ 这本帐 `deptNo` 全空，做不了分部门分析） |
| `list_invoices` | 销售发票（含 `dueDate` / `cancelled` / `outstandingAmount` / 明细行 `accNo`） |
| `get_invoice` | 单张发票全文 |
| `list_purchase_invoices` | 采购发票（这本帐很少，成本多半直接记在付款单上） |
| `list_credit_notes` | 贷记单（冲减营收） |
| `list_payments` | 收付款（CashBookEntry），`docType` `OR`=收 / `PV`=付 |
| `list_journal_entries` | 手工日记帐（见上面警告） |
| `get_journal_entry` | 单张日记帐全文 |
| `list_debtors` / `list_creditors` | 客户 / 供应商 |
| `get_outstanding_transactions` | 某控制科目在某日的未清项目 |

科目分类速查：`SL`/`OI` 收入、`SA` 营收减项、`CO` 销货成本、`EP` 营业费用、
`CL` 流动负债、`SBK`/`SCH` 银行/现金（`specialAccType`）。

银行户：跑 `list_accounts` 后筛 `specialAccType` 为 `SBK`（银行）或 `SCH`（现金）的科目 —— **每家公司的科目号和户名都不一样，不要写死**。

## 常见问法 → 正确做法

| 问题 | 做法 |
|---|---|
| 上个月营收 | `list_accounts` + `list_invoices` + `list_journal_entries` + `list_credit_notes`，取 `SL`/`OI`/`SA` 净贷方，用 ex-tax 金额 |
| 谁欠最多钱 | `list_invoices` 全区间 → 滤掉 `cancelled` → `outstandingAmount > 0` → 按 `debtorCode` 汇总 |
| 逾期多久 | `today − dueDate`，当天 = 0 天 = 未逾期 |
| 某项费用趋势 | `list_payments` + `list_purchase_invoices`，按明细行 `accNo` 归类，`EP`/`CO` |
| 现金流 | `list_payments`，银行侧看 `paymentDetails[].paymentMethod` 映射到银行科目，对方科目看 `details[].accNo` |
| 银行**余额** | ❌ 做不到。API 没有余额端点，期初余额未知。只能讲「变动」 |
| 分部门毛利 | ❌ 做不到。`deptNo` 全空。**不要按营收比例分摊** —— 那会让每个部门毛利率必然等于公司整体，一张看起来精确但什么都没说的表 |

## 挂载 / 排查

设定档 `/Users/yu/Documents/testing- autocount cloud/.mcp.json`：

```json
{ "mcpServers": { "autocount": {
    "command": "node",
    "args": ["$MCP/cloud-index.js"]
} } }
```

**凭证不在这里** —— `cloud-index.js` 自己读隔壁的 `.env`，所以设定档可以安全分享。

### 工具没出现

1. **要完全退出 Claude 再开**，关视窗不算 —— 设定只在启动时读一次。这是最常见原因。
2. 手动验证 server 起不起得来：
   ```bash
   cd "$MCP" && node cloud-selftest.mjs
   ```
   guard 那半不需要凭证也不碰网络。**出现任何 `ALLOWED` 就停，不准接真帐。**
3. `.env` 里 `ACCT_CLOUD_KEY_ID` / `ACCT_CLOUD_API_KEY` / `ACCT_CLOUD_BOOKS` 有没有填。

### 回 403

那个方法没在 API Key 的权限清单里开。去 AutoCount Cloud → Settings → API Keys 开对应的
**Get / Listing** 方法。⚠️ **只开读的，Create / Update / Delete / Void 一个都不要开** ——
API Key 的权限是这条路唯一的只读边界，而 AutoCount 建 key 时预设是 All Permissions。

注意 `account/listing` 是 **POST** 的读端点（filter 太大塞不进 query string），
所以「只开 GET」会把科目表锁在外面。

## 安全

`cloud-api.js` 有 32 条读端点白名单，任何非白名单的 method + path 组合会被 `GuardError` 挡下，
**碰不到网络**。程式码里根本不存在指向 `/void`、`DELETE`、`PUT`、create 的路径。
这是第二层防线；第一层是 API Key 的权限设定。
