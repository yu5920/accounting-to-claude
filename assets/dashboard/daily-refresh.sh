#!/bin/bash
# Daily refresh for the finance dashboard, run by the OS scheduler.
#
# The direct-database path needs this to run on the machine holding the
# database. The Cloud API is reachable from anywhere, so this runs on the Mac.
#
# The one design decision worth knowing: if headless-check fails, the PREVIOUS
# dashboard.html is put back. A stale dashboard that is known-good beats a fresh
# one whose numbers are wrong, because a wrong one still draws and nobody
# notices. The log says which happened.
set -uo pipefail

cd "$(dirname "$0")" || exit 1

LOG="refresh-log.txt"
BACKUP="dashboard.prev.html"
stamp() { date "+%Y-%m-%d %H:%M:%S"; }
say() { echo "[$(stamp)] $*" | tee -a "$LOG"; }

# Keep the log from growing without bound - last ~2000 lines is months of runs.
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 2000 ]; then
  tail -n 1000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

say "---- refresh start ----"

# node is not on launchd's PATH; find it the way the login shell would.
NODE="$(command -v node || true)"
for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.nvm/versions/node/*/bin/node"; do
  [ -n "$NODE" ] && break
  for n in $candidate; do [ -x "$n" ] && NODE="$n" && break; done
done
if [ -z "$NODE" ]; then
  say "FAILED: node not found. launchd does not inherit your shell PATH."
  exit 1
fi
say "node: $NODE ($("$NODE" -v))"

[ -f dashboard.html ] && cp dashboard.html "$BACKUP"

if ! "$NODE" build-data-cloud.mjs --refresh >> "$LOG" 2>&1; then
  say "FAILED: build-data-cloud.mjs - dashboard left untouched"
  exit 1
fi

# BRAND comes from profile.json via render-dashboard's own lookup; passing it
# here would hard-code one company into a script meant to be copied as-is.
if ! "$NODE" render-dashboard.mjs >> "$LOG" 2>&1; then
  say "FAILED: render-dashboard.mjs - restoring previous dashboard"
  [ -f "$BACKUP" ] && mv "$BACKUP" dashboard.html
  exit 1
fi

# The check that matters: a page that still draws with numbers that are now
# wrong is the failure this exists to catch.
if ! "$NODE" headless-check.mjs >> "$LOG" 2>&1; then
  say "FAILED: headless-check.mjs - the new page is wrong, restoring previous dashboard"
  say "        Run 'node headless-check.mjs' by hand to see which check failed."
  [ -f "$BACKUP" ] && mv "$BACKUP" dashboard.html
  exit 1
fi

rm -f "$BACKUP"
say "OK  $("$NODE" -e '
const c=JSON.parse(require("fs").readFileSync("dashboard-data.json","utf8"));
const x=c.companies[0];
process.stdout.write(x.name+" | "+c.months.length+" 个月 | 分录 "+x.glPostings+" | AR 未清 "+Math.round(x.ar.total).toLocaleString());
')"
say "---- refresh done ----"
