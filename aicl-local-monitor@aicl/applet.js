const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const Util = imports.misc.util;
const Mainloop = imports.mainloop;
const GLib = imports.gi.GLib;
const St = imports.gi.St;

const GB = 1073741824;
const MB = 1048576;
const TOP_ROWS = 10;
const MONO = "font-family: monospace;";
const COMPACT = "padding-top: 1px; padding-bottom: 1px;";
const BUTTON = "font-family: monospace; padding: 0 7px; margin-left: 3px; border-radius: 4px; background-color: rgba(255,255,255,0.10);";
const MEM_COL_WIDTH = 46;
const BRANCH_WIDTH = 30;
const RED = "#ff6b6b";
const ORANGE = "#ffb347";
const YELLOW = "#e5c07b";
const GREEN = "#7bd88f";
const GREY = "#8a8a8a";
// Same file local-up.sh's checklist uses, so both always show the same selection
const SELECTION_FILE = `${GLib.get_user_cache_dir()}/aicl-local-up.last`;
const PENDING_TIMEOUT_MS = 300000;
const UPDATE_CHECK_SECONDS = 3600;

function esc(text) {
    return GLib.markup_escape_text(String(text), -1);
}

function paint(text, color) {
    return color ? `<span foreground="${color}">${esc(text)}</span>` : esc(text);
}

function level(pct, warn = 75, crit = 90) {
    if (pct >= crit) return RED;
    return pct >= warn ? ORANGE : null;
}

function size(bytes) {
    return bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.round(bytes / MB)} MB`;
}

function duration(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return d ? `${d}d ${h}h` : `${h}h ${m}m`;
}

// The kit clone this applet folder links into (install.sh); null when it was copied, not linked
function kitDirOf(appletPath) {
    try {
        const target = GLib.file_read_link(appletPath);
        const absolute = GLib.path_is_absolute(target) ? target : GLib.build_filenamev([GLib.path_get_dirname(appletPath), target]);
        const kit = GLib.path_get_dirname(absolute);
        return GLib.file_test(`${kit}/.git`, GLib.FileTest.EXISTS) ? kit : null;
    } catch (e) {
        return null;
    }
}

function fit(text, width) {
    return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

// One local service: click the row to (un)select it, buttons act on it right away
class ServiceItem extends PopupMenu.PopupBaseMenuItem {
    _init(applet, name) {
        super._init({});
        this._applet = applet;
        this.name = name;
        this.actor.set_style(COMPACT);

        this._check = new St.Label({ style: MONO });
        this._info = new St.Label({ style: MONO });
        this._buttons = new St.BoxLayout();
        // One spanning box: separate actors would be aligned to the menu's shared column widths
        const row = new St.BoxLayout();
        row.add(this._check);
        row.add(this._info, { expand: true });
        row.add(this._buttons);
        this.addActor(row, { span: -1, expand: true });

        this._btn = {};
        for (const [action, glyph] of [["start", "▶"], ["restart", "↻"], ["stop", "■"], ["open", "↗"]]) {
            const button = new St.Button({ label: glyph, style: BUTTON, reactive: true, track_hover: true });
            button.connect("clicked", () => applet._serviceAction(action, name));
            this._buttons.add_actor(button);
            this._btn[action] = button;
        }
    }

    activate(event) {
        this._applet._toggleSelected(this.name);
        super.activate(event, true);
    }

    update(svc, selected, pending) {
        this._check.clutter_text.set_markup(` ${paint(selected ? "☑" : "☐", selected ? GREEN : GREY)}`);

        const branch = fit(svc.branch || "-", BRANCH_WIDTH);
        const mainBranch = ["main", "master", "development"].includes(svc.branch);
        let dot = paint("○", GREY);
        let usage = "".padEnd(13);
        if (pending) {
            dot = paint("◌", YELLOW);
            usage = paint(fit(`${pending}…`, 13), YELLOW);
        } else if (svc.up) {
            dot = paint("●", GREEN);
            usage = esc(`${size(svc.rss).padStart(7)} ${`${Math.round(svc.cpu)}%`.padStart(4)} `);
        } else if (svc.exitCode !== null) {
            dot = paint("✗", RED);
            usage = paint(fit(`exited (${svc.exitCode})`, 13), RED);
        }
        const nameText = svc.up || pending || svc.exitCode !== null ? esc(fit(svc.name, 17)) : paint(fit(svc.name, 17), GREY);
        this._info.clutter_text.set_markup(
            ` ${dot} ${nameText} ${paint(fit(`:${svc.port}`, 6), GREY)} ${paint(branch, mainBranch ? GREY : YELLOW)} ${usage}`
        );

        this._btn.start.visible = !svc.up && !pending;
        this._btn.restart.visible = svc.up && !pending;
        this._btn.stop.visible = svc.up && !pending;
        this._btn.open.visible = svc.up;
    }
}

class AiclLocalMonitorApplet extends Applet.TextApplet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);
        this._helper = `${metadata.path}/stats.py`;
        this._timer = 0;
        this._busy = false;
        this._pendingFull = false;
        this._serviceKey = "";
        this._services = [];
        this._serviceRows = {};
        this._selected = null;
        this._pending = {};
        this._kitDir = kitDirOf(metadata.path);
        this._updateTimer = 0;

        this.settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);
        this.settings.bind("refresh-seconds", "refreshSeconds", () => this._schedule());
        this.settings.bind("localup-path", "localupPath");
        this.settings.bind("show-temp", "showTemp");
        this.settings.bind("show-swap", "showSwap");

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);
        this._buildMenu();
        this.menu.connect("open-state-changed", (menu, open) => {
            if (!open) return;
            this._selected = null; // re-read: local-up.sh's checklist may have changed it
            this._refresh();
        });

        this.set_applet_label("CPU …");
        this.set_applet_tooltip("AICL Local Monitor");
        this._refresh();
        this._schedule();
        if (this._kitDir) {
            this._checkForUpdate();
            this._updateTimer = Mainloop.timeout_add_seconds(UPDATE_CHECK_SECONDS, () => {
                this._checkForUpdate();
                return true;
            });
        }
    }

    on_applet_clicked() {
        this.menu.toggle();
    }

    on_applet_removed_from_panel() {
        if (this._timer) Mainloop.source_remove(this._timer);
        if (this._updateTimer) Mainloop.source_remove(this._updateTimer);
        this._timer = 0;
        this._updateTimer = 0;
        this.settings.finalize();
    }

    // --- Self-update -----------------------------------------------------------

    _checkForUpdate() {
        Util.spawnCommandLineAsyncIO("", (stdout, stderr, exitCode) => {
            const [behind, head, edited] = (stdout || "").trim().split(" ");
            if (exitCode !== 0 || !head) {
                this._updateItem.label.set_text("⟳  Update stack-launcher (could not reach GitHub)");
            } else if (Number(edited) > 0) {
                // Edited tracked files make `pull --ff-only` fail, and pushed they change everyone's setup
                this._updateItem.label.clutter_text.set_markup(
                    ` ${paint("⚠  stack-launcher has local edits: move them to local-up.local.sh", ORANGE)}`
                );
            } else if (Number(behind) > 0) {
                this._updateItem.label.clutter_text.set_markup(
                    ` ${paint(`⟳  Update stack-launcher (${behind} new commit${behind === "1" ? "" : "s"})`, ORANGE)}`
                );
            } else {
                this._updateItem.label.set_text(`✓  stack-launcher is up to date (${head})`);
            }
        }, { argv: [`${this._kitDir}/update.sh`, "--check"] });
    }

    // update.sh ends with install.sh --reload, which replaces this applet instance
    _update() {
        this.menu.close();
        this._runInTerminal(`"${this._kitDir}/update.sh"`);
    }

    _schedule() {
        if (this._timer) Mainloop.source_remove(this._timer);
        this._timer = Mainloop.timeout_add_seconds(Math.max(1, this.refreshSeconds), () => {
            this._refresh();
            return true;
        });
    }

    _localupPath() {
        return (this.localupPath || "").replace(/^~/, GLib.get_home_dir());
    }

    // The helper samples CPU for 0.5 s; a menu opened mid-run gets its full refresh right after
    _refresh() {
        const full = this.menu.isOpen;
        if (this._busy) {
            this._pendingFull = this._pendingFull || full;
            return;
        }
        this._busy = true;
        const argv = ["python3", this._helper, full ? "--full" : "--brief", "--localup", this._localupPath()];
        Util.spawnCommandLineAsyncIO("", (stdout, stderr, exitCode) => {
            this._busy = false;
            let data = null;
            try {
                data = exitCode === 0 ? JSON.parse(stdout) : null;
            } catch (e) {
                data = null;
            }
            if (!data) {
                this.set_applet_label("monitor ✗");
                this.set_applet_tooltip(`stats.py failed: ${stderr || stdout}`);
                global.logError(`aicl-local-monitor: stats.py failed (${exitCode}): ${stderr}`);
            } else {
                this._updatePanel(data);
                if (full) this._updateMenu(data);
            }
            if (this._pendingFull) {
                this._pendingFull = false;
                this._refresh();
            }
        }, { argv });
    }

    _updatePanel(d) {
        const cpu = Math.round(d.cpu);
        const memPct = Math.round(100 * (1 - d.memAvailable / d.memTotal));
        const swapPct = d.swapTotal ? Math.round((100 * d.swapUsed) / d.swapTotal) : 0;
        const diskPct = Math.round(100 * (1 - d.diskFree / d.diskTotal));

        const parts = [
            `CPU ${paint(`${String(cpu).padStart(2)}%`, level(cpu))}`,
            `RAM ${paint(`${memPct}%`, level(memPct, 80, 92))}`,
        ];
        if (this.showSwap && swapPct >= 25) parts.push(`SWP ${paint(`${swapPct}%`, level(swapPct, 25, 50))}`);
        if (this.showTemp && d.temp !== null) parts.push(paint(`${d.temp}°C`, level(d.temp, 80, 90)));
        if (diskPct >= 95) parts.push(paint(`DISK ${diskPct}%`, RED));
        this._applet_label.clutter_text.set_markup(parts.join("  "));

        this.set_applet_tooltip(
            `RAM ${size(d.memTotal - d.memAvailable)} / ${size(d.memTotal)} · ` +
            `Swap ${size(d.swapUsed)} · Disk ${size(d.diskFree)} free · ` +
            `Load ${d.load.map((l) => l.toFixed(1)).join(" ")}`
        );
    }

    // --- Menu ----------------------------------------------------------------

    _header(text) {
        const item = new PopupMenu.PopupMenuItem(text, { reactive: false });
        item.label.set_style("font-weight: bold;");
        this.menu.addMenuItem(item);
        return item;
    }

    _textRow(target) {
        const item = new PopupMenu.PopupMenuItem("", { reactive: false });
        item.label.set_style(MONO);
        item.actor.set_style(COMPACT);
        target.addMenuItem(item);
        return item;
    }

    _setRow(item, markup) {
        item.label.clutter_text.set_markup(markup);
    }

    _buildMenu() {
        this._header("System");
        this._sysRows = Array.from({ length: 5 }, () => this._textRow(this.menu));
        this._sysRows[0].label.set_text("loading…");

        // Memory and CPU side by side: stacked, the menu is taller than a 1080p screen
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const topHeader = this._textRow(this.menu);
        this._setRow(topHeader, `<b>${esc("Top memory (by app)".padEnd(MEM_COL_WIDTH))}  Top CPU now (100% = 1 core)</b>`);
        this._topRows = Array.from({ length: TOP_ROWS }, () => this._textRow(this.menu));

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._localHeader = this._header("AICL local stack");
        this._localSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._localSection);
        this._infraRow = this._textRow(this.menu);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._startItem = new PopupMenu.PopupMenuItem("▶  Start selected");
        this._startItem.connect("activate", () => this._startSelected());
        this.menu.addMenuItem(this._startItem);
        this._stopAllItem = new PopupMenu.PopupMenuItem("■  Stop all running");
        this._stopAllItem.connect("activate", () => this._stopAll());
        this.menu.addMenuItem(this._stopAllItem);
        if (this._kitDir) {
            this._updateItem = new PopupMenu.PopupMenuItem("⟳  Update stack-launcher (checking…)");
            this._updateItem.connect("activate", () => this._update());
            this.menu.addMenuItem(this._updateItem);
        }
        const monitor = new PopupMenu.PopupMenuItem("System Monitor");
        monitor.connect("activate", () => Util.spawn(["gnome-system-monitor"]));
        this.menu.addMenuItem(monitor);
    }

    _updateMenu(d) {
        const memUsed = d.memTotal - d.memAvailable;
        const memPct = Math.round((100 * memUsed) / d.memTotal);
        const swapPct = d.swapTotal ? Math.round((100 * d.swapUsed) / d.swapTotal) : 0;
        const diskUsed = d.diskTotal - d.diskFree;
        const diskPct = Math.round((100 * diskUsed) / d.diskTotal);
        const temp = d.temp === null ? "" : `  ·  ${paint(`${d.temp}°C`, level(d.temp, 80, 90))}`;

        this._setRow(this._sysRows[0],
            `CPU   ${paint(`${Math.round(d.cpu)}%`, level(d.cpu))}  ·  ${d.cores} cores  ·  load ${d.load.map((l) => l.toFixed(1)).join(" ")}${temp}`);
        this._setRow(this._sysRows[1],
            `RAM   ${paint(`${size(memUsed)} / ${size(d.memTotal)} (${memPct}%)`, level(memPct, 80, 92))}  ·  ${size(d.memAvailable)} available`);
        this._setRow(this._sysRows[2],
            `Swap  ${paint(`${size(d.swapUsed)} / ${size(d.swapTotal)} (${swapPct}%)`, level(swapPct, 25, 50))}${swapPct >= 25 ? paint("  ← RAM is overflowing to disk", ORANGE) : ""}`);
        this._setRow(this._sysRows[3],
            `Disk  ${paint(`/ ${size(diskUsed)} / ${size(d.diskTotal)} (${diskPct}%)`, level(diskPct, 85, 95))}  ·  ${size(d.diskFree)} free`);
        this._setRow(this._sysRows[4], `Up    ${duration(d.uptime)}`);

        this._topRows.forEach((item, i) => {
            const m = d.topMem[i];
            const c = d.topCpu[i];
            let left = "".padEnd(MEM_COL_WIDTH);
            if (m) {
                const name = m.name.slice(0, MEM_COL_WIDTH - 16);
                const procs = `(${m.procs})`;
                const gap = "".padEnd(MEM_COL_WIDTH - 10 - name.length - procs.length);
                left = `${esc(size(m.value).padStart(8))}  ${esc(name)} ${paint(procs, GREY)}${gap}`;
            }
            const right = c
                ? `${paint(`${Math.round(c.value)}%`.padStart(5), level(c.value, 50, 100))}  ${esc(c.name.slice(0, 28))}`
                : "";
            this._setRow(item, `${left}  ${right}`);
        });

        this._services = d.services || [];
        this._updateLocalStack(d.infra || []);
    }

    // --- Local stack -----------------------------------------------------------

    _loadSelection() {
        try {
            const [ok, bytes] = GLib.file_get_contents(SELECTION_FILE);
            if (ok) return new Set(imports.byteArray.toString(bytes).trim().split(/\s+/).filter(Boolean));
        } catch (e) {
            // no saved pick yet: local-up.sh's defaults
        }
        return new Set(this._services.filter((s) => !s.defaultOff).map((s) => s.name));
    }

    _toggleSelected(name) {
        if (this._selected.has(name)) this._selected.delete(name);
        else this._selected.add(name);
        const ordered = this._services.map((s) => s.name).filter((n) => this._selected.has(n));
        GLib.file_set_contents(SELECTION_FILE, `${ordered.join(" ")}\n`);
        this._updateLocalStack(null);
    }

    // "starting…" until the port listens, "stopping…" until it is free; a restart passes through both
    _pendingLabel(svc) {
        const p = this._pending[svc.name];
        if (!p) return null;
        if (Date.now() > p.until) {
            delete this._pending[svc.name];
            return null;
        }
        if (p.state === "restarting" && !svc.up) p.state = "starting";
        const exitedSince = svc.exitedAt !== null && svc.exitedAt * 1000 > p.since;
        if ((p.state === "starting" && (svc.up || exitedSince)) || (p.state === "stopping" && !svc.up)) {
            delete this._pending[svc.name];
            return null;
        }
        return p.state;
    }

    _updateLocalStack(infra) {
        if (this._selected === null && this._services.length) this._selected = this._loadSelection();
        const key = this._services.map((s) => s.name).join(",");
        if (key !== this._serviceKey) {
            this._serviceKey = key;
            this._localSection.removeAll();
            this._serviceRows = {};
            for (const s of this._services) {
                const row = new ServiceItem(this, s.name);
                this._localSection.addMenuItem(row);
                this._serviceRows[s.name] = row;
            }
        }

        let running = 0;
        let toStart = 0;
        for (const s of this._services) {
            const pending = this._pendingLabel(s);
            if (s.up) running++;
            if (this._selected.has(s.name) && !s.up && !pending) toStart++;
            this._serviceRows[s.name].update(s, this._selected.has(s.name), pending);
        }

        this._localHeader.label.set_text(this._services.length
            ? `AICL local stack · ${running}/${this._services.length} running · click a row to select it`
            : `AICL local stack · local-up.sh not found at ${this._localupPath()}`);
        if (infra !== null) {
            this._setRow(this._infraRow, infra.length
                ? " Infra  " + infra.map((i) => `${paint(i.up ? "●" : "○", i.up ? GREEN : RED)} ${esc(i.name)}`).join("  ")
                : "");
        }
        this._startItem.label.set_text(toStart
            ? `▶  Start selected (${toStart} not running)`
            : "▶  Start selected (all selected are running)");
        this._startItem.setSensitive(toStart > 0);
        this._stopAllItem.setSensitive(running > 0);
    }

    _markPending(names, state) {
        const since = Date.now();
        for (const name of names) this._pending[name] = { state, since, until: since + PENDING_TIMEOUT_MS };
        this._updateLocalStack(null);
    }

    // Starts go through local-up.sh in a terminal: it may need sudo, a port-conflict answer or an install
    _runInTerminal(script) {
        Util.spawn([
            "gnome-terminal", "--title=local-up", "--", "bash", "-c",
            `${script} && sleep 5 || read -rp "Something failed (see above). Press Enter to close"`,
        ]);
    }

    _startSelected() {
        const names = this._services
            .filter((s) => this._selected.has(s.name) && !s.up && !this._pending[s.name])
            .map((s) => s.name);
        if (!names.length) return;
        this._markPending(names, "starting");
        this._runInTerminal(`"${this._localupPath()}" --no-watch ${names.join(" ")}`);
    }

    _stopAll() {
        const names = this._services.filter((s) => s.up).map((s) => s.name);
        this._markPending(names, "stopping");
        Util.spawn([this._localupPath(), "--stop", ...names]);
    }

    _serviceAction(action, name) {
        const svc = this._services.find((s) => s.name === name);
        const localup = `"${this._localupPath()}"`;
        if (action === "open") {
            Util.spawn(["xdg-open", `http://localhost:${svc.port}${svc.path}`]);
            this.menu.close();
        } else if (action === "stop") {
            this._markPending([name], "stopping");
            Util.spawn([this._localupPath(), "--stop", name]);
        } else if (action === "start") {
            this._markPending([name], "starting");
            this._runInTerminal(`${localup} --no-pull --no-watch ${name}`);
        } else if (action === "restart") {
            this._markPending([name], "restarting");
            this._runInTerminal(`${localup} --stop ${name} && ${localup} --no-pull --no-watch ${name}`);
        }
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new AiclLocalMonitorApplet(metadata, orientation, panelHeight, instanceId);
}
