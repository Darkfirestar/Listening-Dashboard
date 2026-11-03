"""Independent calculation of dashboard numbers from the compact data file.

Shares no code with engine.js. Usage: python3 expected.py <listening.json> <est|full>
"""
import json
import statistics
import sys
from collections import defaultdict
from datetime import date, datetime
from zoneinfo import ZoneInfo

raw = json.load(open(sys.argv[1]))
mode = sys.argv[2]
tz = ZoneInfo("America/Los_Angeles")
T = raw["tracks"]
ts, t = [], raw["plays"]["t0"]
for d in raw["plays"]["dt"]:
    t += d
    ts.append(t)
trs = raw["plays"]["tr"]
H = raw["plays"].get("h") or [0] * len(trs)
rows = []
for i, (u, tr) in enumerate(zip(ts, trs)):
    d = T["d"][tr] or H[i]
    if H[i]:
        est = H[i]
    elif d:
        gap = ts[i + 1] - u if i + 1 < len(ts) else None
        est = gap if gap is not None and 0 < gap < d else d
    else:
        est = 0
    v = d if mode == "full" else est
    rows.append(dict(ts=u, a=raw["artists"][T["a"][tr]], t=T["t"][tr], al=T["al"][tr], ai=T["a"][tr],
                     v=v, known=bool(d), full=d, dt=datetime.fromtimestamp(u, tz)))

out = {"total": sum(r["v"] for r in rows), "n": len(rows)}
for g in ("month", "quarter", "year"):
    out[g] = defaultdict(int)
for r in rows:
    d = r["dt"]
    out["month"]["%d-%02d" % (d.year, d.month)] += r["v"]
    out["quarter"]["%d-Q%d" % (d.year, (d.month - 1) // 3 + 1)] += r["v"]
    out["year"][str(d.year)] += r["v"]
out["hour"] = [sum(r["v"] for r in rows if r["dt"].hour == h) for h in range(24)]
out["wd"] = [sum(r["v"] for r in rows if r["dt"].weekday() == w) for w in range(7)]
art, trk, alb = defaultdict(int), defaultdict(int), defaultdict(int)
for r in rows:
    art[r["a"]] += r["v"]
    trk[(r["a"], r["t"])] += r["v"]
    if r["al"]:
        alb[r["al"]] += r["v"]
out["top_artist"] = sorted(art.items(), key=lambda kv: -kv[1])[:3]
out["top_track"] = sorted(((k[0] + " | " + k[1], v) for k, v in trk.items()), key=lambda kv: -kv[1])[:3]
out["uniq"] = [len(trk), len(art), len(alb)]
gv = defaultdict(float)
for r in rows:
    tags = raw["genres"][r["ai"]]
    for x in tags:
        gv[raw["genreNames"][x]] += r["v"] / len(tags)
out["top_genre"] = sorted(gv.items(), key=lambda kv: -kv[1])[:3]

byday = defaultdict(int)
for r in rows:
    byday[r["dt"].date()] += r["v"]
d0 = rows[0]["dt"].date()
d1 = max(rows[-1]["dt"].date(), datetime.fromisoformat(raw["asOf"]).astimezone(tz).date() if raw.get("asOf") else d0)
days = [d0.toordinal() + i for i in range((d1 - d0).days + 1)]
vals = [byday.get(date.fromordinal(o), 0) for o in days]
out["days"] = len(vals)
out["day_mean"] = statistics.mean(vals)
out["day_sd"] = statistics.stdev(vals)
out["day_median"] = statistics.median(vals)
wk = [v for o, v in zip(days, vals) if date.fromordinal(o).weekday() < 5]
we = [v for o, v in zip(days, vals) if date.fromordinal(o).weekday() >= 5]
out["wk_mean"] = statistics.mean(wk)
out["we_mean"] = statistics.mean(we)

known_full = [r["full"] for r in rows if r["known"]]
fb = statistics.median(known_full)
ses, cur = [], None
for r in rows:
    ln = r["v"] if r["v"] > 0 else (0 if r["known"] else fb)
    if cur and r["ts"] - cur["end"] <= 1800:
        cur["end"] = max(cur["end"], r["ts"] + ln)
    else:
        if cur:
            ses.append(cur)
        cur = {"start": r["ts"], "end": r["ts"] + ln}
ses.append(cur)
out["sessions"] = len(ses)
out["longest_session"] = max(s["end"] - s["start"] for s in ses)
active = sorted({r["dt"].date().toordinal() for r in rows})
best = run = 1
for a, b in zip(active, active[1:]):
    run = run + 1 if b == a + 1 else 1
    best = max(best, run)
out["longest_streak"] = best
out["unknown_plays"] = sum(1 for r in rows if not r["known"])
json.dump(out, sys.stdout)
