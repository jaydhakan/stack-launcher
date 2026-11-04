# stack-launcher: audit and feature roadmap

Written 2026-11-04, after the first five commits from Jay and Nirav (local-up.sh, the applet, ports from `.env`, branch picker, tunnel, Docker/replica-set infra, reset to origin, push to client).

Each item has a **priority**, **why** it matters, **what** to build, and any **changes to current features**. Effort is a rough size: S = an hour or two, M = half a day, L = a day or more.

| # | Feature | Priority | Effort |
|---|---|---|---|
| 1 | [CI checks on every push](#1-ci-checks-on-every-push) | ✅ done | S |
| 2 | [Service logs to files, and a Logs button](#2-service-logs-to-files-and-a-logs-button) | P1 | M |
| 3 | [Desktop notification when a service crashes](#3-desktop-notification-when-a-service-crashes) | P1 | S |
| 4 | [`--doctor`: one command that checks the whole setup](#4---doctor-one-command-that-checks-the-whole-setup) | P1 | M |
| 5 | [`.env` drift check against `.env.example`](#5-env-drift-check-against-envexample) | P1 | S |
| 6 | [One source of truth for config (`--config-json`)](#6-one-source-of-truth-for-config---config-json) | P1 | M |
| 7 | [Safer push to client: merge mode and a deploy log](#7-safer-push-to-client-merge-mode-and-a-deploy-log) | P1 | M |
| 8 | [Backup ref before reset](#8-backup-ref-before-reset) | ✅ done | S |
| 9 | [Multiple projects (AICL becomes one project file)](#9-multiple-projects-aicl-becomes-one-project-file) | P2 | L |
| 10 | [Real health checks instead of "port is open"](#10-real-health-checks-instead-of-port-is-open) | P2 | M |
| 11 | [Memory guard and orphan cleanup](#11-memory-guard-and-orphan-cleanup) | P2 | M |
| 12 | [Branch picker: stash and switch, new branch, prune](#12-branch-picker-stash-and-switch-new-branch-prune) | P2 | M |
| 13 | [Pending migration warning after a pull](#13-pending-migration-warning-after-a-pull) | P2 | M |
| 14 | [Jump to a service's terminal tab](#14-jump-to-a-services-terminal-tab) | P2 | S |
| 15 | [Faster nx start (`nx run-many`)](#15-faster-nx-start-nx-run-many) | P3 | M |
| 16 | ["What's new" before updating, and uninstall](#16-whats-new-before-updating-and-uninstall) | P3 | S |
| 17 | [Split `local-up.sh` into modules](#17-split-local-upsh-into-modules) | P3 | M |
| 18 | [Commit guard for secrets and machine files](#18-commit-guard-for-secrets-and-machine-files) | P3 | S |
| 19 | [Memory trend per service](#19-memory-trend-per-service) | P3 | M |

**Priorities:**
- **P1:** do next. These prevent breakage, or answer "why did it fail?".
- **P2:** clear wins once P1 is done.
- **P3:** nice to have.

---

## P1

### 1. CI checks on every push
> **Done:** `.github/workflows/ci.yml` runs `tests/smoke.sh` (syntax, Cinnamon 6-only API guard, CLI, a stubbed start, and reset / undo / client push against throwaway repos) and `shellcheck -S warning`.

**Why:**
- Two people now push straight to `main`, and the applet updates itself from it, so one bad push lands on everyone's machine at the next update.
- This has already happened once: a Cinnamon 6-only dialog option broke the branch picker on Mint 21 (`96a1b26`).

**What:** a GitHub Actions workflow on push that runs:
- `bash -n` and `shellcheck` (warnings only at first) on `local-up.sh`, `install.sh` and `update.sh`;
- `node --check applet.js` and `python3 -m py_compile stats.py`;
- a guard that fails on known Cinnamon 6-only API use (`destroyOnClose`, etc.), the same list as the `CLAUDE.md` gotcha;
- a dry-run smoke test: `./local-up.sh --help`, `--list`, and a stubbed `--no-pull --no-watch <service>` in a fake root, like the tests in `CLAUDE.md`.

**Changes to current features:** none. Add a status badge to the README.

### 2. Service logs to files, and a Logs button
**Why:**
- A service's output lives only in its terminal tab. Close the tab, or let it scroll, and the reason for a crash is gone.
- We already had to rerun `nx serve agrisphere` by hand just to see that `exceljs` was missing.

**What:**
- Each tab runs its command through `tee` (or `script -q`) into `~/.cache/aicl-local-up/logs/<service>.log`, keeping the last N MB.
- Applet: a 📄 button per row opens the log (`less +G` in a tab, or the default text viewer).
- The red `✗ exited (N)` row shows the last error line from the log.
- `local-up.sh --logs <service> [-f]`.

**Changes to current features:**
- **Tab command:** the exit-marker wrapper becomes `cmd 2>&1 | tee …; echo ${PIPESTATUS[0]} > …exit`. `PIPESTATUS`, not `$?`, or every exit code reads as tee's.
- **`--stop`:** it kills the process group, which includes the `tee`. That's fine.

### 3. Desktop notification when a service crashes
**Why:** the red `✗` only shows while the menu is open. A backend that dies in the background is noticed only when the UI starts failing.

**What:** when a service gets an exit marker, or isn't up within `READY_TIMEOUT` after a start, send `notify-send "auth exited (1)" "<last log line>"` with a Restart action. Exit code 130 (your own Ctrl+C) is excluded.

**Changes to current features:**
- **Exit 130:** today it shows red `✗ exited (130)`. Show it grey, as "stopped", since it wasn't a crash.

### 4. `--doctor`: one command that checks the whole setup
**Why:** setup problems so far were found one at a time, by failing:
- nvm not on PATH from the applet;
- stale `node_modules`;
- port and infra unit names;
- Cinnamon 5 vs 6.

A teammate's first run, and `SETUP_PROMPT.md`, should get one report instead.

**What:** `./local-up.sh --doctor` prints ✓/✗ for:
- tools (`node`/`npx` via nvm, `uv`, `git`, `ss`, `lsof`, `gnome-terminal`, `python3`) and the Cinnamon version;
- each infra port and unit;
- each repo: cloned, branch, behind/ahead, dependencies stale, `.env` present, and the `.env` drift from #5;
- ports in use by something else, the IPv6 state, `local-up.local.sh` present, and edits in the kit's tracked files;
- applet installed and enabled, `update.sh --check`.

The applet gets a "Run doctor" item.

**Changes to current features:** `SETUP_PROMPT.md` Steps 1 and 3 become "run `--doctor` and fix what it reports".

### 5. `.env` drift check against `.env.example`
**Why:** pulls add new env keys, and a missing key makes a service fail at startup or later at runtime. On Jay's machine today, keys listed in `.env.example` but missing from `.env`:

| Repo | Missing keys |
|---|---|
| node monorepo | 12 |
| Python API | 27 |
| form-builder API | 43 |
| form-builder UI | 1 |

Some are optional, but nothing tells you which new ones matter.

**What:**
- Compare key **names** only (never values; same single-key reading as the port lookup). Report keys added to `.env.example` since your last pull, or since you last acknowledged them.
- Show it in the pull log ("+3 new env keys in aicl-monorepo-node-api-server: X, Y, Z"), in `--doctor`, and as a ⚠ on the applet row.
- Keep acknowledged keys per repo in `~/.cache/aicl-local-up/env-ack/`, so optional keys stop nagging.

**Changes to current features:** `update_repos` gets one extra line per repo whose `.env.example` changed in the pull.

### 6. One source of truth for config (`--config-json`)
**Why:** `stats.py` re-implements `local-up.sh`'s config resolution in Python: `.env` ports, `local-up.local.sh` overrides, last-definition-wins arrays. Every new setting must be written twice, and the two copies will drift. The tunnel feature already had to parse `TUNNEL_ID` a second time in `stats.py` (`tunnel_state`).

**What:**
- `local-up.sh --config-json` prints the fully resolved `SERVICES`, `INFRA`, `DEFAULT_OFF`, client and tunnel settings as JSON.
- `stats.py` calls it, caching by the mtimes of `local-up.sh`, `local-up.local.sh` and the repos' `.env` files, and drops its own parsing.

**Changes to current features:**
- `parse_localup`, `resolve_port`, `env_value` and `assignments` in `stats.py` go away.
- The `CLAUDE.md` rule "stats.py must mirror resolve_config" becomes "stats.py reads `--config-json`".

### 7. Safer push to client: merge mode and a deploy log
**Why:**
- Today `origin/main → client/client-main` is not a fast-forward: `client-main` carries its own commits (`Update deploy.yaml`, `Merge branch 'main' into client-main`). The only way through is a force push that deletes them.
- The history shows the intended workflow is **merging** main into `client-main`, which the tool can't do.
- Deploys to a client are consequential, but nothing records who pushed what, and when.

**What:**
- A third option in the plan view, **"Merge origin/main into client-main"**:
  - done in a temporary worktree (`git worktree add`), so the user's checkout is never touched;
  - a fast-forward-safe push afterwards;
  - on conflicts, abort and show the conflicting files.
- A deploy log, `~/.cache/aicl-local-up/deploys.log`, with time, user, repo, `source → target`, old → new commit, and whether it was forced. The client view shows "last deployed: 2h ago by jay (a1b2c3d)".
- Retry once on `Permission denied (publickey)`. GitHub SSH here is intermittent (see `update.sh`).

**Changes to current features:**
- `client_sync` gains `--merge`.
- The client menu's "main" becomes the repo's real default branch (`origin/HEAD`; two repos here don't report one, and the docs repo works on `development`). Hide the "→ client/main" option unless that branch exists on the client.

### 8. Backup ref before reset
> **Done:** `--reset` saves the old HEAD and the uncommitted changes (`git stash create`) under `refs/local-up/backup/<timestamp>/{head,wip}/<branch>`. `--reset-undo` and the picker's **Undo reset** button restore both. Backups are pruned after 30 days.

**Why:** `--reset` relies on `git reflog` for undo, which few people know how to use. Local commits are the one thing a reset must never lose for real.

**What:**
- Before resetting, if there are local-only commits, create `refs/local-up/backup/<branch>/<date>` (or a `backup/<branch>-<date>` branch).
- The success message and the picker show "Undo: restore backup".
- `--reset-undo <service>` resets back to it.
- Prune backups older than 30 days.

**Changes to current features:**
- `reset_to_origin` writes the ref.
- The reset view says "kept as backup/…" instead of "(still in git reflog)".

---

## P2

### 9. Multiple projects (AICL becomes one project file)
**Why:**
- **The stated goal:** run other projects from this repo too.
- **It's AICL-shaped everywhere:** `SERVICES` / `INFRA` live inside `local-up.sh`, and the uuid, cache paths and texts all say AICL.
- **The repo is public:** AICL's internal repo names, ports and `.env` keys are in it.

**What:**
- `projects/<name>.sh` holds `SERVICES`, `INFRA`, `DEFAULT_OFF` and the client settings. `local-up.sh` becomes the generic engine.
- The project is chosen by `--project <name>`, `LOCAL_UP_PROJECT`, or the root's `local-up.local.sh`.
- The applet gets a project switcher, and a section per project when several are running.
- Optionally, private project files live outside the public repo (`~/.config/stack-launcher/projects/`), so AICL's file can leave GitHub. Its history would remain unless rewritten.

**Changes to current features:**
- Caches move to `~/.cache/stack-launcher/<project>/` (migrate the old `aicl-local-up` paths once).
- The applet uuid stays (renaming it breaks installs), but its display name and texts become generic.
- `--config-json` (#6) makes the applet side easy.

### 10. Real health checks instead of "port is open"
**Why:** "ready" today means "something listens on the port". NestJS and Uvicorn open the port before Kafka, Mongo or migrations are ready, and a crashed worker can keep the port open. Green does not mean working.

**What:**
- An optional health URL per service, e.g. a 7th `SERVICES` column `/health`; responseHub's core routes already serve `GET /health` (catalyst shares the same core service).
- Ready = HTTP 200 within 2 s. The applet shows ● green (healthy), ● yellow (port open, unhealthy) or ○.
- `watch_ready` and the applet both use it. Without a URL, the check falls back to the port.

**Changes to current features:** the `SERVICES` format gets an optional column. Keep it optional, so old `local-up.local.sh` arrays still parse.

### 11. Memory guard and orphan cleanup
**Why:** on a 15 GB machine we saw 12 GB of swap in use, and builds slowed to a crawl. Two causes:
- several webpack builds at once;
- processes left behind: old `nx` daemons, Playwright browsers, `vite preview`, `tsc --watch` from closed tabs.

**What:**
- **Before starting:** if available RAM < 2 GB, or swap > 50%, warn and offer to stop the biggest idle apps from the top-memory list.
- **Applet "Clean up" item:** list processes whose working directory is under the AICL root but that don't belong to a running service's process group (orphans), with their RAM, and kill the selected ones.

**Changes to current features:** `stats.py` already maps processes to the AICL root by working directory and to services by process group, so orphan detection falls out of what's already collected.

### 12. Branch picker: stash and switch, new branch, prune
**Why:**
- Switching is refused with uncommitted changes, and the only answer is "go stash it yourself".
- New work always starts with "branch off origin/main".
- `aicl-web-react-client` has 648 branches, most of them merged.

**What:**
- **"Stash and switch"** when the tree is dirty: `git stash push -m local-up/<branch>`. Offer to re-apply when switching back.
- **"New branch from origin/<default>…"** with a name field.
- **"Prune merged local branches"** with a preview list. It never touches the current branch or anything unmerged.

**Changes to current features:** `switch_branch` gains `--stash`. The picker's status line gets the stash count.

### 13. Pending migration warning after a pull
**Why:** a pull that brings a new MikroORM migration (node monorepo, form-builder) or a Python migration script leaves the service starting against an old schema. The failure appears later, as a 500.

**What:** after a pull or reset that changed migration folders, show "N new migration(s) in <repo>: run `<command>`". Optionally add a "Run migrations" button per repo. The command is per-project config, e.g. `npx mikro-orm migration:pending`.

**Changes to current features:** `update_repos` and `reset_to_origin` diff the migration paths, the same way they diff lockfiles today.

### 14. Jump to a service's terminal tab
**Why:** with 9+ tabs in one window, finding the auth tab to read its error means clicking through tabs. Your colleague already records each tab's `GNOME_TERMINAL_SCREEN`.

**What:** a ⤴ button per running row that activates that tab, using the recorded screen object path over gnome-terminal's DBus (`org.gnome.Terminal`). Fall back to raising the window.

**Changes to current features:** none. This builds on the one-window tabs.

---

## P3

### 15. Faster nx start (`nx run-many`)
**Why:** nx services start one at a time, to avoid the `.nx/workspace-data` race. Three services take about 3–4 minutes, each running a full webpack build that rebuilds the shared libraries.

**What:**
- An opt-in mode that starts all selected nx services with `npx nx run-many -t serve -p nucleus auth notification` in one tab. nx builds the shared dependencies once and coordinates, so there's no race.
- Prefixed output, and one tab to stop them all.
- Measure before making it the default.

**Changes to current features:**
- Per-service ▶/■/↻ for nx services would act on the group, or keep the current one-at-a-time path for single starts.

### 16. "What's new" before updating, and uninstall
**Why:**
- The Update item pulls blind.
- There's no clean way to remove the kit.

**What:**
- The update item opens a small view with `git log --oneline HEAD..@{u}` before running `update.sh`.
- `install.sh --uninstall` removes the links, restores the newest backups from `~/.cache/aicl-local-up/backup/`, and removes the applet from the panel.

### 17. Split `local-up.sh` into modules
**Why:** it's over 1,000 lines mixing UI, git, infra, ports and deploys, and every feature in this list adds more.

**What:** `lib/{config,git,infra,ports,deps,deploy,ui}.sh`, sourced by a thin `local-up.sh`. Keep the arrays parseable, or do this after #6, so `stats.py` no longer parses the script.

**Changes to current features:** `install.sh` links the folder, or the script finds its `lib/` through `readlink -f`.

### 18. Commit guard for secrets and machine files
**Why:** the repo is public, and `local-up.local.sh` holds machine paths, ports and tunnel IDs. A `git add -A` slip is the most likely leak.

**What:** `install.sh` installs a `pre-commit` hook in the kit clone that refuses commits containing:
- `local-up.local.sh` or `.env*` files;
- strings that look like keys or tokens;
- known internal hostnames.

`.gitignore` covers the first case; the hook covers files forced in with `git add -f`.

### 19. Memory trend per service
**Why:** "nucleus is at 900 MB" means little without knowing whether it was 300 MB an hour ago. Leaks show up as slow climbs.

**What:** `stats.py` keeps a small rolling RAM history per service in `~/.cache` (one sample a minute, a few hours' worth). The applet row gets a tiny ▁▂▃▅ sparkline and a ↗ marker when the trend climbs steadily.

---

## Smaller fixes to current features

- **Client push assumes `main`.** Use each repo's `origin/HEAD` (see #7).
- **Exit 130 shows as a red crash.** Show grey "stopped" (see #3).
- **Menu height.** About 41 rows today; each new row type (tunnel, a 15th service) pushes it past a 1080p screen. Make the top-memory/CPU block collapsible, or cap it at 5 rows when the local stack is long.
- **`local-up.sh --stop` with no names stops everything,** including services you started by hand outside the kit, if they use the same ports. Show what will be stopped and confirm, when run in a terminal.
- **Ready table vs applet.** `watch_ready` and the applet compute "up" separately; move both to the health check (#10).
- **Update check every hour.** Fine, but also check right after a reload. Today the first check runs on load, which install's `--reload` triggers, so this already holds. Keep it when refactoring.
