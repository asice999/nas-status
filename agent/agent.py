import json
import os
import socket
import subprocess
import time
from urllib import request, error

REPORT_URL = os.environ["REPORT_URL"]
REPORT_TOKEN = os.environ["REPORT_TOKEN"]
INTERVAL = int(os.environ.get("REPORT_INTERVAL", "60"))
CONFIG_PATH = os.environ.get("CONFIG_PATH", "/app/config.json")
HOST_FS_PATH = os.environ.get("HOST_FS_PATH", "/hostfs")
NET_STATE_PATH = os.environ.get("NET_STATE_PATH", "/tmp/net_state.json")

DEFAULT_CONFIG = {
    "watch_services": [
        "qinglong",
        "postgres-main",
        "sub2api",
        "moviepilot-v2",
        "emby",
        "qbittorrent",
        "navidrome",
    ],
    "ping_targets": [
        {"name": "网关", "target": "192.168.3.1"},
        {"name": "Cloudflare DNS", "target": "1.1.1.1"},
    ],
    "http_targets": [
        {"name": "青龙面板", "url": "http://192.168.3.20:5700"},
        {"name": "Emby", "url": "http://192.168.3.20:8096"},
    ],
}


def load_config():
    config = DEFAULT_CONFIG.copy()
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
            for key in ["watch_services", "ping_targets", "http_targets", "thresholds", "notifications"]:
                if key in data:
                    config[key] = data[key]
        except Exception:
            pass
    return config


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


def get_disk_stats():
    path = HOST_FS_PATH if os.path.exists(HOST_FS_PATH) else "/"
    try:
        stat = os.statvfs(path)
        total = stat.f_frsize * stat.f_blocks
        free = stat.f_frsize * stat.f_bavail
        used = total - free
        percent = round((used / total) * 100, 1) if total > 0 else 0
        return {
            "disk_percent": percent,
            "disk_total_gb": round(total / 1024 / 1024 / 1024, 1),
            "disk_used_gb": round(used / 1024 / 1024 / 1024, 1),
            "disk_free_gb": round(free / 1024 / 1024 / 1024, 1),
        }
    except Exception:
        return {
            "disk_percent": 0,
            "disk_total_gb": 0,
            "disk_used_gb": 0,
            "disk_free_gb": 0,
        }


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


def read_net_bytes():
    rx = 0
    tx = 0
    with open("/proc/net/dev", "r", encoding="utf-8") as f:
        lines = f.readlines()[2:]
    for line in lines:
        if ":" not in line:
            continue
        iface, rest = line.split(":", 1)
        iface = iface.strip()
        if iface == "lo":
            continue
        vals = rest.split()
        if len(vals) < 16:
            continue
        rx += int(vals[0])
        tx += int(vals[8])
    return rx, tx


def get_network_speed():
    now = time.time()
    rx, tx = read_net_bytes()
    prev = None
    if os.path.exists(NET_STATE_PATH):
        try:
            with open(NET_STATE_PATH, "r", encoding="utf-8") as f:
                prev = json.load(f)
        except Exception:
            prev = None
    try:
        with open(NET_STATE_PATH, "w", encoding="utf-8") as f:
            json.dump({"ts": now, "rx": rx, "tx": tx}, f)
    except Exception:
        pass
    if not prev:
        return {"net_rx_kbps": 0, "net_tx_kbps": 0}
    elapsed = max(now - float(prev.get("ts", now)), 1)
    rx_speed = max(rx - int(prev.get("rx", rx)), 0) / 1024 / elapsed
    tx_speed = max(tx - int(prev.get("tx", tx)), 0) / 1024 / elapsed
    return {
        "net_rx_kbps": round(rx_speed, 1),
        "net_tx_kbps": round(tx_speed, 1),
    }


def get_docker_services(watch_services):
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
            if name in watch_services:
                if state == "running" and "unhealthy" in status.lower():
                    level = "warn"
                elif state == "running":
                    level = "up"
                else:
                    level = "down"
                result[name] = {
                    "status": level,
                    "container_state": status,
                }

    for name in watch_services:
        if name not in result:
            result[name] = {
                "status": "down",
                "container_state": "not found",
            }

    return running, result


def ping_target(name, target):
    out = run(f"ping -c 1 -W 1 {target}")
    if not out:
        return name, {"status": "down", "latency_ms": None}
    latency = None
    for part in out.split():
        if part.startswith("time="):
            try:
                latency = round(float(part.split("=")[1]), 1)
            except Exception:
                latency = None
            break
    return name, {"status": "up", "latency_ms": latency}


def check_http(name, url):
    start = time.time()
    try:
        req = request.Request(url, method="GET", headers={"User-Agent": "nas-status-agent/1.0"})
        with request.urlopen(req, timeout=5) as resp:
            latency = round((time.time() - start) * 1000, 1)
            status = resp.status
            level = "up" if 200 <= status < 400 else "down"
            return name, {
                "status": level,
                "http_status": status,
                "latency_ms": latency,
            }
    except Exception:
        latency = round((time.time() - start) * 1000, 1)
        return name, {
            "status": "down",
            "http_status": None,
            "latency_ms": latency,
        }


def get_ping_checks(config):
    result = {}
    for item in config.get("ping_targets", []):
        name, data = ping_target(item.get("name", item.get("target", "未知目标")), item.get("target", ""))
        result[name] = data
    return result


def get_http_checks(config):
    result = {}
    for item in config.get("http_targets", []):
        name, data = check_http(item.get("name", item.get("url", "未知目标")), item.get("url", ""))
        result[name] = data
    return result


def build_payload():
    config = load_config()
    host = socket.gethostname()
    cpu = get_cpu_percent()
    mem = get_memory_percent()
    disk = get_disk_stats()
    load = get_load_average()
    uptime = get_uptime_seconds()
    network = get_network_speed()
    docker_running, services = get_docker_services(config.get("watch_services", []))
    ping_checks = get_ping_checks(config)
    http_checks = get_http_checks(config)

    return {
        "host": host,
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "cpu_percent": cpu,
        "memory_percent": mem,
        "disk_percent": disk["disk_percent"],
        "disk_total_gb": disk["disk_total_gb"],
        "disk_used_gb": disk["disk_used_gb"],
        "disk_free_gb": disk["disk_free_gb"],
        "load_average": load,
        "uptime_seconds": uptime,
        "net_rx_kbps": network["net_rx_kbps"],
        "net_tx_kbps": network["net_tx_kbps"],
        "docker_running": docker_running,
        "services": services,
        "ping_checks": ping_checks,
        "http_checks": http_checks,
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
