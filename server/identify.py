"""Work out what an unknown device on the network is, from clues it gives away:

- the maker of its network card (first half of the MAC, from the hwdata database)
- a name it announces: reverse DNS, mDNS (.local), NetBIOS, or the computer name
  a Windows machine reports when asked over SMB (no login needed, same as
  what shows up in Windows' Network folder)
- a UPnP/DLNA description (TVs, printers, routers say what they are)
- which well-known ports answer (Windows, SSH, printer, Apple, Chromecast...)

Everything here is best-effort and quiet: each probe has a short timeout and
results are cached per MAC, so this only runs once per new device.
"""
import re
import socket
import struct
import subprocess
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache

OUI_FILE = "/usr/share/hwdata/oui.txt"

# Maker name fragments -> the kind of device they usually mean. Checked in order.
MAKERS = [
    ("raspberry", "pi"),
    ("guangzhou shiyuan", "tv"),  # CVTE: the board in many budget TVs (NEI, Vortex...)
    ("hisense", "tv"), ("tcl", "tv"), ("roku", "tv"),
    ("intel", "laptop"),          # Intel Wi-Fi cards: almost always a laptop
    ("cloud network technology", "laptop"), ("azurewave", "laptop"), ("liteon", "laptop"),
    ("realtek", "desktop"), ("micro-star", "desktop"), ("asustek", "desktop"), ("gigabyte", "desktop"),
    ("fiberhome", "router"),
]


@lru_cache(maxsize=256)
def maker(mac):
    """Full manufacturer name for a MAC, from the local hwdata database."""
    if int(mac[:2], 16) & 2:
        return None  # randomized "private" address: no real maker
    key = mac[:8].upper().replace(":", "-")
    try:
        with open(OUI_FILE, encoding="utf-8", errors="replace") as f:
            for line in f:
                if line.startswith(key):
                    return line.split("(hex)", 1)[1].strip()
    except OSError:
        pass
    return None


def tcp_state(ip, port, timeout=0.6):
    s = socket.socket()
    s.settimeout(timeout)
    try:
        r = s.connect_ex((ip, port))
    except OSError:
        return "silent"
    finally:
        s.close()
    return "open" if r == 0 else "refused" if r == 111 else "silent"


def run(cmd, timeout=3):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def name_dns(ip):
    try:
        name = socket.gethostbyaddr(ip)[0].split(".")[0]
    except OSError:
        return None
    return None if name in ("_gateway", "gateway", "localhost") else name


def name_mdns(ip):
    out = run(["avahi-resolve", "-a", ip], 2).split()
    return out[1].removesuffix(".local") if len(out) > 1 else None


def name_netbios(ip):
    for line in run(["nmblookup", "-A", ip], 3).splitlines():
        m = re.match(r"\s+(\S+)\s+<00>\s+-\s+(?!<GROUP>)", line)
        if m:
            return m.group(1)
    return None


def name_smb(ip, timeout=2.0):
    """Ask a Windows machine its computer name over SMB2 (NTLM challenge, no login)."""
    def nb(payload):
        return struct.pack(">I", len(payload)) + payload

    def recv(s):
        hdr = s.recv(4)
        n = struct.unpack(">I", hdr)[0] & 0xFFFFFF
        data = b""
        while len(data) < n:
            chunk = s.recv(n - len(data))
            if not chunk:
                break
            data += chunk
        return data

    def smb2(cmd, msg_id, body):
        return (b"\xfeSMB" + struct.pack("<HHIHHIIQIIQ16s", 64, 0, 0, cmd, 1, 0, 0, msg_id, 0, 0, 0, b"\0" * 16) + body)

    negotiate = struct.pack("<HHHHI16sIHH", 36, 2, 1, 0, 0, b"\0" * 16, 0, 0, 0) + struct.pack("<HH", 0x0202, 0x0210)
    # NTLM NEGOTIATE without the VERSION flag (that flag needs 8 more bytes; Windows rejects it otherwise).
    ntlm = b"NTLMSSP\0" + struct.pack("<II", 1, 0x60088215) + b"\0" * 16
    setup = struct.pack("<HBBIIHHQ", 25, 0, 1, 0, 0, 88, len(ntlm), 0) + ntlm
    try:
        with socket.create_connection((ip, 445), timeout=timeout) as s:
            s.sendall(nb(smb2(0, 0, negotiate)))
            recv(s)
            s.sendall(nb(smb2(1, 1, setup)))
            resp = recv(s)
    except OSError:
        return None
    i = resp.find(b"NTLMSSP\0\x02\0\0\0")
    if i < 0:
        return None
    chal = resp[i:]
    try:
        ti_len, _, ti_off = struct.unpack("<HHI", chal[40:48])
        info = chal[ti_off:ti_off + ti_len]
        names = {}
        while len(info) >= 4:
            av_id, av_len = struct.unpack("<HH", info[:4])
            if av_id == 0:
                break
            names[av_id] = info[4:4 + av_len].decode("utf-16-le", errors="replace")
            info = info[4 + av_len:]
    except struct.error:
        return None
    return names.get(1) or names.get(3)  # NetBIOS computer name, else DNS name


def name_rpc(ip, timeout=2.0):
    """Windows computer name via RPC on port 135 (IOXIDResolver ServerAlive2, no login).

    Works even when Windows' "Public network" profile blocks SMB, NetBIOS and mDNS,
    because port 135 usually stays open. The reply lists the machine's own name
    followed by its IP addresses."""
    bind = bytes.fromhex(
        "05000b03100000004800000001000000b810b810000000000100000000000100"
        "c4fefc9960521b10bbcb00aa0021347a00000000"   # IObjectExporter v0.0
        "045d888aeb1cc9119fe808002b10486002000000")  # NDR transfer syntax v2
    alive2 = bytes.fromhex("050000031000000018000000020000000000000000000500")  # opnum 5
    try:
        with socket.create_connection((ip, 135), timeout=timeout) as s:
            s.sendall(bind)
            if s.recv(4096)[2:3] != b"\x0c":  # bind_ack
                return None
            s.sendall(alive2)
            reply = s.recv(8192)
    except OSError:
        return None
    # Reply stub: COMVERSION (4) | pointer (4) | max count (4) | wNumEntries (2) | wSecurityOffset (2),
    # then string bindings: wTowerId (2) + UTF-16 text up to a 0x0000. The first one is the host name.
    pos = 24 + 16 + 2
    end = pos
    while end + 1 < len(reply) and reply[end:end + 2] != b"\0\0":
        end += 2
    name = reply[pos:end].decode("utf-16-le", errors="replace").strip()
    try:
        socket.inet_pton(socket.AF_INET, name)
        return None  # some machines list only addresses
    except OSError:
        return name or None


def upnp_describe(location, ip):
    """friendlyName / manufacturer / model / type from a UPnP description URL.

    The URL is whatever a device on the network announced, so only plain http to
    that same device is followed (no file://, no other hosts), and reads are capped."""
    u = urllib.parse.urlparse(location)
    if u.scheme != "http" or u.hostname != ip:
        return {}
    try:
        with urllib.request.urlopen(location, timeout=3) as r:
            root = ET.fromstring(r.read(256 * 1024))
    except (OSError, ET.ParseError, ValueError):
        return {}
    out = {}
    for el in root.iter():
        tag = el.tag.split("}")[-1]
        if tag in ("friendlyName", "manufacturer", "modelName", "deviceType") and tag not in out and el.text:
            out[tag] = el.text.strip()
    return out


def ssdp_locations(wait=3.0):
    """ip -> description URL for every UPnP device that answers on the LAN."""
    msg = ("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\n"
           "MX: 2\r\nST: upnp:rootdevice\r\n\r\n").encode()
    found = {}
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.settimeout(wait)
        try:
            s.sendto(msg, ("239.255.255.250", 1900))
            while True:
                data, addr = s.recvfrom(4096)
                for line in data.decode(errors="replace").split("\r\n"):
                    if line.lower().startswith("location:"):
                        found.setdefault(addr[0], line.split(":", 1)[1].strip())
        except OSError:
            pass
    return found


def identify(ip, mac, upnp_location=None):
    """Best guess: {"label": human description, "name": suggested name, "kind": ...}."""
    full_maker = maker(mac)
    kind = "other"
    if full_maker:
        low = full_maker.lower()
        kind = next((k for frag, k in MAKERS if frag in low), "other")

    probe = (22, 135, 445, 548, 62078, 8008, 9100, 631)
    with ThreadPoolExecutor(len(probe)) as ex:
        ports = dict(zip(probe, ex.map(lambda p: tcp_state(ip, p), probe)))
    is_windows = ports[135] == "open" or ports[445] == "open"
    what = None
    if is_windows:
        what = "Windows computer"
        if kind not in ("laptop", "desktop"):
            kind = "desktop"
    elif ports[62078] == "open":
        what, kind = "iPhone / iPad", "phone"
    elif ports[548] == "open":
        what, kind = "Mac", "laptop"
    elif ports[8008] == "open":
        what, kind = "Chromecast / Google TV", "tv"
    elif ports[9100] == "open" or ports[631] == "open":
        what, kind = "Printer", "other"
    elif ports[22] == "open" and kind == "other":
        what = "Linux device (SSH)"

    name = None
    upnp = upnp_describe(upnp_location, ip) if upnp_location else {}
    if upnp:
        dtype = upnp.get("deviceType", "")
        if "MediaRenderer" in dtype:
            kind, what = "tv", "TV (DLNA)"
        elif "Printer" in dtype:
            what = what or "Printer"
        elif "InternetGatewayDevice" in dtype:
            kind, what = "router", "Router"
        fn = upnp.get("friendlyName")
        if fn and fn.lower() not in ("smart tv", "renderer", "mediarenderer"):
            name = fn
        model = " ".join(x for x in (upnp.get("manufacturer"), upnp.get("modelName")) if x and x.lower() not in ("smarttv", "renderer"))
        if model and not what:
            what = model

    name = (name or (name_smb(ip) if ports[445] == "open" else None)
            or (name_rpc(ip) if ports[135] == "open" else None)
            or name_mdns(ip) or name_netbios(ip) or name_dns(ip))

    # What the user sees: just the operating system / kind of device, no hardware details.
    if what is None and kind == "pi":
        what = "Raspberry Pi OS"
    elif what is None and kind == "tv":
        what = "Smart TV"
    os_names = {
        "Windows computer": "Windows", "iPhone / iPad": "iOS", "Mac": "macOS",
        "Chromecast / Google TV": "Google TV", "Linux device (SSH)": "Linux",
        "TV (DLNA)": "Smart TV", "Router": "Router", "Printer": "Printer",
    }
    label = os_names.get(what, what)
    return {"label": label, "name": name, "kind": kind, "maker": full_maker}
