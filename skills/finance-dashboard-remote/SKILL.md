---
name: finance-dashboard-remote
description: 把只读会计 MCP 架成一台可以远端连的 server，让团队各自在自己电脑的 Claude 问帐，不用 remote 进那台装了会计软体的机器。含权杖验证、内网设定、以及「开放读取」这件事的代价。触发词：远端 / remote / MCP server / 架 server / 一次设定大家都能用 / 不用 remote desktop / 团队一起用 / 别台电脑连 / 共用 MCP。
---

# 远端只读 MCP Server

一台机器架起来，其他人在**自己电脑的 Claude** 问帐。

## ⚠️ 先确认你真的需要这个

多数情况**不需要**。先问清楚资料在哪：

| 资料来源 | 要架 server 吗 |
|---|---|
| **云端 API**（AutoCount Cloud 等） | ❌ **不用**。API 从哪都连得到 —— 每人在自己电脑装一份、填自己的 key 就好 |
| **本机资料库**（AutoCount 桌面版 / SQL Accounting） | ✅ 要。资料库只有那台机器碰得到 |
| **汇出档**（Excel） | ❌ 不用。档案传给谁谁就能跑 |

⚠️ 如果是云端 API 却在 remote desktop，那台机器上唯一特别的东西**只有 `.env` 里那两行凭证**。
帮每人各建一把只读 key 就解决了，五分钟，零基础设施。**先问，不要直接开始架。**

## ⚠️ 再确认要的是「问帐」还是「看数字」

| 需求 | 用什么 |
|---|---|
| 看 dashboard、点开看分录 | **`serve.mjs` 就够了**，一行指令，不用改任何程式 |
| 用中文问帐（「上个月哪个客户欠最多」） | 才需要这个 skill |

## 最重要的一段：白名单挡不住「读」

`cloud-api.js` 那 32 条读端点白名单挡的是**写入**。对**读取**它是刻意全开的 —— 读就是目的。

所以一旦上了网路，**任何连得到那个 port 的人都能读完整的帐**：营收、客户名、
银行流水、每一笔分录。

因此：

1. **权杖是唯一的门。** 没有权杖 `cloud-server.js` **拒绝启动**，这是刻意的。
2. **只绑内网。** 不要开到公网。要跨地点就用 Tailscale / ZeroTier / VPN，
   让专门做这件事的东西去管谁能连。
3. **一人一支权杖**，撤销就是删掉那一行然后重启。

## 架设

在**连得到资料的那台机器**上：

```bash
cd "$MCP" && node -e 'console.log(require("crypto").randomUUID())' >> server-tokens.txt
```

编辑 `server-tokens.txt`，在权杖后面加上使用者名字（**一人一行**）：

```
# <权杖>  <使用者>
2f9c8a41-...  Alice
7b1e0d93-...  Bob
```

```bash
chmod 600 server-tokens.txt && node cloud-server.js
```

启动后会印出内网位址，例如 `http://192.168.110.35:8899/mcp`。

⚠️ `server-tokens.txt` 已在 `.gitignore`。**不要提交、不要贴在群组里** ——
一支权杖等于一份完整帐本的读取权。

### 长期跑

跟 dashboard 刷新一样，Mac 用 launchd、Windows 用工作排程器。见 `finance-dashboard-refresh`。

## 使用者那边

在**他自己的电脑**，`.mcp.json` 里加：

```json
{
  "mcpServers": {
    "accounting": {
      "type": "http",
      "url": "http://192.168.110.35:8899/mcp",
      "headers": { "Authorization": "Bearer <他自己的权杖>" }
    }
  }
}
```

然后**完全退出 Claude 再开**（关视窗不算）。

之后就跟本机版一模一样 —— 同样 14 个工具、同样的读取白名单。
问法上的陷阱见 `finance-dashboard-ask`（那些坑跟连线方式无关）。

## 排查

| 症状 | 查什么 |
|---|---|
| `401` | 权杖错、或 `server-tokens.txt` 改了没重启 server |
| 连不上 | 防火墙挡了 8899；或使用者不在同一个内网 |
| 工具没出现 | 没有完全退出 Claude 重开 |
| server 起不来 | 没有权杖（刻意拒绝启动）；或 `.env` 没设 |

健康检查（不需要权杖，只回状态不回资料）：

```bash
curl -s http://<位址>:8899/health
```

server 会把每次连线和每次拒绝印在 log 上，**看得到谁在用**。

## 给学员的一句话

> 这台机器变成「帐本的只读窗口」。它改不了任何数字，但**读得到全部** ——
> 所以那支权杖要当成公司帐本的钥匙来管。

## 相关

- 怎么问帐、哪些问法会算错 → `finance-dashboard-ask`
- 只是要看 dashboard → `finance-dashboard-share`
- 排程长期跑 → `finance-dashboard-refresh`
