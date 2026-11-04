const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const Util = imports.misc.util;
const Mainloop = imports.mainloop;
const ModalDialog = imports.ui.modalDialog;
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const St = imports.gi.St;

const GB = 1073741824;
const MB = 1048576;
const TOP_ROWS = 10;
const MONO = "font-family: monospace;";
const COMPACT = "padding-top: 1px; padding-bottom: 1px;";
const BUTTON = "font-family: monospace; padding: 0 7px; margin-left: 3px; border-radius: 4px; background-color: rgba(255,255,255,0.10);";
const BRANCH_BUTTON = "font-family: monospace; padding: 0; border-radius: 3px;";
const PICKER_ROW = "padding: 3px 6px; border-radius: 4px;";
const PICKER_ROW_HOVER = `${PICKER_ROW} background-color: rgba(255,255,255,0.12);`;
const MAX_PICKER_ROWS = 200;
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
const DIALOG_FADE_MS = 400; // 5.x close() fades over 100 ms; destroy after it
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

function ago(epoch) {
    const days = Math.floor((Date.now() / 1000 - epoch) / 86400);
    if (days < 1) return "today";
    return days < 14 ? `${days}d ago` : `${Math.floor(days / 7)}w ago`;
}

// local-up.sh colours its terminal output; the branch picker shows it as plain text
function plain(text) {
    return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/[ \t]+/g, " ").trim();
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
        // The branch is a dropdown: it opens the branch picker for this service's repo
        this._branchLabel = new St.Label({ style: MONO });
        this._branch = new St.Button({ child: this._branchLabel, style: BRANCH_BUTTON, reactive: true, track_hover: true });
        this._branch.connect("clicked", () => applet._openBranchPicker(name));
        this._usage = new St.Label({ style: MONO });
        this._buttons = new St.BoxLayout();
        // One spanning box: separate actors would be aligned to the menu's shared column widths
        const row = new St.BoxLayout();
        row.add(this._check);
        row.add(this._info);
        row.add(this._branch);
        row.add(this._usage, { expand: true });
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

        const branch = `${fit(svc.branch || "-", BRANCH_WIDTH - 2)} ▾`;
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
        // Each label's markup starts with a plain space (see CLAUDE.md: markup at index 0 is dropped)
        this._info.clutter_text.set_markup(` ${dot} ${nameText} ${paint(fit(`:${svc.port}`, 6), GREY)}`);
        this._branchLabel.clutter_text.set_markup(` ${paint(branch, mainBranch ? GREY : YELLOW)}`);
        this._usage.clutter_text.set_markup(` ${usage}`);

        this._btn.start.visible = !svc.up && !pending;
        this._btn.restart.visible = svc.up && !pending;
        this._btn.stop.visible = svc.up && !pending;
        this._btn.open.visible = svc.up;
    }
}

// Cinnamon 6 dialogs take destroyOnClose; 5.x (Mint 21) rejects any unknown parameter
// ("Unrecognized parameter") -> [dialog, destroys itself on close]
function newModalDialog() {
    try {
        return [new ModalDialog.ModalDialog({ destroyOnClose: true }), true];
    } catch (e) {
        return [new ModalDialog.ModalDialog(), false];
    }
}

// Branch picker for the repo of one service: type to filter, click a branch (or Enter for the first
// match) to switch. Fetch / Pull act on the whole repo, which the node services share.
class BranchPicker {
    constructor(applet, service) {
        this._applet = applet;
        this._service = service;
        this._repo = null;
        this._branches = [];
        this._running = [];
        this._busy = false;

        [this._dialog, this._destroysItself] = newModalDialog();
        const box = new St.BoxLayout({ vertical: true, style: "spacing: 8px; min-width: 620px;" });
        this._title = new St.Label({ text: service, style: "font-weight: bold; font-size: 1.15em;" });
        this._state = new St.Label({ text: "loading…", style: MONO });
        this._search = new St.Entry({ hint_text: "Search branches…", can_focus: true, style: MONO });
        this._search.clutter_text.connect("text-changed", () => this._render());
        this._search.clutter_text.connect("activate", () => {
            const first = this._filtered().find((b) => !b.current);
            if (first) this._switch(first.name);
        });
        this._list = new St.BoxLayout({ vertical: true });
        const scroll = new St.ScrollView({
            style: "max-height: 420px;",
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        scroll.add_actor(this._list);
        this._status = new St.Label({ style: MONO });
        this._status.clutter_text.line_wrap = true;
        for (const actor of [this._title, this._state, this._search, scroll, this._status]) box.add_child(actor);
        this._dialog.contentLayout.add_child(box);
        this._dialog.setInitialKeyFocus(this._search.clutter_text);
        this._setButtons();
        this._dialog.open();
        this._load();
    }

    _setButtons() {
        if (this._view) return;
        const buttons = [
            { label: "Fetch", action: () => this._fetch() },
            { label: "Pull", action: () => this._pull() },
            { label: "Reset to origin…", action: () => this._resetPreview() },
        ];
        if (this._client) buttons.push({ label: "Push to client…", action: () => this._clientMenu() });
        if (this._running.length) {
            buttons.push({ label: `Restart ${this._running.length} running`, action: () => this._restart(), default: true });
        }
        buttons.push({ label: "Close", action: () => this._close(), key: Clutter.KEY_Escape });
        this._dialog.setButtons(buttons);
    }

    _setStatus(text, color) {
        this._status.clutter_text.set_markup(paint(text, color));
    }

    _run(args, done) {
        this._busy = true;
        Util.spawnCommandLineAsyncIO("", (stdout, stderr, exitCode) => {
            this._busy = false;
            // A fetch/pull can outlive the dialog; its labels are disposed by then
            if (!this._closed) done(stdout, plain(stderr), exitCode);
        }, { argv: [this._applet._localupPath(), ...args] });
    }

    _load() {
        this._run(["--branches", this._service], (stdout, stderr, exitCode) => {
            if (exitCode !== 0) {
                this._setStatus(stderr || "could not list branches", RED);
                return;
            }
            const lines = stdout.trim().split("\n").map((line) => line.split("\t"));
            const [, dir, branch, behind, ahead, uncommitted] = lines[0];
            this._repo = { dir, branch, behind: Number(behind), ahead: Number(ahead), uncommitted: Number(uncommitted) };
            const client = lines.find(([kind]) => kind === "client");
            this._client = client ? { remote: client[1], mainTarget: client[2] } : null;
            this._branches = lines
                .filter(([kind]) => kind === "local" || kind === "remote")
                .map(([kind, name, date, mark]) => ({ kind, name, date: Number(date), current: mark === "*" }));
            this._setButtons();
            this._title.set_text(dir);
            const parts = [`on ${paint(branch, YELLOW)}`];
            if (this._repo.behind) parts.push(paint(`↓${behind} behind origin`, ORANGE));
            if (this._repo.ahead) parts.push(paint(`↑${ahead} ahead`, GREY));
            if (this._repo.uncommitted) parts.push(paint(`${uncommitted} uncommitted, switching disabled`, RED));
            this._state.clutter_text.set_markup(parts.join("  ·  "));
            this._render();
        });
    }

    _filtered() {
        const words = this._search.get_text().toLowerCase().split(/\s+/).filter(Boolean);
        return this._branches.filter((b) => words.every((w) => b.name.toLowerCase().includes(w)));
    }

    _render() {
        if (this._view) return;
        this._list.destroy_all_children();
        const matches = this._filtered();
        for (const b of matches.slice(0, MAX_PICKER_ROWS)) {
            const label = new St.Label({ style: MONO, x_align: Clutter.ActorAlign.START, x_expand: true });
            label.clutter_text.set_markup(
                `${b.current ? paint("●", GREEN) : " "} ${esc(fit(b.name, 56))} ${paint(fit(b.kind === "remote" ? "origin" : "local", 7), GREY)} ${paint(ago(b.date), GREY)}`
            );
            const row = new St.Button({ child: label, style: PICKER_ROW, reactive: !b.current, track_hover: true, x_expand: true });
            row.connect("notify::hover", () => row.set_style(row.hover ? PICKER_ROW_HOVER : PICKER_ROW));
            row.connect("clicked", () => this._switch(b.name));
            this._list.add_child(row);
        }
        const hidden = matches.length - MAX_PICKER_ROWS;
        if (!matches.length) this._list.add_child(new St.Label({ text: "  No branch matches", style: MONO }));
        else if (hidden > 0) this._list.add_child(new St.Label({ text: `  … ${hidden} more, refine the search`, style: MONO }));
    }

    _switch(name) {
        if (this._busy || !this._repo) return;
        if (this._repo.uncommitted) {
            this._setStatus(`${this._repo.dir} has ${this._repo.uncommitted} uncommitted change(s); commit or stash them before switching`, RED);
            return;
        }
        this._setStatus(`switching to ${name}…`, YELLOW);
        this._run(["--switch", this._service, name], (stdout, stderr, exitCode) => {
            if (exitCode !== 0) this._setStatus(stderr || "switch failed", RED);
            else this._changed(plain(stdout));
        });
    }

    _fetch() {
        if (this._busy) return;
        this._setStatus("fetching…", YELLOW);
        this._run(["--fetch", this._service], (stdout, stderr, exitCode) => {
            this._setStatus(exitCode === 0 ? plain(stdout) : stderr, exitCode === 0 ? GREEN : RED);
            this._load();
        });
    }

    _pull() {
        if (this._busy) return;
        this._setStatus("pulling… (installs dependencies when the lockfile changed)", YELLOW);
        this._run(["--pull", this._service], (stdout, stderr, exitCode) => {
            const out = plain(stdout.replace(/^Updating from origin:\s*/, "")).replace(/\n+/g, "\n");
            if (exitCode !== 0 || /FAILED|failed/.test(out)) this._setStatus(out || stderr, RED);
            else if (/updated/.test(out)) this._changed(out);
            else this._setStatus(out, GREEN);
            this._load();
        });
    }

    // --- Action views: replace the branch list in the same popup; Back returns to it ---

    _showView(title, rows, buttons) {
        this._view = title;
        this._search.hide();
        this._list.destroy_all_children();
        const heading = new St.Label({ style: `${MONO} font-weight: bold; padding: 4px 6px;` });
        heading.clutter_text.set_markup(title);
        this._list.add_child(heading);
        for (const row of rows) this._list.add_child(row);
        this._dialog.setButtons([...buttons, { label: "Back", action: () => this._showBranches(), key: Clutter.KEY_Escape }]);
    }

    _showBranches() {
        this._view = null;
        this._search.show();
        this._setButtons();
        this._render();
    }

    _textRow(markup) {
        const label = new St.Label({ style: `${MONO} padding: 1px 6px;` });
        label.clutter_text.set_markup(markup);
        label.clutter_text.line_wrap = true;
        return label;
    }

    _choiceRow(markup, onClick) {
        const label = new St.Label({ style: MONO, x_align: Clutter.ActorAlign.START, x_expand: true });
        label.clutter_text.set_markup(markup);
        const row = new St.Button({ child: label, style: PICKER_ROW, track_hover: true, x_expand: true });
        row.connect("notify::hover", () => row.set_style(row.hover ? PICKER_ROW_HOVER : PICKER_ROW));
        row.connect("clicked", onClick);
        return row;
    }

    _commitRows(lines, kind, color, max = 10) {
        const picked = lines.filter(([k]) => k === kind);
        const rows = picked.slice(0, max).map(([, text]) => this._textRow(`  ${paint(fit(text, 80), color)}`));
        if (picked.length > max) rows.push(this._textRow(paint(`  … and more`, GREY)));
        return rows;
    }

    _resetPreview() {
        if (this._busy || !this._repo) return;
        this._setStatus("checking origin…", YELLOW);
        this._run(["--reset-preview", this._service], (stdout, stderr, exitCode) => {
            if (exitCode !== 0) {
                this._setStatus(stderr || "could not check origin", RED);
                return;
            }
            this._setStatus("", null);
            const lines = stdout.trim().split("\n").map((line) => line.split("\t"));
            const [, branch, lost, behind, uncommitted] = lines[0];
            const title = `Reset ${esc(branch)} to origin/${esc(branch)}`;
            if (!Number(lost) && !Number(uncommitted)) {
                const note = Number(behind) ? `Fast-forwards ${behind} commit(s) from origin; nothing local is lost.` : "Already identical to origin.";
                this._showView(title, [this._textRow(paint(note, GREEN))],
                    Number(behind) ? [{ label: `Reset to origin/${branch}`, action: () => this._reset() }] : []);
                return;
            }
            const rows = [this._textRow(paint("This discards, with git reset --hard:", RED))];
            if (Number(lost)) {
                rows.push(this._textRow(`${paint(`${lost} local commit(s) not on origin`, ORANGE)} ${paint("(still in git reflog)", GREY)}`));
                rows.push(...this._commitRows(lines, "lost", ORANGE));
            }
            if (Number(uncommitted)) {
                rows.push(this._textRow(paint(`${uncommitted} uncommitted change(s) to tracked files (gone for good)`, RED)));
                rows.push(...this._commitRows(lines, "file", RED));
            }
            rows.push(this._textRow(paint("Untracked files are kept.", GREY)));
            this._showView(title, rows, [{ label: `Discard and reset to origin/${branch}`, action: () => this._reset() }]);
        });
    }

    _reset() {
        if (this._busy) return;
        this._setStatus("resetting… (installs dependencies when the lockfile changed)", YELLOW);
        this._run(["--reset", this._service], (stdout, stderr, exitCode) => {
            this._showBranches();
            if (exitCode !== 0) this._setStatus(stderr || "reset failed", RED);
            else this._changed(plain(stdout).trim());
        });
    }

    _clientMenu() {
        if (this._busy || !this._client) return;
        const { remote, mainTarget } = this._client;
        const branch = this._repo.branch;
        const choices = [["main", mainTarget], ["main", "main"]];
        if (branch !== "main") choices.push([branch, branch]);
        const rows = choices.map(([source, target]) =>
            this._choiceRow(`  origin/${esc(source)}  →  ${paint(`${remote}/${target}`, YELLOW)}`, () => this._clientPlan(source, target)));
        rows.push(this._textRow(paint("Always pushes origin's commit, never local work. Removing client commits needs a separate confirm.", GREY)));
        this._setStatus("", null);
        this._showView(`Push to ${esc(remote)}`, rows, []);
    }

    _clientPlan(source, target) {
        if (this._busy) return;
        const { remote } = this._client;
        this._setStatus(`checking ${remote}/${target}…`, YELLOW);
        this._run(["--client-sync", this._service, source, target, "--dry-run"], (stdout, stderr, exitCode) => {
            if (exitCode !== 0) {
                this._setStatus(stderr || "could not check the client remote", RED);
                return;
            }
            this._setStatus("", null);
            const lines = stdout.trim().split("\n").map((line) => line.split("\t"));
            const [, kind, added, dropped] = lines[0];
            const localOnly = Number((lines.find(([k]) => k === "local") || [])[1] || 0);
            const title = `origin/${esc(source)} → ${esc(remote)}/${esc(target)}`;
            const rows = [];
            const buttons = [];
            if (kind === "same") {
                rows.push(this._textRow(paint("Already up to date, nothing to push.", GREEN)));
            } else if (kind === "create") {
                rows.push(this._textRow(paint(`Creates ${remote}/${target} at origin/${source}.`, GREEN)));
                buttons.push({ label: "Push", action: () => this._clientPush(source, target, false) });
            } else {
                if (Number(added)) rows.push(this._textRow(paint(`Adds ${added} commit(s):`, GREEN)), ...this._commitRows(lines, "new", GREEN, 8));
                if (kind === "rewrite") {
                    rows.push(this._textRow(paint(`Not a fast-forward: force push REMOVES ${dropped} commit(s) from ${remote}/${target}:`, RED)));
                    rows.push(...this._commitRows(lines, "drop", RED, 8));
                    buttons.push({ label: `Force push (removes ${dropped})`, action: () => this._clientPush(source, target, true) });
                } else {
                    buttons.push({ label: "Push", action: () => this._clientPush(source, target, false) });
                }
            }
            if (localOnly) rows.push(this._textRow(paint(`${localOnly} local-only commit(s) on ${source} are not included: push them to origin first.`, ORANGE)));
            this._showView(title, rows, [...buttons, { label: "Other target", action: () => this._clientMenu() }]);
        });
    }

    _clientPush(source, target, force) {
        if (this._busy) return;
        const args = ["--client-sync", this._service, source, target];
        if (force) args.push("--force");
        this._setStatus(`${force ? "force " : ""}pushing origin/${source} to ${this._client.remote}/${target}…`, YELLOW);
        this._run(args, (stdout, stderr, exitCode) => {
            if (exitCode === 0) this._setStatus(plain(stdout).trim(), GREEN);
            else this._setStatus(stderr || "push failed", RED);
            if (exitCode === 0) this._clientMenu();
        });
    }

    // After a switch, or a pull that moved HEAD: offer to restart what runs from this repo
    _changed(message) {
        const dir = this._repo.dir;
        this._running = this._applet._services.filter((s) => s.dir === dir && s.up).map((s) => s.name);
        this._setStatus(this._running.length ? `${message}\nRunning from this repo: ${this._running.join(", ")}` : message, GREEN);
        this._setButtons();
        this._applet._refresh();
        this._load();
    }

    _restart() {
        this._applet._restartServices(this._running);
        this._close();
    }

    _close() {
        this._closed = true;
        this._dialog.close();
        // 5.x close() only fades out and hides; destroy once the fade is done so dialogs don't pile up
        if (!this._destroysItself) {
            Mainloop.timeout_add(DIALOG_FADE_MS, () => {
                this._dialog.destroy();
                return false;
            });
        }
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
        // Clickable: starts or stops the dev tunnel; hidden while no TUNNEL_ID is set
        this._tunnel = null;
        this._tunnelItem = new PopupMenu.PopupMenuItem("");
        this._tunnelItem.label.set_style(MONO);
        this._tunnelItem.actor.set_style(COMPACT);
        this._tunnelItem.connect("activate", () => this._toggleTunnel());
        this._tunnelItem.actor.hide();
        this.menu.addMenuItem(this._tunnelItem);

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
        this._tunnel = d.tunnel || null;
        this._updateTunnel();
    }

    _updateTunnel() {
        const t = this._tunnel;
        this._tunnelItem.actor.visible = t !== null;
        if (!t) return;
        this._setRow(this._tunnelItem,
            ` Tunnel ${paint(t.up ? "●" : "○", t.up ? GREEN : GREY)} ${esc(t.id)}  ${paint(t.up ? "running · click to stop" : "stopped · click to start", GREY)}`);
    }

    _toggleTunnel() {
        if (!this._tunnel) return;
        Util.spawn([this._localupPath(), this._tunnel.up ? "--stop-tunnel" : "--tunnel"]);
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

    _runInTerminal(script) {
        Util.spawn([
            "gnome-terminal", "--title=local-up", "--", "bash", "-c",
            `${script} && sleep 5 || read -rp "Something failed (see above). Press Enter to close"`,
        ]);
    }

    // Starts go through local-up.sh in a tab of its window: it may need sudo, a port-conflict answer or an install
    _runLocalup(args) {
        Util.spawn([this._localupPath(), "--in-terminal", ...args]);
    }

    _startSelected() {
        const names = this._services
            .filter((s) => this._selected.has(s.name) && !s.up && !this._pending[s.name])
            .map((s) => s.name);
        if (!names.length) return;
        this._markPending(names, "starting");
        this._runLocalup(["--no-watch", ...names]);
    }

    _stopAll() {
        const names = this._services.filter((s) => s.up).map((s) => s.name);
        this._markPending(names, "stopping");
        Util.spawn([this._localupPath(), "--stop", ...names]);
    }

    _serviceAction(action, name) {
        const svc = this._services.find((s) => s.name === name);
        if (action === "open") {
            Util.spawn(["xdg-open", `http://localhost:${svc.port}${svc.path}`]);
            this.menu.close();
        } else if (action === "stop") {
            this._markPending([name], "stopping");
            Util.spawn([this._localupPath(), "--stop", name]);
        } else if (action === "start") {
            this._markPending([name], "starting");
            this._runLocalup(["--no-pull", "--no-watch", name]);
        } else if (action === "restart") {
            this._restartServices([name]);
        }
    }

    // One stop, then one start: local-up.sh starts nx services one at a time only within a single run
    _restartServices(names) {
        if (!names.length) return;
        const localup = `"${this._localupPath()}"`;
        this._markPending(names, "restarting");
        Util.spawn(["bash", "-c", `${localup} --stop ${names.join(" ")} && ${localup} --in-terminal --no-pull --no-watch ${names.join(" ")}`]);
    }

    _openBranchPicker(name) {
        this.menu.close();
        this._picker = new BranchPicker(this, name);
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new AiclLocalMonitorApplet(metadata, orientation, panelHeight, instanceId);
}
