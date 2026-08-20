---
name: finance-dashboard-setup
description: 从零把一家公司的会计软体接成老板每天早上会打开的财务 dashboard —— 侦测电脑与会计系统（AutoCount 桌面版 / AutoCount Cloud / SQL Accounting / 其他）、只读连线、验证数字、出 dashboard、设定每日自动更新。全程一步一个选项弹出来让使用者选，不预设立场、不静默跳过。触发词：我要看我公司的帐 / 接会计软体 / 做财务 dashboard / connect accounting / 设定 dashboard / 从零开始 / 我的帐目 / 老板报表 / AutoCount 接 Claude / SQL Accounting 接 Claude。
---

# 会计软体 → 财务 Dashboard

把一家公司从「我们的帐在会计软体里」变成「老板每天早上打开一个网页就看得到」，
**而且全程不可能改到任何一个数字**。

## 你面对的人

预设对方是**老板或会计，不是工程师**。他可能：

- 不知道自己的资料库在哪台电脑、不知道什么是 SQL
- 没开过终端机 / 命令提示字元
- 分不清 AutoCount 桌面版和 AutoCount Cloud

所以：**不要丢命令给他自己跑，你自己跑**。要他做的事只有三种 ——
在会计软体网页上点东西、把档案放到某个资料夹、回答关于他家帐怎么记的问题。

## 铁律

1. **每一个决策点都用 AskUserQuestion 弹出选项**，不要用文字问、不要自己假设。
2. **能侦测的不要问**（作业系统、有没有装 Node、资料夹在哪）—— 问了显得笨。
   **不能侦测的一定要问**（帐怎么记的、哪本帐是活的）—— 猜了会算错。
3. **不准静默跳过任何一步。** 某一步做不了，就弹出选项告诉他做不了、代价是什么、
   要不要跳过。跳过必须是他知情后选的。
4. **数字没对帐过就不算完成。** 没验证的 dashboard 比没有 dashboard 更危险 ——
   它照样画得漂漂亮亮。
5. 讲话用对方的语言（多数是中文），术语第一次出现要解释。

---

## Step 0 前置 — 先问一句，再决定要不要往下走

**第一句就问：「你们的帐现在放在哪里？」**

答案是**「没有会计软体」/「只有会计给的报表」/「只有 Excel」** ——
**立刻转到 `finance-dashboard-import`，不要再问任何一题。**

不要问作业系统、不要问哪套软体、不要问资料库在哪、不要提 API。
那些对他一题都不适用，问了只会让他以为自己走错地方。
`finance-dashboard-import` 是完整入口，会自己处理安装。

有软体才继续往下。

## Step 0 — 先侦测，别问

自己跑，不要问他：

```bash
uname -s 2>/dev/null || echo Windows; node -v 2>/dev/null || echo "no-node"
```

- `Darwin` = Mac，`Linux` = Linux，其他 = Windows
- 记下有没有 Node.js，等一下 Step 3 用

## Step 1 — 他用什么会计软体

**用 AskUserQuestion 问**，选项要含「我不确定」：

| 选项 | 后续 |
|---|---|
| AutoCount 桌面版 / 伺服器版 (2.x) | 直连 SQL Server，**已验证** |
| AutoCount Cloud（浏览器登入） | 官方 REST API，**已验证** |
| SQL Accounting (eStream) | 直连 Firebird，**未验证** |
| 其他 / 我不确定 | 进下面的辨识流程 |

⚠️ **AutoCount 桌面版和 AutoCount Cloud 底下完全是两套东西**，名字像而已。
一个是本机 SQL Server，一个是厂商的 REST API。搞错整条路都白走。

### 「我不确定」怎么辨识

弹出选项问他：**你怎么打开你的会计软体？**

- 「桌面上有个图示，双击就开」→ 桌面版
- 「开浏览器登入一个网址」→ Cloud（请他念出网址）
- 「远端桌面连到公司另一台电脑，再双击图示」→ **hosted 桌面版**，
  资料库在那台远端 Windows 上，要装在那台机器

## Step 2 — 资料在哪台机器

这一题决定一切。**弹出选项问**：

| 情况 | 做法 |
|---|---|
| 就在这台电脑 | 直接装 |
| 在办公室另一台电脑/伺服器 | **必须装在那台机器上**，不是这台。请他改在那台开 Claude |
| 在厂商的云端（Cloud） | 这台电脑就可以，API 从哪都连得到 |
| 不知道 | 请他问帮他装 AutoCount 的经销商（dealer）—— 马来西亚多数装机都是经销商做的 |

## Step 3 — 前置检查（Node.js）

Step 0 已经知道有没有。**没有的话弹出选项**：

- **我帮你装**（Mac: Homebrew 或官网 pkg；Windows: 官网 MSI）—— 你跑指令，他只要点同意
- **我自己装** —— 给他 https://nodejs.org 的连结，装完回来说一声
- **这是什么？** —— 一句话解释：一个免费的程式执行环境，dashboard 靠它产生，不会动到帐

⚠️ Windows 装完要**重开终端机**环境变数才生效。Mac 用 Homebrew 装完同理。

## Step 4 — 建立只读连线

先把 `assets/` 整个资料夹複製到工作目录（预设 `~/FinanceDashboard`，Windows 是
`%USERPROFILE%\FinanceDashboard`），然后：

```bash
cd <工作目录>/mcp-server && npm install
```

### 路线 A：AutoCount Cloud（已验证）

读 `references/autocount-cloud-api.md`，重点：

1. 请他在 Cloud 网页版 **Settings → API Keys → Create API Key**
2. ⚠️ **权限一定要先全部取消，只开 Get / Listing**。AutoCount 预设给
   **All Permissions**，那把 key 能作废发票、删分录。
   **这是整件事唯一的只读边界**，比任何程式码都重要。
3. ⚠️ 「只开 GET」是**错的** —— `account/listing` 是 POST 的读端点，
   只开 GET 会把科目表锁在外面。要开的是那 11 类物件的 Get 和 Listing。
4. 请他把 Key ID / API Key / Account Book ID 填进 `mcp-server/.env`
   （複製 `.env.example`）。**不要叫他贴进聊天。**

### 路线 B：AutoCount 桌面版（已验证）

读 `references/autocount-desktop.md`。走 `mcp-server/index.js` + `sqlcmd`。
只有 Windows 能跑。

### 路线 C：SQL Accounting（未验证）

读 `references/sql-accounting-firebird.md`。走 Firebird `isql`。
**明白告诉他这条路没有在真实系统上验证过**，Step 5 的自测才是判准，不是你的信心。

### 路线 D：只有汇出档（没有会计软体 / 接不到）

**用 `finance-dashboard-import` skill**，那边有完整流程。

客户只要拿得出这几份就能做：总帐 GL、应收/应付明细帐、帐龄表（都要 **Excel/CSV**），
外加损益表和资产负债表（PDF 可以，只用来对帐）。

⚠️ **走这条路一定要问「账期几天」。** 帐龄表是按「距开票日几个月」分桶的，
没有到期日也没有信用期 —— 不知道账期就无法判断哪些是真的逾期。
账期 60 天却把「1 MONTH」当逾期，会让老板去催根本还没到期的客户。

## Step 5 — 验证连线（不可跳过）

```bash
node cloud-selftest.mjs        # 路线 A
node selftest.mjs              # 路线 B / C
```

- **Guard 那半不需要凭证也不碰网路**，可以先跑。
  **任何一项出现 `ALLOWED` 就停下来，不准接真帐。**
- Integrity 那半验：非 ASCII（中文客户名）往返、分页不丢行、空结果 ≠ 错误。
- ⚠️ **`SKIP` 不等于 `PASS`。** 跳过的检查要讲出来为什么跳过。

## Step 6 — 探测这本帐能给出什么

```bash
node cloud-probe.mjs           # 路线 A
```

它回答三件决定 dashboard 内容的事，**不要预设答案**：

1. **总帐能不能重建** —— `journalentry` 只有手工日记帐，还是也含发票自动过帐？
   猜错一边营收消失、猜错另一边营收翻倍，**两种都会画出漂亮的图**。
2. **科目有没有分类** —— `accType` 分收入/成本，`specialAccType` 认银行现金。
3. **帐龄能不能算** —— 要有 `outstandingAmount`、`cancelled`、`dueDate`。

探测完**弹出选项**把结果讲给他听：哪些主题做得到、哪些做不到、做不到的要不要
用替代方式（或直接留白）。

## Step 7 — 学这家公司的帐（最容易算错的一步）

先读 `references/accounting-pitfalls.md`。**每一个坑都会产生一个合理但错误的数字。**

然后**一题一题弹出选项问他**（这些不能推断，猜错就是自信地算错）：

1. **哪几本帐是活的？** 看每本最后一笔交易日期，别假设。休眠帐和测试帐很常见。
2. **收入什么时候确认？** 开票即确认，还是先进负债科目、交付后才转收入？
   （实测案例：某公司月底把跨期收入认列、次日全额冲回，
   拿开票金额当营收会让连续三个月都错。）
3. **有没有代收代缴？** 开在销售发票上但其实不是公司收入的（政府基金、代垫、税）。
   这会让「开票总额」永远大于「营收」—— 是正常的，但要标示出来。
4. **哪些付款方式算真实现金？** 客户押金、第三方钱包挂的常常不是银行户。
5. **成本有没有分产品/部门？** 早点问，答案通常是「没有」。
   ⚠️ **不要提议按营收比例分摊** —— 那在数学上必然让每个产品毛利率等于公司整体，
   一张看起来精确但没有资讯的表。

把答案写进 `dashboard/profile.json` 和 `project-map.json` 的 `_decisions`，
下次才知道当初为什么这样设。

## Step 8 — 出 dashboard，然后对帐

```bash
node build-data-cloud.mjs && node render-dashboard.mjs && node headless-check.mjs
```

**接着一定要对帐。** 请他从会计软体自己出一份 P&L（挑一个月），跟你的数字比。

⚠️ **先讲出你预期他会看到什么数字、以及已知差异从哪来，再让他去看。**
先看答案再调参数，对上了也证明不了什么。

对不上就查（这些都是实测踩过的）：

- 差额恰好等于某张单的税额 → 用了含税金额，该用 ex-tax 栏位
- AR 虚高好几倍 → 作废发票仍保留未清余额，没过滤 `cancelled`
- 某几个月忽高忽低 → 月底应计+次日冲回的跨期分录
- 营收整体翻倍 → `journalentry` 重複计算（Step 6 的 Q1 判断错了）

余额类（现金、负债）要对**试算表**不是 P&L —— 那些是从开帐累加出来的，
只有抓取起点早于开帐日才成立。

## Step 9 — 上线

**弹出选项问他要哪些**（可複选）：

| 选项 | 做法 |
|---|---|
| 每天自动更新 | Mac 用 launchd，Windows 用工作排程器。`daily-refresh.sh` 已含「验证失败就还原旧版」 |
| 内网给同事看 | `node serve.mjs`，⚠️ **没有密码保护**，同一 WiFi 的人都看得到 |
| 加密放公开网址 | `build-site.mjs --lock`，⚠️ 密文可被离线爆破，强度全靠密码 |
| 只有我自己看 | 双击 `dashboard.html` 就好，最单纯 |

## Step 10 — 交棒

把设定写进 `dashboard/profile.json`（`brand` / `system` / `books` / `groupHints`），
然后告诉他之后可以用这些：

| 想做什么 | 说 |
|---|---|
| 只有 Excel 汇出档 | 「我只有报表档，帮我做 dashboard」 |
| 用中文问帐 | 「上个月营收多少」「谁欠钱最多」 |
| 数字看起来怪 | 「帮我对帐」 |
| 更新数字 | 「刷新 dashboard」 |
| 加新主题 | 「我的 dashboard 还能加什么」 |
| 分产品看毛利 | 「分析产品」 |

最后**弹出选项**问他要不要现在就做下一件事，别自己结束对话。

---

## 已验证 vs 未验证

| 系统 | 状态 |
|---|---|
| AutoCount Cloud | **已验证** —— 真实 tenant，20 个月、9,349 笔重构分录，P&L 对帐分毫不差 |
| AutoCount 桌面版 2.x | **已验证** —— 21 本帐 / 约 32,000 笔 |
| SQL Accounting (Firebird) | 未验证，照文件写的 |
| 其他云端 / ERP | 未验证 |

**「未验证」要明白讲给使用者听**，然后让 Step 5 的自测决定行不行，不是让你的信心决定。

## 参考档

`references/` 里：`autocount-cloud-api.md`（Cloud API 实测）、`autocount-desktop.md`、
`sql-accounting-firebird.md`、`cloud-systems.md`、
**`accounting-pitfalls.md`（算任何东西之前必读）**、`dashboard.md`、`budget-3d.md`
