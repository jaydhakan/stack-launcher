# Set up the AICL local stack kit on this machine

You are setting up two tools a teammate built and tested on their own Linux Mint machine (Cinnamon 5.8.4):

1. **`local-up.sh`**: starts the AICL local stack in one gnome-terminal window, one tab per service. It shows an inline checklist with each repo's branch and behind/ahead/dirty state, fetches and fast-forwards each selected repo from origin, checks Mongo/Redis/Postgres/Kafka, runs `npm install` / `uv sync` when a lockfile changed, resolves port conflicts, starts the nx services one at a time, and shows a live "ready" table. `--stop`, `--help`, `--list`, `--no-pull`, `--no-watch` and `--all` are also supported.
2. **`aicl-local-monitor@aicl/`**: a Cinnamon panel applet. The panel shows CPU, RAM, swap and temperature. The menu shows system stats, the top 10 apps by memory and by CPU, and the local stack: each service's state, branch, memory and CPU, a checkbox to select it, start/restart/stop/open buttons, plus "Start selected" and "Stop all running". It reads the service list from `local-up.sh`, so the two never drift apart.

Both live in the git repo `https://github.com/jaydhakan/stack-launcher.git`. The repo is cloned into the AICL workspace root, and `install.sh` links (not copies) `local-up.sh` and the applet into place. The applet's "Update stack-launcher" item later runs `git pull` and reloads, so updates arrive without reinstalling.

Your job is to install both, adapt them to **this** machine, test everything, and report back. Work through the steps in order.

## Ground rules

- **Do not modify any AICL repository**: no code, `.env`, `project.json`, ports or package files.
- **Do not edit the kit's tracked files.** Machine-specific changes go only in `<AICL root>/local-up.local.sh` (git-ignored). Edits to tracked files would make the applet's updates (`git pull --ff-only`) fail.
- **Keep the existing setup.** Ports, commands, the nx one-at-a-time start, the default-off list and the IPv6 step are correct on the author's machine. Change a value only if this machine's repos prove it differs, and report every change you make.
- **Never print secrets.** When checking `.env` files, grep only the specific `*_PORT` / `*_URL` keys listed below; never `cat` a `.env`.
- **Ask the user before you:** run `sudo`, start systemd services, kill or stop processes, change `gsettings`, or start the real stack.
- **No git commits, pushes or branches** in any repo, including the kit.

## Step 1: Preflight

Check and report:
- **Desktop:** `echo $XDG_CURRENT_DESKTOP; cinnamon --version`. The applet needs Cinnamon 4 or later. If this isn't Cinnamon, skip Steps 4 and 6 (the applet) and say so; `local-up.sh` still works.
- **Tools:** `bash` 4.4 or later, `git`, `python3` 3.9 or later (standard library only, no pip packages), `ss`, `lsof`, `timeout`, `gnome-terminal`, `gnome-screenshot` (used for testing), `node`/`npm`/`npx`, `uv`.
- **Infra:** `local-up.sh` expects systemd units `mongod`, `redis-server`, `postgresql`, `kafka`, on ports 27017, 6379, 5432 and 9092. Check with `systemctl list-units --type=service | grep -iE "mongo|redis|postgres|kafka"` and `ss -ltn`. If a unit has a different name here, or the service runs in Docker, redefine `INFRA=(...)` in `local-up.local.sh` (Step 3), or tell the user the auto-start offer won't apply.

## Step 2: Clone the kit and install it

1. Find the AICL workspace root: the folder that contains the repos (`aicl-monorepo-node-api-server`, `aicollect-python-api-server`, `aicl-api-node-form-builder`, `aicl-web-react-client`, ...). The author's is `~/projects/AICL`. If you can't find it, ask the user.
2. `cd <root> && git clone https://github.com/jaydhakan/stack-launcher.git stack-launcher`. If the user can't access it, stop and tell them to ask the teammate for access.
3. If an older `dev-up.sh`, `local-up.sh` or `~/.local/share/cinnamon/applets/aicl-local-monitor@aicl` already exists (from an earlier zip), tell the user. `install.sh` moves real files to `~/.cache/aicl-local-up/backup/` before linking.
4. Run `./stack-launcher/install.sh --root <root>`. The default root is the clone's parent folder. It:
   - links `<root>/local-up.sh` to the clone, and links the applet if Cinnamon is present;
   - asks before adding the applet to the panel. Ask the user before answering yes.
5. **Node via nvm:** when `npx` isn't on PATH (for example, started from the panel applet, which never reads `~/.bashrc`), `local-up.sh` sources `$NVM_DIR/nvm.sh` itself.
   - If node is installed some other way (fnm, volta, system), make sure `npx` is on PATH for non-interactive shells.
   - If a needed tool is still missing, the script stops with `Not found on PATH: ...` before it opens any tabs.

## Step 3: Adapt to this machine (only via `local-up.local.sh`)

Most machines need nothing here: backend ports are read from each repo's own `.env`, and repo folders use the default clone names.

1. Run `./local-up.sh --help`. The table shows each service's port, its repo folder and where the port came from (`<KEY> in .env`, `app default` or `fixed`). Report the table.
2. **Repo folders:** check every repo folder in the table exists under the root. If a repo has another folder name here, set `SERVICE_DIR[<service>]=<folder>`. If a repo isn't cloned, tell the user; the script skips missing repos.
3. **Ports:** only if a port in the table is wrong for this machine, set `SERVICE_PORT[<service>]=<port>`. Never edit a `.env`. When checking `.env` files, grep only these keys: `NUCLEUS_PORT`, `AUTH_PORT`, `NOTIFICATION_PORT`, `PAYMENT_MANAGER_PORT`, `AGRISPHERE_PORT`, `AUDITOR_PORT` (node monorepo `.env`), `RESPONSE_HUB_APP_PORT`, `CATALYST_APP_PORT` (python `.env`) and `APP_PORT` (form-builder `.env`). The Vite UIs (client 5173 … backoffice 5177) are fixed by the script.
4. **Infra:** if a unit name or port differs (Step 1), set `INFRA_UNIT[<name>]=...` or `INFRA_PORT[<name>]=...`. Leave `DISABLE_IPV6` at its default (`true`): the Node services need IPv6 disabled. Never turn it off to avoid the sudo prompt; only the user may decide that.
5. Put these lines in `<root>/local-up.local.sh`, starting from the kit's `local-up.local.example.sh`. Re-run `--help` to confirm. Never change the kit's tracked files: `git -C <root>/stack-launcher status` must stay clean.
6. **Leave these as they are:**
   - `DEFAULT_OFF`: payment-manager, agrisphere-api, auditor, catalyst and agrisphere-ui start unticked.
   - The nx one-at-a-time start: parallel `nx serve` runs in one monorepo crash with `NX Unexpected token ']'`.

### Known quirks: report them, don't fix them

- The node monorepo `.env` has `ACCOUNT_PANEL_BASE_URL` on 5176 and `BACKOFFICE_BASE_URL` on 5175, but the script runs account on 5175, form-builder-ui on 5176 and backoffice on 5177.
- `CATALYST_SERVER_URL` in the node `.env` points at port 9999 (responseHub's), but catalyst runs on 30521.
- The auditor DB settings are commented out in the node `.env`, so auditor may fail to start.
- Every `nx serve` opens the Node debugger on port 9229, so only the first one gets it.

## Step 4: Check the applet (Cinnamon only)

1. `ls -l ~/.local/share/cinnamon/applets/aicl-local-monitor@aicl` is a link into the clone.
2. If the root isn't `~/projects/AICL`, the user must right-click the applet → Configure and set the `local-up.sh` path to `<root>/local-up.sh`. Tell them to.
3. Confirm it loaded: `grep aicl-local-monitor ~/.xsession-errors | tail` should show `Loaded applet aicl-local-monitor@aicl`, with no errors.

## Step 5: Test `local-up.sh` (report each result)

1. `bash -n local-up.sh` passes. `./local-up.sh --help` prints the usage and a 14-service table. `--list` prints 14 names. `./local-up.sh -q` and `./local-up.sh foo` exit with code 2 and a clear message.
2. **Dry run, nothing launched:** put stub `gnome-terminal` and `npx` scripts in a temp dir that only print their arguments, then run `PATH=<stubdir>:$PATH READY_TIMEOUT=3 ./local-up.sh --no-pull payment-manager agrisphere-api auditor` (pick services whose ports are free). Check that:
   - each nx tab after the first waits for the previous one's port;
   - the infra line lists the right services;
   - the run exits cleanly.
3. **Dependencies:** the script installs dependencies when `node_modules` is missing, when its pull changed a lockfile, or when `package-lock.json` is newer than `node_modules/.package-lock.json` (stale since an earlier pull or branch switch). Run `./local-up.sh --no-pull --no-watch <one stopped service>` and check the "Installing dependencies" lines. Logs are in `~/.cache/aicl-local-up/install-<repo>.log`. Make sure `git status` in that repo stays clean afterwards.
4. **Stop path:** `./local-up.sh --stop catalyst` (or any service that isn't running) prints `not running`.
5. **Real run:** ask the user first. The checklist needs a real terminal, so ask the user to run `./local-up.sh` themselves and paste the output, or run `./local-up.sh --no-watch client` yourself. Then confirm with `ss -ltn` that the ports are listening, and that the pull log shows each repo's branch.

## Step 6: Test the applet (report each result)

Drive it through Cinnamon's DBus interface. `A` stands for the running applet:

```bash
A="imports.ui.appletManager.getRunningInstancesForUuid('aicl-local-monitor@aicl')[0]"
ev() { gdbus call --session --dest org.Cinnamon --object-path /org/Cinnamon --method org.Cinnamon.Eval "$1"; }
ev "$A.menu.open(true); 'ok'"; sleep 4; gnome-screenshot -f /tmp/applet.png; ev "$A.menu.close(true); 'ok'"
```

1. **Panel and menu:** the screenshot shows CPU/RAM in the panel. The menu shows System, side-by-side top memory/CPU, the local stack (14 rows with branch names, running services with a green ●), the infra row, and the actions. The whole menu must fit on screen.
2. **Helper:** `python3 ~/.local/share/cinnamon/applets/aicl-local-monitor@aicl/stats.py --full --localup <path>` prints valid JSON with 14 `services`, each with a `branch`.
3. **Selection:** with the menu open, `ev "$A._serviceRows['backoffice'].activate(null); $A._startItem.label.get_text()"` toggles backoffice in `~/.cache/aicl-local-up.last`. The menu stays open. Toggle it again to restore the file, and confirm it matches the original.
4. **Actions:** ask the user first. Stop one cheap running UI service (`ev "$A._serviceAction('stop','client')"`): it should show `stopping…` and then a grey ○. Start it again with `_serviceAction('start','client')`: a terminal opens, then `starting…`, then a green ●. Also check that ↗ opens the right URL.
5. **Crash detection:** when a service's tab command ends, the tab writes its exit code to `~/.cache/aicl-local-up/exit/<name>.exit`, and the applet shows a red `✗ exited (code)` instead of a stuck `starting…`. To test it, mark a service pending with `ev "$A._markPending(['catalyst'],'starting')"`, write a fake marker with `bash -c 'false; echo $? > ~/.cache/aicl-local-up/exit/catalyst.exit'`, check that the row shows `exited (1)` within one refresh, then delete the marker.
6. **Update item:** near the bottom, the menu shows `✓ stack-launcher is up to date (<sha>)`. Within a few seconds of loading it fetches the kit's origin; if fetching fails, it says `could not reach GitHub`. Clicking it runs `git pull --ff-only && ./install.sh --reload` in a terminal. Check it from the shell: `git -C <root>/stack-launcher status` must be clean, and `git -C <root>/stack-launcher pull --ff-only` must succeed.
7. If `stats.py` fails, the panel shows `monitor ✗` and the reason is in the tooltip and in `~/.xsession-errors`.

## Step 7: Report

Give the user a short summary:
- what you installed and where;
- the contents of `local-up.local.sh` (if you created it), and why each override was needed;
- each test with pass or fail, quoting the output of any failure;
- the known quirks from Step 3 that apply here;
- anything the user still needs to do. For example, "right-click the applet → Configure" changes the refresh interval, the `local-up.sh` path and the panel options.
