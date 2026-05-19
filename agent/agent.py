import json
import os
import socket
import subprocess
import time
from urllib import request, error

REPORT_URL = os.environ["REPORT_URL"]
REPORT_TOKEN = os.environ["REPORT_TOKEN"]
INTERVAL = int(os.environ.get("REPORT_INTERVAL", "60"))

WATCH_SERVICES = [
    "qinglong",
    "postgres-main",
    "sub2api",
    "moviepilot-v2",
    "jellyfin",
    "emby",
    "qbittorrent",
    "navidrome",
]


def run(cmd):
    try:
        return subprocess.check_output(cmd, shell=True, text=True).strip()
    except Exception:
        return ""


def get_cpu_percent():
    def read_cpu():
        with open("/proc/stat", "r", encoding="utf-8") as f:
            parts = f.readline().split()[1:]
            vals = list(map(int, parts[:8]))
            total = sum(vals)
            idle = vals[3]
            return total, idle

    t1, i1 = read_cpu()
    time.sleep(0.5)
    t2, i2 = read_cpu()
    total = t2 - t1
    idle = i2 - i1
    if total <= 0:
        return 0
    return round((1 - idle / total) * 100, 1)


def get_memory_percent():
    meminfo = {}
    with open("/proc/meminfo", "r", encoding="utf-8") as f:
        for line in f:
            k, v = line.split(":", 1)
            meminfo[k] = int(v.strip().split()[0])
    total = meminfo.get("MemTotal", 0)
    avail = meminfo.get("MemAvailable", 0)
    if total <= 0:
        return 0
    used = total - avail
    return round(used / total * 100, 1)


def get_disk_percent():
    out = run("df -P / | tail -1 | awk '{print $5}' | tr -d '%' ")
    try:
        return float(out)
    except Exception:
        return 0


def get_load_average():
    try:
        vals = os.getloadavg()
        return {
            "1m": round(vals[0], 2),
            "5m": round(vals[1], 2),
            "15m": round(vals[2], 2),
        }
    except Exception:
        return {"1m": 0, "5m": 0, "15m": 0}


def get_uptime_seconds():
    try:
        with open("/proc/uptime", "r", encoding="utf-8") as f:
            return int(float(f.read().split()[0]))
    except Exception:
        return 0


def get_docker_services():
    out = run("docker ps -a --format '{{.Names}}|{{.State}}|{{.Status}}'")
    result = {}
    running = 0

    if out:
        lines = out.splitlines()
        for line in lines:
            parts = line.split("|", 2)
            if len(parts) != 3:
                continue
            name, state, status = parts
            if state == "running":
                running += 1
            if name in WATCH_SERVICES:
                result[name] = {
                    "status": "up" if state == "running" else "down",
                    "container_state": status,
                }

    for name in WATCH_SERVICES:
        if name not in result:
            result[name] = {
                "status": "down",
                "container_state": "not found",
            }

    return running, result


def build_payload():
    host = socket.gethostname()
    cpu = get_cpu_percent()
    mem = get_memory_percent()
    disk = get_disk_percent()
    load = get_load_average()
    uptime = get_uptime_seconds()
    docker_running, services = get_docker_services()

    return {
        "host": host,
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "cpu_percent": cpu,
        "memory_percent": mem,
        "disk_percent": disk,
        "load_average": load,
        "uptime_seconds": uptime,
        "docker_running": docker_running,
        "services": services,
    }


def report(payload):
    data = json.dumps(payload).encode("utf-8")
    req = request.Request(
        REPORT_URL,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {REPORT_TOKEN}",
        },
        method="POST",
    )
    with request.urlopen(req, timeout=20) as resp:
        return resp.read().decode()


def main():
    payload = build_payload()
    print(report(payload), flush=True)


if __name__ == "__main__":
    while True:
        try:
            main()
        except error.HTTPError as e:
            print(f"HTTPError: {e.code} {e.reason}", flush=True)
        except Exception as e:
            print(f"Error: {e}", flush=True)
        time.sleep(INTERVAL)
