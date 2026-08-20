---
name: finance-dashboard-share
description: 把 dashboard 开给别人看 —— 本机 / 内网用 serve.mjs（预设做法），以及要传到外网时的加密路线和它的真实限制。触发词：分享 / 给老板看 / 开出来 / serve / 内网 / 局域网 / 让别人看 dashboard / 发布 / 部署 / Netlify / 加密。
---

# 分享 dashboard

## 先找到工作目录

这个 skill 里的 `$DASH` 和 `$MCP` 是变数，不是字面路径 —— 每个客户装的位置不一样。

```bash
DASH=$(dirname "$(find ~ -name dashboard-data.json -not -path '*/node_modules/*' 2>/dev/null | head -1)")
MCP=$(cd "$DASH/../mcp-server" 2>/dev/null && pwd)
echo "dashboard: $DASH"; echo "mcp-server: $MCP"
```

找不到就代表还没建过 —— 改用 `finance-dashboard-setup` skill 从头做。
公司名、帐本、系统类型都记在 `$DASH/profile.json` 里。


`dashboard.html` 是**单一自足档案**（约 1.2MB），双击就能开。分享方式按可控程度排序，
**预设走第一种**。

## 1. 本机 / 内网（预设做法）

```bash
cd "$DASH" && node serve.mjs
```

会印出两个网址：

```
AutoCount dashboard: http://localhost:8787
            内网:  http://192.168.0.150:8787
```

同一个 WiFi 的人开第二个网址就能看。换 port：`node serve.mjs 9000`。

用完 **Ctrl+C 关掉**。

### ⚠️ 这条路没有密码

`serve.mjs` 绑定所有网路介面（这正是内网能连的原因），而且**没有任何验证**。
同一个网路上的任何人只要知道网址就能看到公司完整财务 —— 营收、客户名、欠款、银行流水。

所以：

- 开会 / 给人看的时候才开，**看完就关**，不要长期挂着
- 不要在咖啡厅、机场、共享办公室的公共 WiFi 上开
- 需要长期挂着的话，那不是这条路该做的事

### 「更新资料」按钮

页面上的按钮会重跑 `build-data-cloud --refresh` → `render-dashboard` → `headless-check`，
所以别人看的时候可以自己拉最新数字，不用碰命令列。

⚠️ 这个按钮**只有从 `serve.mjs` 开的页面才有作用**。直接双击 `dashboard.html` 打开的话，
页面没有 server 可以呼叫，按钮会说明要先跑 `serve.mjs`（不会默默失败）。

⚠️ **原版 `serve.mjs` 的按钮是坏的**，已修正：它原本跑 `build-data.mjs`（SQL Server 版，
这台 Mac 没有资料库可连）和 `build-site.mjs --lock`（没给密码会拒绝执行）。

## 2. 直接传档案

`dashboard.html` 自足，用 AirDrop / email 传给对方，对方双击就能看。

代价：那是一份**快照**，不会更新，而且档案一旦传出去就完全脱离掌控 ——
收到的人可以随便转发。传之前先想清楚。

## 3. 加密后放公开静态站（要传外网才用）

老板/合伙人在外地也要随时看，才走这条。

```bash
cd "$DASH" && node build-site.mjs --lock --id <帐号> --pw <密码>
```

产出 `site/` 资料夹传 Netlify。资料和程式码用 AES-GCM 加密（PBKDF2-SHA256，310,000 次迭代）。

验证加密确实有效：

```bash
cd "$DASH" && node verify-lock.mjs <帐号> <密码>
```

会确认三件事：正确密码打得开、错误密码打不开、**没有明文外泄**。

### ⚠️ 这条路的真实限制，要跟老板讲清楚

**密文放在公开网址上，任何人都能下载回去慢慢爆破，想破多久就破多久。**
没有次数限制、没有锁定、没人会收到警报。强度**完全**取决于密码本身。

所以：

- 用长的、随机的密码，不要用公司名 + 年份那种
- 密码**不要**跟其他系统共用
- 换人了就重新产生一次（改密码 = 重跑 `--lock` 重新部署）
- 刻意没有预设帐密 —— `build-site.mjs` 不给 `--id`/`--pw` 会直接拒绝执行，
  因为写死在共用脚本里的密码，迟早会被某个忘记覆盖的人publish 出去

**这是真实公司的财务资料。曝险的问题要自己主动提出来让对方决定，不要等人问。**

## 千万不要做的事

| 不要 | 为什么 |
|---|---|
| 把 `dashboard.html` / `dashboard-data.json` / `site/` 提交进 git | 内含真实分录、银行流水、客户名。`.gitignore` 已排除，别手动加回去 |
| 不加密就丢上公开网址 | 完整财务资料对全网公开 |
| 把 `.env` 或 API key 放进任何输出 | `render-dashboard` 只嵌资料不嵌凭证，自己写发布步骤时要维持这点 |
| 在聊天/工单/共享文件里贴密码 | 贴过就当作已外泄，重新产生 |
