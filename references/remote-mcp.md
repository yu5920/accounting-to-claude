# Reaching the books from another computer

**Status: verified.** The OAuth flow, the guard and the audit trail are covered
by `remote-selftest.mjs` — 30 checks, most of them negative.

The stdio server (`index.js`) is only reachable by Claude running on the same
machine. `remote.js` serves the *same* server — same guard, same engine layer,
same four tools, all from `core.js` — over HTTP, so Claude on a laptop, a phone,
or in a browser can ask questions about the books.

## Say the trade-off out loud first

Local means the accounts cannot be reached from outside that machine, at all.
Remote means there is now a door. It has a good lock, and the lock is tested,
but the honest summary is:

| | Local (`index.js`) | Remote (`remote.js`) |
|---|---|---|
| Reachable from the internet | No | Yes, while it is running |
| Can it change the books | No | No — same guard |
| Who can read them | Whoever uses that PC | Whoever has a username and password |
| If a password leaks | Nothing happens | Someone reads the accounts |
| Machine must be on | Only when used | Whenever anyone wants to ask |

Raise this with whoever owns the accounts before switching it on. If the answer
is "only the boss, only sometimes", start it when needed and stop it after —
`Ctrl+C` and the door is gone.

## How it is locked

**OAuth 2.0 with Dynamic Client Registration and PKCE.** Claude supports DCR out
of the box. A fixed bearer token in a request header would be simpler, but
`static_headers` is still beta and gated, so DCR is the path that works today.

`remote.js` is both the resource server and its own authorization server. It
serves the discovery documents, registers Claude as a client, shows a login page,
issues short-lived access tokens (1 hour) and rotating refresh tokens.

- No account exists by default, and passwords under 12 characters are refused at
  startup — this is on the internet, so a weak one is guessable while you read
  the error message.
- Failed logins are delayed and logged, and the failure message never says which
  half was wrong.
- Authorization codes are single-use; a replay is refused even when it arrives
  with the correct PKCE verifier.
- Refresh tokens rotate: using an old one fails with `invalid_grant`, which is
  how stolen-token reuse becomes visible in the log.
- The HTTP server binds to `127.0.0.1` only. The tunnel is the single way in,
  which is what makes it reasonable to trust the forwarded-IP header.
- Every tool call is appended to `remote-audit.log` with the username, the IP,
  the tool and the SQL.

**The read-only guard is unchanged and still applies.** It comes from the same
`core.js` both entry points import. `remote-selftest.mjs` re-checks it through
the HTTP path anyway, because a guard that is only tested on one route is only
guarded on one route.

## Setting it up

### 1. Install a tunnel

The server listens on localhost; something has to give it a public https name.
Cloudflare Tunnel is free and needs no inbound firewall rule:

```bash
winget install Cloudflare.cloudflared
```

Open a **new** terminal afterwards, or `cloudflared` will not be on the PATH yet.

### 2. Configure

```bash
copy remote-config.example.json remote-config.json
```

Set at least a username and a long password. `remote-config.json`,
`remote-state.json` and `remote-audit.log` are all in `.gitignore` — the first
holds live credentials, the second the registered OAuth clients, the third who
asked what.

Worth considering while you are in there:

- **`allowBooks`** — a remote session is allowed to be narrower than a local one.
  If the question is "how is the group doing", listing the two or three books
  that answer it is a smaller door than all twenty-one.
- **`allowCidr`** — set to `160.79.104.0/21` and only Anthropic's servers can
  reach it. That covers Claude on the web, Desktop and mobile. It blocks Claude
  Code on another computer, which connects directly from that computer.

### 3. Start it

```bash
node start-remote.mjs
```

This starts the tunnel first, reads the address it hands out, then starts the
server with that address baked in — the order matters, because the public URL
goes into the OAuth metadata and Claude checks it matches what you typed.

It prints one line to paste into Claude.

### 4. Add the connector in Claude

On the other computer: **Settings → Connectors → Add custom connector**, paste
the `.../mcp` URL, click Add, then Connect. The login page appears; sign in with
the username and password from the config. Claude asks once and remembers.

### 5. Ask something

> Which company books are there, and which ones have transactions this year?

If the tools do not appear, work through the troubleshooting list below rather
than guessing — every failure here has a specific cause.

## Quick tunnel vs named tunnel

`start-remote.mjs` uses a **quick tunnel** by default: no account, no domain, and
a fresh `*.trycloudflare.com` address every single start.

That address changing is the thing that will annoy you. Each new address means
removing the connector in Claude and adding it again, because the OAuth metadata
is bound to the exact URL.

For anything beyond testing, set up a **named tunnel** with a Cloudflare account
and a domain, then put the stable URL in `remote-config.json` as `publicUrl`.
`start-remote.mjs` sees it and skips the tunnel step, assuming something else is
routing that name to the port.

## Troubleshooting

**"Couldn't reach the MCP server"** — Claude could not find the OAuth metadata.
Check `https://your-url/.well-known/oauth-protected-resource` in a browser; it
must return JSON whose `resource` field is *exactly* the URL you typed into
Claude, including `/mcp`. A trailing slash difference is enough to break it.

**The login page never appears** — the connector URL and `ACCT_PUBLIC_URL` do not
match. `start-remote.mjs` sets them together, so this usually means a stale
connector from a previous quick-tunnel address. Remove it and add it again.

**It worked yesterday and not today** — quick tunnels get a new address every
start. This is the expected outcome, not a fault.

**Tools appear but every call errors** — the database, not the transport. Run
`node selftest.mjs` locally to separate the two.

**Everything is refused after a restart** — `remote-state.json` was deleted, so
the registered clients went with it. Remove the connector in Claude and add it
again.

## Running it as a service

Resist it, at least at first. A tunnel that is always up is a door that is always
open, and the thing behind it is the company's accounts.

If it does need to be always available, then at minimum: a named tunnel, the
`allowCidr` allowlist on, `allowBooks` narrowed to what is actually needed, and
somebody actually reading `remote-audit.log` — an audit log nobody opens is a
file, not a control.

## The alternative worth weighing

If the real need is "let people ask about the numbers", the encrypted dashboard
(`build-site.mjs --lock`, see `dashboard.md`) answers a lot of it with **no
inbound path to your network at all**. It is a snapshot rather than a live
connection, so it cannot answer a question nobody anticipated — but nothing can
reach the database through it, because there is nothing to reach.

Live connection for open-ended questions; published snapshot for the regular
ones. They are not competing, and most groups end up wanting both.
