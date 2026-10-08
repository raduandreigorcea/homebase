"""What Homebase does on other devices over SSH, once its key is set up there:
stats without installing anything, quick actions, sending files, speed tests.

Everything here runs without prompts (BatchMode) using Homebase's own key, and
shares one connection per device (ControlMaster) so a check every 30 s doesn't
redo the SSH handshake on this slow CPU. Callers pass an already-validated
"user@ip" target; nothing here builds a shell command from user input.
"""
import base64
import os
import subprocess
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
        args += ["-o", "BatchMode=yes", "-o", "ControlMaster=auto",
                 "-o", f"ControlPath={CONTROL}/%C", "-o", "ControlPersist=120"]
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
Write-Host 'Cheia Homebase a fost adaugata.'
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
        return "Dispozitivul nu a răspuns la timp"
    except OSError:
        return "Lipsește ssh pe acest calculator"
    out = r.stdout + r.stderr
    if r.returncode == 0 and key_works(target):
        return None
    if "IDENTIFICATION HAS CHANGED" in out or "Host key verification failed" in out:
        return "Dispozitivul are altă cheie de identificare decât data trecută (l-ai reinstalat?)"
    if "Permission denied" in out:
        return "Parolă sau utilizator greșit"
    if any(x in out for x in ("Connection refused", "timed out", "No route to host", "Connection closed")):
        return "Dispozitivul nu răspunde pe SSH. E pornit și are SSH activat?"
    return "Nu s-a putut configura accesul fără parolă"


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
        return "Dispozitivul nu a răspuns la timp"
    # The shared connection is still logged in with the key; close it, or the check below would pass.
    subprocess.run(["ssh", *ssh_args(), "-O", "exit", target], capture_output=True, timeout=10)
    if r.returncode != 0 and "Permission denied" not in r.stderr:  # refused = the key is already gone
        return "Dispozitivul nu răspunde pe SSH. E pornit?"
    if key_works(target):
        return "Cheia e încă acolo. Încearcă din nou."
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


def action_argv(target, windows, action):
    cmd = ACTIONS["windows" if windows else "linux"].get(action)
    if not cmd:
        return None
    return ["ssh", "-t", *ssh_args(interactive=True), "--", target, cmd]


# --- Stats without an agent (Linux devices) ----------------------------------

# Each line is tagged so the order and missing pieces (no temperature sensor) don't matter.
STATS_CMD = ("echo U $(cut -d' ' -f1 /proc/uptime); head -1 /proc/stat; "
             "grep -E '^(MemTotal|MemAvailable):' /proc/meminfo; "
             "echo D $(df -Pk / | tail -1); echo T $(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null)")
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

def send_file(target, path, name):
    """Copy a local file into the user's home folder on the device."""
    try:
        r = subprocess.run(["scp", "-q", *ssh_args(), "--", str(path), f"{target}:{name}"],
                           capture_output=True, text=True, errors="replace", timeout=3600)
    except (OSError, subprocess.SubprocessError):
        return False
    return r.returncode == 0


# --- Speed test --------------------------------------------------------------

SPEED_SECONDS = 3.0
CHUNK = 256 * 1024
WINDOWS_SINK = powershell("$i=[Console]::OpenStandardInput();$b=New-Object byte[] 262144;while($i.Read($b,0,$b.Length) -gt 0){}")
WINDOWS_SOURCE = powershell("$o=[Console]::OpenStandardOutput();$b=New-Object byte[] 262144;while($true){$o.Write($b,0,$b.Length)}")


def _mbps(nbytes, seconds):
    return round(nbytes * 8 / seconds / 1e6, 1) if seconds > 0 else None


def speed(target, windows):
    """Upload and download speed between this machine and the device, in Mbit/s.

    Data goes through SSH (nothing to install), so a device with a weak CPU
    (Pi Zero) may top out below what its Wi-Fi could do."""
    if not key_works(target):  # also opens the shared connection, so the handshake isn't timed
        return None
    sink, source = (WINDOWS_SINK, WINDOWS_SOURCE) if windows else ("cat > /dev/null", "cat /dev/zero")
    base = ["ssh", *ssh_args(), "--", target]
    result = {}
    zeros = bytes(CHUNK)

    up = subprocess.Popen(base + [sink], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    sent, start = 0, time.perf_counter()
    try:
        while time.perf_counter() - start < SPEED_SECONDS:
            up.stdin.write(zeros)
            sent += CHUNK
        up.stdin.close()
    except (BrokenPipeError, OSError):
        pass
    # Stop the clock only once the device has read everything: until then up to a few MB
    # still sit in SSH's buffers, which would overstate a slow link by a lot.
    try:
        up.wait(timeout=30)
        result["up"] = _mbps(sent, time.perf_counter() - start)
    except subprocess.TimeoutExpired:
        up.kill()
        result["up"] = None

    down = subprocess.Popen(base + [source], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    got, start = 0, None
    try:
        while True:
            chunk = down.stdout.read1(CHUNK)
            if not chunk:
                break
            if start is None:  # count from the first byte: PowerShell takes a moment to start
                start = time.perf_counter()
            got += len(chunk)
            if time.perf_counter() - start >= SPEED_SECONDS:
                break
    finally:
        down.kill()
        down.wait()
    result["down"] = _mbps(got, time.perf_counter() - start) if start else None
    return result if result["up"] or result["down"] else None
