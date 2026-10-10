"""Internet speed test, like speedtest.net: ping, download and upload against Cloudflare's speed
test servers (speed.cloudflare.com). Runs only when asked, and reports live progress so the page
can move a needle while it measures.
"""
import http.client
import ssl
import statistics
import threading
import time

HOST = "speed.cloudflare.com"
SECONDS = 8          # per direction
WORKERS = 4          # parallel connections: one alone can't fill a fast line
UP_CHUNK = 1_000_000
HOLD_LAST = 0.8      # seconds at the end of a direction during which the live value stays put

lock = threading.Lock()
status = {"phase": "idle"}  # idle | ping | download | upload | done | error


def snapshot():
    with lock:
        return dict(status)


def _set(**kw):
    with lock:
        status.update(kw)


def _conn():
    return http.client.HTTPSConnection(HOST, timeout=10, context=ssl.create_default_context())


# Cloudflare names its data centres after the nearest airport; the common ones near us, as cities.
CITIES = {"OTP": "Bucharest", "SOF": "Sofia", "BUD": "Budapest", "BEG": "Belgrade", "VIE": "Vienna", "FRA": "Frankfurt",
          "AMS": "Amsterdam", "LHR": "London", "CDG": "Paris", "WAW": "Warsaw", "PRG": "Prague", "MXP": "Milan",
          "MUC": "Munich", "ZRH": "Zurich", "IST": "Istanbul", "ATH": "Athens", "KBP": "Kyiv", "KIV": "Chisinau"}


def _ping(n=10):
    """Round trips of a tiny request on one open connection: (ping ms, jitter ms)."""
    c = _conn()
    times = []
    try:
        for _ in range(n):
            t = time.perf_counter()
            c.request("GET", "/__down?bytes=0")
            r = c.getresponse()
            r.read()
            times.append((time.perf_counter() - t) * 1000)
        # Which data centre answered: the last part of the "cf-ray" header, like "...-OTP".
        code = (r.getheader("cf-ray") or "").rsplit("-", 1)[-1].upper()
        if code.isalpha():
            _set(server=CITIES.get(code, code))
    finally:
        c.close()
    times = times[1:]  # the first one also sets up the connection
    jitter = statistics.mean(abs(a - b) for a, b in zip(times, times[1:])) if len(times) > 1 else 0
    return round(min(times), 1), round(jitter, 1)


def _transfer(direction):
    """Mbit/s over SECONDS with WORKERS connections, updating the live value as it goes."""
    moved = [0]
    stop = threading.Event()

    def worker():
        c = _conn()
        body = bytes(UP_CHUNK)
        try:
            while not stop.is_set():
                if direction == "download":
                    c.request("GET", "/__down?bytes=25000000")
                    r = c.getresponse()
                    while not stop.is_set():
                        chunk = r.read(65536)
                        if not chunk:
                            break
                        with lock:
                            moved[0] += len(chunk)
                    if stop.is_set():
                        break
                else:
                    c.request("POST", "/__up", body=body, headers={"Content-Type": "application/octet-stream"})
                    c.getresponse().read()
                    with lock:
                        moved[0] += len(body)
        except (OSError, http.client.HTTPException):
            pass
        finally:
            c.close()

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(WORKERS)]
    start = time.perf_counter()
    for t in threads:
        t.start()
    # Live value: the rate over the last two seconds, four times a second. Uploads count a piece when it's
    # confirmed, so they arrive in bursts; a shorter window made the gauge jump around. The last stretch
    # keeps its value: the transfers are being cut off then, which isn't a slowdown.
    samples = [(start, 0)]
    live = 0.0
    while time.perf_counter() - start < SECONDS:
        time.sleep(0.25)
        now = time.perf_counter()
        with lock:
            total = moved[0]
        samples.append((now, total))
        if now - start < SECONDS - HOLD_LAST:
            t0, b0 = next((s for s in samples if s[0] >= now - 2), samples[0])
            live = (total - b0) * 8 / max(now - t0, 0.01) / 1e6
        _set(live=round(live, 1), progress=round(min(1, (now - start) / SECONDS), 2))
    stop.set()
    with lock:
        total, elapsed = moved[0], time.perf_counter() - start
    # Leave out the first second: connections are still ramping up then.
    first = next((b for t, b in samples if t >= start + 1), 0)
    return round((total - first) * 8 / max(elapsed - 1, 0.1) / 1e6, 1)


def run():
    """The whole test; meant for a background thread. Progress is in status()."""
    with lock:
        if status.get("phase") in ("ping", "download", "upload"):
            return  # already running
        status.clear()
        status.update(phase="ping", started=time.time())
    try:
        ping, jitter = _ping()
        _set(ping=ping, jitter=jitter, phase="download", live=0, progress=0)
        down = _transfer("download")
        _set(down=down, phase="upload", live=0, progress=0)
        up = _transfer("upload")
        _set(up=up, phase="done", live=0, finished=time.time())
    except (OSError, http.client.HTTPException, ValueError) as e:
        _set(phase="error", error=f"The speed test server didn't answer ({e.__class__.__name__})")
