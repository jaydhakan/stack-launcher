#!/usr/bin/env bash
# Smoke tests for the kit: syntax, CLI, a stubbed start, and reset / undo / client push against
# throwaway git repos. Nothing real is touched: a temp root, temp cache, stub terminal and npm.
# Runs in CI on every push; locally: ./tests/smoke.sh
set -euo pipefail

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export XDG_CACHE_HOME="$WORK/cache"
fails=0

pass() { printf '  \e[32m✓\e[0m %s\n' "$1"; }
fail() { printf '  \e[31m✗ %s\e[0m\n' "$1"; fails=$((fails + 1)); }
check() { # check <description> <command...>
  local name=$1
  shift
  if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name"; fi
}
g() { git -c user.email=ci@local -c user.name=ci -c init.defaultBranch=main "$@"; }

echo "Syntax"
check "bash -n local-up.sh install.sh update.sh tests/smoke.sh" bash -n "$KIT/local-up.sh" "$KIT/install.sh" "$KIT/update.sh" "$KIT/tests/smoke.sh"
check "node --check applet.js" node --check "$KIT/aicl-local-monitor@aicl/applet.js"
check "python3 -m py_compile stats.py" python3 -c "import ast,sys; ast.parse(open(sys.argv[1]).read())" "$KIT/aicl-local-monitor@aicl/stats.py"
check "metadata.json and settings-schema.json parse" python3 -c "import json,sys; [json.load(open(f)) for f in sys.argv[1:]]" \
  "$KIT/aicl-local-monitor@aicl/metadata.json" "$KIT/aicl-local-monitor@aicl/settings-schema.json"

echo "Cinnamon 5.x compatibility"
# Options that only Cinnamon 6 accepts break the applet on Mint 21 ("Unrecognized parameter"). They
# may appear only on a line marked `cinnamon6-only`, inside a try/catch fallback.
if grep -nE 'destroyOnClose' "$KIT/aicl-local-monitor@aicl/applet.js" | grep -vE '^[0-9]+:\s*//|cinnamon6-only'; then
  fail "Cinnamon 6-only option used without the cinnamon6-only fallback marker"
else
  pass "no unguarded Cinnamon 6-only options"
fi

# A fake AICL root: the script is linked in like install.sh does, repos are local git repos
ROOT="$WORK/root"
mkdir -p "$ROOT" "$WORK/bin"
ln -s "$KIT/local-up.sh" "$ROOT/local-up.sh"
L="$ROOT/local-up.sh"
cat >"$ROOT/local-up.local.sh" <<'EOF'
DISABLE_IPV6=false
SERVICE_PORT[client]=59173
EOF
printf '#!/bin/bash\nfor a in "$@"; do [[ $a == --command=* || $a == bash ]] && echo "$*" >> "%s/terminal.log"; done; exit 0\n' "$WORK" >"$WORK/bin/gnome-terminal"
printf '#!/bin/bash\necho "npm $*"\n' >"$WORK/bin/npm"
chmod +x "$WORK/bin/"*
export PATH="$WORK/bin:$PATH"

echo "CLI"
check "--help lists the services" bash -c "'$L' --help | grep -q '^client '"
check "--list prints names" bash -c "'$L' --list | grep -qx client"
check "local-up.local.sh override reaches --help" bash -c "'$L' --help | grep -E '^client ' | grep -q 59173"
"$L" -q >/dev/null 2>&1 && fail "unknown option exits 2" || { [[ $? -eq 2 ]] && pass "unknown option exits 2" || fail "unknown option exits 2"; }
"$L" nosuchservice >/dev/null 2>&1 && fail "unknown service exits 2" || { [[ $? -eq 2 ]] && pass "unknown service exits 2" || fail "unknown service exits 2"; }

echo "Stubbed start"
mkdir -p "$ROOT/aicl-web-react-client/node_modules"
echo '{}' >"$ROOT/aicl-web-react-client/package-lock.json"
touch "$ROOT/aicl-web-react-client/node_modules/.package-lock.json"
if READY_TIMEOUT=1 "$L" --no-pull --no-watch client </dev/null >"$WORK/start.log" 2>&1 &&
  grep -q -- '--port 59173 --strictPort' "$WORK/terminal.log"; then
  pass "start opens a tab with the overridden port"
else
  fail "start opens a tab with the overridden port (see output below)"
  cat "$WORK/start.log" "$WORK/terminal.log" 2>/dev/null || true
fi
check "--stop of a stopped service" bash -c "'$L' --stop client | grep -q 'not running'"

echo "Reset to origin, backup and undo"
cd "$WORK"
g init -q --bare origin.git
g init -q --bare client.git
g init -q seed
(cd seed && echo a >f && g add f && g commit -qm a && g push -q ../origin.git main)
g clone -q -b main origin.git "$ROOT/aicollect-python-api-server"
R="$ROOT/aicollect-python-api-server"
g -C "$R" remote add client ../../client.git
g -C "$R" push -q client main:client-main
(cd seed && echo b >>f && g commit -qam "b on origin" && g push -q ../origin.git main)
(cd "$R" && echo local >>f && g commit -qam "local only" && echo dirty >>f)

check "--reset-preview lists the lost commit" bash -c "'$L' --reset-preview responseHub | grep -q 'local only'"
"$L" --reset responseHub >"$WORK/reset.log" 2>&1
check "--reset moves to origin" bash -c "[[ \"\$(git -C '$R' log -1 --format=%s)\" == 'b on origin' ]]"
check "--reset leaves no tracked changes" bash -c "[[ -z \"\$(git -C '$R' status --porcelain --untracked-files=no)\" ]]"
check "--branches offers the backup" bash -c "'$L' --branches responseHub | grep -q '^backup'"
"$L" --reset-undo responseHub >"$WORK/undo.log" 2>&1
check "--reset-undo restores the local commit" bash -c "[[ \"\$(git -C '$R' log -1 --format=%s)\" == 'local only' ]]"
check "--reset-undo restores uncommitted changes" bash -c "grep -q dirty '$R/f'"
check "the backup is gone after undo" bash -c "! '$L' --branches responseHub | grep -q '^backup'"
check "--reset-undo without a backup fails" bash -c "! '$L' --reset-undo responseHub"

echo "Push to client"
git -C "$R" checkout -q -- f
(cd "$WORK" && g clone -q -b client-main client.git c2 && cd c2 && echo d >deploy.yaml && g add . && g commit -qm "client deploy" && g push -q origin client-main)
check "--dry-run plans a rewrite" bash -c "'$L' --client-sync responseHub main client-main --dry-run | grep -q '^plan.rewrite'"
"$L" --client-sync responseHub main client-main >/dev/null 2>&1 && fail "non-fast-forward is refused (exit 3)" ||
  { [[ $? -eq 3 ]] && pass "non-fast-forward is refused (exit 3)" || fail "non-fast-forward is refused (exit 3)"; }
check "--force deploys origin's commit" bash -c "'$L' --client-sync responseHub main client-main --force && [[ \"\$(git -C '$WORK/client.git' log -1 --format=%s client-main)\" == 'b on origin' ]]"
check "a second push has nothing to do" bash -c "'$L' --client-sync responseHub main client-main | grep -q 'nothing to push'"
check "a repo without the client remote is refused" bash -c "! '$L' --client-sync client main client-main --dry-run"

echo
if ((fails)); then
  echo "$fails check(s) failed"
  exit 1
fi
echo "All checks passed"
