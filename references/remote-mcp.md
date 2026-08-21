# Reaching the books from another computer

**Status: verified.** Both modes are covered by tests —
`remote-selftest-private.mjs` (14 checks) and `remote-selftest.mjs` (30 checks),
most of them negative.

`index.js` is reachable only by Claude on the machine it runs on. `remote.js`
serves the *same* server — same guard, same engine layer, same four tools, all
from `core.js` — over HTTP, so Claude on a laptop somewhere else can ask
questions about the books.

## Pick the mode first, because it changes everything else

### Private mode — the one to want

No public URL. The server listens on the machine's own addresses and checks a
**device token** on every request.

Reachable over:

- the office **LAN** (`http://192.168.x.x:8790/mcp`), and
- a private overlay network like **ZeroTier** or **Tailscale**
  (`http://10.x.x.x:8790/mcp`), which is how you reach it from *outside* the
  office without putting anything on the public internet.

That second point is worth sitting with. An overlay network gives the remote
laptop an address on your private network from anywhere in the world. You get
external access with no public port, no certificate, no OAuth, and nothing for a
scanner to find.

### Public mode — only if you need hosted connectors

Set `ACCT_PUBLIC_URL` and the server becomes its own OAuth authorization server:
discovery documents, dynamic client registration, PKCE S256, a login page,
one-hour access tokens and rotating refresh tokens.

This exists because **Claude's custom connectors are fetched by Anthropic's
servers**, from `160.79.104.0/21`. Those servers cannot see a LAN or ZeroTier
address, so a private URL simply will not work as a custom connector. If you want
to paste a URL into *Settings → Connectors* and have it just work, it has to be
publicly resolvable https — which means a tunnel, and a real door on the
internet.

`bridge.mjs` avoids all of that. Prefer it.

## Who can connect to a private address

| On the other computer | How | Needs |
|---|---|---|
| **Claude Code** | `claude mcp add --transport http accounting <url> --header "Authorization: Bearer <token>"` | nothing else |
| **Claude Desktop** | run `bridge.mjs` as a local stdio server | Node + `bridge.mjs` + the token |
| **claude.ai in a browser** | not possible on a private address | public mode |

`bridge.mjs` is the trick that makes Claude Desktop work. Desktop's *custom
connectors* go out through Anthropic, but Desktop also starts *local* stdio
servers — and a local process can reach a private address perfectly well. So the
bridge is that local process: it reads JSON-RPC on stdin, forwards it over HTTP
with the token, and writes the reply back. Nothing but Node and one file is
needed on that machine — no database client, no accounting credentials.

## Setting up private mode

### 1. Issue a token per device

```bash
node make-token.mjs "boss laptop"
```

One token per device, not one shared secret — that is what makes revocation
possible. Delete the line from `remote-tokens.txt`, restart, and only that
device loses access. A shared password can only be changed for everybody at
once, which in practice means it never gets changed.

The audit log records the device name against every query, so name them
properly.

### 2. Start it

```bash
node remote.js
```

It refuses to start with no tokens, prints every address it can be reached on,
and says which mode it is in.

### 3. Open the port on the Windows firewall

Needed once, in an **administrator** PowerShell — this is why it is a step for
you rather than something a script does quietly:

```powershell
New-NetFirewallRule -DisplayName "Accounting MCP" -Direction Inbound -Protocol TCP -LocalPort 8790 -Action Allow -Profile Private
```

`-Profile Private` matters: it opens the port on networks Windows treats as
private (home/office) and leaves public Wi‑Fi alone. If the machine's network is
marked Public, either change that or the rule will not apply.

### 4. Connect from the other computer

**Claude Code:**

```bash
claude mcp add --transport http accounting http://10.243.39.206:8790/mcp --header "Authorization: Bearer PASTE_TOKEN"
```

**Claude Desktop:** copy `bridge.mjs` to that machine and add to
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "accounting": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\Tools\\bridge.mjs"],
      "env": {
        "ACCT_MCP_URL": "http://10.243.39.206:8790/mcp",
        "ACCT_MCP_TOKEN": "PASTE_TOKEN"
      }
    }
  }
}
```

Then fully quit and reopen Claude — on Windows, closing the window leaves the
process in the tray and the config is only read at startup.

## How it is locked

- **No token, no start.** The server refuses to run with an empty token list,
  because anyone who could reach the port could otherwise read every posting,
  balance and customer name.
- **Tokens are compared in constant time** against every entry, so the work done
  is the same whether the token exists or not.
- **The read-only guard is unchanged** — same `core.js` both entry points
  import. The tests re-check it through the HTTP path anyway, because a guard
  tested on one route is only guarded on one route.
- **Every tool call is appended** to `remote-audit.log` with the device name, the
  IP, the tool and the SQL.
- **No OAuth surface in private mode.** `/authorize`, `/token`, `/register` and
  the discovery documents return 404 — an authorization server nobody can reach
  is a liability, not a feature.
- **Forwarded-IP headers are ignored** unless `ACCT_TRUST_PROXY` is set. Reachable
  directly on a network, that header is attacker-controlled.
- **`allowBooks`** narrows a remote session to specific company books, and
  **`ACCT_ALLOW_CIDR`** restricts which addresses may connect at all
  (`192.168.0.0/16`, or your ZeroTier range).

In public mode, add: single-use authorization codes, rotating refresh tokens,
delayed and logged login failures whose message never says which half was wrong,
loopback-with-any-port redirects for Claude Code per RFC 8252, and binding to
127.0.0.1 so the tunnel is the only way in.

## Troubleshooting

**The other computer cannot reach it at all** — firewall first. From that
machine: `curl http://<address>:8790/` should return the status page. If it
times out, the rule in step 3 is missing or the network profile is Public.

**`401`** — the token is wrong, or its line was removed from
`remote-tokens.txt`, or the server was not restarted after the line was added.

**Tools appear but every call errors** — the database, not the transport. Run
`node selftest.mjs` on the server machine to separate the two.

**ZeroTier address does not answer but the LAN one does** — the other machine is
not joined to the same ZeroTier network, or the member is not authorised in the
ZeroTier console.

**Everything stops when you close the window** — by design. Ctrl+C and the door
is gone. If it needs to be always on, run it as a service, but read the next
section first.

## Leaving it running

The honest position: a server that is always up is a door that is always open,
and behind it is the company's complete accounts.

If it must be always available, then at minimum — private mode only,
`ACCT_ALLOW_CIDR` set to the network that should reach it, `allowBooks` narrowed
to what is actually needed, one token per person so a leak can be traced and
revoked, and somebody actually reading `remote-audit.log`. An audit log nobody
opens is a file, not a control.

## The alternative worth weighing

If the real need is "let people see the numbers", the encrypted dashboard
(`build-site.mjs --lock`, see `dashboard.md`) covers a lot of it with **no
inbound path to your network at all**. It is a snapshot, so it cannot answer a
question nobody anticipated — but nothing can reach the database through it,
because there is nothing to reach.

Live connection for open-ended questions; published snapshot for the regular
ones. Most groups end up wanting both.
