---
name: finance-dashboard-refresh
description: dashboard 的每日自动刷新 —— Mac 用 launchd、Windows 用工作排程器，看 log、刷新失败怎么定位、电脑关机错过了怎么补跑、快取什么时候该清。也用于手动重跑一次整条管线。触发词：刷新 / 重跑 / 更新 dashboard / 自动更新 / 排程 / launchd / 工作排程器 / 定时 / dashboard 没更新 / 数字还是旧的。
---

# Dashboard 每日刷新

## 先确认你在哪条路线

```bash
node -e 'console.log(require("./dashboard-data.json").source)'   # 在 $DASH 里跑
```

| 输出 | 路线 |
|---|---|
| `file-import` | **汇出档**（Excel / CSV）—— 见下方「汇入路线」段 |
| `autocount-cloud-api` 或其他 | **直连**（API / 资料库） |

### 汇入路线没有「自动刷新」

下面整篇讲的是直连路线的排程（launchd / 工作排程器）。
**汇出档路线用不上** —— 没有连线可以定时去抓。

汇入路线的更新方式就是**丢新档进来再跑一次**：

```bash
cd "$DASH" && node build-data-file.mjs /path/to/exports/ && node render-dashboard.mjs && node headless-check.mjs
```

新鲜度 = 上次汇出的日期，**不是今天**。这点要跟老板讲清楚，
不然他会以为看到的是即时数字。

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


刷新要跑在**连得到资料的那台机器**上：

- **云端 API 路线**（AutoCount Cloud 等）→ 从哪都连得到，跑在使用者自己的电脑就行
- **直连资料库路线**（AutoCount 桌面版 / SQL Accounting）→ **必须跑在资料库那台机器**，
  不能跑在别台。装错机器会每天安静地失败。

工作目录 `$DASH`

## 手动跑一次

```bash
cd "$DASH" && ./daily-refresh.sh
```

成功会印一行 `OK  <公司名> | N 个月 | 分录 N | AR 未清 N`。
（实测参考：一本 20 个月、9,349 笔分录的帐约 21 秒。）

## ⚠️ 最重要的设计：失败时保留旧版

`daily-refresh.sh` 跑三步：`build-data-cloud` → `render-dashboard` → `headless-check`。

**`headless-check` 不过，就把上一版 `dashboard.html` 换回去**，并以 exit code 1 结束。

理由：一张过期但已知正确的 dashboard，好过一张崭新但数字错的 —— **错的那张照样画得好好的，
没人会发现**。log 会写明是哪种情况。（这条还原路径实测过：强制让 check 失败，
`dashboard.html` 的 md5 与刷新前完全一致。）

## 装排程

⚠️ **先确认作业系统**，两边完全不同：

```bash
uname -s 2>/dev/null || echo Windows
```

### macOS — launchd

设定档范本在 `$DASH/com.<公司代号>.dashboard-refresh.plist`。没有的话就依这个格式产生一份，
把 `ProgramArguments` 的路径换成实际的 `$DASH/daily-refresh.sh`，
`StandardOutPath` / `StandardErrorPath` 换成 `$DASH/launchd.{out,err}.log`。

```bash
cp "$DASH"/com.*.dashboard-refresh.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/com.*.dashboard-refresh.plist
```

确认装上了：

```bash
launchctl list | grep dashboard-refresh
```

改时间就编辑 plist 里的 `Hour` / `Minute`，然后 `launchctl unload` 再 `load` 一次 ——
**改了不重载不会生效**。停掉就 `launchctl unload`。

**关机错过了不用管**：`StartCalendarInterval` 错过的工作，launchd 会在下次开机/唤醒时补跑一次。
plist 里 `RunAtLoad` 刻意设 `false` —— 补跑已涵盖关机情境，设 `true` 会变成每次登入都跑。

### Windows — 工作排程器

`daily-refresh.sh` 是 bash 脚本，Windows 上要嘛用 Git Bash 跑，要嘛改写成 `.bat`。
**建议直接产生一份 `.bat`**，内容就是依序跑那三个 node 指令，并保留「验证失败就还原旧版」的逻辑。

⚠️ **`.bat` 档必须是纯 ASCII。** `cmd` 用系统码页读它，非 ASCII 字元会让解析出错，
而且错法完全看不出原因 —— 实测遇过 `build-data.mjs` 被静默截断成 `d-data.mjs`。
中文讯息要放在 node 脚本里印，不要放进 `.bat`。

用 PowerShell 注册（每天 08:00）：

```powershell
$action  = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"C:\path\to\daily-refresh.bat`""
$trigger = New-ScheduledTaskTrigger -Daily -At "08:00"
Register-ScheduledTask -TaskName "Finance dashboard refresh" -Action $action -Trigger $trigger -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable)
```

**`-StartWhenAvailable` 一定要加** —— 它就是 Windows 版的「关机错过了会补跑」。

## 排查

### 「dashboard 数字还是旧的」

按顺序查：

1. **刷新到底有没有跑**
   ```bash
   tail -20 "$DASH/refresh-log.txt"
   ```
   看最后一次是 `OK` 还是 `FAILED`。

2. **是不是 `headless-check` 挡下来了** —— log 会写 `restoring previous dashboard`。
   手动跑 `node headless-check.mjs` 看是哪一项失败。
   ⚠️ 单一帐本时「entity tab switches statement」会 SKIP，那是正常的，**SKIP 不等于 PASS**。

3. **是不是看到快取** —— `daily-refresh.sh` 带 `--refresh`，会重抓。
   但如果你手动跑 `node build-data-cloud.mjs`（不带旗标），会读 `cloud-cache/` 的快取。

### 排程没跑 — macOS (launchd)

```bash
cat "$DASH/launchd.err.log"
```

最常见原因：**launchd 不继承你的 shell PATH**，所以 `node` 找不到。
脚本已经处理了（依序找 `command -v node`、Homebrew、`/usr/local/bin`、nvm），
但换了 node 安装方式的话可能要补路径。

其次是**磁碟存取权限** —— macOS 可能挡住 launchd 读 `~/Documents`。
系统设定 → 隐私权与安全性 → 完整磁碟取用权，把 `/bin/bash` 加进去。

### 排程没跑 — Windows (工作排程器)

工作排程器 → 找到那个工作 → 「上次执行结果」。常见原因：

- **`0x1`** → 脚本本身失败，看 `refresh-log.txt`
- **工作根本没跑** → 排程设定成「只在使用者登入时执行」，改成「不论使用者是否登入」
- **找不到 node** → `.bat` 里用 node 的完整路径，别依赖 PATH

### API 报 403

某个方法没在 API Key 权限清单里开。见 `finance-dashboard-ask` skill 的排查段。

## 快取

`cloud-cache/` 存的是 API 原始回应（已 gitignore，内含真实帐务资料）。

| 情况 | 要不要清 |
|---|---|
| 每日排程 | 不用，`--refresh` 会覆写 |
| 改了 `build-data-cloud.mjs` 的**计算逻辑** | 不用清 —— 快取存的是原始回应，改的是怎么读它 |
| 改了**抓取范围**（`MONTHS`、端点、`field` 参数） | 要清：`rm -rf cloud-cache/` |
| 怀疑资料不对 | 清掉重抓，排除快取因素 |

## 刷新完要做什么

**改过 `build-data-cloud.mjs` 的算法就必须重新对帐** —— 用 `finance-dashboard-reconcile` skill，
而且要用一个**没拿来调参数的月份**验证。只是例行刷新（没改码）不用每次对帐。
