#!/usr/bin/env bash
# Updates this kit from GitHub (the applet's "Update" item runs it).
#
#   ./update.sh            # fetch, fast-forward, relink and reload the applet
#   ./update.sh --check    # print "<commits behind> <short sha> <edited tracked files>" only
#
# Fetches over HTTPS when origin is a GitHub SSH URL: the repo is public, and SSH keys can be
# flaky or prompt from a keyring, so reading never depends on them (pushing still uses SSH).
# Falls back to plain `git fetch origin` (e.g. a private repo).

set -euo pipefail
cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"

branch=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}')
branch=${branch#origin/}
url=$(git remote get-url origin)
https=""
if [[ "$url" =~ ^git@github\.com[^:]*:(.+)$ ]]; then https="https://github.com/${BASH_REMATCH[1]}"; fi

export GIT_TERMINAL_PROMPT=0
if ! { [[ -n "$https" ]] && timeout 30 git fetch -q "$https" "+refs/heads/$branch:refs/remotes/origin/$branch" 2>/dev/null; }; then
  GIT_SSH_COMMAND="ssh -o BatchMode=yes" timeout 30 git fetch -q origin
fi

if [[ "${1:-}" == "--check" ]]; then
  echo "$(git rev-list --count 'HEAD..@{u}') $(git rev-parse --short HEAD) $(git status --porcelain --untracked-files=no | wc -l)"
  exit 0
fi

git merge -q --ff-only '@{u}'
./install.sh --reload
