"""What Homebase does on other devices over SSH, once its key is set up there:
stats without installing anything, quick actions, sending files, speed tests.

Everything here runs without prompts (BatchMode) using Homebase's own key, and
shares one connection per device (ControlMaster) so a check every 30 s doesn't
redo the SSH handshake on this slow CPU. Callers pass an already-validated
"user@ip" target; nothing here builds a shell command from user input.
"""
import base64
import os
import re
import shlex
import subprocess
import threading
import time
from pathlib import Path

KEY = None
CONTROL = None


def init(data):
    global KEY, CONTROL
    folder = data / "ssh"
    folder.mkdir(mode=0o700, exist_ok=True)
    KEY = folder / "id_ed25519"
    # Socket paths are limited to ~100 characters, so prefer the short runtime dir.
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    CONTROL = Path(runtime) / "homebase-ssh" if runtime else folder
    # %C adds 40 characters and ssh a temporary suffix on top; past the limit every call would fail.
    if len(str(CONTROL)) > 40:
        CONTROL = Path(f"/tmp/homebase-ssh-{os.getuid()}")
    CONTROL.mkdir(mode=0o700, exist_ok=True)


def public_key():
    """Homebase's own key (made on first use), separate from the user's ~/.ssh keys."""
    if not KEY.exists():
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "homebase", "-f", str(KEY)],
                       check=True, capture_output=True)
    return KEY.with_name(KEY.name + ".pub").read_text().strip()


def ssh_args(interactive=False):
    """Options for every ssh/scp call. Interactive sessions (the terminal) skip the
    shared connection and may still ask for a password; the rest never ask."""
    args = ["-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=8"]
    if KEY.exists():
        args += ["-i", str(KEY)]
    if not interactive:
        # Keepalives: a connection that died silently (the device restarted, Wi-Fi changed) is dropped
        # in ~30 s instead of hanging every command that shares it, forever.
        args += ["-o", "BatchMode=yes", "-o", "ControlMaster=auto", "-o", f"ControlPath={CONTROL}/%C",
                 "-o", "ControlPersist=120", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3"]
    return args


def run(target, command, timeout=15):
    return subprocess.run(["ssh", *ssh_args(), "--", target, command],
                          capture_output=True, text=True, errors="replace", timeout=timeout)


def key_works(target):
    try:
        return run(target, "exit 0", timeout=12).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


# --- Setting the key up (once, with the password typed in the device's settings) --

# Windows keeps an administrator's keys in one shared file that must allow only
# Administrators and SYSTEM (SIDs, because the group names are translated).
WINDOWS_ADD_KEY = r"""
$k = '__KEY__'
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if ($me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $f = Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'
} else {
    $d = Join-Path $env:USERPROFILE '.ssh'
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    $f = Join-Path $d 'authorized_keys'
}
if (-not (Test-Path $f) -or -not (Select-String -Path $f -SimpleMatch $k -Quiet)) {
    Add-Content -Path $f -Value $k -Encoding ascii
}
if ($f -like "$env:ProgramData*") { icacls $f /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' | Out-Null }
Write-Host 'Homebase key added.'
"""


def powershell(script):
    """A command line that runs a PowerShell script without any quoting problems."""
    return "powershell -NoProfile -NonInteractive -EncodedCommand " + base64.b64encode(script.encode("utf-16-le")).decode()


def askpass():
    """A tiny helper ssh runs to get the password. It prints it from its environment, so the
    password is never written to disk nor put on a command line (which other users could see)."""
    path = KEY.with_name("askpass")
    if not path.exists():
        path.write_text("#!/bin/sh\nprintf '%s\\n' \"$HOMEBASE_PASSWORD\"\n")
        path.chmod(0o700)
    return str(path)


def install_key(target, windows, password):
    """Put Homebase's key on the device using its password, once. Returns None or an error message.
    The password is only handed to this one ssh run and never stored."""
    pub = public_key()
    env = os.environ | {"SSH_ASKPASS": askpass(), "SSH_ASKPASS_REQUIRE": "force", "HOMEBASE_PASSWORD": password}
    opts = ["-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=8", "-o", "NumberOfPasswordPrompts=1"]
    if windows:
        argv = ["ssh", *opts, "--", target, powershell(WINDOWS_ADD_KEY.replace("__KEY__", pub))]
    else:
        argv = ["ssh-copy-id", "-i", str(KEY) + ".pub", *opts, target]
    try:
        r = subprocess.run(argv, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True,
                           errors="replace", timeout=45)
    except subprocess.TimeoutExpired:
        return "The device didn't answer in time"
    except OSError:
        return "ssh is missing on this computer"
    out = r.stdout + r.stderr
    if r.returncode == 0 and key_works(target):
        return None
    if "IDENTIFICATION HAS CHANGED" in out or "Host key verification failed" in out:
        return "The device has a different identity key than last time (was it reinstalled?)"
    if "Permission denied" in out:
        return "Wrong password or user"
    if any(x in out for x in ("Connection refused", "timed out", "No route to host", "Connection closed")):
        return "The device doesn't answer on SSH. Is it on, with SSH enabled?"
    return "Couldn't set up password-free access"


# Removal matches the key itself (its base64 part), so other keys in the file stay untouched.
LINUX_REMOVE_KEY = ('f="$HOME/.ssh/authorized_keys"; if [ -f "$f" ]; then grep -vF \'__KEY__\' "$f" > "$f.homebase"; '
                    'cat "$f.homebase" > "$f"; rm -f "$f.homebase"; fi')  # cat > keeps the file's permissions
WINDOWS_REMOVE_KEY = r"""
$k = '__KEY__'
foreach ($f in @((Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'), (Join-Path $env:USERPROFILE '.ssh\authorized_keys'))) {
    if (Test-Path $f) {
        $keep = @(Get-Content -Path $f | Where-Object { $_ -notlike "*$k*" })
        Set-Content -Path $f -Value $keep -Encoding ascii
    }
}
"""


def remove_key(target, windows):
    """Take Homebase's key off the device. Returns None or an error message."""
    if not KEY.exists():
        return None
    body = public_key().split()[1]
    script = powershell(WINDOWS_REMOVE_KEY.replace("__KEY__", body)) if windows else LINUX_REMOVE_KEY.replace("__KEY__", body)
    try:
        r = run(target, script, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return "The device didn't answer in time"
    # The shared connection is still logged in with the key; close it, or the check below would pass.
    subprocess.run(["ssh", *ssh_args(), "-O", "exit", target], capture_output=True, timeout=10)
    if r.returncode != 0 and "Permission denied" not in r.stderr:  # refused = the key is already gone
        return "The device doesn't answer on SSH. Is it on?"
    if key_works(target):
        return "The key is still there. Try again."
    return None


# --- Quick actions (run in the terminal, so sudo can ask for its password) ---

ACTIONS = {
    "linux": {
        "update": "sudo apt update && sudo apt full-upgrade -y",
        "reboot": "sudo reboot",
        "poweroff": "sudo poweroff",
    },
    "windows": {
        "reboot": "shutdown /r /t 0",
        "poweroff": "shutdown /s /t 0",
    },
}


# Lets this one user restart and shut down without a password, and nothing else. Written to a temp
# file and checked with visudo first: a broken sudoers file could lock sudo out entirely.
SUDOERS_RULE = ("f=/etc/sudoers.d/homebase-power; "
                "echo '__USER__ ALL=(root) NOPASSWD: /usr/sbin/reboot, /usr/sbin/poweroff, /sbin/reboot, /sbin/poweroff' > $f.tmp && "
                "chmod 440 $f.tmp && visudo -cqf $f.tmp && mv $f.tmp $f || rm -f $f.tmp")


def allow_power(target, user, password):
    """Using the password once (it goes to sudo on stdin, never on a command line), let the user
    restart and shut down without one, so Homebase can do it without opening a terminal."""
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]{0,31}", user or ""):
        return False
    cmd = "sudo -S -p '' sh -c " + shlex.quote(SUDOERS_RULE.replace("__USER__", user)) + " && sudo -n -l /usr/sbin/reboot >/dev/null && echo POWER_OK"
    try:
        r = subprocess.run(["ssh", *ssh_args(), "--", target, cmd], input=password + "\n",
                           capture_output=True, text=True, errors="replace", timeout=30)
    except (OSError, subprocess.SubprocessError):
        return False
    return "POWER_OK" in r.stdout


def power(target, windows, action):
    """Restart or shut down without a terminal. "ok", "password" (sudo wants one: use the terminal
    instead) or "error". The connection drops as the device goes down, so that counts as success."""
    if windows:
        cmd = {"reboot": "shutdown /r /t 0", "poweroff": "shutdown /s /t 0"}[action]
    else:
        cmd = {"reboot": "sudo -n reboot", "poweroff": "sudo -n poweroff"}[action]  # -n: never ask, fail instead
    try:
        r = run(target, cmd, timeout=20)
    except subprocess.TimeoutExpired:
        return "ok"  # it went down mid-call
    except OSError:
        return "error"
    out = r.stdout + r.stderr
    if "password is required" in out or "a terminal is required" in out:
        return "password"
    if r.returncode in (0, 255) or "closed by remote host" in out:  # 255: the link dropped as it shut down
        return "ok"
    return "error"


def action_argv(target, windows, action):
    cmd = ACTIONS["windows" if windows else "linux"].get(action)
    if not cmd:
        return None
    return ["ssh", "-t", *ssh_args(interactive=True), "--", target, cmd]


# --- Stats without an agent (Linux devices) ----------------------------------

# Each line is tagged so the order and missing pieces (no temperature sensor) don't matter.
STATS_CMD = ("echo U $(cut -d' ' -f1 /proc/uptime); head -1 /proc/stat; "
             "grep -E '^(MemTotal|MemAvailable):' /proc/meminfo; "
             "echo D $(df -Pk / | tail -1); echo T $(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null); "
             "echo K $(uname -r); echo M $(tr -d '\\0' < /proc/device-tree/model 2>/dev/null)")
_prev_cpu = {}


def parse_stats(text, key, now):
    out = {"t": now}
    for line in text.splitlines():
        parts = line.split()
        if not parts:
            continue
        try:
            if parts[0] == "U" and len(parts) > 1:
                out["boot"] = now - float(parts[1])
            elif parts[0] == "cpu":
                nums = list(map(int, parts[1:]))
                idle, total = nums[3] + nums[4], sum(nums)
                prev = _prev_cpu.get(key)
                if prev and total > prev[1]:
                    out["cpu"] = round(100 * (1 - (idle - prev[0]) / (total - prev[1])), 1)
                _prev_cpu[key] = (idle, total)
            elif parts[0] == "MemTotal:":
                out["mem_total"] = int(parts[1]) * 1024
            elif parts[0] == "MemAvailable:":
                out["mem_free"] = int(parts[1]) * 1024
            elif parts[0] == "D" and len(parts) >= 5:
                out["disk_total"] = int(parts[2]) * 1024
                out["disk_free"] = int(parts[4]) * 1024
            elif parts[0] == "T" and len(parts) > 1:
                out["temp"] = round(int(parts[1]) / 1000, 1)
            elif parts[0] == "K" and len(parts) > 1:
                out["kernel"] = parts[1][:60]
            elif parts[0] == "M" and len(parts) > 1:
                out["model"] = " ".join(parts[1:])[:60]  # e.g. "Raspberry Pi Zero 2 W Rev 1.0"
        except (ValueError, IndexError):
            continue
    return out


def stats(target, key):
    try:
        r = run(target, STATS_CMD, timeout=12)
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0:
        return None
    s = parse_stats(r.stdout, key, time.time())
    return s if "mem_total" in s else None


# --- Sending files -----------------------------------------------------------

def exists(target, windows, rel):
    """Whether a path (relative to the user's home folder) already exists on the device."""
    if windows:
        lit = rel.replace("'", "''")  # a literal in single quotes: nothing in the name is interpreted
        cmd = powershell(f"if (Test-Path -LiteralPath (Join-Path $HOME '{lit}')) {{ 'yes' }}")
    else:
        cmd = f"test -e {shlex.quote(rel)} && echo yes"
    try:
        return "yes" in run(target, cmd, timeout=20).stdout
    except (OSError, subprocess.SubprocessError):
        return False


def send_file(target, windows, path, name):
    """Copy a local file to where people look for received files: Downloads on Windows, the home
    folder on Linux. A file with the same name is never overwritten: the copy becomes "name (1).ext".
    Returns where it went (relative to the home folder), or None."""
    folder = "Downloads/" if windows else ""
    stem, dot, ext = name.rpartition(".") if "." in name.lstrip(".") else (name, "", "")
    rel, n = folder + name, 1
    while exists(target, windows, rel) and n < 100:
        rel, n = f"{folder}{stem} ({n}){dot}{ext}", n + 1
    try:
        r = subprocess.run(["scp", "-q", *ssh_args(), "--", str(path), f"{target}:{rel}"],
                           capture_output=True, text=True, errors="replace", timeout=3600)
    except (OSError, subprocess.SubprocessError):
        return None
    return rel if r.returncode == 0 else None


# --- Internet speed test, run on the device -------------------------------------
#
# The device itself downloads from and uploads to Cloudflare's speed test servers (like the laptop's own
# test in netspeed.py), so you see the internet as that device gets it: its Wi-Fi, its distance to the
# router. It prints its progress, one line every quarter second, which is read here:
#   P <ping ms> <jitter ms> <data centre>     D|U <bytes so far> <seconds so far>     E <what went wrong>

NET_SECONDS = 8  # per direction, as in netspeed.py

# Linux: Python 3, which Raspberry Pi OS and most systems have. Four connections, like netspeed.py.
LINUX_NET = r"""
import http.client, os, ssl, statistics, sys, threading, time
H = "speed.cloudflare.com"
def out(*a): print(*a, flush=True)
def conn(): return http.client.HTTPSConnection(H, timeout=10, context=ssl.create_default_context())
try:
    c, ts = conn(), []
    for _ in range(10):
        t = time.perf_counter(); c.request("GET", "/__down?bytes=0"); r = c.getresponse(); r.read()
        ts.append((time.perf_counter() - t) * 1000)
    c.close(); ts = ts[1:]
    out("P", round(min(ts), 1), round(statistics.mean(abs(a - b) for a, b in zip(ts, ts[1:])), 1),
        (r.getheader("cf-ray") or "-").rsplit("-", 1)[-1])
    for tag in "DU":
        moved, stop, lk = [0], threading.Event(), threading.Lock()
        def work(tag, moved, stop, lk):  # its own copies: the previous direction's threads may still be ending
            c, body = conn(), bytes(262144)
            try:
                while not stop.is_set():
                    if tag == "D":
                        c.request("GET", "/__down?bytes=25000000"); r = c.getresponse()
                        while not stop.is_set():
                            b = r.read(65536)
                            if not b: break
                            with lk: moved[0] += len(b)
                    else:
                        c.request("POST", "/__up", body=body, headers={"Content-Type": "application/octet-stream"})
                        c.getresponse().read()
                        with lk: moved[0] += len(body)
            except Exception:
                pass
        for _ in range(4): threading.Thread(target=work, args=(tag, moved, stop, lk), daemon=True).start()
        t0 = time.perf_counter()
        while time.perf_counter() - t0 < SECONDS:
            time.sleep(0.25); out(tag, moved[0], round(time.perf_counter() - t0, 3))
        stop.set()
except Exception as e:
    out("E", type(e).__name__)
os._exit(0)
""".replace("SECONDS", str(NET_SECONDS))

# Windows: PowerShell with .NET's HttpClient; four reads (or uploads) in flight at once.
WINDOWS_NET = r"""
$ErrorActionPreference = 'Stop'
$inv = [Globalization.CultureInfo]::InvariantCulture
function Out($s) { [Console]::Out.WriteLine($s); [Console]::Out.Flush() }
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  [Net.ServicePointManager]::DefaultConnectionLimit = 16
  Add-Type -AssemblyName System.Net.Http
  $h = New-Object Net.Http.HttpClient
  $B = 'https://speed.cloudflare.com'
  $ts = @(); $code = '-'
  for ($i = 0; $i -lt 10; $i++) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $r = $h.GetAsync("$B/__down?bytes=0").Result; $null = $r.Content.ReadAsByteArrayAsync().Result
    $ts += $sw.Elapsed.TotalMilliseconds
    $v = $null; if ($r.Headers.TryGetValues('cf-ray', [ref]$v)) { $code = (@($v)[0] -split '-')[-1] }
  }
  $ts = $ts[1..9]; $j = 0; for ($i = 1; $i -lt $ts.Count; $i++) { $j += [Math]::Abs($ts[$i] - $ts[$i - 1]) }
  Out ([string]::Format($inv, 'P {0:F1} {1:F1} {2}', ($ts | Measure-Object -Minimum).Minimum, $j / ($ts.Count - 1), $code))
  $W = 4; $tasks = New-Object 'System.Threading.Tasks.Task[]' $W
  $streams = New-Object object[] $W; $bufs = @(); for ($i = 0; $i -lt $W; $i++) { $bufs += ,(New-Object byte[] 262144) }
  $body = New-Object byte[] 262144
  foreach ($tag in 'D', 'U') {
    $tot = [long]0; $next = 0.25
    for ($i = 0; $i -lt $W; $i++) {
      if ($tag -eq 'D') {
        $resp = $h.GetAsync("$B/__down?bytes=25000000", [Net.Http.HttpCompletionOption]::ResponseHeadersRead).Result
        $streams[$i] = $resp.Content.ReadAsStreamAsync().Result
        $tasks[$i] = $streams[$i].ReadAsync($bufs[$i], 0, 262144)
      } else { $tasks[$i] = $h.PostAsync("$B/__up", (New-Object Net.Http.ByteArrayContent(,$body))) }
    }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt SECONDS) {
      $k = [Threading.Tasks.Task]::WaitAny($tasks, 100)
      if ($k -ge 0) {
        if ($tag -eq 'D') {
          $n = $tasks[$k].Result
          if ($n -le 0) {
            $streams[$k].Dispose()
            $resp = $h.GetAsync("$B/__down?bytes=25000000", [Net.Http.HttpCompletionOption]::ResponseHeadersRead).Result
            $streams[$k] = $resp.Content.ReadAsStreamAsync().Result
          } else { $tot += $n }
          $tasks[$k] = $streams[$k].ReadAsync($bufs[$k], 0, 262144)
        } else {
          $null = $tasks[$k].Result; $tot += $body.Length
          $tasks[$k] = $h.PostAsync("$B/__up", (New-Object Net.Http.ByteArrayContent(,$body)))
        }
      }
      if ($sw.Elapsed.TotalSeconds -ge $next) { Out ([string]::Format($inv, '{0} {1} {2:F3}', $tag, $tot, $sw.Elapsed.TotalSeconds)); $next += 0.25 }
    }
  }
} catch { Out ('E ' + $_.Exception.GetBaseException().GetType().Name) }
[Environment]::Exit(0)
""".replace("SECONDS", str(NET_SECONDS))


def _mbps(nbytes, seconds):
    return round(nbytes * 8 / seconds / 1e6, 1) if seconds > 0 else None


def net_speed(target, windows, report=lambda **kw: None):
    """Ping, download and upload of the device's own internet connection.
    report(phase=..., live=..., ...) is called as it goes, for a live gauge.
    Returns {"ping", "jitter", "server", "down", "up"}, or {"error": ...}."""
    from netspeed import CITIES
    if not key_works(target):  # also opens the shared connection
        return {"error": "isn't reachable over SSH right now"}
    if windows:
        cmd = powershell(WINDOWS_NET)
    else:
        cmd = "python3 -c \"import base64;exec(base64.b64decode('%s'))\"" % base64.b64encode(LINUX_NET.encode()).decode()
    p = subprocess.Popen(["ssh", *ssh_args(), "--", target, cmd], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                         text=True, errors="replace")
    watchdog = threading.Timer(NET_SECONDS * 2 + 40, p.kill)
    watchdog.start()
    res, samples, tag = {}, [], None

    def finish():  # this direction's result, from a second after data starts flowing (connections ramping up)
        if samples:
            t_end, b_end = samples[-1]
            t_first = next((t for t, b in samples if b > 0), 0)
            t1, b1 = next(((t, b) for t, b in samples if t >= t_first + 1), samples[0])
            res["down" if tag == "D" else "up"] = _mbps(b_end - b1, t_end - t1)
    try:
        for line in p.stdout:
            f = line.split()
            if not f:
                continue
            if f[0] == "P" and len(f) == 4:
                res.update(ping=float(f[1]), jitter=float(f[2]), server=CITIES.get(f[3].upper(), f[3].upper()))
                report(phase="download", live=0, progress=0, **res)
            elif f[0] in ("D", "U") and len(f) == 3:
                if f[0] != tag:
                    if tag:
                        finish()
                        report(phase="upload", live=0, progress=0, **res)
                    tag, samples = f[0], []
                b, t = int(f[1]), float(f[2])
                samples.append((t, b))
                t0, b0 = next(((ts, bs) for ts, bs in samples if ts >= t - 1), samples[0])
                report(live=_mbps(b - b0, t - t0) if t > t0 else 0, progress=min(1, t / NET_SECONDS))
            elif f[0] == "E":
                res["error"] = "couldn't reach the speed test servers from there"
        p.wait()
        if tag:
            finish()
    finally:
        watchdog.cancel()
        if p.poll() is None:
            p.kill()
    if p.returncode == 127 and not tag:
        return {"error": "needs Python 3 for the test (it isn't installed there)"}
    if res.get("down") is None and "error" not in res:
        res["error"] = "the test didn't finish there"
    return res
