#!/usr/bin/env python3
"""Prints one JSON snapshot of system stats and the AICL local stack for the aicl-local-monitor applet.

  stats.py --brief                 CPU / RAM / swap / temp only (panel label, menu closed)
  stats.py --full --localup PATH   everything, incl. top apps and local services from local-up.sh
"""
import json
import os
import re
import sys
import time

PAGE_BYTES = os.sysconf("SC_PAGE_SIZE")
CLOCK_TICKS = os.sysconf("SC_CLK_TCK")
SAMPLE_SECONDS = 0.5
TOP_N = 10

# (regex on the full command line, app name) - first match wins
APP_PATTERNS = [
    (r"chrome", "Chrome"),
    (r"firefox", "Firefox"),
    (r"/usr/share/code/|\.vscode/extensions/", "VS Code"),
    (r"pycharm", "PyCharm"),
    (r"kaspersky|kesl", "Kaspersky"),
    (r"mongod", "MongoDB"),
    (r"kafka", "Kafka"),
    (r"postgres", "PostgreSQL"),
    (r"redis-server", "Redis"),
    (r"claude", "Claude Code"),
    (r"slack", "Slack"),
    (r"cinnamon", "Cinnamon"),
    (r"Xorg", "Xorg"),
]
APP_REGEXES = [(re.compile(p), name) for p, name in APP_PATTERNS]
GENERIC_COMMS = {"MainThread": "node", "node": "node", "python3": "python", "python": "python", "java": "java"}


def read_file(path, mode="r"):
    try:
        with open(path, mode) as f:
            return f.read()
    except OSError:
        return None


def cpu_times():
    fields = [int(x) for x in read_file("/proc/stat").split("\n", 1)[0].split()[1:]]
    idle = fields[3] + fields[4]  # idle + iowait
    return sum(fields), idle


def read_procs():
    procs = {}
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        stat = read_file(f"/proc/{pid}/stat", "rb")
        if not stat:
            continue
        statm = (read_file(f"/proc/{pid}/statm") or "0 0 0").split()
        stat = stat.decode(errors="replace")
        close = stat.rfind(")")
        fields = stat[close + 2:].split()  # fields[0] is field 3 (state) of proc(5)
        procs[int(pid)] = {
            "comm": stat[stat.find("(") + 1:close],
            "pgid": int(fields[2]),
            "ticks": int(fields[11]) + int(fields[12]),
            # resident minus shared: RSS counts Chrome's shared memory once per process (20 GB "used"
            # on a 15 GB box); exact PSS (smaps_rollup) takes ~3 s, too slow for a live view
            "rss": (int(statm[1]) - int(statm[2])) * PAGE_BYTES,
        }
    return procs


def meminfo():
    info = {}
    for line in read_file("/proc/meminfo").splitlines():
        key, value = line.split(":", 1)
        info[key] = int(value.split()[0]) * 1024
    return info


def cpu_temp():
    base = "/sys/class/hwmon"
    for hw in os.listdir(base):
        if (read_file(f"{base}/{hw}/name") or "").strip() in ("coretemp", "k10temp", "zenpower"):
            value = read_file(f"{base}/{hw}/temp1_input")
            if value:
                return round(int(value) / 1000)
    return None


def listening_ports():
    """port -> set of socket inodes for every listening TCP socket (v4 and v6)."""
    ports = {}
    for path in ("/proc/net/tcp", "/proc/net/tcp6"):
        for line in (read_file(path) or "").splitlines()[1:]:
            cols = line.split()
            if cols[3] == "0A":  # LISTEN
                port = int(cols[1].rsplit(":", 1)[1], 16)
                ports.setdefault(port, set()).add(cols[9])
    return ports


def find_block(texts, pattern):
    """Last match wins, the same way local-up.local.sh overrides local-up.sh's arrays."""
    match = None
    for text in texts:
        match = re.search(pattern, text, re.S | re.M) or match
    return match


def env_value(path, key):
    """KEY's value in a dotenv file (only that key is read), or None."""
    value = None
    for line in (read_file(path) or "").splitlines():
        match = re.match(rf"\s*(?:export\s+)?{re.escape(key)}\s*=\s*[\"']?([^\"'#\s]*)", line)
        if match:
            value = match.group(1)
    return value


def assignments(text, array):
    """ARRAY[key]=value lines of local-up.local.sh, e.g. SERVICE_PORT[nucleus]=5200."""
    return dict(re.findall(rf"^\s*{array}\[([\w.-]+)\]=[\"']?([^\"'\s#]*)", text, re.M))


def resolve_port(raw, name, repo, port_overrides):
    """Same order as local-up.sh's resolve_config: local-up.local.sh, the repo's .env, the default."""
    if name in port_overrides:
        return int(port_overrides[name])
    if ":" in raw:
        key, default = raw.split(":", 1)
        value = env_value(f"{repo}/.env", key)
        return int(value) if value and value.isdigit() else int(default)
    return int(raw)


def parse_localup(path):
    """SERVICES, INFRA and DEFAULT_OFF of local-up.sh (+ local overrides), so the applet never drifts from it."""
    root = os.path.dirname(path)
    local = read_file(os.path.join(root, "local-up.local.sh")) or ""
    texts = [read_file(path) or "", local]
    service_dirs, service_ports = assignments(local, "SERVICE_DIR"), assignments(local, "SERVICE_PORT")
    infra_ports = assignments(local, "INFRA_PORT")
    services, infra = [], []
    for block_name, target in (("SERVICES", services), ("INFRA", infra)):
        block = find_block(texts, rf"^{block_name}=\((.*?)^\)")
        for entry in re.findall(r'"([^"]+)"', block.group(1) if block else ""):
            parts = entry.split("|")
            if block_name == "SERVICES" and len(parts) >= 6:
                name, repo_dir = parts[0], service_dirs.get(parts[0], parts[1])
                port = resolve_port(parts[2], name, f"{root}/{repo_dir}", service_ports)
                target.append({"name": name, "dir": repo_dir, "port": port, "path": parts[3]})
            elif block_name == "INFRA" and len(parts) >= 3:
                target.append({"name": parts[0], "port": int(infra_ports.get(parts[0], parts[1]))})
    default_off = find_block(texts, r"^DEFAULT_OFF=\(([^)]*)\)")
    return services, infra, set(default_off.group(1).split()) if default_off else set()


def classify(pid, comm, aicl_root):
    cwd = ""
    try:
        cwd = os.readlink(f"/proc/{pid}/cwd")
    except OSError:
        pass
    if aicl_root and cwd.startswith(aicl_root + "/"):
        return "AICL " + cwd[len(aicl_root) + 1:].split("/", 1)[0].removeprefix("aicl-"), cwd
    cmdline = (read_file(f"/proc/{pid}/cmdline", "rb") or b"").replace(b"\0", b" ").decode(errors="replace")
    for regex, name in APP_REGEXES:
        if regex.search(cmdline):
            return name, cwd
    # node renames its main thread "MainThread"; the project folder says more than either
    if comm in GENERIC_COMMS and cwd not in ("", "/", os.path.expanduser("~")):
        return f"{GENERIC_COMMS[comm]} ({os.path.basename(cwd)})", cwd
    return comm, cwd


def socket_owner_pids(pids, inodes):
    """pid owning each wanted socket inode; only the given (local-stack) pids are scanned."""
    owners = {}
    for pid in pids:
        try:
            fds = os.listdir(f"/proc/{pid}/fd")
        except OSError:
            continue
        for fd in fds:
            try:
                link = os.readlink(f"/proc/{pid}/fd/{fd}")
            except OSError:
                continue
            if link.startswith("socket:[") and link[8:-1] in inodes:
                owners[link[8:-1]] = pid
    return owners


def top(groups, key, scale):
    rows = sorted(groups.items(), key=lambda kv: kv[1][key], reverse=True)[:TOP_N]
    return [{"name": name, "value": round(g[key] / scale, 1), "procs": g["procs"]} for name, g in rows]


def git_branch(repo):
    head = (read_file(f"{repo}/.git/HEAD") or "").strip()
    if head.startswith("ref: refs/heads/"):
        return head[len("ref: refs/heads/"):]
    return head[:7] or "-"  # detached HEAD shows the short sha


def exit_marker(name):
    """(exit code, epoch seconds) that local-up.sh's tab wrote when this service's command ended."""
    cache = os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache")
    path = f"{cache}/aicl-local-up/exit/{name}.exit"
    code = (read_file(path) or "").strip()
    if not code:
        return None, None
    return (int(code) if code.lstrip("-").isdigit() else -1), os.path.getmtime(path)


def local_stack(localup_path, procs, cpu_pct, cwds, ports):
    root = os.path.dirname(os.path.abspath(localup_path))
    services, infra, default_off = parse_localup(localup_path)
    aicl_pids = [pid for pid, cwd in cwds.items() if cwd]
    wanted = {inode for s in services for inode in ports.get(s["port"], ())}
    owners = socket_owner_pids(aicl_pids, wanted)
    out = []
    for s in services:
        pgids = {procs[owners[i]]["pgid"] for i in ports.get(s["port"], ()) if owners.get(i) in procs}
        members = [pid for pid, p in procs.items() if p["pgid"] in pgids]
        exit_code, exited_at = exit_marker(s["name"])
        out.append({
            **s,
            "exitCode": exit_code,
            "exitedAt": exited_at,
            "up": s["port"] in ports,
            "branch": git_branch(f"{root}/{s['dir']}"),
            "defaultOff": s["name"] in default_off,
            "rss": sum(procs[pid]["rss"] for pid in members),
            "cpu": round(sum(cpu_pct.get(pid, 0) for pid in members), 1),
        })
    return out, [{**i, "up": i["port"] in ports} for i in infra]


def main():
    full = "--full" in sys.argv
    localup = sys.argv[sys.argv.index("--localup") + 1] if "--localup" in sys.argv else ""
    aicl_root = os.path.dirname(os.path.abspath(localup)) if localup else ""

    total1, idle1 = cpu_times()
    procs1 = read_procs() if full else {}
    start = time.monotonic()
    time.sleep(SAMPLE_SECONDS)
    total2, idle2 = cpu_times()
    elapsed = time.monotonic() - start

    mem = meminfo()
    disk = os.statvfs("/")
    load = read_file("/proc/loadavg").split()[:3]
    snapshot = {
        "cpu": round(100 * (1 - (idle2 - idle1) / max(total2 - total1, 1)), 1),
        "cores": os.cpu_count(),
        "load": [float(x) for x in load],
        "memTotal": mem["MemTotal"],
        "memAvailable": mem["MemAvailable"],
        "swapTotal": mem["SwapTotal"],
        "swapUsed": mem["SwapTotal"] - mem["SwapFree"],
        "temp": cpu_temp(),
        "diskTotal": disk.f_blocks * disk.f_frsize,
        "diskFree": disk.f_bavail * disk.f_frsize,
        "uptime": float(read_file("/proc/uptime").split()[0]),
    }
    if not full:
        print(json.dumps(snapshot))
        return

    procs = read_procs()
    groups, cpu_pct, cwds = {}, {}, {}
    for pid, p in procs.items():
        before = procs1.get(pid)
        cpu_pct[pid] = 100 * (p["ticks"] - before["ticks"]) / CLOCK_TICKS / elapsed if before else 0.0
        name, cwd = classify(pid, p["comm"], aicl_root)
        cwds[pid] = cwd if aicl_root and cwd.startswith(aicl_root + "/") else ""
        g = groups.setdefault(name, {"rss": 0, "cpu": 0.0, "procs": 0})
        g["rss"] += p["rss"]
        g["cpu"] += cpu_pct[pid]
        g["procs"] += 1

    snapshot["topMem"] = top(groups, "rss", 1)
    snapshot["topCpu"] = top(groups, "cpu", 1)
    if localup:
        snapshot["services"], snapshot["infra"] = local_stack(localup, procs, cpu_pct, cwds, listening_ports())
    print(json.dumps(snapshot))


if __name__ == "__main__":
    main()
