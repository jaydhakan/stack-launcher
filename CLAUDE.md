# stack-launcher: rules for AI agents

## Git (always)
- **Commit to `main` only.** No other branches, tags or PR branches. Push with `git push origin main`.
- **Never add Claude (or any AI) as co-author.** No `Co-Authored-By:` trailer, no "Generated with Claude Code" line, in commits or anywhere else. Commits carry only the repo's local git identity (Jay Dhakan).
- Remote: `git@github.com-PR:jaydhakan/stack-launcher.git` (the `github.com-PR` SSH host alias picks the personal key). This repo is **public**: never commit secrets, `.env` values, tokens or machine-specific files.

## What this is
- **`local-up.sh`**: starts a local stack, one gnome-terminal tab per service. Inline checklist (branch, ↓behind ↑ahead, ● dirty), parallel `git fetch`, then `merge --ff-only` of each selected repo, infra check (offers `sudo systemctl start`), dependency install, port-conflict check (kill / skip / quit), tabs, live ready table. Flags: `--all --no-pull --no-watch --stop [names] --list --help`, env `READY_TIMEOUT`. Also `--in-terminal` (re-run in a tab of the local-up window; the applet's starts use it), `--tunnel [names]` / `--stop-tunnel` (`devtunnel host $TUNNEL_ID` in its own tab), and `--branches|--switch|--fetch|--pull <service> [branch]` for the applet's branch picker (tab-separated output from `--branches`).
- **`aicl-local-monitor@aicl/`**: Cinnamon panel applet. `applet.js` holds the UI. `stats.py` is the data helper (stdlib only), which prints one JSON snapshot per call, `--brief` while the menu is closed and `--full` while it's open.
- **`install.sh`**: links (never copies) `<root>/local-up.sh` and `~/.local/share/cinnamon/applets/aicl-local-monitor@aicl` into this clone. It moves real files it would replace to `~/.cache/aicl-local-up/backup/`; a second folder with the same applet uuid would confuse Cinnamon. `--reload` calls `org.Cinnamon.ReloadXlet`.
- **`update.sh`**: the applet's update path. `--check` prints `<behind> <sha> <edited>`. With no flag it fetches, runs `merge --ff-only @{u}` and then `install.sh --reload`. It fetches over HTTPS when origin is a GitHub SSH URL, because SSH keys here are flaky (GitHub intermittently rejects the personal key and falls back to the work one) and a keyring can prompt. It falls back to `git fetch origin`. Pushing still uses SSH (`github.com-PR`), so retry a push that gets `Permission denied (publickey)`.
- **`SETUP_PROMPT.md`**: what a teammate's Claude Code follows to install, adapt and test on their machine. Keep it in step with any behaviour change.

## Design decisions (keep them)
- **One source of truth for services.** The `SERVICES` / `INFRA` / `DEFAULT_OFF` arrays in `local-up.sh`. `stats.py` parses them, and the per-machine overrides, with regexes, so the applet never keeps its own list. Keep the array syntax parseable: one quoted `"a|b|c"` entry per line, closing `)` on its own line.
- **Ports come from each repo's own `.env`.** The port column `KEY:default` means: KEY from `<repo>/.env` (read with a single-key regex, never the whole file), else the app's built-in default from its config code. A plain number is fixed (the Vite UIs), and `{port}` in a command is replaced with the resolved port. `resolve_config` in `local-up.sh` bakes this into `SERVICES`/`INFRA` once, so the rest of the script sees plain values. `stats.py` (`resolve_port`) must mirror it exactly: local file, then `.env`, then default. `--help` shows each port's source.
- **Per-machine settings go only in `<root>/local-up.local.sh`** (git-ignored; template `local-up.local.example.sh`): `SERVICE_PORT[..]`, `SERVICE_DIR[..]`, `INFRA_PORT[..]`, `INFRA_UNIT[..]`, or whole `SERVICES`/`INFRA`/`DEFAULT_OFF` arrays (last definition wins). Never put one machine's values in tracked files: the applet's self-update is `git pull --ff-only`, and a pushed personal edit breaks everyone. Both `local-up.sh` and the applet warn when the clone has edits to tracked files.
- **`ROOT` is the directory of the `local-up.sh` link** (the AICL root), not the clone. Always run it through the link.
- **nx services start one at a time.** Parallel `nx serve` in one monorepo races on `.nx/workspace-data` and fails with `NX Unexpected token ']'`. Each later nx tab waits (max 5 min) for the previous one's port.
- **nvm is sourced at the top of `local-up.sh`** when `npx` is missing, before `set -u` (nvm.sh trips it). The applet and launchers start from Cinnamon's environment, which never read `~/.bashrc`. The tabs inherit the PATH. A preflight stops with `Not found on PATH: ...` before opening tabs.
- **Deps are stale when** `node_modules` is missing, our pull changed `package-lock.json` / `uv.lock`, or `package-lock.json` is newer than `node_modules/.package-lock.json` (npm's install stamp). After a successful install the stamp is touched, since npm skips rewriting it when nothing changed.
- **IPv6 is disabled by default** (`DISABLE_IPV6=true` in `local-up.sh`, a sudo `sysctl` once per boot). The Node services need it, so keep the default `true`. Never flip it, and never suggest `false` just to avoid the sudo prompt.
- **Exit markers.** Each tab runs `cmd; echo $? > ~/.cache/aicl-local-up/exit/<name>.exit`. The applet shows a red `✗ exited (code)` and clears `starting…`. `--stop` kills the tab's whole process group, so stopped services leave no marker.
- **Selection** lives in `~/.cache/aicl-local-up.last` and is shared by the checklist and the applet.
- **One terminal window.** Each tab writes `$GNOME_TERMINAL_SCREEN $GNOME_TERMINAL_SERVICE` to `~/.cache/aicl-local-up/screen/<tab>`. Later starts pick any of those screens that is still alive (`gdbus introspect`) and open `--tab`s there; `gnome-terminal --tab` only joins that window when **both** variables are set (screen alone opens a new window on 3.52). Otherwise both are unset, so tabs never land in the user's own terminal.
- **Infra units:** a systemd name (asks for sudo), `docker:<container>` (`docker start`, no prompt) or `replset` (`mongod --replSet $MONGO_REPLSET --dbpath $MONGO_DBPATH --fork`, `rs.initiate()` on a fresh dbpath, waits for primary; asks before `sudo systemctl stop mongod` when a non-replica-set mongod holds the port). The defaults stay systemd; machines opt in through `INFRA_UNIT[..]`.
- **Branch switching** is refused while tracked files are modified, so no change is carried to another branch. Pull is fetch + `merge --ff-only` + the dependency check. After a switch, or a pull that moved HEAD, the applet only *offers* to restart that repo's running services, in one run so nx still starts one at a time.
- **The dev tunnel** listens on no local port, so it is found by process (`^devtunnel host <id>`, anchored so the tab's `bash -c` wrapper never matches) in both `local-up.sh` and `stats.py`. No `TUNNEL_ID` = no tunnel row.
- **Memory = resident − shared** (`/proc/<pid>/statm`), not RSS. RSS counts Chrome's shared pages once per process (20 GB "used" on a 15 GB box), and exact PSS via `smaps_rollup` takes ~3 s for all processes, too slow for a live view.

- **Reset to origin and Push to client** (branch picker views, `--reset[-preview]`, `--client-sync`).
  - Both always show what changes before acting: commits lost, files discarded, commits added or removed on the client.
  - `--reset` is `reset --hard origin/<checked-out branch>`. Untracked files are kept.
  - Before it, local-only commits and uncommitted changes are saved under `refs/local-up/backup/<timestamp>/{head,wip}/<branch>`. Hidden refs; the timestamp comes first because branch names contain `/`. `--reset-undo` restores both, and backups are pruned after 30 days.
  - `--client-sync` deploys **origin's** commit of a branch, never local work, to `CLIENT_REMOTE` (only repos that have that remote). It refuses a non-fast-forward with exit 3 unless `--force`, and pushes with `--force-with-lease` pinned to the inspected commit. `--dry-run` prints `plan/new/drop/local` lines.
  - Never make force the default: the client's `client-main` carries its own deploy commits.

## Cinnamon applet gotchas
- **The applet must run on Cinnamon 5.x (Mint 21) and 6.x (Mint 22).** The team uses both.
  - Cinnamon's `Params.parse` throws on any unknown option, so a 6.x-only option breaks 5.x (`Unrecognized parameter`). Example: `ModalDialog({ destroyOnClose })`.
  - Feature-detect with try/catch (see `newModalDialog`) instead of checking version numbers. On 5.x, `ModalDialog.close()` only hides, so destroy the dialog after the fade.
  - Check new UI code against `/usr/share/cinnamon/js/ui/*.js` of the older version, and test on both if you can.
- **Markup at index 0 of a clickable menu row's label is dropped.** Start such markup with a plain space: `` ` ${paint(...)}` ``.
- **A menu's columns are aligned across all its items.** Put a multi-part row into one `St.BoxLayout` and `addActor(box, { span: -1, expand: true })`, or it gets pushed right.
- **The menu must fit a 1080p screen.** Hence the compact rows (`padding: 1px`) and top memory/CPU side by side.
- **A row that toggles without closing the menu** overrides `activate(event)` and calls `super.activate(event, true)`.
- **Commands** run through `Util.spawnCommandLineAsyncIO("", cb, { argv })`, and anything interactive (sudo, prompts) goes into a `gnome-terminal`.

## Testing
- **Run `./tests/smoke.sh` before every push.** CI (`.github/workflows/ci.yml`) runs it plus `shellcheck -S warning` on each push to `main`, because everyone's applet updates from it. Add a check there for every new CLI path. It works in a temp root and cache with a stub terminal and npm, and never touches real repos.
- Otherwise, run the real thing, twice:
- **Syntax:** `bash -n local-up.sh install.sh`, `node --check aicl-local-monitor@aicl/applet.js`, and `python3 aicl-local-monitor@aicl/stats.py --full --localup <root>/local-up.sh | python3 -m json.tool`.
- **Dry runs:** put stub `gnome-terminal` / `npx` / `npm` scripts that echo their args first on `PATH`. Use `READY_TIMEOUT=3`. To mimic the applet's environment, use `env -i HOME=$HOME PATH=<cinnamon PATH>`.
- **Interactive checklist:** drive it with `script -qc ./local-up.sh /dev/null`, piping keys in (`\e[B`, space, `\r`).
- **Applet,** through DBus:
  ```bash
  A="imports.ui.appletManager.getRunningInstancesForUuid('aicl-local-monitor@aicl')[0]"
  ev() { gdbus call --session --dest org.Cinnamon --object-path /org/Cinnamon --method org.Cinnamon.Eval "$1"; }
  gdbus call --session --dest org.Cinnamon --object-path /org/Cinnamon --method org.Cinnamon.ReloadXlet aicl-local-monitor@aicl APPLET
  ev "$A.menu.open(true); 'ok'"; sleep 4; gnome-screenshot -f /tmp/menu.png; ev "$A.menu.close(true); 'ok'"
  ```
  Check `~/.xsession-errors` for `Loaded applet aicl-local-monitor@aicl` and for JS errors.
- **Shared state.** Never leave the user's selection file or exit markers changed after a test. Ask before stopping or starting their real services.
- **Never kill with `pkill -f <pattern>`** when the pattern also appears in your own command line: it kills your own shell.

## Style
- Bash: `set -euo pipefail`. Use `if` rather than a trailing `[[ ]] && x` as a function's last line. Avoid `((x++))` from 0 under `set -e`.
- Comments say why, not what, in 1-2 lines. Keep the comment density of the surrounding code.
- No new dependencies: bash, coreutils, `ss`, `lsof`, git, python3 stdlib, gjs.
