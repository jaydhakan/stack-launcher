#!/usr/bin/env bash
# Links this kit into place. Safe to run again; an update is `git pull && ./install.sh --reload`
# (the applet's "Update" item does exactly that).
#
#   ./install.sh                 # link local-up.sh into the AICL root and the applet into Cinnamon
#   ./install.sh --root PATH     # the folder that holds the AICL repos (default: where this kit is cloned)
#   ./install.sh --reload        # also reload the applet so it runs the new code
#   ./install.sh --yes           # enable the applet in the panel without asking
#
# Links, not copies: the AICL root's local-up.sh and the applet folder point into this clone,
# so pulling the kit updates both. Machine-specific changes go in <root>/local-up.local.sh.

set -euo pipefail

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UUID="aicl-local-monitor@aicl"
APPLETS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/cinnamon/applets"
BACKUP_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/aicl-local-up/backup"

root="$(dirname "$KIT")"
reload=false
yes=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) root="$2"; shift ;;
    --reload) reload=true ;;
    --yes) yes=true ;;
    -h | --help) sed -n '2,/^$/{/^$/q;s/^# \{0,1\}//;p}' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Unknown option: $1 (see ./install.sh --help)" >&2; exit 2 ;;
  esac
  shift
done

root="$(cd "$root" && pwd)"
if ! compgen -G "$root/aicl-*" >/dev/null && ! compgen -G "$root/aicollect-*" >/dev/null; then
  echo "No AICL repos in $root. Pass --root <folder that holds the repos>." >&2
  exit 1
fi

# link <target> <path>: a real file/folder already at <path> is moved to the backup folder first
# (not left beside it: a second folder with the same applet uuid would confuse Cinnamon)
link() {
  local target=$1 path=$2 backup
  if [[ -L "$path" ]]; then
    rm "$path"
  elif [[ -e "$path" ]]; then
    mkdir -p "$BACKUP_DIR"
    backup="$BACKUP_DIR/$(basename "$path").$(date +%Y%m%d-%H%M%S)"
    mv "$path" "$backup"
    echo "  backed up the old $path to $backup"
  fi
  ln -s "$target" "$path"
  echo "  $path -> $target"
}

echo "Linking (kit: $KIT):"
link "$KIT/local-up.sh" "$root/local-up.sh"

if ! command -v cinnamon >/dev/null 2>&1; then
  echo "Cinnamon not found: skipped the applet. local-up.sh works on its own."
  exit 0
fi
mkdir -p "$APPLETS_DIR"
link "$KIT/$UUID" "$APPLETS_DIR/$UUID"

if [[ "$root/local-up.sh" != "$HOME/projects/AICL/local-up.sh" ]]; then
  echo "Note: right-click the applet > Configure and set the local-up.sh path to $root/local-up.sh"
fi

enabled=$(gsettings get org.cinnamon enabled-applets)
if [[ "$enabled" != *"$UUID"* ]]; then
  answer=y
  if [[ "$yes" == false ]]; then read -rp "Add the applet to the panel? [Y/n] " answer </dev/tty || answer=n; fi
  if [[ ! "$answer" =~ ^[Nn] ]]; then
    next_id=$(($(grep -oE ":[0-9]+'" <<<"$enabled" | tr -d ":'" | sort -n | tail -1) + 1))
    gsettings set org.cinnamon enabled-applets "${enabled%]}, 'panel1:right:0:$UUID:$next_id']"
    echo "Added to the panel (instance $next_id)."
  fi
elif [[ "$reload" == true ]]; then
  gdbus call --session --dest org.Cinnamon --object-path /org/Cinnamon \
    --method org.Cinnamon.ReloadXlet "$UUID" APPLET >/dev/null
  echo "Reloaded the applet."
fi
echo "Done ($(git -C "$KIT" log -1 --format='%h %s' 2>/dev/null || echo 'not a git clone'))."
