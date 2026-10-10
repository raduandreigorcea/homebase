"""The internet's long-term history: response time and outages over days and weeks, kept on disk.

Every internet check (a few seconds apart) goes into a 5-minute bucket; a finished bucket is one line
appended to a file, so the cost is a small write every 5 minutes. Outages are kept apart, with when
they started and ended. Time the laptop was asleep or off has no buckets: it shows as "not measured".
"""
import json
import threading
import time

BUCKET = 300           # seconds per stored point
KEEP_DAYS = 90
RANGES = {             # what the page can ask for: (seconds back, seconds per point it gets)
    "day": (86400, 300),
    "week": (7 * 86400, 3600),
    "month": (30 * 86400, 6 * 3600),
}

lock = threading.Lock()
_points_file = None
_outages_file = None
_bucket = None         # the bucket being filled: {"t", "n", "sum", "max", "miss"}
_down_since = None     # the outage going on right now, if any


def init(data):
    global _points_file, _outages_file
    _points_file = data / "internet-history.jsonl"
    _outages_file = data / "internet-outages.json"
    _prune()


def _load_points():
    try:
        with open(_points_file) as f:
            out = []
            for line in f:
                try:
                    out.append(json.loads(line))
                except ValueError:
                    pass  # a line cut short by a power loss
            return out
    except OSError:
        return []


def _load_outages():
    try:
        with open(_outages_file) as f:
            return json.load(f)
    except (OSError, ValueError):
        return []


def _prune():
    """Drop what's older than KEEP_DAYS (at start-up; the files grow slowly)."""
    cutoff = time.time() - KEEP_DAYS * 86400
    pts = _load_points()
    if pts and pts[0].get("t", 0) < cutoff:
        tmp = _points_file.with_suffix(".tmp")
        with open(tmp, "w") as f:
            for p in pts:
                if p.get("t", 0) >= cutoff:
                    f.write(json.dumps(p) + "\n")
        tmp.replace(_points_file)
    outs = _load_outages()
    if outs and outs[0].get("end", 0) < cutoff:
        _save_outages([o for o in outs if o.get("end", 0) >= cutoff])


def _save_outages(outs):
    tmp = _outages_file.with_suffix(".tmp")
    with open(tmp, "w") as f:
        json.dump(outs, f)
    tmp.replace(_outages_file)


def _flush(b):
    n = b["n"]
    point = {"t": b["t"], "n": n, "loss": round(b["miss"] / n, 3)}
    if n > b["miss"]:
        point["avg"] = round(b["sum"] / (n - b["miss"]), 1)
        point["max"] = round(b["max"], 1)
    with open(_points_file, "a") as f:
        f.write(json.dumps(point) + "\n")


def record(latency, online, now=None):
    """One internet check: latency in ms (None = no answer), and whether the internet counts as up."""
    global _bucket, _down_since
    now = now or time.time()
    start = now - now % BUCKET
    with lock:
        if _bucket and _bucket["t"] != start:
            _flush(_bucket)
            _bucket = None
        if not _bucket:
            _bucket = {"t": start, "n": 0, "sum": 0.0, "max": 0.0, "miss": 0}
        _bucket["n"] += 1
        if latency is None:
            _bucket["miss"] += 1
        else:
            _bucket["sum"] += latency
            _bucket["max"] = max(_bucket["max"], latency)
        if not online and _down_since is None:
            _down_since = now
        elif online and _down_since is not None:
            outs = _load_outages()
            outs.append({"start": round(_down_since), "end": round(now)})
            _save_outages(outs)
            _down_since = None


def asleep():
    """The laptop slept: what we knew about the current bucket and outage no longer holds."""
    global _bucket, _down_since
    with lock:
        if _bucket:
            _flush(_bucket)
        _bucket = None
        _down_since = None


def summary(which):
    """Points, outages and totals for "day", "week" or "month", for the page's history window."""
    back, step = RANGES.get(which, RANGES["day"])
    now = time.time()
    since = now - back
    with lock:
        pts = [p for p in _load_points() if p["t"] >= since]
        if _bucket and _bucket["n"]:
            b = _bucket
            cur = {"t": b["t"], "n": b["n"], "loss": b["miss"] / b["n"]}
            if b["n"] > b["miss"]:
                cur.update(avg=b["sum"] / (b["n"] - b["miss"]), max=b["max"])
            pts.append(cur)
        outs = [o for o in _load_outages() if o["end"] >= since]
        if _down_since is not None:
            outs.append({"start": round(_down_since), "end": round(now), "ongoing": True})

    # Coarser points for the longer ranges: average weighted by checks, worst of the maxima.
    first = since - since % step
    slots = {}
    for p in pts:
        k = int(p["t"] - (p["t"] - first) % step)
        slots.setdefault(k, []).append(p)
    series = []
    for i in range(int((now - first) // step) + 1):
        t = int(first + i * step)
        group = slots.get(t)
        if not group:
            series.append({"t": t})  # not measured (laptop off or asleep)
            continue
        n = sum(p["n"] for p in group)
        answered = [(p["avg"], p["n"] * (1 - p["loss"])) for p in group if "avg" in p]
        weight = sum(w for _, w in answered)
        point = {"t": t, "loss": round(sum(p["loss"] * p["n"] for p in group) / n, 3)}
        if weight:
            point["avg"] = round(sum(a * w for a, w in answered) / weight, 1)
            point["max"] = round(max(p["max"] for p in group if "max" in p), 1)
        series.append(point)

    measured = len(pts) * BUCKET  # time the laptop was checking (whole 5-minute buckets)
    down = sum(min(o["end"], now) - max(o["start"], since) for o in outs)
    answered = [(p["avg"], p["n"] * (1 - p["loss"])) for p in pts if "avg" in p]
    weight = sum(w for _, w in answered)
    return {
        "range": which if which in RANGES else "day",
        "step": step,
        "points": series,
        "outages": sorted(outs, key=lambda o: o["start"], reverse=True),
        "measured": min(measured, back),
        "uptime": round(100 * (1 - down / measured), 2) if measured else None,
        "avg": round(sum(a * w for a, w in answered) / weight, 1) if weight else None,
        "worst": max((p["max"] for p in pts if "max" in p), default=None),
    }
