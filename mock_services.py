"""Fake Last.fm, Deezer, iTunes and MusicBrainz for offline testing of fetch.py.

Run directly to leave a server up (python tests/mock_services.py 8765) or import
start() from the test runner.
"""
import json
import random
import sys
import threading
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

LA = ZoneInfo("America/Los_Angeles")
API_KEY = "TESTKEY"
ADJ = ["Neon", "Velvet", "Hollow", "Paper", "Static", "Amber", "Glass", "Midnight",
       "Copper", "Silent", "Lunar", "Rusty", "Electric", "Faded", "Golden", "Crimson"]
NOUN = ["Harbor", "Echo", "Gardens", "Parade", "Signal", "Orchard", "Engine", "Tide",
        "Canyon", "Lantern", "Mirage", "Avenue", "Satellite", "Ritual", "Compass", "Fever"]
W1 = ["Slow", "Midnight", "Paper", "Golden", "Broken", "Quiet", "Neon", "Summer",
      "Distant", "Careless", "Burning", "Yellow"]
W2 = ["Motion", "Drive", "Letters", "Rain", "Dreams", "Hours", "Signals", "Heart",
      "Bridges", "Weather", "Pulse", "Skyline"]
GENRES = ["Indie Rock", "Hip-Hop", "Pop", "R&B", "Electronic", "Alternative", "Lo-Fi",
          "Rock", "Soul", "Dance", "Synthpop", "Rap"]


def build_catalog(rng):
    artists, used = [], set()
    i = 0
    while len(artists) < 36:
        name = "%s %s" % (ADJ[i % 16], NOUN[(i * 5 + 3 + i // 16) % 16])
        i += 1
        if name in used:
            continue
        used.add(name)
        albums = ["%s %s" % (rng.choice(W1), rng.choice(W2)) for _ in range(rng.choice([1, 2]))]
        tracks, titles = [], set()
        while len(tracks) < rng.randint(4, 8):
            title = "%s %s" % (rng.choice(W1), rng.choice(W2))
            if title in titles:
                continue
            titles.add(title)
            roll = rng.random()
            avail = ("lastfm" if roll < 0.74 else "deezer" if roll < 0.84 else
                     "itunes" if roll < 0.90 else "mb" if roll < 0.94 else "none")
            tracks.append({"artist": name, "title": title,
                           "album": "" if rng.random() < 0.08 else rng.choice(albums),
                           "dur": rng.randint(150, 330), "avail": avail})
        tags = rng.sample(GENRES, 3)
        artists.append({"name": name, "tracks": tracks, "tags": tags})
    return artists


def build_history(rng, artists, start, end):
    weights = [1 / (k + 1) ** 0.9 for k in range(len(artists))]
    order = list(range(len(artists)))
    rng.shuffle(order)
    plays, day, idx = [], start, 0
    while day <= end:
        idx += 1
        weekend = day.weekday() >= 5
        if rng.random() < 0.08:
            day += timedelta(days=1)
            continue
        sessions = rng.choice([1, 2, 2, 3])
        for _ in range(sessions):
            hour = (rng.choice([10, 11, 13, 15, 19, 21, 22, 23]) if weekend
                    else rng.choice([7, 8, 8, 9, 12, 17, 18, 20, 21, 22, 23]))
            t = datetime(day.year, day.month, day.day, hour, rng.randint(0, 59), rng.randint(0, 59), tzinfo=LA)
            length = max(10, min(120, rng.gauss(35 + idx * 0.15, 15))) * 60
            elapsed = 0
            while elapsed < length:
                a = artists[order[rng.choices(range(len(order)), weights)[0]]]
                tr = rng.choice(a["tracks"])
                plays.append((int(t.timestamp()) + int(elapsed), tr))
                elapsed += tr["dur"] * (rng.uniform(0.5, 0.9) if rng.random() < 0.15 else 1)
        day += timedelta(days=1)
    plays.sort(key=lambda p: p[0])
    out, last = [], None
    for p in plays:
        if p[0] != last:
            out.append(p)
        last = p[0]
    return out


class State:
    def __init__(self):
        rng = random.Random(42)
        self.artists = build_catalog(rng)
        self.by_key = {(t["artist"], t["title"]): t for a in self.artists for t in a["tracks"]}
        self.by_artist = {a["name"]: a for a in self.artists}
        cutoff = datetime(2026, 10, 28, 23, 0, tzinfo=LA)
        hist = build_history(rng, self.artists, datetime(2026, 6, 23, tzinfo=LA), datetime(2026, 10, 28, tzinfo=LA))
        self.plays = [p for p in hist if p[0] <= int(cutoff.timestamp())]
        # Boundary trap: a play exactly one second before the next run's lookback window.
        # Last.fm's "from" may include that second, which once caused a duplicate.
        trap = self.plays[-1][0] - 14 * 86400 - 1
        if all(p[0] != trap for p in self.plays):
            self.plays.append((trap, self.artists[2]["tracks"][0]))
            self.plays.sort(key=lambda p: p[0])
        self.trap_uts = trap
        self.rng2 = random.Random(7)
        self.hit_log = []
        self.fail_once = {"lastfm_rate": True, "deezer_503": True}
        self.phase = 1
        self.drops = []          # for each coming full read, the pages to answer with no plays and no error
        self.cur_drop = set()
        self.deleted_uts = None
        self.late_uts = None

    def advance(self):
        """Phase 2: two more days of plays, one deleted play and one late scrobble inside the lookback window."""
        self.phase = 2
        last_uts = self.plays[-1][0]
        self.deleted_uts = self.plays[-1][0]
        self.plays.pop()  # deleted on Last.fm after the first run
        tr = self.artists[0]["tracks"][0]
        self.late_uts = last_uts - 3600 * 5 + 1
        self.plays.append((self.late_uts, tr))  # scrobbled late, older than the newest play
        new = build_history(self.rng2, self.artists, datetime(2026, 10, 29, tzinfo=LA), datetime(2026, 10, 30, tzinfo=LA))
        self.plays.extend(new)
        self.plays.sort(key=lambda p: p[0])
        return {"added": len(new), "deleted": self.deleted_uts, "late": self.late_uts}


STATE = None


def tj(obj):
    return json.dumps(obj).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, obj, code=200):
        body = tj(obj)
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        S = STATE
        S.hit_log.append(u.path + ":" + q.get("method", ""))
        if u.path == "/admin/advance":
            return self.send(S.advance())
        if u.path == "/admin/hits":
            return self.send(S.hit_log)
        if u.path == "/admin/delete-old":
            cutoff = S.plays[-1][0] - 40 * 86400
            victim = max(p[0] for p in S.plays if p[0] < cutoff)
            S.plays = [p for p in S.plays if p[0] != victim]
            return self.send({"deleted": victim, "plays": len(S.plays)})
        if u.path == "/admin/drop":
            S.drops.append({int(x) for x in q.get("pages", "2").split(",")})
            return self.send({"drops": len(S.drops)})
        if u.path == "/admin/state":
            return self.send({"plays": len(S.plays), "deleted": S.deleted_uts, "late": S.late_uts})
        if u.path.startswith("/2.0"):
            return self.lastfm(q)
        if u.path == "/deezer":
            return self.deezer(q)
        if u.path == "/itunes":
            return self.itunes(q)
        if u.path == "/mb":
            return self.mb(q)
        self.send({"error": "not found"}, 404)

    def lastfm(self, q):
        S = STATE
        if q.get("api_key") != API_KEY:
            return self.send({"error": 10, "message": "Invalid API key"}, 403)
        m = q.get("method")
        if m == "user.getrecenttracks":
            if q.get("user", "").lower() != "mungusx":
                return self.send({"error": 6, "message": "User not found"}, 404)
            frm = int(q.get("from", 0))
            to = int(q.get("to", 10 ** 12))
            rows = [p for p in reversed(S.plays) if frm <= p[0] <= to]  # inclusive, the harder case
            per, page = int(q.get("limit", 50)), int(q.get("page", 1))
            total_pages = max(1, -(-len(rows) // per)) if rows else 0
            chunk = rows[(page - 1) * per: page * per]
            if page == 1:
                S.cur_drop = S.drops.pop(0) if S.drops else set()
            if page in S.cur_drop:
                chunk = []  # Last.fm's silent hiccup: an empty page with no error
            items = []
            if page == 1:
                tr = S.artists[1]["tracks"][0]
                items.append({"artist": {"mbid": "", "#text": tr["artist"]}, "name": tr["title"],
                              "album": {"mbid": "", "#text": tr["album"]}, "@attr": {"nowplaying": "true"}})
            for uts, tr in chunk:
                items.append({"artist": {"mbid": "", "#text": tr["artist"]}, "name": tr["title"],
                              "album": {"mbid": "", "#text": tr["album"]}, "mbid": "",
                              "date": {"uts": str(uts), "#text": "x"}})
            if len(items) == 1 and not chunk:
                items = items  # only now playing
            return self.send({"recenttracks": {"track": items if len(items) != 1 else items[0],
                              "@attr": {"user": q.get("user"), "totalPages": str(total_pages),
                                        "page": str(page), "perPage": str(per), "total": str(len(rows))}}})
        if m == "track.getInfo":
            if S.fail_once["lastfm_rate"]:
                S.fail_once["lastfm_rate"] = False
                return self.send({"error": 29, "message": "Rate limit exceeded"})
            tr = S.by_key.get((q.get("artist"), q.get("track")))
            if not tr:
                return self.send({"error": 6, "message": "Track not found"})
            ms = tr["dur"] * 1000 if tr["avail"] == "lastfm" else 0
            return self.send({"track": {"name": tr["title"], "artist": {"name": tr["artist"]}, "duration": str(ms)}})
        if m == "artist.getTopTags":
            a = S.by_artist.get(q.get("artist"))
            if not a:
                return self.send({"error": 6, "message": "Artist not found"})
            tags = [{"count": 100 - i * 20, "name": t.lower()} for i, t in enumerate(a["tags"])]
            tags += [{"count": 90, "name": "seen live"}, {"count": 10, "name": "obscure"},
                     {"count": 50, "name": "2010s"}]
            tags.sort(key=lambda t: -t["count"])
            if a["name"] == S.artists[5]["name"]:
                tags = tags[:1]  # Last.fm returns a lone dict for single results
                return self.send({"toptags": {"tag": tags[0]}})
            return self.send({"toptags": {"tag": tags}})
        self.send({"error": 3, "message": "Invalid method"})

    def deezer(self, q):
        S = STATE
        if S.fail_once["deezer_503"]:
            S.fail_once["deezer_503"] = False
            return self.send({"oops": 1}, 503)
        raw = q.get("q", "")
        hits = []
        for (artist, title), tr in S.by_key.items():
            if artist.lower() in raw.lower() and title.lower() in raw.lower():
                if tr["avail"] == "deezer":
                    hits.append({"title": tr["title"], "artist": {"name": tr["artist"]}, "duration": tr["dur"]})
                elif tr["avail"] == "none":  # wrong match trap: same artist, other title
                    hits.append({"title": tr["title"] + " (Live Version Extended)xyz", "artist": {"name": tr["artist"]},
                                 "duration": 999})
        self.send({"data": hits})

    def itunes(self, q):
        S = STATE
        raw = q.get("term", "").lower()
        out = []
        for (artist, title), tr in S.by_key.items():
            if artist.lower() in raw and title.lower() in raw and tr["avail"] == "itunes":
                out.append({"trackName": tr["title"], "artistName": tr["artist"], "trackTimeMillis": tr["dur"] * 1000})
        self.send({"resultCount": len(out), "results": out})

    def mb(self, q):
        S = STATE
        raw = q.get("query", "").replace("\\", "").lower()
        out = []
        for (artist, title), tr in S.by_key.items():
            if artist.lower() in raw and title.lower() in raw and tr["avail"] == "mb":
                out.append({"title": tr["title"], "length": tr["dur"] * 1000,
                            "artist-credit": [{"name": tr["artist"]}]})
        self.send({"recordings": out})


def start(port=0):
    global STATE
    STATE = State()
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, STATE


if __name__ == "__main__":
    srv, st = start(int(sys.argv[1]) if len(sys.argv) > 1 else 8765)
    print("mock up on", srv.server_address, "plays:", len(st.plays), flush=True)
    threading.Event().wait()
