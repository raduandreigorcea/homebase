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
import select
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


# --- Speed test ---------------------------------------------------------------

SPEED_SECONDS = 3.0
CHUNK = 256 * 1024
WINDOWS_SOURCE = powershell("$o=[Console]::OpenStandardOutput();$b=New-Object byte[] 262144;while($true){$o.Write($b,0,$b.Length)}")


def _mbps(nbytes, seconds):
    return round(nbytes * 8 / seconds / 1e6, 1) if seconds > 0 else None


class _Rate:
    """Live Mbit/s over the last second, from a running byte count."""
    def __init__(self):
        self.samples = [(time.perf_counter(), 0)]

    def add(self, total):
        now = time.perf_counter()
        self.samples.append((now, total))
        self.samples = [x for x in self.samples if x[0] >= now - 1.5]
        t0, b0 = self.samples[0]
        return _mbps(total - b0, now - t0) if now > t0 else None


def _download(base, source, report):
    """Mbit/s the device sends for SPEED_SECONDS, counted from the first byte; reports live values."""
    p = subprocess.Popen(base + [source], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    fd, got, start, rate, shown = p.stdout.fileno(), 0, None, _Rate(), 0.0
    deadline = time.monotonic() + SPEED_SECONDS + 10  # 10 s for it to start sending at all
    try:
        while time.monotonic() < deadline:
            ready, _, _ = select.select([fd], [], [], 0.25)
            if ready:
                chunk = os.read(fd, CHUNK)
                if not chunk:
                    break
                if start is None:  # PowerShell takes a moment to start: don't count that
                    start = time.perf_counter()
                    deadline = time.monotonic() + SPEED_SECONDS
                got += len(chunk)
            if start and time.perf_counter() - shown >= 0.25:
                shown = time.perf_counter()
                report(live=rate.add(got), progress=min(1, (shown - start) / SPEED_SECONDS))
    finally:
        p.kill()
        p.wait()
    return _mbps(got, time.perf_counter() - start) if start else None


UPLOAD_LIMIT = 40  # seconds; a watchdog ends the upload after this, whatever happens
WIN_PIECES = 5     # Windows upload goes in pieces, so there's something to show while it runs


def _upload(target, windows, nbytes, tmp_dir, report):
    """Send nbytes and time it until the device has them all (not just until our buffers empty).

    Linux: piped into `head`. Windows: copied as a temporary file over SFTP, in pieces (the same way
    files are sent), because PowerShell started over SSH never reads what's piped into it."""
    start = time.perf_counter()
    if windows:
        piece = max(256 * 1024, nbytes // WIN_PIECES)
        local = tmp_dir / "homebase-speedtest.tmp"
        with open(local, "wb") as f:
            f.truncate(piece)  # zeros, without writing them all to disk
        sent = 0
        try:
            while sent < nbytes and time.perf_counter() - start < UPLOAD_LIMIT:
                t = time.perf_counter()
                r = subprocess.run(["scp", "-q", *ssh_args(), "--", str(local), f"{target}:homebase-speedtest.tmp"],
                                   capture_output=True, timeout=UPLOAD_LIMIT)
                if r.returncode != 0:
                    return None
                sent += piece
                report(live=_mbps(piece, time.perf_counter() - t), progress=min(1, sent / nbytes))
            took = time.perf_counter() - start
            run(target, powershell("Remove-Item -LiteralPath (Join-Path $HOME 'homebase-speedtest.tmp')"), timeout=20)
        except (OSError, subprocess.SubprocessError):
            return None
        finally:
            local.unlink(missing_ok=True)
        return _mbps(sent, took)
    p = subprocess.Popen(["ssh", *ssh_args(), "--", target, f"head -c {nbytes} > /dev/null"],
                         stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    watchdog = threading.Timer(UPLOAD_LIMIT, p.kill)  # a write can block forever if the other end stalls
    watchdog.start()
    sent, zeros, rate, shown = 0, bytes(CHUNK), _Rate(), 0.0
    try:
        while sent < nbytes:
            n = min(CHUNK, nbytes - sent)
            p.stdin.write(zeros[:n])
            sent += n
            if time.perf_counter() - shown >= 0.25:
                shown = time.perf_counter()
                report(live=rate.add(sent), progress=min(1, sent / nbytes))
        p.stdin.close()
        p.wait()
    except (BrokenPipeError, OSError):
        p.wait()
    finally:
        watchdog.cancel()
    return _mbps(sent, time.perf_counter() - start) if p.returncode == 0 and sent == nbytes else None


def speed(target, windows, tmp_dir, report=lambda **kw: None):
    """Download and upload speed between this machine and the device, in Mbit/s.
    report(phase=..., live=..., progress=...) is called as it goes, for a live gauge.

    Data goes through SSH (nothing to install), so a device with a weak CPU
    (Pi Zero) may top out below what its Wi-Fi could do."""
    if not key_works(target):  # also opens the shared connection, so the handshake isn't timed
        return None
    base = ["ssh", *ssh_args(), "--", target]
    report(phase="download", live=0, progress=0)
    down = _download(base, WINDOWS_SOURCE if windows else "cat /dev/zero", report)
    report(phase="upload", down=down, live=0, progress=0)
    # Upload about SPEED_SECONDS' worth, guessed from the download speed (links are rarely lopsided at home).
    nbytes = int(min(80e6, max(1e6, (down or 8) * 1e6 / 8 * SPEED_SECONDS)))
    up = _upload(target, windows, nbytes, tmp_dir, report)
    return {"down": down, "up": up} if down or up else None
