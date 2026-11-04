# stack-launcher

Start, stop and monitor your local service stack: a pick-and-run script plus a Linux Mint panel applet. Today it runs the AICL stack; other projects can be added later.

- **`local-up.sh`** starts the local stack, one gnome-terminal tab per service. In order, it:
  - shows a checklist of services with each repo's branch, behind/ahead and uncommitted state;
  - pulls the selected repos;
  - checks Mongo, Redis, Postgres and Kafka;
  - installs dependencies when they're out of date;
  - resolves port conflicts;
  - starts the nx services one at a time (in parallel they crash);
  - shows a live "ready" table.
- **AICL Local Monitor** (`aicl-local-monitor@aicl/`) is a panel applet:
  - **Panel:** live CPU, RAM, swap and temperature.
  - **Click it:** system stats, the top apps by memory and CPU, and every local service with its branch, memory and CPU.
  - **Service controls:** tick services and press **Start selected**, or use ▶ start, ↻ restart, ■ stop and ↗ open on each row.
  - **Updates:** it tells you when the kit has new commits; clicking that updates it.

## Install

Clone it **into the folder that holds the AICL repos** (e.g. `~/projects/AICL`), then run the installer:

```bash
cd ~/projects/AICL
git clone https://github.com/jaydhakan/stack-launcher.git stack-launcher
./stack-launcher/install.sh
```

`install.sh` links `~/projects/AICL/local-up.sh` and the applet to this clone, so they're links, not copies. It asks before adding the applet to your panel. Use `--root PATH` if your repos live somewhere else.

**With Claude Code:** open Claude Code in the clone and say:

> Read SETUP_PROMPT.md and follow it step by step. Ask me before any sudo, gsettings change, or starting/stopping services.

It adapts the setup to your machine and tests everything.

## Use

```bash
./local-up.sh            # checklist → pull → start (your last pick is remembered)
./local-up.sh --help     # all options and every service with its port and default
./local-up.sh --stop     # stop everything (or: --stop client auth)
```

## Update

Click **Update stack-launcher** in the applet, or run `cd stack-launcher && git pull && ./install.sh --reload`.

## Ports, folders and other machine-specific settings

- **Ports are automatic.** Each backend's port is read from its repo's own `.env` (e.g. `NUCLEUS_PORT`); without it, the app's built-in default is used. That matches the port the app really listens on. `./local-up.sh --help` shows every port and where it came from.
- **Anything else that differs on your machine** goes in `local-up.local.sh`, next to the `local-up.sh` link. Copy [`local-up.local.example.sh`](local-up.local.example.sh) and keep only the lines you need:

  ```bash
  SERVICE_PORT[client]=5180                       # another port
  SERVICE_DIR[form-builder-api]=my-folder-name    # another clone folder
  INFRA_UNIT[kafka]=confluent-kafka               # another systemd unit
  ```

  That file is git-ignored, and both the script and the applet read it.
- **Never edit `local-up.sh` itself for your machine.** Updates (`git pull --ff-only`) would fail, and once pushed, your edit would change everyone's setup. The script and the applet both warn when the kit has local edits.
