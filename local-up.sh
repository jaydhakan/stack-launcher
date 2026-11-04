#!/usr/bin/env bash
# Starts the AICL local stack in one gnome-terminal window, one tab per service.
# Later starts add their tabs to that window while it is still open.
#
#   ./local-up.sh                  # pick services from an inline checklist (last pick is remembered)
#   ./local-up.sh --all            # start everything, no checklist
#   ./local-up.sh nucleus auth     # start only the named services
#   ./local-up.sh --no-pull ...    # skip fetching/pulling from origin
#   ./local-up.sh --no-watch ...   # exit once the tabs are open (skip the live ready table)
#   ./local-up.sh --stop [names]   # stop running services (all of them when no names are given)
#   ./local-up.sh --in-terminal ...  # run in a tab of the local-up window (the panel applet uses this)
#   ./local-up.sh --tunnel [names] # start the dev tunnel (TUNNEL_ID) in a tab, plus any named services
#   ./local-up.sh --stop-tunnel    # stop the dev tunnel
#   ./local-up.sh --branches <service>         # list the branches of that service's repo
#   ./local-up.sh --switch <service> <branch>  # switch that repo (refused while it has uncommitted changes)
#   ./local-up.sh --fetch|--pull <service>     # fetch, or fetch + fast-forward (+ install if the lockfile changed)
#   ./local-up.sh --list           # show available service names
#   ./local-up.sh --help           # show this help and every service with its port
#
#   READY_TIMEOUT=300 ./local-up.sh   # seconds to wait for services in the ready table (default 240)
#
# Steps on start:
#   1. fetch origin for the repos in parallel (the checklist then shows branch, behind/ahead, dirty)
#   2. check Mongo/Redis/Postgres/Kafka needed by the selection, offer to start them via systemctl
#      (docker:<container> infra is started with `docker start`; replset runs mongod as a replica set)
#   3. fast-forward each selected repo on its current branch and log the result
#   4. npm install / uv sync where a lockfile changed in that pull or deps are missing
#   5. check the service ports, offer to kill whatever is holding them
#   6. open the tabs, then show a live table until every service listens on its port
#
# Closing the window stops every service. Ctrl+C in a tab stops just that service
# and leaves a shell open in its directory so you can read the logs / restart it.

# Started from the panel applet or a launcher, the shell never read ~/.bashrc, so nvm's
# node/npx are missing; the tabs inherit this PATH. Loaded before `set -u` (nvm.sh trips it).
if ! command -v npx >/dev/null 2>&1 && [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
fi

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAST_SELECTION_FILE="${XDG_CACHE_HOME:-$HOME/.cache}/aicl-local-up.last"
LOG_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/aicl-local-up"
# <service>.exit holds the exit code of a service whose tab command ended (crash or Ctrl+C)
EXIT_DIR="$LOG_DIR/exit"
# <tab>: "screen service" of each tab this script opened, so later starts can add tabs to that window
SCREEN_DIR="$LOG_DIR/screen"
READY_TIMEOUT="${READY_TIMEOUT:-240}"

# name | directory (relative to ROOT) | port | URL path | infra it needs | command
# Port `KEY:default` = KEY from the repo's own .env (the port the app will really use), else
# the app's built-in default; a plain number is fixed. {port} in a command is replaced with
# the resolved port (Vite ports are pinned with --strictPort, so start order never shifts them).
SERVICES=(
  "nucleus|aicl-monorepo-node-api-server|NUCLEUS_PORT:5200|/nucleus|postgres,kafka|npx nx serve nucleus"
  "auth|aicl-monorepo-node-api-server|AUTH_PORT:3100|/auth|postgres,kafka|npx nx serve auth"
  "notification|aicl-monorepo-node-api-server|NOTIFICATION_PORT:5700|/notification|postgres,kafka|npx nx serve notification"
  "payment-manager|aicl-monorepo-node-api-server|PAYMENT_MANAGER_PORT:3600|/payment-manager|postgres,kafka|npx nx serve payment-manager"
  "agrisphere-api|aicl-monorepo-node-api-server|AGRISPHERE_PORT:3800|/agrisphere|postgres,kafka|npx nx serve agrisphere"
  "auditor|aicl-monorepo-node-api-server|AUDITOR_PORT:3300|/auditor|postgres,kafka|npx nx serve auditor"
  "responseHub|aicollect-python-api-server|RESPONSE_HUB_APP_PORT:30510|/response-hub|mongo,redis,kafka|uv run python -m apps.responseHub"
  "catalyst|aicollect-python-api-server|CATALYST_APP_PORT:30521|/catalyst|mongo,redis,kafka|uv run python -m apps.catalyst"
  "form-builder-api|aicl-api-node-form-builder|APP_PORT:3001|/frmbld|postgres,mongo|npm run dev"
  "client|aicl-web-react-client|5173|||npm run dev -- --port {port} --strictPort"
  "agrisphere-ui|aicl-web-react-agrisphere|5174|||npm run dev -- --port {port} --strictPort"
  "account|aicl-web-react-account|5175|||npm run dev -- --port {port} --strictPort"
  "form-builder-ui|aicl-web-react-form-builder|5176|||npm run dev -- --port {port} --strictPort"
  "backoffice|aicl-web-react-backoffice|5177|||npm run dev -- --port {port} --strictPort"
)

# Unticked in the checklist until you pick them once (after that your last pick is remembered)
DEFAULT_OFF=(payment-manager agrisphere-api auditor catalyst agrisphere-ui)

# name | port | systemd unit, docker:<container> (started with `docker start`, no sudo), or
# replset (mongod as replica set MONGO_REPLSET, see start_replset)
INFRA=(
  "mongo|27017|mongod"
  "redis|6379|redis-server"
  "postgres|5432|postgresql"
  "kafka|9092|kafka"
)

# Per-machine settings go in local-up.local.sh next to this script's link (git-ignored; see
# local-up.local.example.sh), never in this file: the kit updates with `git pull --ff-only`,
# so one person's edit here would conflict with, or once pushed break, everyone else's setup.
declare -A SERVICE_PORT=() SERVICE_DIR=() INFRA_PORT=() INFRA_UNIT=() PORT_SOURCE=()
DISABLE_IPV6=true
# Used by INFRA unit `replset` (form-builder needs Mongo as a replica set)
MONGO_REPLSET="rs0"
MONGO_DBPATH="/data/db"
# Dev tunnel ID for --tunnel (`devtunnel list`); empty = no tunnel
TUNNEL_ID=""
LOCAL_OVERRIDES="$ROOT/local-up.local.sh"
if [[ -f "$LOCAL_OVERRIDES" ]]; then
  # shellcheck disable=SC1090
  . "$LOCAL_OVERRIDES"
fi

env_value() { # env_value <dotenv file> <KEY> -> its value (only that key is read), empty when unset
  [[ -f "$1" ]] || return 0
  sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?$2[[:space:]]*=[[:space:]]*[\"']?([^\"'#[:space:]]*).*/\2/p" "$1" | tail -n 1
}

# Bakes overrides and .env ports into SERVICES/INFRA, so everything below sees plain values.
# The applet's stats.py mirrors this order: local-up.local.sh, then the repo's .env, then the default.
resolve_config() {
  local i name dir port path needs cmd value
  for i in "${!SERVICES[@]}"; do
    IFS='|' read -r name dir port path needs cmd <<<"${SERVICES[$i]}"
    dir=${SERVICE_DIR[$name]:-$dir}
    if [[ -n "${SERVICE_PORT[$name]:-}" ]]; then
      port=${SERVICE_PORT[$name]}
      PORT_SOURCE[$name]="local-up.local.sh"
    elif [[ "$port" == *:* ]]; then
      value=$(env_value "$ROOT/$dir/.env" "${port%%:*}")
      if [[ "$value" =~ ^[0-9]+$ ]]; then
        PORT_SOURCE[$name]="${port%%:*} in .env"
        port=$value
      else
        PORT_SOURCE[$name]="app default"
        port=${port#*:}
      fi
    else
      PORT_SOURCE[$name]="fixed"
    fi
    SERVICES[i]="$name|$dir|$port|$path|$needs|${cmd//\{port\}/$port}"
  done
  for i in "${!INFRA[@]}"; do
    IFS='|' read -r name port value <<<"${INFRA[$i]}"
    INFRA[i]="$name|${INFRA_PORT[$name]:-$port}|${INFRA_UNIT[$name]:-$value}"
  done
}
resolve_config

TMP_DIR="$(mktemp -d)"
MY_PGID="$(ps -o pgid= -p $$ | tr -d ' ')"
declare -A repo_info=()
declare -A lock_changed=()

cleanup() {
  if [[ -t 1 ]]; then printf '\e[?25h'; fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

# --- Small helpers ------------------------------------------------------------
is_listening() { [[ -n "$(ss -ltnH "sport = :$1" 2>/dev/null)" ]]; }

listener_pids() { lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | sort -u || true; }

# Anchored so the tab's `bash -c` wrapper, whose command line also contains it, is not matched
tunnel_pids() { pgrep -u "$USER" -f "^(\S*/)?devtunnel host $TUNNEL_ID( |$)" || true; }

# Points GNOME_TERMINAL_SCREEN/SERVICE at a still-open tab of the local-up window, so
# `gnome-terminal --tab` adds tabs there (it needs both). Otherwise clears them so tabs never
# land in the terminal this script was started from, and returns 1.
use_local_window() {
  local f screen service
  unset GNOME_TERMINAL_SCREEN GNOME_TERMINAL_SERVICE
  for f in "$SCREEN_DIR"/*; do
    [[ -f "$f" ]] || continue
    read -r screen service <"$f" || true
    if [[ -n "$screen" && -n "$service" ]] &&
      gdbus introspect --session --dest "$service" --object-path "$screen" 2>/dev/null | grep -q 'org.gnome.Terminal.Terminal0'; then
      export GNOME_TERMINAL_SCREEN=$screen GNOME_TERMINAL_SERVICE=$service
      return 0
    fi
    rm -f "$f" # that tab is closed
  done
  return 1
}

# The tab command's first step: record where it runs, for use_local_window
record_screen() { echo "echo \"\$GNOME_TERMINAL_SCREEN \$GNOME_TERMINAL_SERVICE\" > \"$SCREEN_DIR/$1\"; "; }

describe_pid() {
  local pid=$1 cwd
  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || echo "?")
  printf '%s (pid %s) in %s' "$(ps -o comm= -p "$pid" 2>/dev/null || echo "?")" "$pid" "${cwd#"$ROOT"/}"
}

pad() { # pad <text with \e colour codes> <width> -> text padded to its visible width
  local text plain
  text=$(printf '%b' "$1")
  plain=$(sed 's/\x1b\[[0-9;]*m//g' <<<"$text")
  printf '%s%*s' "$text" $(($2 > ${#plain} ? $2 - ${#plain} : 0)) ""
}

usage() { # the header comment of this file, then the service table
  local svc name dir port path default
  sed -n '2,/^$/{/^$/q;s/^# \{0,1\}//;p}' "${BASH_SOURCE[0]}"
  echo
  printf '%-18s %-6s %-8s %-32s %s\n' "SERVICE" "PORT" "DEFAULT" "REPO" "PORT FROM"
  for svc in "${SERVICES[@]}"; do
    IFS='|' read -r name dir port path _ <<<"$svc"
    default=on
    if [[ " ${DEFAULT_OFF[*]} " == *" $name "* ]]; then default=off; fi
    printf '%-18s %-6s %-8s %-32s %s\n' "$name" "$port" "$default" "$dir" "${PORT_SOURCE[$name]}"
  done
  echo
  if [[ -f "$LOCAL_OVERRIDES" ]]; then echo "Machine settings: $LOCAL_OVERRIDES"; else echo "No local-up.local.sh (see local-up.local.example.sh in the kit)"; fi
}

ask() { # ask "prompt" -> answer on stdout (empty without a terminal)
  local ans=""
  if [[ -t 0 ]]; then read -rp "$1" ans </dev/tty || true; fi
  echo "$ans"
}

unique_dirs() { # unique_dirs <service entries...> -> one repo dir per line
  local svc dir seen=" "
  for svc in "$@"; do
    IFS='|' read -r _ dir _ <<<"$svc"
    if [[ "$seen" != *" $dir "* ]]; then
      seen+="$dir "
      echo "$dir"
    fi
  done
}

# Kills the process group holding the port (the whole `npm run dev` / `nx serve` tree),
# falling back to the single pid when the group is ours or init's.
free_port() {
  local port=$1 pid pgid
  for pid in $(listener_pids "$port"); do
    pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')
    if [[ -n "$pgid" && "$pgid" != 1 && "$pgid" != "$MY_PGID" ]]; then
      kill -TERM -- "-$pgid" 2>/dev/null || true
    else
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  for _ in {1..20}; do
    is_listening "$port" || return 0
    sleep 0.25
  done
  for pid in $(listener_pids "$port"); do kill -KILL "$pid" 2>/dev/null || true; done
  sleep 0.5
  ! is_listening "$port"
}

# --- Git ------------------------------------------------------------------------
fetch_repos() { # fetch origin for every given repo at once
  local dir key
  echo "Fetching origin for $# repos..."
  for dir in "$@"; do
    [[ -d "$ROOT/$dir/.git" ]] || continue
    key=${dir//\//_}
    (
      if GIT_TERMINAL_PROMPT=0 timeout 60 git -C "$ROOT/$dir" fetch --quiet origin >"$TMP_DIR/$key.fetch" 2>&1; then
        echo ok
      else
        echo fail
      fi >"$TMP_DIR/$key.fetch-status"
    ) &
  done
  wait
}

repo_state() { # repo_state <dir> -> "branch|behind|ahead|dirty"
  local dir=$ROOT/$1 branch behind=0 ahead=0 dirty=0
  branch=$(git -C "$dir" branch --show-current 2>/dev/null || true)
  if [[ -n "$branch" ]] && git -C "$dir" rev-parse -q --verify "origin/$branch" >/dev/null 2>&1; then
    read -r ahead behind < <(git -C "$dir" rev-list --left-right --count "HEAD...origin/$branch")
  fi
  if [[ -n "$(git -C "$dir" status --porcelain --untracked-files=no 2>/dev/null)" ]]; then dirty=1; fi
  echo "${branch:--}|$behind|$ahead|$dirty"
}

git_info() { # git_info <dir> -> coloured "branch ↓behind ↑ahead ●"
  local branch behind ahead dirty out
  IFS='|' read -r branch behind ahead dirty <<<"$(repo_state "$1")"
  case "$branch" in
    main | master | development | -) out="$branch" ;;
    *) out="\e[33m$branch\e[0m" ;;
  esac
  if ((behind > 0)); then out+=" \e[36m↓$behind\e[0m"; fi
  if ((ahead > 0)); then out+=" \e[35m↑$ahead\e[0m"; fi
  if ((dirty == 1)); then out+=" \e[31m●\e[0m"; fi
  printf '%s' "$out"
}

update_repos() { # fast-forward every selected repo and remember which lockfiles changed
  local dir key branch before after status out
  echo "Updating from origin:"
  for dir in $(unique_dirs "${selected[@]}"); do
    [[ -d "$ROOT/$dir/.git" ]] || continue
    key=${dir//\//_}
    branch=$(git -C "$ROOT/$dir" branch --show-current)
    before=$(git -C "$ROOT/$dir" rev-parse HEAD)
    if [[ -z "$branch" ]]; then
      status="detached HEAD, skipped"
    elif [[ "$(cat "$TMP_DIR/$key.fetch-status" 2>/dev/null)" != ok ]]; then
      status="\e[31mFETCH FAILED\e[0m: $(grep -m1 -E 'fatal|error' "$TMP_DIR/$key.fetch" 2>/dev/null || echo "timed out")"
    elif ! git -C "$ROOT/$dir" rev-parse -q --verify "origin/$branch" >/dev/null; then
      status="no origin/$branch (local-only branch)"
    elif out=$(git -C "$ROOT/$dir" merge --ff-only "origin/$branch" 2>&1); then
      after=$(git -C "$ROOT/$dir" rev-parse HEAD)
      if [[ "$before" == "$after" ]]; then
        status="up to date"
      else
        status="\e[32mupdated\e[0m (+$(git -C "$ROOT/$dir" rev-list --count "$before..$after") commits)"
      fi
    else
      status="\e[31mPULL FAILED\e[0m: $(grep -m1 -iE 'error|fatal|not possible' <<<"$out" || tail -1 <<<"$out")"
    fi
    after=$(git -C "$ROOT/$dir" rev-parse HEAD)
    if [[ "$before" != "$after" ]] && ! git -C "$ROOT/$dir" diff --quiet "$before" "$after" -- package-lock.json uv.lock; then
      lock_changed[$dir]=1
    fi
    printf '  %-32s %s %b\n' "$dir" "$(pad "$(git_info "$dir")" 56)" "$status"
  done
  echo
}

# --- Dependencies ---------------------------------------------------------------
install_deps() {
  local dir reason log printed=false
  for dir in $(unique_dirs "${selected[@]}"); do
    reason=""
    if [[ -n "${lock_changed[$dir]:-}" ]]; then
      reason="lockfile changed"
    elif [[ -f "$ROOT/$dir/package-lock.json" && ! -d "$ROOT/$dir/node_modules" ]]; then
      reason="node_modules missing"
    # npm stamps node_modules/.package-lock.json on install; a newer lockfile means a pull or
    # branch switch outside this script changed the deps
    elif [[ -f "$ROOT/$dir/node_modules/.package-lock.json" &&
      "$ROOT/$dir/package-lock.json" -nt "$ROOT/$dir/node_modules/.package-lock.json" ]]; then
      reason="node_modules outdated"
    elif [[ -f "$ROOT/$dir/uv.lock" && ! -d "$ROOT/$dir/.venv" ]]; then
      reason=".venv missing"
    fi
    [[ -n "$reason" ]] || continue

    if [[ "$printed" == false ]]; then
      echo "Installing dependencies:"
      printed=true
    fi
    mkdir -p "$LOG_DIR"
    log="$LOG_DIR/install-$dir.log"
    printf '  %-32s %-22s ' "$dir" "($reason)"
    if (
      cd "$ROOT/$dir"
      if [[ -f uv.lock ]]; then uv sync; fi
      if [[ -f package-lock.json ]]; then
        npm install --no-audit --no-fund
        # npm skips rewriting it when nothing changed; touch so the next run is not flagged again
        if [[ -f node_modules/.package-lock.json ]]; then touch node_modules/.package-lock.json; fi
      fi
    ) >"$log" 2>&1; then
      printf '\e[32m✓ installed\e[0m\n'
    else
      printf '\e[31m✗ failed\e[0m, see %s\n' "$log"
    fi
  done
  if [[ "$printed" == true ]]; then echo; fi
}

# --- Branches (the applet's branch picker runs these) ---------------------------
service_entry() { # service_entry <name> -> its SERVICES line
  local svc
  for svc in "${SERVICES[@]}"; do
    if [[ "${svc%%|*}" == "$1" ]]; then
      echo "$svc"
      return 0
    fi
  done
  echo "Unknown service: $1. Available: $(printf '%s ' "${SERVICES[@]%%|*}")" >&2
  return 1
}

uncommitted_count() { git -C "$ROOT/$1" status --porcelain --untracked-files=no | wc -l; }

# Tab-separated: "repo <dir> <branch> <behind> <ahead> <uncommitted>", then one line per branch,
# newest commit first: "local|remote <name> <epoch> [*]" (* = checked out; remote = only on origin)
list_branches() {
  local dir=$1 branch behind ahead name date
  local -A is_local=()
  IFS='|' read -r branch behind ahead _ <<<"$(repo_state "$dir")"
  printf 'repo\t%s\t%s\t%s\t%s\t%s\n' "$dir" "$branch" "$behind" "$ahead" "$(uncommitted_count "$dir")"
  while IFS=$'\t' read -r name date; do
    is_local[$name]=1
    printf 'local\t%s\t%s\t%s\n' "$name" "$date" "$(if [[ "$name" == "$branch" ]]; then echo '*'; fi)"
  done < <(git -C "$ROOT/$dir" for-each-ref --sort=-committerdate --format='%(refname:lstrip=2)%09%(committerdate:unix)' refs/heads)
  while IFS=$'\t' read -r name date; do
    if [[ "$name" == HEAD || -n "${is_local[$name]:-}" ]]; then continue; fi
    printf 'remote\t%s\t%s\t\n' "$name" "$date"
  done < <(git -C "$ROOT/$dir" for-each-ref --sort=-committerdate --format='%(refname:lstrip=3)%09%(committerdate:unix)' refs/remotes/origin)
}

# Refused while tracked files are modified, so no change is ever carried to another branch.
# A branch that is only on origin becomes a local branch tracking it.
switch_branch() {
  local dir=$1 branch=$2 changes out
  if ! git check-ref-format --branch "$branch" >/dev/null 2>&1; then
    echo "Not a valid branch name: $branch" >&2
    return 1
  fi
  changes=$(uncommitted_count "$dir")
  if ((changes > 0)); then
    echo "$dir has $changes uncommitted change(s); commit or stash them before switching" >&2
    return 1
  fi
  if ! out=$(git -C "$ROOT/$dir" switch "$branch" 2>&1); then
    echo "$out" >&2
    return 1
  fi
  echo "$dir: switched to $branch"
}

# --- Infra ------------------------------------------------------------------------
# True when the mongod on that port is in replica set MONGO_REPLSET (without mongosh: assume it is)
is_replset() {
  command -v mongosh >/dev/null 2>&1 || return 0
  [[ "$(mongosh --quiet --port "$1" --eval 'db.hello().setName || ""' 2>/dev/null)" == "$MONGO_REPLSET" ]]
}

# start_replset start|restart <port>: mongod as replica set MONGO_REPLSET, in the background.
# restart = a mongod outside the set holds the port; the systemd one is stopped first (sudo, asked).
start_replset() {
  local mode=$1 port=$2 log="$LOG_DIR/mongod-$MONGO_REPLSET.log" pid
  if [[ "$mode" == restart ]]; then
    if ! systemctl is-active --quiet mongod; then
      for pid in $(listener_pids "$port"); do
        printf '  \e[33m:%s is held by %s, which is not replica set %s; stop it yourself\e[0m\n' "$port" "$(describe_pid "$pid")" "$MONGO_REPLSET"
      done
      return 0
    fi
    if [[ ! -t 0 ]] || [[ "$(ask "Stop the systemd mongod (sudo systemctl stop mongod) and start replica set $MONGO_REPLSET? [Y/n] ")" =~ ^[Nn] ]]; then
      printf '\e[33mKeeping the systemd mongod; anything that needs replica set %s will fail.\e[0m\n' "$MONGO_REPLSET"
      return 0
    fi
    sudo systemctl stop mongod
    for _ in {1..40}; do
      is_listening "$port" || break
      sleep 0.25
    done
  fi

  mkdir -p "$LOG_DIR"
  printf '  starting mongod, replica set %s on :%s (log %s) ' "$MONGO_REPLSET" "$port" "$log"
  # --fork returns once the server accepts connections, and keeps it running after the window closes
  if ! mongod --replSet "$MONGO_REPLSET" --port "$port" --dbpath "$MONGO_DBPATH" --fork --logpath "$log" --logappend >/dev/null 2>&1; then
    printf '\e[31m✗ failed, see the log\e[0m\n'
    return 0
  fi
  # A dbpath that never held the set has to be initiated once
  if ! mongosh --quiet --port "$port" --eval 'rs.status().ok' >/dev/null 2>&1; then
    printf '(initiating) '
    mongosh --quiet --port "$port" --eval "rs.initiate({_id: '$MONGO_REPLSET', members: [{_id: 0, host: 'localhost:$port'}]})" >/dev/null 2>&1 || true
  fi
  # Writes fail until this node has been elected primary, a few seconds after start
  for _ in {1..30}; do
    if [[ "$(mongosh --quiet --port "$port" --eval 'db.hello().isWritablePrimary' 2>/dev/null)" == true ]]; then
      printf '\e[32m✓ primary\e[0m\n'
      return 0
    fi
    sleep 0.5
  done
  printf '\e[33mstarted, not primary yet\e[0m\n'
}

check_infra() {
  local svc needs=" " infra_needs entry name port unit line="" units=() containers=() down=() replset=""
  for svc in "${selected[@]}"; do
    IFS='|' read -r _ _ _ _ infra_needs _ <<<"$svc"
    needs+="${infra_needs//,/ } "
  done
  for entry in "${INFRA[@]}"; do
    IFS='|' read -r name port unit <<<"$entry"
    [[ "$needs" == *" $name "* ]] || continue
    if [[ "$unit" == replset ]] && is_listening "$port" && ! is_replset "$port"; then
      line+="$name \e[31m✗ not replica set $MONGO_REPLSET\e[0m  "
      replset="restart|$port"
    elif is_listening "$port"; then
      line+="$name \e[32m✓\e[0m  "
    else
      line+="$name \e[31m✗\e[0m  "
      down+=("$entry")
      case "$unit" in
        docker:*) containers+=("${unit#docker:}") ;;
        replset) replset="start|$port" ;;
        *) units+=("$unit") ;;
      esac
    fi
  done
  [[ -n "$line" ]] || return 0
  printf 'Infra: %b\n' "$line"
  [[ ${#down[@]} -gt 0 || -n "$replset" ]] || { echo; return 0; }

  if [[ -n "$replset" ]]; then start_replset "${replset%%|*}" "${replset#*|}"; fi
  # Docker needs no sudo, so stopped containers are started without asking
  if [[ ${#containers[@]} -gt 0 ]]; then
    echo "  starting docker containers: ${containers[*]}"
    docker start "${containers[@]}" >/dev/null || printf '  \e[31mdocker start failed\e[0m\n'
  fi
  if [[ ${#units[@]} -gt 0 ]]; then
    if [[ "$(ask "Start ${units[*]} with sudo systemctl? [Y/n] ")" =~ ^[Nn] ]] || [[ ! -t 0 ]]; then
      printf '\e[33mContinuing without them; services that need them will fail to connect.\e[0m\n'
      units=()
    else
      sudo systemctl start "${units[@]}"
    fi
  fi
  for entry in "${down[@]}"; do
    IFS='|' read -r name port unit <<<"$entry"
    # start_replset waited for its mongod; declined systemd units are not waited for
    if [[ "$unit" == replset ]] || [[ "$unit" != docker:* && ${#units[@]} -eq 0 ]]; then continue; fi
    printf '  waiting for %s on :%s ' "$name" "$port"
    for _ in {1..60}; do
      is_listening "$port" && break
      sleep 0.5
    done
    if is_listening "$port"; then printf '\e[32m✓\e[0m\n'; else printf '\e[31m✗ still down\e[0m\n'; fi
  done
  echo
}

# --- Ports ------------------------------------------------------------------------
check_ports() {
  local svc name port pid conflicts=() keep=() choice
  for svc in "${selected[@]}"; do
    IFS='|' read -r name _ port _ <<<"$svc"
    is_listening "$port" || continue
    conflicts+=("$name")
    for pid in $(listener_pids "$port"); do
      printf '  \e[33m%-18s :%-5s in use by %s\e[0m\n' "$name" "$port" "$(describe_pid "$pid")"
    done
  done
  [[ ${#conflicts[@]} -gt 0 ]] || return 0

  choice=$(ask "[k] kill them and continue · [s] skip these services · [q] quit  (default s): ")
  case "$choice" in
    q | Q) echo "Cancelled."; exit 0 ;;
    k | K)
      for svc in "${selected[@]}"; do
        IFS='|' read -r name _ port _ <<<"$svc"
        if [[ " ${conflicts[*]} " == *" $name "* ]] && ! free_port "$port"; then
          printf '  \e[31mcould not free :%s, skipping %s\e[0m\n' "$port" "$name"
          continue
        fi
        keep+=("$svc")
      done
      ;;
    *)
      for svc in "${selected[@]}"; do
        [[ " ${conflicts[*]} " == *" ${svc%%|*} "* ]] || keep+=("$svc")
      done
      echo "  skipping: ${conflicts[*]}"
      ;;
  esac
  selected=("${keep[@]}")
  echo
}

# --- Stop -------------------------------------------------------------------------
stop_services() {
  local svc name port pid
  for svc in "${selected[@]}"; do
    IFS='|' read -r name _ port _ <<<"$svc"
    if ! is_listening "$port"; then
      printf '  %-18s :%-5s not running\n' "$name" "$port"
      continue
    fi
    for pid in $(listener_pids "$port"); do
      printf '  %-18s :%-5s %s ' "$name" "$port" "$(describe_pid "$pid")"
    done
    if free_port "$port"; then printf '\e[32m✓ stopped\e[0m\n'; else printf '\e[31m✗ still running\e[0m\n'; fi
  done
}

# --- Ready table ------------------------------------------------------------------
watch_ready() {
  local n=${#selected[@]} start=$SECONDS elapsed ready_count i name port path printed=false
  local -a ready_at=() states=()
  echo "Waiting for services (Ctrl+C stops watching, the services keep running):"
  while true; do
    elapsed=$((SECONDS - start))
    ready_count=0
    for i in "${!selected[@]}"; do
      IFS='|' read -r name _ port path _ <<<"${selected[$i]}"
      if [[ -z "${ready_at[$i]:-}" ]] && is_listening "$port"; then ready_at[$i]=$elapsed; fi
      if [[ -n "${ready_at[$i]:-}" ]]; then
        ready_count=$((ready_count + 1))
        states[$i]="\e[32m✓ ready\e[0m in ${ready_at[$i]}s"
      elif ((elapsed >= READY_TIMEOUT)); then
        states[$i]="\e[31m✗ not up after ${READY_TIMEOUT}s, check its tab\e[0m"
      else
        states[$i]="\e[33m… starting\e[0m ${elapsed}s"
      fi
    done
    local finished=false
    if ((ready_count == n || elapsed >= READY_TIMEOUT)); then finished=true; fi

    if [[ -t 1 || "$finished" == true ]]; then
      if [[ "$printed" == true ]]; then printf '\e[%dA' "$n"; fi
      for i in "${!selected[@]}"; do
        IFS='|' read -r name _ port path _ <<<"${selected[$i]}"
        printf '\e[2K  %-18s %-42s %b\n' "$name" "http://localhost:$port$path" "${states[$i]}"
      done
      printed=true
    fi
    [[ "$finished" == false ]] || break
    sleep 1
  done
}

# --- Inline checklist (drawn in the terminal output, no popup) ---------------
# menu_rows[i] = "name|dir|git info", menu_on[i] = 1/0, menu_cur = highlighted row
menu_rows=()
menu_on=()
menu_cur=0

draw_menu() {
  local i mark name dir info
  printf '\e[2K  \e[1m%-4s %-18s %-32s %s\e[0m\n' "" "SERVICE" "REPO" "BRANCH"
  for i in "${!menu_rows[@]}"; do
    IFS='|' read -r name dir info <<<"${menu_rows[$i]}"
    mark="[ ]"
    [[ "${menu_on[$i]}" == 1 ]] && mark="[\e[32mx\e[0m]"
    if [[ $i -eq $menu_cur ]]; then
      printf '\e[2K\e[36m>\e[0m %b \e[7m%-18s\e[0m %-32s %b\n' "$mark" "$name" "$dir" "$info"
    else
      printf '\e[2K  %b %-18s %-32s %b\n' "$mark" "$name" "$dir" "$info"
    fi
  done
  printf '\e[2K  \e[2m↑/↓ move · Space toggle · a all · n none · Enter start · q quit\e[0m\n'
  printf '\e[2K  \e[2m\e[33myellow\e[0m\e[2m = not main/development · ↓ behind origin (ticked repos are pulled after Enter) · ↑ ahead · ● uncommitted changes\e[0m\n'
}

pick_services() {
  local i key rest name dir n=${#SERVICES[@]} last=""
  [[ -f "$LAST_SELECTION_FILE" ]] && last=" $(cat "$LAST_SELECTION_FILE") "
  for svc in "${SERVICES[@]}"; do
    IFS='|' read -r name dir _ <<<"$svc"
    [[ -n "${repo_info[$dir]:-}" ]] || repo_info[$dir]=$(git_info "$dir")
    menu_rows+=("$name|$dir|${repo_info[$dir]}")
    if [[ -n "$last" && "$last" == *" $name "* ]] || [[ -z "$last" && " ${DEFAULT_OFF[*]} " != *" $name "* ]]; then
      menu_on+=(1)
    else
      menu_on+=(0)
    fi
  done

  printf '\e[?25l'
  echo "Select services to start:"
  draw_menu
  while true; do
    IFS= read -rsn1 key || true
    if [[ "$key" == $'\e' ]]; then
      IFS= read -rsn2 -t 0.05 rest || true
      key+="$rest"
    fi
    case "$key" in
      $'\e[A' | k) menu_cur=$(((menu_cur - 1 + n) % n)) ;;
      $'\e[B' | j) menu_cur=$(((menu_cur + 1) % n)) ;;
      " ") menu_on[menu_cur]=$((1 - menu_on[menu_cur])) ;;
      a) for i in "${!menu_on[@]}"; do menu_on[i]=1; done ;;
      n) for i in "${!menu_on[@]}"; do menu_on[i]=0; done ;;
      "") break ;;
      q | $'\e') echo "Cancelled."; exit 0 ;;
    esac
    printf '\e[%dA' $((n + 3))
    draw_menu
  done
  printf '\e[?25h'

  names=()
  for i in "${!menu_rows[@]}"; do
    [[ "${menu_on[$i]}" == 1 ]] && names+=("${menu_rows[$i]%%|*}")
  done
  [[ ${#names[@]} -gt 0 ]] || { echo "Nothing selected." >&2; exit 1; }
  mkdir -p "$(dirname "$LAST_SELECTION_FILE")"
  echo "${names[*]}" >"$LAST_SELECTION_FILE"
  echo
}

# --- Main ---------------------------------------------------------------------------
# Branch commands act on the repo of the named service (nucleus, auth, ... share one repo)
if [[ "${1:-}" =~ ^--(branches|switch|fetch|pull)$ ]]; then
  if [[ $# -lt 2 || ("$1" == --switch && $# -lt 3) ]]; then
    echo "Usage: ./local-up.sh $1 <service>$(if [[ "$1" == --switch ]]; then echo ' <branch>'; fi)" >&2
    exit 2
  fi
  entry=$(service_entry "$2") || exit 2
  IFS='|' read -r _ dir _ <<<"$entry"
  case "$1" in
    --branches) list_branches "$dir" ;;
    --switch) switch_branch "$dir" "$3" || exit 1 ;;
    --fetch)
      fetch_repos "$dir" >/dev/null
      if [[ "$(cat "$TMP_DIR/${dir//\//_}.fetch-status" 2>/dev/null)" != ok ]]; then
        echo "$dir: fetch failed: $(grep -m1 -E 'fatal|error' "$TMP_DIR/${dir//\//_}.fetch" 2>/dev/null || echo "timed out")" >&2
        exit 1
      fi
      printf '%s: fetched, %b\n' "$dir" "$(git_info "$dir")"
      ;;
    --pull)
      selected=("$entry")
      fetch_repos "$dir" >/dev/null
      update_repos
      install_deps
      ;;
  esac
  exit 0
fi

pull=true
all=false
stop=false
watch=true
in_terminal=false
tunnel=""
names=()
for arg in "$@"; do
  case "$arg" in
    --list)
      for svc in "${SERVICES[@]}"; do echo "${svc%%|*}"; done
      exit 0
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --no-pull) pull=false ;;
    --all) all=true ;;
    --stop) stop=true ;;
    --no-watch) watch=false ;;
    --in-terminal) in_terminal=true ;;
    --tunnel) tunnel=start ;;
    --stop-tunnel) tunnel=stop ;;
    -*)
      echo "Unknown option: $arg (see ./local-up.sh --help)" >&2
      exit 2
      ;;
    *)
      if ! printf '%s\n' "${SERVICES[@]%%|*}" | grep -qxF -- "$arg"; then
        echo "Unknown service: $arg. Available: $(printf '%s ' "${SERVICES[@]%%|*}")" >&2
        exit 2
      fi
      names+=("$arg")
      ;;
  esac
done

# Re-run the rest of the command line in a tab of the local-up window, where sudo, port-conflict
# and install prompts can be answered; the tab closes 5 s after a clean run
if [[ "$in_terminal" == true ]]; then
  rest=()
  for arg in "$@"; do
    if [[ "$arg" != --in-terminal ]]; then rest+=("$(printf '%q' "$arg")"); fi
  done
  if use_local_window; then win=(--tab); else win=(--window --maximize); fi
  mkdir -p "$SCREEN_DIR"
  gnome-terminal "${win[@]}" --title=local-up --working-directory="$ROOT" -- bash -c \
    "$(record_screen local-up)$(printf '%q' "$ROOT/$(basename "${BASH_SOURCE[0]}")") ${rest[*]} && sleep 5 || read -rp 'Something failed (see above). Press Enter to close'"
  exit 0
fi

if [[ "$tunnel" == stop ]]; then
  pids=$(tunnel_pids)
  if [[ -z "$TUNNEL_ID" || -z "$pids" ]]; then
    echo "devtunnel ${TUNNEL_ID:-(no TUNNEL_ID)}: not running"
  else
    # shellcheck disable=SC2086
    kill -TERM $pids
    echo "devtunnel $TUNNEL_ID: stopped"
  fi
  exit 0
fi

# The tunnel gets its own tab; it keeps running while services in other tabs restart
if [[ "$tunnel" == start ]]; then
  if [[ -z "$TUNNEL_ID" ]]; then
    echo "No TUNNEL_ID: set it in $LOCAL_OVERRIDES (see \`devtunnel list\`)" >&2
    exit 2
  elif [[ -n "$(tunnel_pids)" ]]; then
    echo "devtunnel $TUNNEL_ID: already running"
  elif ! command -v devtunnel >/dev/null 2>&1; then
    echo "Not found on PATH: devtunnel" >&2
    exit 1
  else
    if use_local_window; then win=(--tab); else win=(--window --maximize); fi
    mkdir -p "$SCREEN_DIR"
    gnome-terminal "${win[@]}" --title=devtunnel --working-directory="$ROOT" -- bash -c \
      "$(record_screen devtunnel)devtunnel host $TUNNEL_ID; echo; echo \"[devtunnel exited]\"; exec bash"
    echo "devtunnel $TUNNEL_ID: started"
  fi
  if [[ ${#names[@]} -eq 0 && "$all" == false ]]; then exit 0; fi
fi

# Edits to the kit's tracked files are lost or conflict on the next update, and pushed they
# change everyone's setup; say so before anything else happens
KIT_DIR="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
if [[ "$stop" == false ]] && [[ -n "$(git -C "$KIT_DIR" status --porcelain --untracked-files=no 2>/dev/null)" ]]; then
  printf '\e[33mstack-launcher (%s) has local edits; machine-specific settings belong in %s\e[0m\n\n' "$KIT_DIR" "$LOCAL_OVERRIDES"
fi

# No names and no --all: show the checklist (falls back to everything without a terminal)
menu=false
if [[ ${#names[@]} -eq 0 && "$all" == false ]]; then
  if [[ -t 0 && -t 1 && "$stop" == false ]]; then menu=true; else all=true; fi
fi

if [[ "$menu" == true ]]; then
  if [[ "$pull" == true ]]; then
    # shellcheck disable=SC2046
    fetch_repos $(unique_dirs "${SERVICES[@]}")
  fi
  pick_services
fi

# Only start what was asked for (or everything with --all)
selected=()
for svc in "${SERVICES[@]}"; do
  IFS='|' read -r name dir _ <<<"$svc"
  if [[ "$all" == true ]] || [[ " ${names[*]} " == *" $name "* ]]; then
    if [[ -d "$ROOT/$dir" ]]; then
      selected+=("$svc")
    else
      echo "Skipping $name: $ROOT/$dir not found" >&2
    fi
  fi
done

if [[ ${#selected[@]} -eq 0 ]]; then
  echo "No matching services. Use --list to see names." >&2
  exit 1
fi

if [[ "$stop" == true ]]; then
  echo "Stopping:"
  stop_services
  exit 0
fi

if [[ "$pull" == true && "$menu" == false ]]; then
  # shellcheck disable=SC2046
  fetch_repos $(unique_dirs "${selected[@]}")
fi

check_infra
if [[ "$pull" == true ]]; then update_repos; fi
install_deps
check_ports

if [[ ${#selected[@]} -eq 0 ]]; then
  echo "Nothing left to start." >&2
  exit 1
fi

# Fail here rather than open tabs that die with "command not found"
missing=()
for svc in "${selected[@]}"; do
  IFS='|' read -r _ _ _ _ _ cmd <<<"$svc"
  tool=${cmd%% *}
  if ! command -v "$tool" >/dev/null 2>&1 && [[ " ${missing[*]} " != *" $tool "* ]]; then missing+=("$tool"); fi
done
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Not found on PATH: ${missing[*]} (is nvm / uv installed for this user?)" >&2
  exit 1
fi

# The Node services need IPv6 disabled locally; this resets on reboot (DISABLE_IPV6=false to skip).
if [[ "$DISABLE_IPV6" == true && "$(sysctl -n net.ipv6.conf.all.disable_ipv6)" != "1" ]]; then
  echo "Disabling IPv6 (needs sudo)..."
  sudo sysctl -w net.ipv6.conf.all.disable_ipv6=1 >/dev/null
fi

# Add the tabs to the local-up window while any of its tabs is open, else open a new window
if use_local_window; then args=(--tab); else args=(--window --maximize); fi
first=true
prev_nx_name=""
prev_nx_port=""
for svc in "${selected[@]}"; do
  IFS='|' read -r name dir port _ _ cmd <<<"$svc"

  [[ "$first" == true ]] || args+=(--tab)
  first=false

  # Parallel `nx serve` runs in the one monorepo race on nx's workspace files ("Unexpected
  # token"), so each waits (max 5 min) until the previous one listens before building.
  wait_prev=""
  if [[ "$cmd" == "npx nx "* ]]; then
    if [[ -n "$prev_nx_port" ]]; then
      wait_prev="echo \"Waiting for $prev_nx_name (:$prev_nx_port) to start first...\"; for i in {1..150}; do ss -ltnH \"sport = :$prev_nx_port\" | grep -q . && break; sleep 2; done; "
    fi
    prev_nx_name=$name
    prev_nx_port=$port
  fi

  rm -f "$EXIT_DIR/$name.exit"
  args+=(
    --title="$name"
    --working-directory="$ROOT/$dir"
    --command="bash -c '$(record_screen "$name")$wait_prev$cmd; echo \$? > \"$EXIT_DIR/$name.exit\"; echo; echo \"[$name exited]\"; exec bash'"
  )
done
mkdir -p "$EXIT_DIR" "$SCREEN_DIR"

# --command is deprecated but is the only way to open several tabs in one call
gnome-terminal "${args[@]}" 2>/dev/null
echo "Started: $(for s in "${selected[@]}"; do printf '%s ' "${s%%|*}"; done)"
echo
if [[ "$watch" == true ]]; then watch_ready; fi
