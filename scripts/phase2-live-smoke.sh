#!/usr/bin/env bash
#
# phase2-live-smoke.sh — live behavioral smoke of the Phase 2 surface against the
# REAL grok CLI, driving the companion + Stop hook exactly as Claude Code would.
#
# WHAT THIS COVERS (scriptable, runs real grok):
#   - /grok:review re-scoped defect pass still catches a planted bug
#   - /grok:adversarial-review returns design findings + correct label
#   - /grok:setup --enable/--disable-review-gate toggles config (and rejects both)
#   - Stop hook: ALLOW (clean turn), BLOCK (buggy turn, clean reason / no preamble
#     leak), busy-skip (job in flight), and gate-off pass-through
#
# WHAT THIS CANNOT COVER (needs a real interactive Claude Code session):
#   - that `/plugin install` registers the slash commands in the TUI
#   - that the harness actually invokes the Stop hook on a genuine Stop event and
#     honors the {decision:"block"} JSON (stops the session)
#   Those two remain a manual check; everything else is asserted here.
#
# Runs the real grok CLI ~7 times, so expect ~5-9 minutes. Requires grok installed
# and logged in. Touches only a throwaway /tmp repo and the brokers it spawns.

set -uo pipefail

REPO="${GROK_REPO:-/Users/sal/Projects/grok-plugin-cc}"
COMP="$REPO/plugins/grok/scripts/grok-companion.mjs"
HOOK="$REPO/plugins/grok/scripts/stop-review-gate-hook.mjs"
STATE_ROOT="$HOME/.claude/plugins/data/grok-grok/state"
BUDGET_MS=300000

pass=0; fail=0; inconclusive=0
BGJOB=""

green()  { printf '\033[32m%s\033[0m\n' "$1"; }
red()    { printf '\033[31m%s\033[0m\n' "$1"; }
yellow() { printf '\033[33m%s\033[0m\n' "$1"; }
step()   { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

# check <name> <actual> <expected>
check() {
  if [ "$2" = "$3" ]; then green "  PASS  $1 (= $2)"; pass=$((pass+1))
  else red "  FAIL  $1 (got '$2', want '$3')"; fail=$((fail+1)); fi
}
note_inconclusive() { yellow "  SKIP  $1"; inconclusive=$((inconclusive+1)); }

# jf <expr> — parse JSON on stdin; `d` is the decoded object.
jf() { python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: print("<no-json>"); sys.exit()
print(eval(sys.argv[1]))' "$1" 2>/dev/null; }

# --- verify prerequisites --------------------------------------------------
[ -f "$COMP" ] || { red "companion not found at $COMP (set GROK_REPO)"; exit 2; }
command -v python3 >/dev/null || { red "python3 required"; exit 2; }

before_state="$(ls -1 "$STATE_ROOT" 2>/dev/null | sort || true)"
SCRATCH="$(mktemp -d /tmp/grok-live-smoke.XXXXXX)"

cleanup() {
  set +e
  [ -n "$BGJOB" ] && node "$COMP" cancel "$BGJOB" -C "$SCRATCH" >/dev/null 2>&1
  if [ -d "$STATE_ROOT" ]; then
    for d in "$STATE_ROOT"/*/; do
      [ -d "$d" ] || continue
      name="$(basename "$d")"
      printf '%s\n' "$before_state" | grep -qx "$name" && continue   # pre-existing; leave alone
      bj="$d/broker.json"
      if [ -f "$bj" ]; then
        pid="$(python3 -c "import json;print(json.load(open('$bj')).get('pid',''))" 2>/dev/null)"
        [ -n "$pid" ] && kill "$pid" 2>/dev/null
      fi
      rm -rf "$d"
    done
  fi
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

hook_json() { # <session> <message>
  printf '{"session_id":"%s","cwd":"%s","last_assistant_message":"%s"}' "$1" "$SCRATCH" "$2"
}

# --- preflight -------------------------------------------------------------
step "Preflight: grok available + logged in"
setup="$(node "$COMP" setup --json -C "$SCRATCH" 2>/dev/null)"
ready="$(printf '%s' "$setup" | jf "d.get('ready')")"
if [ "$ready" != "True" ]; then
  red "grok is not ready (setup.ready=$ready). Install + \`grok login\` first, then re-run."
  printf '%s\n' "$setup" | jf "d.get('nextSteps')"
  exit 2
fi
green "  grok ready"

# scratch git repo with a good baseline
( cd "$SCRATCH"
  git init -q && git config user.email t@t.co && git config user.name smoke
  printf 'export function transfer(from,to,amt){\n  if(amt<=0)throw new Error("bad");\n  if(from.bal<amt)throw new Error("insufficient");\n  from.bal-=amt; to.bal+=amt;\n}\n' > bank.js
  git add -A && git commit -qm baseline )

# --- 1. re-scoped /grok:review catches a planted bug -----------------------
step "1. /grok:review catches a planted overdraft bug (~60s)"
# drop the sufficient-funds guard in the working tree
printf 'export function transfer(from,to,amt){\n  if(amt<=0)throw new Error("bad");\n  from.bal-=amt; to.bal+=amt;\n}\n' > "$SCRATCH/bank.js"
out="$(node "$COMP" review --wait --json --scope working-tree --budget-ms "$BUDGET_MS" -C "$SCRATCH" 2>/dev/null)"
check "review: schema-valid (parseError null)" "$(printf '%s' "$out" | jf "d.get('payload',d).get('parseError')")" "None"
check "review: needs-attention verdict"        "$(printf '%s' "$out" | jf "(d.get('payload',d).get('result') or {}).get('verdict','')")" "needs-attention"
nfind="$(printf '%s' "$out" | jf "len((d.get('payload',d).get('result') or {}).get('findings') or [])")"
[ "${nfind:-0}" -ge 1 ] 2>/dev/null && { green "  PASS  review: >=1 finding ($nfind)"; pass=$((pass+1)); } || { red "  FAIL  review: no findings"; fail=$((fail+1)); }
( cd "$SCRATCH" && git commit -qam overdraft )

# --- 2. /grok:adversarial-review returns design findings -------------------
step "2. /grok:adversarial-review on a design smell (~60s)"
# swallow-all-errors: a wrong-layer / undefended-commitment design smell
printf 'export function loadConfig(raw){\n  try { return JSON.parse(raw); } catch { return {}; }\n}\n' > "$SCRATCH/config.js"
( cd "$SCRATCH" && git add -A && git commit -qm add-config
  printf 'export function loadConfig(raw){\n  try { return JSON.parse(raw); } catch { return {}; }\n}\nexport function loadAll(raws){ return raws.map(loadConfig); }\n' > config.js )
out="$(node "$COMP" adversarial-review --wait --json --scope working-tree --budget-ms "$BUDGET_MS" -C "$SCRATCH" "is error handling at the right layer?" 2>/dev/null)"
check "adversarial: schema-valid"          "$(printf '%s' "$out" | jf "d.get('payload',d).get('parseError')")" "None"
check "adversarial: label is Adversarial"  "$(printf '%s' "$out" | jf "d.get('payload',d).get('review','')")" "Adversarial Review"
nfind="$(printf '%s' "$out" | jf "len((d.get('payload',d).get('result') or {}).get('findings') or [])")"
[ "${nfind:-0}" -ge 1 ] 2>/dev/null && { green "  PASS  adversarial: >=1 design finding ($nfind)"; pass=$((pass+1)); } || note_inconclusive "adversarial: approved with no findings (valid, but expected a design smell)"
( cd "$SCRATCH" && git commit -qam config-smell )

# --- 3. setup review-gate toggle -------------------------------------------
step "3. /grok:setup review-gate toggle"
en="$(node "$COMP" setup --json --enable-review-gate -C "$SCRATCH" 2>/dev/null | jf "d.get('reviewGateEnabled')")"
check "setup: --enable-review-gate -> enabled" "$en" "True"
dis="$(node "$COMP" setup --json --disable-review-gate -C "$SCRATCH" 2>/dev/null | jf "d.get('reviewGateEnabled')")"
check "setup: --disable-review-gate -> disabled" "$dis" "False"
node "$COMP" setup --json --enable-review-gate --disable-review-gate -C "$SCRATCH" >/dev/null 2>&1
check "setup: both flags rejected (nonzero exit)" "$([ $? -ne 0 ] && echo yes || echo no)" "yes"

# gate ON for the hook tests
node "$COMP" setup --json --enable-review-gate -C "$SCRATCH" >/dev/null 2>&1

# --- 4. Stop hook ALLOW on a clean turn ------------------------------------
step "4. Stop hook ALLOW on a correct edit (~60s)"
printf 'export function mul(a,b){ return a*b; }\n' > "$SCRATCH/extra.js"
outfile="$(mktemp)"; errfile="$(mktemp)"
hook_json "smoke-allow" "Added a correct mul() helper." | node "$HOOK" >"$outfile" 2>"$errfile"
check "hook ALLOW: empty stdout (no block decision)" "$([ -s "$outfile" ] && echo nonempty || echo empty)" "empty"
rm -f "$outfile" "$errfile" "$SCRATCH/extra.js"

# --- 5. Stop hook BLOCK on a buggy turn ------------------------------------
step "5. Stop hook BLOCK on a no-base-case recursion (~60s)"
printf 'export function factorial(n){ return n * factorial(n-1); }\n' > "$SCRATCH/rec.js"
outfile="$(mktemp)"
hook_json "smoke-block" "Added factorial(n)." | node "$HOOK" >"$outfile" 2>/dev/null
decision="$(cat "$outfile" | jf "d.get('decision','')")"
check "hook BLOCK: decision is block" "$decision" "block"
reason="$(cat "$outfile" | jf "d.get('reason','')")"
case "$reason" in
  *"I'll verify"*|*"I'll check"*) red "  FAIL  hook BLOCK: preamble leaked into reason"; fail=$((fail+1));;
  "") red "  FAIL  hook BLOCK: empty reason"; fail=$((fail+1));;
  *) green "  PASS  hook BLOCK: clean reason (no preamble leak)"; pass=$((pass+1));;
esac
rm -f "$outfile"

# --- 6. busy-skip: job in flight -> skip + allow ---------------------------
step "6. Stop hook busy-skip with a job in flight (~30s)"
bg="$(node "$COMP" task --background --json -C "$SCRATCH" "Read every file and write a detailed multi-paragraph architecture summary." 2>/dev/null)"
BGJOB="$(printf '%s' "$bg" | jf "d.get('jobId','')")"
running="no"
for _ in 1 2 3 4 5 6 7 8; do
  st="$(node "$COMP" status "$BGJOB" --json -C "$SCRATCH" 2>/dev/null | jf "d['job']['status']")"
  [ "$st" = "running" ] && { running="yes"; break; }
  sleep 1
done
if [ "$running" = "yes" ]; then
  outfile="$(mktemp)"; errfile="$(mktemp)"
  printf 'export function bad(n){ return n * bad(n-1); }\n' > "$SCRATCH/rec.js"
  hook_json "smoke-busy" "Made an edit." | node "$HOOK" >"$outfile" 2>"$errfile"
  check "hook busy: empty stdout (skip+allow)" "$([ -s "$outfile" ] && echo nonempty || echo empty)" "empty"
  grep -qi "still running" "$errfile" && { green "  PASS  hook busy: surfaced running-job note"; pass=$((pass+1)); } || { red "  FAIL  hook busy: no running-job note"; fail=$((fail+1)); }
  rm -f "$outfile" "$errfile"
else
  note_inconclusive "busy-skip: background job never observed 'running' (finished too fast)"
fi
node "$COMP" cancel "$BGJOB" -C "$SCRATCH" >/dev/null 2>&1; BGJOB=""

# --- 7. gate OFF -> pass through even with a bug present --------------------
step "7. Gate disabled -> Stop hook allows even with a buggy edit"
node "$COMP" setup --json --disable-review-gate -C "$SCRATCH" >/dev/null 2>&1
outfile="$(mktemp)"
printf 'export function stillbad(n){ return n * stillbad(n-1); }\n' > "$SCRATCH/rec.js"
hook_json "smoke-off" "Made a buggy edit." | node "$HOOK" >"$outfile" 2>/dev/null
check "hook gate-off: empty stdout (no review, allow)" "$([ -s "$outfile" ] && echo nonempty || echo empty)" "empty"
rm -f "$outfile"

# --- summary ---------------------------------------------------------------
step "Summary"
printf 'passed: %d   failed: %d   inconclusive: %d\n' "$pass" "$fail" "$inconclusive"
echo
echo "Still requires a real Claude Code session (not scriptable):"
echo "  - install the plugin and confirm /grok:adversarial-review is a registered slash command"
echo "  - enable the gate, make an edit, and confirm the Stop hook fires on a genuine Stop"
echo "    event and that a BLOCK actually stops the session"
[ "$fail" -eq 0 ] && { green "behavioral smoke: GREEN"; exit 0; } || { red "behavioral smoke: FAILURES above"; exit 1; }
