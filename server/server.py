#!/usr/bin/env python3
"""Homebase: a tiny local control panel for the netbook.

Serves a dashboard on http://127.0.0.1:8800 with live netbook stats and
the status of the devices listed in devices.json. Stdlib only, so it stays
light on the Celeron.
"""
import base64
import configparser
import ipaddress
import fcntl
import json
import os
import pty
import re
import secrets
import shutil
import signal
import struct
import socket
import subprocess
import termios
import threading
import time
import urllib.request
import xml.etree.ElementTree as ET
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import identify as idf
import netspeed
import remote

HERE = Path(__file__).resolve().parent
UI_DIR = HERE.parent / "web" / "dist"  # the page, built with `npm run build:ui`
ASSET_TYPES = {".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
               ".woff2": "font/woff2", ".png": "image/png"}
# Device list, history and seen-devices live outside the code, so rebuilding
# or moving the project never loses them.
DATA = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "homebase"
DATA.mkdir(parents=True, exist_ok=True)
remote.init(DATA)
PORT = 8800
AGENT_PORT = 8801  # listens on the LAN, only for PC agents (install + push), nothing else
AGENTS_ENABLED = True  # Windows PCs send their stats here; the port only serves install + push (token-protected)
HISTORY = 90  # samples kept for sparklines (2 s apart = 3 minutes)
INTERVAL = 2.0

SCAN_EVERY = 30  # seconds between network discovery sweeps (a sweep is ~254 tiny packets; known devices are cached)

lock = threading.Lock()
devices_lock = threading.Lock()
state = {"netbook": {}, "devices": {}, "history": {}, "discovered": {}, "last_scan": 0, "stats": {}, "tv": {},
         "sshstats": {}, "rdp": {}, "power": {}}  # power: restarts / shutdowns asked for and not done yet

# First three bytes of the hardware address -> maker, for devices worth naming.
VENDORS = {
    "b8:27:eb": ("Raspberry Pi", "pi"), "dc:a6:32": ("Raspberry Pi", "pi"),
    "e4:5f:01": ("Raspberry Pi", "pi"), "d8:3a:dd": ("Raspberry Pi", "pi"),
    "2c:cf:67": ("Raspberry Pi", "pi"), "88:a2:9e": ("Raspberry Pi", "pi"),
}


def load_devices():
    # A fresh install has no devices.json yet: that just means no devices.
    return load_json(DATA / "devices.json", [])


def save_devices(devices):
    save_json(DATA / "devices.json", devices)


def default_iface():
    """The interface the default route uses (wlo1, wlan0, eth0, enp3s0...), whatever this machine calls it."""
    out = subprocess.run(["ip", "-4", "route", "show", "default"], capture_output=True, text=True).stdout.split()
    return out[out.index("dev") + 1] if "dev" in out else None


def local_net(iface=None):
    """Our IPv4 address on the LAN, e.g. '192.168.1.20'."""
    iface = iface or default_iface()
    if not iface:
        return None
    out = subprocess.run(["ip", "-4", "-o", "addr", "show", iface], capture_output=True, text=True).stdout
    return out.split()[3].split("/")[0] if out else None


def arp_table():
    """ip -> mac for every neighbour that answered."""
    table = {}
    for line in read("/proc/net/arp", "").splitlines()[1:]:
        ip, _, flags, mac = line.split()[:4]
        if flags == "0x2" and mac != "00:00:00:00:00:00":
            table[ip] = mac.lower()
    return table


def poke(ips):
    """Send one tiny UDP packet to each IP so the kernel ARPs for it.

    Far cheaper than spawning 254 ping processes on this CPU."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        for ip in ips:
            try:
                s.sendto(b"", (ip, 9))
            except OSError:
                pass


def identify(ip, mac):
    vendor, kind = VENDORS.get(mac[:8], (None, "other"))
    # A "locally administered" address is the random one phones use on Wi-Fi.
    private = int(mac[:2], 16) & 2
    if not vendor and private:
        vendor, kind = "Phone or tablet (private address)", "phone"
    try:
        name = socket.gethostbyaddr(ip)[0].split(".")[0]
    except OSError:
        name = None
    if name in ("_gateway", "gateway"):
        name = None
    return {"ip": ip, "mac": mac, "vendor": vendor, "kind": kind, "hostname": name}


IDENTITY_FILE = DATA / "identity.json"
IDENTITY_MAX_AGE = 7 * 86400


def enrich(found):
    """Add a best guess of what each device is (see identify.py), cached per MAC."""
    cache = load_json(IDENTITY_FILE, {})
    locations = None
    changed = False
    for mac, info in found.items():
        if info["kind"] in ("phone", "router"):
            continue
        hit = cache.get(mac)
        if not hit or hit.get("ip") != info["ip"] or time.time() - hit.get("t", 0) > IDENTITY_MAX_AGE:
            if locations is None:
                locations = idf.ssdp_locations()
            try:
                hit = idf.identify(info["ip"], mac, locations.get(info["ip"])) | {"ip": info["ip"], "t": time.time()}
            except Exception:
                continue
            cache[mac] = hit
            changed = True
        info.update(label=hit["label"], name=hit["name"] or info.get("hostname"), maker=hit["maker"])
        if info["kind"] == "other" or hit["kind"] == "phone":
            info["kind"] = hit["kind"]
    if changed:
        save_json(IDENTITY_FILE, cache)
    # Devices added before we knew their OS (or before this existed) get it filled in.
    with devices_lock:
        devices = load_devices()
        missing = [d for d in devices if not d.get("os") and cache.get(d.get("mac", ""), {}).get("label")]
        for d in missing:
            d["os"] = cache[d["mac"]]["label"]
        if missing:
            save_devices(devices)


def scan():
    me = local_net()
    if not me:
        return
    prefix = me.rsplit(".", 1)[0]
    poke([f"{prefix}.{i}" for i in range(1, 255) if f"{prefix}.{i}" != me])
    time.sleep(3)
    gateway = subprocess.run(["ip", "-4", "route", "show", "default"], capture_output=True, text=True).stdout.split()
    gw = gateway[2] if len(gateway) > 2 else None
    neighbours = [(ip, mac) for ip, mac in arp_table().items() if ip.startswith(prefix + ".")]
    # Name lookups can take a second or two each, so run them side by side.
    with ThreadPoolExecutor(8) as ex:
        infos = list(ex.map(lambda n: identify(*n), neighbours))
    found = {}
    for info in infos:
        if info["ip"] == gw:
            info.update(kind="router", vendor="Router")
        found[info["mac"]] = info
    enrich(found)
    # Warn about unfamiliar devices. Phones are skipped: their Wi-Fi address
    # changes often, so they'd trigger an alert every few days.
    seen = set(load_json(SEEN_FILE, []))
    first_run = not seen
    new = [i for m, i in found.items() if m not in seen and i["kind"] not in ("phone", "router")]
    seen |= set(found)
    save_json(SEEN_FILE, sorted(seen))
    known = {d.get("mac", "").lower() for d in load_devices()}
    if not first_run:
        for i in new:
            if i["mac"] not in known:
                what = " · ".join(x for x in (i.get("name"), i.get("label")) if x) or "An unknown device"
                event("new", f"{what} joined the network ({i['ip']})", "dialog-warning")
    with lock:
        state["discovered"] = found
        state["last_scan"] = time.time()


def scanner():
    while True:
        try:
            scan()
        except Exception:
            pass
        time.sleep(SCAN_EVERY)


def read(path, default=None):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return default


def hwmon(name):
    for h in Path("/sys/class/hwmon").iterdir():
        if read(h / "name") == name:
            return h
    return None


class Netbook:
    def __init__(self):
        self.prev_cpu = None
        self.prev_net = None
        self.prev_t = None
        self.core = hwmon("coretemp")
        self.nvme = hwmon("nvme")

    def cpu(self):
        parts = list(map(int, read("/proc/stat").splitlines()[0].split()[1:]))
        idle, total = parts[3] + parts[4], sum(parts)
        pct = 0.0
        if self.prev_cpu:
            di, dt = idle - self.prev_cpu[0], total - self.prev_cpu[1]
            pct = 100.0 * (1 - di / dt) if dt else 0.0
        self.prev_cpu = (idle, total)
        return round(pct, 1)

    def mem(self):
        info = {}
        for line in read("/proc/meminfo").splitlines():
            k, v = line.split(":")
            info[k] = int(v.split()[0])
        total, avail = info["MemTotal"], info["MemAvailable"]
        swap_used = info["SwapTotal"] - info["SwapFree"]
        return {
            "total": total * 1024,
            "used": (total - avail) * 1024,
            "pct": round(100 * (total - avail) / total, 1),
            "swap_used": swap_used * 1024,
            "swap_total": info["SwapTotal"] * 1024,
        }

    def net(self, iface=None):
        iface = iface or default_iface() or "lo"
        rx = int(read(f"/sys/class/net/{iface}/statistics/rx_bytes", 0))
        tx = int(read(f"/sys/class/net/{iface}/statistics/tx_bytes", 0))
        now = time.monotonic()
        down = up = 0.0
        if self.prev_net:
            dt = now - self.prev_t
            down = (rx - self.prev_net[0]) / dt
            up = (tx - self.prev_net[1]) / dt
        self.prev_net, self.prev_t = (rx, tx), now
        wifi = {}
        try:
            out = subprocess.run(["iw", "dev", iface, "link"], capture_output=True, text=True, timeout=2).stdout
            for line in out.splitlines():
                line = line.strip()
                if line.startswith("SSID:"):
                    wifi["ssid"] = line[5:].strip()
                elif line.startswith("signal:"):
                    wifi["signal"] = int(line.split()[1])
        except (OSError, subprocess.SubprocessError, ValueError):
            pass
        return {"down": down, "up": up, **wifi}

    def temps(self):
        out = {}
        if self.core:
            vals = [int(read(p)) / 1000 for p in self.core.glob("temp*_input")]
            if vals:
                out["cpu"] = round(max(vals), 1)
        if self.nvme:
            v = read(self.nvme / "temp1_input")
            if v:
                out["ssd"] = round(int(v) / 1000, 1)
        return out

    def battery(self):
        cap = read("/sys/class/power_supply/BAT0/capacity")
        if cap is None:
            return None
        return {"pct": int(cap), "status": read("/sys/class/power_supply/BAT0/status", "")}

    def disk(self):
        st = os.statvfs("/")
        total = st.f_blocks * st.f_frsize
        free = st.f_bavail * st.f_frsize
        return {"total": total, "used": total - free, "pct": round(100 * (total - free) / total, 1)}

    def sample(self):
        uptime = float(read("/proc/uptime").split()[0])
        return {
            "cpu": self.cpu(),
            "load": read("/proc/loadavg").split()[:3],
            "mem": self.mem(),
            "net": self.net(),
            "temps": self.temps(),
            "battery": self.battery(),
            "disk": self.disk(),
            "uptime": uptime,
            "kernel": os.uname().release,
        }


def probe(host, port, timeout=1.0):
    """TCP connect; returns latency in ms or None if unreachable.

    A refused connection still means the device is up, so it counts."""
    t = time.perf_counter()
    try:
        with socket.create_connection((host, port), timeout=timeout):
            pass
    except ConnectionRefusedError:
        pass
    except OSError:
        return None
    return round((time.perf_counter() - t) * 1000, 1)


arp_seen = {}
arp_first = {}


def probe_arp(host):
    """For devices with no open port (phones): ask the network if it's there."""
    # Only a fresh REACHABLE counts: STALE entries linger after a device leaves.
    # Re-checking the kernel takes ~5-10 s, so we poke now and judge on later
    # ticks; a device counts as up if it was REACHABLE in the last 20 s.
    out = subprocess.run(["ip", "-4", "neigh", "show", host], capture_output=True, text=True).stdout.split()
    now = time.time()
    arp_first.setdefault(host, now)
    if out and out[-1] == "REACHABLE":
        arp_seen[host] = now
    else:
        poke([host])
    if now - arp_seen.get(host, 0) < 20:
        return True
    return None if now - arp_first[host] < 15 else False


def check_device(d):
    """(online, latency ms) for one device; latency is None when only presence is known."""
    port = d.get("probe_port")
    if port:
        lat = probe(d["host"], port, DEVICE_TIMEOUT)
        return lat is not None, lat
    # No open/closed port to try (phones...): ARP tells us "present", not how fast.
    return probe_arp(d["host"]), None


def push(key, value):
    h = state["history"].setdefault(key, deque(maxlen=HISTORY))
    h.append(value)


EVENTS_FILE = DATA / "events.json"
SEEN_FILE = DATA / "seen.json"
FORGOTTEN_FILE = DATA / "forgotten.json"  # removed devices, so re-adding restores them
UPTIME_FILE = DATA / "uptime.json"  # last known on/off + "on since" per device, survives restarts
UPTIME_MAX_GAP = 300  # trust the saved time only if we were checking until recently
FAILS_BEFORE_OFF = 2  # consecutive failed internet checks before we call it down
DEVICE_OFF_AFTER = 20  # seconds a device must stay unreachable before it counts as off
DEVICE_TIMEOUT = 2.0  # per check; Wi-Fi power saving (Pi Zero, phones, plugs) can delay replies ~3 s
WAKE_GRACE = 45  # seconds after standby during which failures aren't believed
INTERNET_HOSTS = [("1.1.1.1", 443), ("8.8.8.8", 443)]


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def tmp_for(path):
    """A temp file only this thread writes, so two writers never swap each other's file away."""
    return path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")


def save_json(path, data):
    tmp = tmp_for(path)
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    tmp.replace(path)


events = deque(load_json(EVENTS_FILE, []), maxlen=200)


def notify(title, body, icon):
    body = body.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    try:
        subprocess.Popen(
            ["notify-send", "--app-name=Homebase", "--hint=string:desktop-entry:homebase", f"--icon={icon}", title, body],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    except OSError:
        pass


def event(kind, text, icon="network-workgroup", alert=True, dev=None):
    """Record something that happened; kind drives the colour in the UI, dev ties it to a device."""
    # The file is written under the lock too: the scanner and the sampler can log at the same moment.
    with lock:
        events.append({"t": time.time(), "kind": kind, "text": text} | ({"dev": dev} if dev else {}))
        tmp = tmp_for(EVENTS_FILE)
        with open(tmp, "w") as f:
            json.dump(list(events), f, ensure_ascii=False)
        tmp.replace(EVENTS_FILE)
    if alert:
        notify("Homebase", text, icon)


def check_internet():
    lats = [probe(h, p, 2.0) for h, p in INTERNET_HOSTS]
    lats = [l for l in lats if l is not None]
    return min(lats) if lats else None


def sampler():
    nb = Netbook()
    fails = {}
    net_fails = 0
    tick = 0
    last_boot, last_mono = time.clock_gettime(time.CLOCK_BOOTTIME), time.monotonic()
    woke_at = None
    # Restore "on since" from before a restart, unless we've been gone a while
    # (then the device may have been off in between and we can't know).
    saved = load_json(UPTIME_FILE, {})
    # Last on/off we actually saw per device. Unlike state["devices"], this is never
    # wiped (not by restarts, not by standby), so a device that changed while we
    # weren't looking still gets its "turned on" / "turned off" entry.
    last_known = {k: v["online"] for k, v in saved.items() if isinstance(v.get("online"), bool)}
    with lock:
        for k, v in saved.items():
            if v.get("online") and time.time() - v.get("checked", 0) < UPTIME_MAX_GAP and v.get("since"):
                state["devices"][k] = {"online": None, "since": v["since"]}
    while True:
        # One bad pass (a sensor that vanished, a full disk...) must not end the
        # loop: the page would keep showing frozen numbers and nothing restarts it.
        try:
            # CLOCK_BOOTTIME keeps counting through standby, CLOCK_MONOTONIC doesn't;
            # a jump between them means the terminal was just asleep.
            boot, mono = time.clock_gettime(time.CLOCK_BOOTTIME), time.monotonic()
            slept = (boot - last_boot) - (mono - last_mono)
            last_boot, last_mono = boot, mono
            if slept > 5:
                woke_at = mono
                fails.clear()
                net_fails = 0
                with lock:
                    # Forget pre-sleep state: it's stale, and comparing against it
                    # is what produced fake "turned off / went down" alerts on wake.
                    for v in state["devices"].values():
                        v["online"] = None
                    state["internet"] = None
                    for k in list(state["history"]):
                        state["history"][k].clear()
                mins = max(1, round(slept / 60))
                event("info", f"This computer woke up from sleep (slept {mins} min)", alert=False)
            # Wi-Fi needs a few seconds to reconnect after waking; until then a
            # failed check means "don't know yet", not "offline".
            waking = woke_at is not None and mono - woke_at < WAKE_GRACE

            s = nb.sample()
            devices = {}
            internet = None
            # Devices and internet are probed every other tick to keep idle cost down.
            if tick % 2 == 0:
                devs = load_devices()
                # Check all devices at once: a powered-off one costs a full timeout,
                # and that shouldn't hold up the others.
                with ThreadPoolExecutor(max(1, min(8, len(devs)))) as ex:
                    results = list(ex.map(check_device, devs))
                for d, (online, lat) in zip(devs, results):
                    # A device in Wi-Fi power saving can miss a few checks while it's
                    # perfectly fine, so it's only "off" after DEVICE_OFF_AFTER seconds
                    # of silence. Without this, a Pi Zero logged on/off every minute.
                    if online is False:
                        first_fail = fails.setdefault(d["id"], time.time())
                        if time.time() - first_fail < DEVICE_OFF_AFTER:
                            # Keep showing what we knew; if we knew nothing yet (just started), "checking".
                            prev_online = state["devices"].get(d["id"], {}).get("online")
                            online = True if prev_online else None
                    else:
                        fails.pop(d["id"], None)
                    if waking and online is False:
                        online = None
                    devices[d["id"]] = {"online": online, "latency": lat, "checked": time.time(), "name": d["name"]}
                ilat = check_internet()
                net_fails = 0 if ilat is not None else net_fails + 1
                internet = {"online": ilat is not None or net_fails < FAILS_BEFORE_OFF, "latency": ilat,
                            "ssid": s["net"].get("ssid")}
                if waking and ilat is None:
                    internet = None

            changes = []
            with lock:
                state["netbook"] = s
                push("cpu", s["cpu"])
                push("mem", s["mem"]["pct"])
                push("down", s["net"]["down"])
                push("up", s["net"]["up"])
                if "cpu" in s["temps"]:
                    push("temp", s["temps"]["cpu"])
                for k, v in devices.items():
                    prev = state["devices"].get(k, {})
                    name = v.pop("name")
                    if v["online"] is None:
                        if "since" in prev:
                            v["since"] = prev["since"]
                        state["devices"][k] = v
                        continue
                    # After standby the state is unknown (None) but "since" survives,
                    # so a device that stayed on keeps its uptime.
                    if v["online"] and (prev.get("online") is False or "since" not in prev):
                        v["since"] = time.time()
                    elif v["online"]:
                        v["since"] = prev.get("since", time.time())
                    # Report real changes only: compare with the last state we actually saw.
                    before = prev.get("online") if prev.get("online") is not None else last_known.get(k)
                    # A restart / shutdown we asked for: the card shows it until it's done, and its
                    # off/on goes in the history without a desktop notification.
                    pw = state["power"].get(k)
                    if pw:
                        # Gone at some point: a missed check counts too (a fast PC restarts within the 20 s
                        # it takes to call a device "off"), and so does a boot time newer than the request.
                        boot = (state["stats"].get(k) or state["sshstats"].get(k) or {}).get("boot") or 0
                        pw["off"] = pw["off"] or not v["online"] or k in fails or boot > pw["t"]
                        done = (pw["off"] and (pw["action"] == "poweroff" or v["online"]))
                        if done or time.time() - pw["t"] > (360 if pw["action"] == "reboot" else 180):
                            del state["power"][k]
                    if before is not None and before != v["online"]:
                        changes.append(("on" if v["online"] else "off", f"{name} " + ("turned on" if v["online"] else "turned off"),
                                        "computer" if v["online"] else "system-shutdown", k, not pw))
                    last_known[k] = v["online"]
                    state["devices"][k] = v
                    push(f"lat:{k}", v["latency"])
                if internet:
                    prev = state.get("internet")
                    if internet["online"] and (not prev or not prev["online"]):
                        internet["since"] = time.time()
                    elif internet["online"]:
                        internet["since"] = prev.get("since", time.time())
                    else:
                        internet["down_since"] = (prev or {}).get("down_since") or time.time()
                    if prev and prev["online"] != internet["online"]:
                        if internet["online"]:
                            mins = max(1, round((time.time() - prev.get("down_since", time.time())) / 60))
                            changes.append(("on", f"Internet is back (was down {mins} min)", "network-wireless", None))
                        else:
                            changes.append(("off", "Internet went down", "network-wireless-offline", None))
                    state["internet"] = internet
                    push("net_lat", ilat)
            for kind, text, icon, dev, *loud in changes:
                event(kind, text, icon, dev=dev, alert=loud[0] if loud else True)
            # TVs: read volume/playback while they're on (cheap: 4 tiny SOAP calls).
            if tick % 2 == 0:
                for d in load_devices():
                    if d.get("dlna") and devices.get(d["id"], {}).get("online"):
                        st = tv_status(d["dlna"])
                        with lock:
                            if st:
                                state["tv"][d["id"]] = st
                            else:
                                state["tv"].pop(d["id"], None)
            if devices and (tick % 10 == 0 or changes):
                with lock:
                    snap = {k: {"online": on, "since": state["devices"].get(k, {}).get("since") if on else None,
                                "checked": time.time()}
                            for k, on in last_known.items()}
                save_json(UPTIME_FILE, snap)
        except Exception:
            pass
        tick += 1
        time.sleep(INTERVAL)


def wake(mac):
    raw = bytes.fromhex(mac.replace(":", "").replace("-", ""))
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        for _ in range(3):
            s.sendto(b"\xff" * 6 + raw * 16, ("255.255.255.255", 9))


def shared_folder():
    """The laptop folder a Windows PC sees during Remote Desktop (and where files for it land without SSH)."""
    try:
        out = subprocess.run(["xdg-user-dir", "DOWNLOAD"], capture_output=True, text=True, timeout=3).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        out = ""
    return Path(out) if out and Path(out).is_dir() else Path.home()


def rdp_connect(device):
    """Open Remote Desktop to a Windows PC in Remmina. None, or what's wrong in plain words."""
    host = lan_ip(device.get("host"))
    if not host:
        return "Invalid address"
    if probe(host, 3389, 1.5) is None:
        return "Remote Desktop is off on the PC (Settings › System › Remote Desktop)"
    # One Remmina profile per PC. Remmina keeps its own settings there, and the password in the
    # system keyring if you tick "save"; Homebase only refreshes the address and the shared folder.
    folder = DATA / "remmina"
    folder.mkdir(exist_ok=True)
    profile = folder / f"{device['id']}.remmina"
    cfg = configparser.ConfigParser(interpolation=None)
    cfg.optionxform = str
    try:
        cfg.read(profile, encoding="utf-8")
    except configparser.Error:
        cfg = configparser.ConfigParser(interpolation=None)
        cfg.optionxform = str
    if "remmina" not in cfg:
        cfg["remmina"] = {}
    r = cfg["remmina"]
    r.update({"name": clean_name(device["name"]), "protocol": "RDP", "server": host, "sharefolder": str(shared_folder()),
              # Full screen, and the PC's desktop takes this screen's resolution: it looks like the PC's own
              # screen rather than another app. Remmina's toolbar peeks in at the top edge to leave.
              "viewmode": "4", "resolution_mode": "1"})
    if device.get("ssh_user") and "username" not in r:  # a name corrected in Remmina's login box wins
        r["username"] = device["ssh_user"]
    # A Microsoft account logs in with its email, and FreeRDP must be told it's one: without this
    # domain it reads "name@outlook.com" as a company (Kerberos) login and the sign-in fails.
    if "@" in r.get("username", "") and not r.get("domain"):
        r["domain"] = "MicrosoftAccount"
    # A PC prepared by Homebase signs in on its own Windows screen (PIN or password), which avoids
    # the Microsoft-account sign-in that FreeRDP can't do. Otherwise let Remmina negotiate.
    if device.get("nla") == 0:
        r["security"] = "tls"
    else:
        r.pop("security", None)
    with open(profile, "w", encoding="utf-8") as f:
        cfg.write(f, space_around_delimiters=False)
    try:
        # Remmina's own messages (why a login failed...) go to a log next to the profile.
        with open(folder / "last.log", "w") as log:
            subprocess.Popen(["remmina", "-c", str(profile)], stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    except OSError:
        return "Remmina is missing on this computer (sudo dnf install remmina)"
    return None


def connect(device):
    """None, or an error message."""
    if is_windows(device):
        return rdp_connect(device)
    if device.get("ssh") and lan_ip(device.get("host")):
        target = f"{device['ssh_user']}@{device['host']}" if device.get("ssh_user") else device["host"]
        subprocess.Popen(["ptyxis", "--new-window", "--", "ssh", "--", target],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        return None
    return "Don't know how to connect to it"


# --- TVs over DLNA -----------------------------------------------------------
# Old smart TVs (like the NEI) often only speak DLNA/UPnP: volume, mute and
# play/pause/stop/seek of whatever is playing. No power or app control.

UPNP = "urn:schemas-upnp-org:service:"
MAX_UPNP_BYTES = 256 * 1024  # device descriptions and SOAP replies are a few KB


def dlna_discover(ip, wait=3.0):
    """Find the TV's MediaRenderer and its control URLs via SSDP."""
    msg = ("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\n"
           "MX: 2\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n").encode()
    location = None
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.settimeout(wait)
        s.sendto(msg, ("239.255.255.250", 1900))
        try:
            while not location:
                data, addr = s.recvfrom(4096)
                if addr[0] != ip:
                    continue
                for line in data.decode(errors="replace").split("\r\n"):
                    if line.lower().startswith("location:"):
                        location = line.split(":", 1)[1].strip()
        except socket.timeout:
            return None
    u = urlparse(location)
    # The URL comes from whatever answered on the network: only http, only to that device.
    if u.scheme != "http" or u.hostname != ip:
        return None
    try:
        with urllib.request.urlopen(location, timeout=4) as r:
            root = ET.fromstring(r.read(MAX_UPNP_BYTES))
    except (OSError, ET.ParseError):
        return None
    out = {"base": f"{u.scheme}://{u.netloc}", "port": u.port or 80}
    for svc in root.iter():
        if not svc.tag.endswith("}service"):
            continue
        typ = next((c.text for c in svc if c.tag.endswith("serviceType")), "") or ""
        ctl = next((c.text for c in svc if c.tag.endswith("controlURL")), "") or ""
        if "AVTransport" in typ:
            out["avt"] = ctl if ctl.startswith("/") else "/" + ctl
        elif "RenderingControl" in typ:
            out["rc"] = ctl if ctl.startswith("/") else "/" + ctl
    return out if "avt" in out and "rc" in out else None


def soap(dlna, which, action, args="", timeout=3):
    service = "AVTransport" if which == "avt" else "RenderingControl"
    body = ('<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
            's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>'
            f'<u:{action} xmlns:u="{UPNP}{service}:1"><InstanceID>0</InstanceID>{args}</u:{action}>'
            '</s:Body></s:Envelope>').encode()
    req = urllib.request.Request(dlna["base"] + dlna[which], data=body, headers={
        "Content-Type": 'text/xml; charset="utf-8"',
        "SOAPACTION": f'"{UPNP}{service}:1#{action}"',
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        root = ET.fromstring(r.read(MAX_UPNP_BYTES))
    return {el.tag.split("}")[-1]: (el.text or "") for el in root.iter()}


def hms(sec):
    sec = max(0, int(sec))
    return f"{sec // 3600}:{sec % 3600 // 60:02d}:{sec % 60:02d}"


def secs(t):
    try:
        h, m, s = (t or "").split(":")
        return int(h) * 3600 + int(m) * 60 + float(s)
    except ValueError:
        return None


def tv_status(dlna):
    """Volume, mute, what's playing and where we are in it. None if unreachable."""
    try:
        vol = soap(dlna, "rc", "GetVolume", "<Channel>Master</Channel>")
        mute = soap(dlna, "rc", "GetMute", "<Channel>Master</Channel>")
        tr = soap(dlna, "avt", "GetTransportInfo")
        pos = soap(dlna, "avt", "GetPositionInfo")
    except (OSError, ET.ParseError):
        return None
    title = None
    meta = pos.get("TrackMetaData") or ""
    if meta.startswith("<"):
        try:
            title = next((el.text for el in ET.fromstring(meta).iter() if el.tag.endswith("}title")), None)
        except ET.ParseError:
            pass
    if not title and pos.get("TrackURI"):
        title = pos["TrackURI"].rsplit("/", 1)[-1][:80]
    return {
        "volume": int(vol.get("CurrentVolume") or 0),
        "mute": mute.get("CurrentMute") in ("1", "true"),
        "state": tr.get("CurrentTransportState", ""),  # PLAYING, PAUSED_PLAYBACK, STOPPED, NO_MEDIA_PRESENT
        "title": title,
        "pos": secs(pos.get("RelTime")),
        # With nothing loaded this TV reports junk durations; anything over a day isn't real.
        "dur": d if (d := secs(pos.get("TrackDuration"))) and d < 86400 else None,
        "t": time.time(),
    }


def tv_command(dev, op, value=None):
    d = dev.get("dlna")
    if not d:
        return False
    try:
        if op == "volume":
            soap(d, "rc", "SetVolume", f"<Channel>Master</Channel><DesiredVolume>{max(0, min(100, int(value)))}</DesiredVolume>")
        elif op == "mute":
            soap(d, "rc", "SetMute", f"<Channel>Master</Channel><DesiredMute>{1 if value else 0}</DesiredMute>")
        elif op == "play":
            soap(d, "avt", "Play", "<Speed>1</Speed>")
        elif op == "pause":
            soap(d, "avt", "Pause")
        elif op == "stop":
            soap(d, "avt", "Stop")
        elif op == "seek":
            soap(d, "avt", "Seek", f"<Unit>REL_TIME</Unit><Target>{hms(float(value))}</Target>")
        else:
            return False
    except (OSError, ET.ParseError, ValueError, TypeError):
        return False
    # Refresh right away so the page reflects the change without waiting a tick.
    st = tv_status(d)
    if st:
        with lock:
            state["tv"][dev["id"]] = st
    # Some TVs (the NEI) answer OK but ignore volume/mute while their own apps
    # (YouTube...) are on screen, so check it actually changed.
    if st and op == "volume" and st["volume"] != max(0, min(100, int(value))):
        return False
    if st and op == "mute" and st["mute"] != bool(value):
        return False
    return True


MAC_RE = re.compile(r"^[0-9a-f]{2}(:[0-9a-f]{2}){5}$")


def lan_ip(value):
    """The address as a private IPv4 string, or None. Device hosts end up as arguments
    to ssh/ssh-keygen/ip, so nothing else (like "-oProxyCommand=...") may get in."""
    try:
        ip = ipaddress.IPv4Address(str(value).strip())
    except ValueError:
        return None
    return str(ip) if ip.is_private and not ip.is_loopback else None


def clean_name(value, limit=40):
    """Device names go into the page, notifications and the terminal: no control characters."""
    return "".join(ch for ch in str(value or "") if ch.isprintable()).strip()[:limit]


def add_device(body):
    ip, mac = lan_ip(body.get("ip", "")), str(body.get("mac", "")).lower()
    name = clean_name(body.get("name"))
    kind = body.get("kind") if body.get("kind") in ("desktop", "laptop", "pi", "tv", "other") else "other"
    if not ip or not MAC_RE.match(mac) or not name:
        return None
    dev = {"id": mac.replace(":", ""), "name": name, "kind": kind, "host": ip, "mac": mac}
    if kind == "pi":
        # No username guess: Raspberry Pi OS has no default "pi" user anymore. The app asks on first connect.
        dev.update(os="Raspberry Pi OS", probe_port=22, ssh=True)
    elif kind == "tv" and (dlna := dlna_discover(ip)):
        dev.update(os="Smart TV (DLNA)", dlna=dlna, probe_port=dlna["port"])
    else:
        # Try a few common ports; whichever answers (or refuses) is used for status.
        dev["probe_port"] = next((p for p in (22, 135, 445, 80, 443) if probe(ip, p, 0.5) is not None), None)
        if dev["probe_port"] == 22:
            dev["ssh"] = True
        if not dev["probe_port"]:
            del dev["probe_port"]
    # Whatever we worked out about it during discovery (Windows, Linux...), so the card shows it.
    if not dev.get("os"):
        label = load_json(IDENTITY_FILE, {}).get(mac, {}).get("label")
        if label:
            dev["os"] = label
    # Re-adding something that was removed earlier brings back its settings
    # (SSH user, key...), only the name and type come from the form.
    forgotten = load_json(FORGOTTEN_FILE, {})
    if mac in forgotten:
        dev = forgotten.pop(mac) | {"name": name, "kind": kind, "host": ip}
        if kind == "tv":  # a TV has no SSH, whatever this address was set up as before
            for k in ("ssh", "ssh_user", "key"):
                dev.pop(k, None)
        save_json(FORGOTTEN_FILE, forgotten)
    with devices_lock:
        devices = [d for d in load_devices() if d.get("mac", "").lower() != mac]
        devices.append(dev)
        save_devices(devices)
    return dev


SSH_USER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.-]{0,31}$")


def edit_device(dev_id, body):
    """Change what a person can set on a device card: name and user (for SSH and Remote Desktop)."""
    with devices_lock:
        devices = load_devices()
        dev = next((d for d in devices if d["id"] == dev_id), None)
        if not dev:
            return "This device no longer exists"
        if "name" in body:
            name = clean_name(body["name"])
            if not name:
                return "The name can't be empty"
            dev["name"] = name
        if "ssh_user" in body:
            user = str(body["ssh_user"]).strip()
            if user and not SSH_USER_RE.match(user):
                return "Invalid user name (letters, digits and - _ . only)"
            if user != dev.get("ssh_user", ""):
                dev.pop("key", None)  # the key was set up for the old user
            if user:
                dev["ssh_user"], dev["ssh"] = user, True
            else:
                dev.pop("ssh_user", None)
        save_devices(devices)
    return None


def ssh_forget_key(dev_id):
    """After a device is reinstalled its SSH key changes and ssh refuses to connect; forget the old one."""
    dev = next((d for d in load_devices() if d["id"] == dev_id), None)
    host = lan_ip(dev["host"]) if dev else None
    if not host:
        return False
    r = subprocess.run(["ssh-keygen", "-R", host], capture_output=True, text=True)
    return r.returncode == 0


def remove_device(dev_id):
    with devices_lock:
        devices = load_devices()
        keep = [d for d in devices if d["id"] != dev_id]
        save_devices(keep)
    gone = next((d for d in devices if d["id"] == dev_id), None)
    if gone and gone.get("mac"):
        forgotten = load_json(FORGOTTEN_FILE, {})
        forgotten[gone["mac"].lower()] = gone
        save_json(FORGOTTEN_FILE, forgotten)
    with lock:
        state["devices"].pop(dev_id, None)
        state["history"].pop(f"lat:{dev_id}", None)
    return len(keep) != len(devices)


# --- Built-in terminal -------------------------------------------------------
# The page shows an xterm.js window; here an `ssh` runs in a pseudo-terminal.
# Output goes to the page as Server-Sent Events, keystrokes come back as POSTs.
# Only `ssh <device from devices.json>` can be started, never an arbitrary command.

terms = {}
terms_lock = threading.Lock()


class TermSession:
    def __init__(self, argv):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:  # child: become ssh (or ssh-copy-id)
            os.environ["TERM"] = "xterm-256color"
            os.execvp(argv[0], argv)
        self.chunks = []  # output so far, so a reconnecting page can catch up
        self.closed = False
        self.cond = threading.Condition()
        self.last_seen = time.time()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        while True:
            try:
                data = os.read(self.fd, 4096)
            except OSError:
                data = b""
            with self.cond:
                if not data:
                    self.closed = True
                    self.cond.notify_all()
                    break
                self.chunks.append(data)
                if len(self.chunks) > 4000:  # keep memory bounded
                    self.chunks = self.chunks[-2000:]
                self.cond.notify_all()
        try:
            os.waitpid(self.pid, 0)
        except ChildProcessError:
            pass
        os.close(self.fd)

    def write(self, data):
        if not self.closed:
            try:
                os.write(self.fd, data)
            except OSError:
                pass  # ssh just exited; the stream reports it

    def resize(self, cols, rows):
        if not self.closed:
            fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def kill(self):
        if not self.closed:
            try:
                os.kill(self.pid, signal.SIGHUP)
            except ProcessLookupError:
                pass


def ssh_target(device):
    """"user@ip" for a device, only from validated parts (it ends up as an ssh argument)."""
    if not device or not device.get("ssh") or not lan_ip(device.get("host")):
        return None
    if device.get("ssh_user") and not SSH_USER_RE.match(device["ssh_user"]):
        return None
    return f"{device['ssh_user']}@{device['host']}" if device.get("ssh_user") else device["host"]


def is_windows(device):
    return "windows" in str(device.get("os", "")).lower()


def term_start(device, mode="shell"):
    """mode: "shell", or a quick action ("update", "reboot"...)."""
    target = ssh_target(device)
    if not target:
        return None
    if mode == "shell":
        argv = ["ssh", *remote.ssh_args(interactive=True), "-o", "ServerAliveInterval=15", "--", target]
    else:
        argv = remote.action_argv(target, is_windows(device), mode)
    if not argv:
        return None
    sid = secrets.token_urlsafe(16)
    with terms_lock:
        terms[sid] = TermSession(argv)
    return sid


def key_setup(dev_id, password):
    """Install Homebase's key with the device's password (used once, never stored). None or an error."""
    dev = next((d for d in load_devices() if d["id"] == dev_id), None)
    target = ssh_target(dev)
    if not target:
        return "Set the SSH user first"
    if not password:
        return "Type the password"
    err = remote.install_key(target, is_windows(dev), password)
    if err is None:
        event("info", f"{dev['name']}: password-free access set up", alert=False, dev=dev_id)
        if not is_windows(dev):  # Windows restarts over SSH without sudo
            remote.allow_power(target, dev["ssh_user"], password)
    with devices_lock:
        devices = load_devices()
        for d in devices:
            if d["id"] == dev_id:
                d["key"] = err is None
        save_devices(devices)
    return err


def key_remove(dev_id):
    """Take Homebase's key off the device and stop using it. None or an error."""
    dev = next((d for d in load_devices() if d["id"] == dev_id), None)
    target = ssh_target(dev)
    if not target:
        return "This device has no SSH set up"
    err = remote.remove_key(target, is_windows(dev))
    if err is None:
        with devices_lock:
            devices = load_devices()
            for d in devices:
                if d["id"] == dev_id:
                    d.pop("key", None)
            save_devices(devices)
        with lock:
            state["sshstats"].pop(dev_id, None)
        event("info", f"{dev['name']}: password-free access removed", alert=False, dev=dev_id)
    return err


def device_events(dev, limit=5):
    """Newest events about one device. Older events have no "dev" field; those match by name."""
    with lock:
        evs = list(events)
    mine = [e for e in reversed(evs) if e.get("dev") == dev["id"]
            or ("dev" not in e and e["text"].startswith(dev["name"] + " "))]
    return mine[:limit]


def rdp_checker():
    """Whether each Windows PC answers on Remote Desktop (the card greys out Connect when it doesn't)."""
    time.sleep(8)  # first look soon after start, once the sampler knows which devices are on
    while True:
        try:
            with lock:
                status = dict(state["devices"])
            for d in load_devices():
                if is_windows(d) and status.get(d["id"], {}).get("online") and lan_ip(d.get("host")):
                    ok = probe(d["host"], 3389, 1.5) is not None
                    with lock:
                        state["rdp"][d["id"]] = ok
        except Exception:
            pass
        time.sleep(30)


devspeed = {"phase": "idle"}  # the device speed test: one at a time, polled by the page while it runs
devspeed_lock = threading.Lock()


def device_speed(dev, target):
    """The device's own internet speed test (see remote.net_speed)."""
    with devspeed_lock:
        if devspeed.get("phase") in ("ping", "download", "upload"):
            return
        devspeed.clear()
        devspeed.update(phase="ping", dev=dev["id"], started=time.time())

    def report(**kw):
        with devspeed_lock:
            devspeed.update(kw)
    try:
        res = remote.net_speed(target, is_windows(dev), report)
    except Exception:
        res = {"error": "the test didn't finish there"}
    with devspeed_lock:
        if "error" in res:
            devspeed.update(phase="error", live=0, error=f"{dev['name']} {res['error']}")
        else:
            devspeed.update(res, phase="done", live=0, finished=time.time())


SSH_STATS_EVERY = 30  # seconds
SSH_STATS_FRESH = 90


def ssh_stats_poller():
    """CPU, memory, disk and temperature of Linux devices with the key set up, read over SSH."""
    while True:
        try:
            with lock:
                status = dict(state["devices"])
            devs = [d for d in load_devices() if d.get("key") and not is_windows(d)
                    and status.get(d["id"], {}).get("online") and ssh_target(d)]
            if devs:
                with ThreadPoolExecutor(min(4, len(devs))) as ex:
                    results = list(ex.map(lambda d: remote.stats(ssh_target(d), d["id"]), devs))
                with lock:
                    for d, st in zip(devs, results):
                        if st:
                            state["sshstats"][d["id"]] = st
                            if st.get("cpu") is not None:
                                push(f"cpu:{d['id']}", st["cpu"])
                            if st.get("temp") is not None:
                                push(f"temp:{d['id']}", st["temp"])
                            push(f"ram:{d['id']}", round(100 * (1 - st["mem_free"] / st["mem_total"]), 1))
        except Exception:
            pass
        time.sleep(SSH_STATS_EVERY)


UPLOAD_MAX = 4 * 1024**3


def safe_filename(name):
    """The file's own name, without folders or characters a remote shell or Windows would mind."""
    name = str(name).replace("\\", "/").rsplit("/", 1)[-1]
    name = "".join(ch for ch in name if ch.isprintable() and ch not in '<>:"|?*$`;&')
    name = name.strip().lstrip(".-").strip()[:120]
    return name or "file"


def receive_and_send(handler, dev, name):
    """Save the upload, then deliver it: with scp when the key is set up, otherwise (a Windows PC)
    into the laptop folder that Remote Desktop shares with it. Returns "ssh", "shared" or None."""
    target = ssh_target(dev) if dev.get("key") else None
    shared = not target and is_windows(dev)
    length = int(handler.headers.get("Content-Length", 0))
    if not (target or shared) or not 0 < length <= UPLOAD_MAX:
        return None
    tmp_dir = DATA / "tmp"
    tmp_dir.mkdir(exist_ok=True)
    tmp = tmp_dir / secrets.token_hex(8)
    try:
        with open(tmp, "wb") as f:
            left = length
            while left:
                chunk = handler.rfile.read(min(left, 1024 * 1024))
                if not chunk:
                    return None
                f.write(chunk)
                left -= len(chunk)
        if target:
            return "ssh" if remote.send_file(target, is_windows(dev), tmp, safe_filename(name)) else None
        dest = shared_folder() / safe_filename(name)
        stem, n = dest.stem, 1
        while dest.exists():  # never overwrite something already there
            dest, n = dest.with_name(f"{stem} ({n}){dest.suffix}"), n + 1
        shutil.move(str(tmp), dest)
        return "shared"
    finally:
        tmp.unlink(missing_ok=True)


def term_reaper():
    """Close terminals whose window went away without saying goodbye."""
    while True:
        time.sleep(30)
        with terms_lock:
            for sid, t in list(terms.items()):
                if t.closed or time.time() - t.last_seen > 120:
                    t.kill()
                    if t.closed:
                        del terms[sid]


# --- Stats agents ------------------------------------------------------------
# A PC runs a small script that POSTs its stats to the netbook. Setup: the panel
# makes a short one-time code; on the PC, `irm http://<netbook>:8801/a/<code> | iex`
# downloads an installer that carries the device's long push token.

STATS_FRESH = 20  # seconds; older stats count as "agent not reporting"
ENROLL_TTL = 15 * 60
enrollments = {}  # short code -> (device id, expires)


def agent_enroll(dev_id):
    with devices_lock:
        devices = load_devices()
        dev = next((d for d in devices if d["id"] == dev_id), None)
        if not dev:
            return None
        if not dev.get("agent_token"):
            dev["agent_token"] = secrets.token_urlsafe(24)
            save_devices(devices)
    code = secrets.token_urlsafe(6)
    enrollments[code] = (dev_id, time.time() + ENROLL_TTL)
    return f"irm http://{local_net()}:{AGENT_PORT}/a/{code} | iex"


def agent_installer(code):
    dev_id, expires = enrollments.get(code, (None, 0))
    if time.time() > expires:
        return None
    dev = next((d for d in load_devices() if d["id"] == dev_id), None)
    if not dev or not dev.get("agent_token"):
        return None
    push_url = f"http://{local_net()}:{AGENT_PORT}/push/{dev['agent_token']}"
    agent = (HERE / "agent-windows.ps1").read_text(encoding="utf-8").replace("__PUSH_URL__", push_url)
    script = (HERE / "install-windows.ps1").read_text(encoding="utf-8").replace("__AGENT__", agent)
    # Homebase's own public key, so the PC trusts it for SSH without anyone typing a password.
    return script.replace("__HOMEBASE_KEY__", remote.public_key())


NUM_FIELDS = ("boot", "cpu", "mem_total", "mem_free", "disk_total", "disk_free", "gpu", "net_down", "net_up", "top_cpu", "nla")


ssh_tries = {}  # device id -> last attempt, so a PC whose key doesn't work isn't retried every 5 s


def adopt_ssh(dev_id, user):
    """A prepared Windows PC reports SSH running: set its user and check Homebase's key works there."""
    if time.time() - ssh_tries.get(dev_id, 0) < 300 or not SSH_USER_RE.match(user or ""):
        return
    ssh_tries[dev_id] = time.time()
    with devices_lock:
        devices = load_devices()
        dev = next((d for d in devices if d["id"] == dev_id), None)
        if not dev:
            return
        dev.setdefault("ssh_user", user)
        dev["ssh"] = True
        save_devices(devices)
    target = ssh_target(dev)
    if target and remote.key_works(target):
        with devices_lock:
            devices = load_devices()
            for d in devices:
                if d["id"] == dev_id:
                    d["key"] = True
            save_devices(devices)
        event("info", f"{dev['name']}: SSH ready", alert=False, dev=dev_id)


def agent_push(token, body):
    dev = next((d for d in load_devices() if d.get("agent_token") and secrets.compare_digest(d["agent_token"], token)), None)
    if not dev:
        return False
    stats = {"t": time.time()}
    for k in NUM_FIELDS:  # keep only known fields, as numbers
        v = body.get(k)
        stats[k] = float(v) if isinstance(v, (int, float)) else None
    for k in ("host", "os", "top_name", "model", "user"):
        stats[k] = clean_name(body.get(k), 80)
    with lock:
        first = dev["id"] not in state["stats"]
        state["stats"][dev["id"]] = stats
        push(f"cpu:{dev['id']}", stats["cpu"])
        if stats["mem_total"] and stats["mem_free"] is not None:
            push(f"ram:{dev['id']}", round(100 * (1 - stats["mem_free"] / stats["mem_total"]), 1))
        if stats["gpu"] is not None:
            push(f"gpu:{dev['id']}", stats["gpu"])
    # SSH came up on the PC (the installer put Homebase's key there): start using it.
    if body.get("ssh") == 1 and not dev.get("key"):
        threading.Thread(target=adopt_ssh, args=(dev["id"], stats["user"]), daemon=True).start()
    # Remember how Remote Desktop signs in, so Remmina is set up right even when the agent is quiet.
    if stats["nla"] is not None and dev.get("nla") != int(stats["nla"]):
        with devices_lock:
            devices = load_devices()
            for d in devices:
                if d["id"] == dev["id"]:
                    d["nla"] = int(stats["nla"])
            save_devices(devices)
    # Only the very first report is news; after a restart of this service it would just repeat.
    if first and not dev.get("agent_seen"):
        with devices_lock:
            devices = load_devices()
            for d in devices:
                if d["id"] == dev["id"]:
                    d["agent_seen"] = True
            save_devices(devices)
        event("on", f"{dev['name']} is sending stats", "computer", alert=False)
    return True


class AgentHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, code, body, ctype="text/plain; charset=utf-8"):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parts = self.path.strip("/").split("/")
        if len(parts) == 2 and parts[0] == "a":
            script = agent_installer(parts[1])
            if script:
                return self.reply(200, script)
            return self.reply(404, "Write-Host 'This code has expired. Make a new one in Homebase.' -ForegroundColor Red")
        self.reply(404, "not found")

    def do_POST(self):
        parts = self.path.strip("/").split("/")
        if len(parts) != 2 or parts[0] != "push":
            return self.reply(404, "not found")
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length > 16384:
                return self.reply(413, "too big")
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self.reply(400, "bad json")
        if not isinstance(body, dict) or not agent_push(parts[1], body):
            return self.reply(403, "unknown device")
        self.reply(200, "ok")


PANEL_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def foreign_host(self):
        """True for requests whose Host isn't us. Blocks DNS rebinding: a web page on
        another domain that resolves to 127.0.0.1 would otherwise read /api/state."""
        if self.headers.get("Host") in PANEL_HOSTS:
            return False
        self.send(403, {"error": "forbidden"})
        return True

    def send(self, code, body, ctype="application/json", cache="no-store"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.foreign_host():
            return
        if self.path in ("/", "/index.html"):
            page = UI_DIR / "index.html"
            if not page.is_file():
                return self.send(500, b"The page isn't built yet: run `npm install && npm run build:ui`.", "text/plain; charset=utf-8")
            self.send(200, page.read_bytes(), "text/html; charset=utf-8")
        elif self.path.startswith("/assets/"):
            # Built files only: a plain name with a known type, inside dist/assets. Their names change
            # with their content, so the browser may keep them for good.
            name = self.path[len("/assets/"):]
            f = UI_DIR / "assets" / name
            ctype = ASSET_TYPES.get(Path(name).suffix)
            if not ctype or not re.fullmatch(r"[A-Za-z0-9_.-]+", name) or ".." in name or not f.is_file():
                return self.send(404, {"error": "not found"})
            self.send(200, f.read_bytes(), ctype, cache="public, max-age=31536000, immutable")
        elif self.path.startswith("/api/term/") and self.path.endswith("/stream"):
            self.term_stream(self.path.split("/")[3])
        elif self.path == "/api/netspeed":  # polled fast while the internet speed test runs
            self.send(200, netspeed.snapshot())
        elif self.path == "/api/devspeed":  # same, for the speed test to a device
            with devspeed_lock:
                snap = dict(devspeed)
            self.send(200, snap)
        elif self.path == "/api/state":
            raw = load_devices()
            known = {d.get("mac", "").lower() for d in raw}
            devices = [{k: v for k, v in d.items() if k != "agent_token"}
                       | {"has_wake": bool(d.get("mac")) and d.get("kind") in ("desktop", "laptop", "other"),
                          "has_agent": bool(d.get("agent_token")), "windows": is_windows(d),
                          "recent": device_events(d), "rdp": state["rdp"].get(d["id"]),
                          "power": (state["power"].get(d["id"]) or {}).get("action")} for d in raw]
            with lock:
                body = {
                    "netbook": state["netbook"],
                    "status": state["devices"],
                    "devices": devices,
                    "discovered": [v for k, v in state["discovered"].items()
                                   if k not in known and v["kind"] not in ("phone", "router")],
                    "last_scan": state["last_scan"],
                    "internet": state.get("internet"),
                    "sshstats": {k: v for k, v in state["sshstats"].items() if time.time() - v["t"] < SSH_STATS_FRESH},
                    "gateway": next((v["ip"] for v in state["discovered"].values() if v["kind"] == "router"), None),
                    "events": list(events)[-30:][::-1],
                    "stats": {k: v for k, v in state["stats"].items() if time.time() - v["t"] < STATS_FRESH},
                    "history": {k: list(v) for k, v in state["history"].items()},
                    "agents_enabled": AGENTS_ENABLED,
                    # Changes when the page itself changes, so an open page knows to reload.
                    "ui": int((UI_DIR / "index.html").stat().st_mtime) if (UI_DIR / "index.html").exists() else 0,
                    "tv": {k: v for k, v in state["tv"].items() if time.time() - v["t"] < 15},
                    "now": time.time(),
                }
            self.send(200, body)
        else:
            self.send(404, {"error": "not found"})

    def term_stream(self, sid):
        t = terms.get(sid)
        if not t:
            return self.send(404, {"error": "no such terminal"})
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        sent = 0
        try:
            while True:
                with t.cond:
                    while sent >= len(t.chunks) and not t.closed:
                        if not t.cond.wait(timeout=15):
                            break
                    new, sent = t.chunks[sent:], len(t.chunks)
                    closed = t.closed
                t.last_seen = time.time()
                if new:
                    self.wfile.write(b"data: " + base64.b64encode(b"".join(new)) + b"\n\n")
                elif not closed:
                    self.wfile.write(b": ping\n\n")  # keepalive, also detects a closed window
                if closed and sent >= len(t.chunks):
                    self.wfile.write(b"event: exit\ndata: x\n\n")
                    self.wfile.flush()
                    return
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        if self.foreign_host():
            return
        # Only accept requests from the page itself.
        if self.headers.get("Origin") not in (None, f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"):
            return self.send(403, {"error": "forbidden"})
        parts = self.path.strip("/").split("/")
        if parts == ["api", "netspeed"]:  # start the internet speed test (no-op if one is running)
            threading.Thread(target=netspeed.run, daemon=True).start()
            return self.send(200, {"ok": True})
        if parts == ["api", "scan"]:
            threading.Thread(target=scan, daemon=True).start()
            return self.send(200, {"ok": True})
        if parts == ["api", "add"]:
            try:
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(min(length, 4096)) or b"{}")
            except (ValueError, json.JSONDecodeError):
                return self.send(400, {"error": "bad json"})
            dev = add_device(body)
            return self.send(200 if dev else 400, {"ok": bool(dev), "device": dev})
        if len(parts) == 4 and parts[:2] == ["api", "term"]:
            sid, op = parts[2], parts[3]
            if sid == "start":
                dev = next((d for d in load_devices() if d["id"] == op), None)
                try:
                    req = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length", 0)), 256)) or b"{}")
                    mode = str(req.get("mode", "shell")) if isinstance(req, dict) else "shell"
                except (ValueError, json.JSONDecodeError):
                    mode = "shell"
                new = term_start(dev, mode) if dev else None
                return self.send(200 if new else 400, {"ok": bool(new), "sid": new})
            t = terms.get(sid)
            if not t:
                return self.send(404, {"error": "no such terminal"})
            length = min(int(self.headers.get("Content-Length", 0)), 65536)
            body = self.rfile.read(length)
            if op == "input":
                t.write(body)
            elif op == "resize":
                try:
                    size = json.loads(body or b"{}")
                    cols, rows = int(size.get("cols", 80)), int(size.get("rows", 24))
                    t.resize(max(10, min(500, cols)), max(5, min(200, rows)))
                except (ValueError, TypeError, AttributeError, OSError):
                    return self.send(400, {"error": "bad size"})
            elif op == "close":
                t.kill()
            else:
                return self.send(400, {"error": "bad op"})
            return self.send(200, {"ok": True})
        if self.path.startswith("/api/send/"):
            u = urlparse(self.path)
            dev = next((d for d in load_devices() if d["id"] == u.path.split("/")[3]), None)
            name = parse_qs(u.query).get("name", [""])[0]
            how = receive_and_send(self, dev, name) if dev else None
            return self.send(200, {"ok": bool(how), "via": how, "folder": str(shared_folder()) if how == "shared" else None})
        if len(parts) != 3 or parts[0] != "api":
            return self.send(404, {"error": "not found"})
        action, dev_id = parts[1], parts[2]
        if action == "keyremove":
            err = key_remove(dev_id)
            return self.send(200, {"ok": err is None, "error": err})
        if action == "keysetup":
            try:
                req = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length", 0)), 1024)) or b"{}")
                password = str(req.get("password") or "") if isinstance(req, dict) else ""
            except (ValueError, json.JSONDecodeError):
                return self.send(400, {"error": "bad json"})
            err = key_setup(dev_id, password)
            return self.send(200, {"ok": err is None, "error": err})
        if action == "power":
            dev = next((d for d in load_devices() if d["id"] == dev_id), None)
            target = ssh_target(dev) if dev and dev.get("key") else None
            try:
                what = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length", 0)), 256)) or b"{}").get("action")
            except (ValueError, json.JSONDecodeError, AttributeError):
                what = None
            if not target or what not in ("reboot", "poweroff"):
                return self.send(400, {"ok": False})
            res = remote.power(target, is_windows(dev), what)
            if res == "ok":
                with lock:
                    state["power"][dev_id] = {"action": what, "t": time.time(), "off": False}
                event("info", f"{dev['name']}: " + ("restarting" if what == "reboot" else "shutting down"), alert=False, dev=dev_id)
            return self.send(200, {"ok": res == "ok", "password": res == "password"})
        if action == "speed":  # starts in the background; the page polls GET /api/devspeed for the live gauge
            dev = next((d for d in load_devices() if d["id"] == dev_id), None)
            target = ssh_target(dev) if dev and dev.get("key") else None
            if not target:
                return self.send(400, {"ok": False})
            threading.Thread(target=device_speed, args=(dev, target), daemon=True).start()
            return self.send(200, {"ok": True})
        if action == "remove":
            return self.send(200, {"ok": remove_device(dev_id)})
        if action == "agent":
            cmd = agent_enroll(dev_id)
            return self.send(200 if cmd else 404, {"ok": bool(cmd), "command": cmd})
        if action in ("edit", "sshreset"):
            if action == "sshreset":
                return self.send(200, {"ok": ssh_forget_key(dev_id)})
            try:
                body = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length", 0)), 1024)) or b"{}")
            except (ValueError, json.JSONDecodeError):
                return self.send(400, {"error": "bad json"})
            err = edit_device(dev_id, body if isinstance(body, dict) else {})
            return self.send(200, {"ok": err is None, "error": err})
        dev = next((d for d in load_devices() if d["id"] == dev_id), None)
        if not dev:
            return self.send(404, {"error": "unknown device"})
        if action == "wake" and dev.get("mac"):
            wake(dev["mac"])
            return self.send(200, {"ok": True})
        if action == "connect":
            err = connect(dev)
            return self.send(200, {"ok": err is None, "error": err})
        if action == "tv":
            try:
                req = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length", 0)), 1024)) or b"{}")
            except (ValueError, json.JSONDecodeError):
                return self.send(400, {"error": "bad json"})
            return self.send(200, {"ok": tv_command(dev, req.get("op"), req.get("value"))})
        self.send(400, {"error": "bad action"})


if __name__ == "__main__":
    threading.Thread(target=sampler, daemon=True).start()
    threading.Thread(target=scanner, daemon=True).start()
    threading.Thread(target=term_reaper, daemon=True).start()
    threading.Thread(target=ssh_stats_poller, daemon=True).start()
    threading.Thread(target=rdp_checker, daemon=True).start()
    if AGENTS_ENABLED:
        agents = ThreadingHTTPServer(("0.0.0.0", AGENT_PORT), AgentHandler)
        threading.Thread(target=agents.serve_forever, daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
