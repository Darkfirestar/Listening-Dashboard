#!/usr/bin/env python3
"""Pull Last.fm scrobbles, add track lengths and genres, write the dashboard data.

Standard library only. Runs on GitHub Actions a few times a day; nothing here runs on the phone.

Files:
  data/library.json        the saved history (committed to the repository, not published)
  data/spotify-history.json  optional: older plays from Spotify, made by docs/import.html
  docs/data/listening.json compact copy the dashboard downloads (published, rebuilt every run)
  docs/data/summary.json   tiny totals for a home-screen widget (published, rebuilt every run)

An update never blocks the site: if Last.fm cannot be reached, the saved history is published
again with a note the dashboard shows, and the script exits with an error so the run shows red.

Environment:
  LASTFM_API_KEY     required (a GitHub secret, never written to any file or log)
  LASTFM_USER        default Mungusx
  TZ_NAME            default America/Los_Angeles (only used for summary.json)
  STORE_FILE         default data/library.json
  SITE_DIR           default docs/data
  SPOTIFY_FILE       default data/spotify-history.json (optional Spotify backlog)
  MAX_LOOKUPS        track-length lookups per run (default 400)
  MAX_GENRE_LOOKUPS  artist-genre lookups per run (default 400)
  ENRICH_BUDGET      seconds of lookups per run before saving (default 5400)
  FULL_RESYNC        1 to re-read the whole history from Last.fm (fixes plays deleted long ago)
  SKIP_ENRICH        1 to skip length and genre lookups
"""
import difflib
import json
import os
import re
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from bisect import bisect_left
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

API_KEY = os.environ.get("LASTFM_API_KEY", "").strip()
USER = os.environ.get("LASTFM_USER", "Mungusx").strip()
TZ_NAME = os.environ.get("TZ_NAME", "America/Los_Angeles")
STORE_FILE = Path(os.environ.get("STORE_FILE", "data/library.json"))
LEGACY_STORE = Path("docs/data/library.json")  # where the first version kept it
SITE_DIR = Path(os.environ.get("SITE_DIR", "docs/data"))
# Spotify history made by the dashboard's import page (docs/import.html), uploaded to the repository
SPOTIFY_FILE = Path(os.environ.get("SPOTIFY_FILE", "data/spotify-history.json"))
SPOTIFY_MIN_SECONDS = 30   # Spotify only counts a stream from 30 seconds; shorter ones are skips
SAME_PLAY_WINDOW = 600     # a Spotify play within 10 minutes of the same song on Last.fm is the same play
LASTFM_URL = os.environ.get("LASTFM_URL", "https://ws.audioscrobbler.com/2.0/")
DEEZER_URL = os.environ.get("DEEZER_URL", "https://api.deezer.com/search")
ITUNES_URL = os.environ.get("ITUNES_URL", "https://itunes.apple.com/search")
MB_URL = os.environ.get("MB_URL", "https://musicbrainz.org/ws/2/recording")
MAX_LOOKUPS = int(os.environ.get("MAX_LOOKUPS", "400"))
MAX_GENRE_LOOKUPS = int(os.environ.get("MAX_GENRE_LOOKUPS", "400"))
PAUSE = float(os.environ.get("REQUEST_PAUSE", "0.25"))
MB_PAUSE = float(os.environ.get("MB_PAUSE", "1.1"))          # MusicBrainz allows 1 request per second
ITUNES_PAUSE = float(os.environ.get("ITUNES_PAUSE", "3.1"))  # iTunes Search allows about 20 per minute
RETRY_SCALE = float(os.environ.get("RETRY_SCALE", "1"))       # tests set 0 to skip waiting
# Stop looking up lengths and genres after this many seconds so the run always has
# time to save. GitHub stops the job at its timeout and anything unsaved is lost.
ENRICH_BUDGET = float(os.environ.get("ENRICH_BUDGET", "5400"))
FULL_RESYNC = os.environ.get("FULL_RESYNC", "").strip().lower() in ("1", "true", "yes")
STARTED = time.time()
# Re-read this many recent days every run. Last.fm accepts scrobbles up to 14 days late
# (Pano keeps them when the phone is offline), and plays deleted in this window disappear.
LOOKBACK_DAYS = 14
RETRY_MISSING_DAYS = 14    # how long to wait before retrying a track with no known length
UA = "personal-listening-dashboard/1.1 (https://github.com/Darkfirestar)"

GENRE_BLOCK = {
    "seen live", "favorites", "favourites", "favorite", "favourite", "love", "loved",
    "awesome", "good", "beautiful", "amazing", "albums i own", "male vocalists",
    "female vocalists", "male vocalist", "female vocalist", "vocalists", "all",
    "best", "cool", "epic", "check out", "my music", "music", "songs", "american",
    "british", "usa", "uk", "canadian", "french", "german", "swedish", "korean",
    "japanese", "under 2000 listeners", "spotify", "cover", "covers", "legend",
    "guilty pleasure", "classic", "new", "fire", "banger", "mellow", "chill",
}
GENRE_ALIAS = {
    "hip hop": "hip-hop", "hiphop": "hip-hop", "rnb": "r&b", "r and b": "r&b",
    "rhythm and blues": "r&b", "alt rock": "alternative rock", "alt-rock": "alternative rock",
    "electronica": "electronic", "indie-pop": "indie pop", "lofi": "lo-fi",
}
GENRE_DISPLAY = {
    "hip-hop": "Hip-Hop", "r&b": "R&B", "k-pop": "K-Pop", "j-pop": "J-Pop",
    "edm": "EDM", "lo-fi": "Lo-Fi", "uk drill": "UK Drill", "uk garage": "UK Garage",
}


class FetchError(Exception):
    """A problem the person can fix or wait out. The message is shown on the dashboard."""


def log(msg):
    print(msg, flush=True)


def die(msg):
    raise FetchError(msg)


def nap(seconds):
    if seconds > 0 and RETRY_SCALE > 0:
        time.sleep(seconds * RETRY_SCALE)


def as_list(x):
    if x is None:
        return []
    return x if isinstance(x, list) else [x]


# --------------------------------------------------------------------------- HTTP

def http_json(url, params=None, attempts=3, pause=None):
    """GET a URL and return parsed JSON, or None after repeated failure.

    Never prints the URL or the exception text, because Last.fm URLs contain the API key.
    """
    if params:
        url = url + ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    for attempt in range(attempts):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = json.loads(resp.read().decode("utf-8"))
            time.sleep(PAUSE if pause is None else pause)
            return body
        except urllib.error.HTTPError as e:
            try:
                body = json.loads(e.read().decode("utf-8"))
                if isinstance(body, dict) and "error" in body:
                    return body  # Last.fm reports API errors this way
            except Exception:
                pass
            if e.code in (429, 500, 502, 503, 504) and attempt < attempts - 1:
                nap(2 ** (attempt + 1))
                continue
            return None
        except Exception:  # network drop, timeout, cut-off or non-JSON reply
            if attempt < attempts - 1:
                nap(2 ** (attempt + 1))
                continue
            return None
    return None


def lastfm(method, strict=False, **params):
    q = {"method": method, "api_key": API_KEY, "format": "json"}
    q.update(params)
    tries = 6 if strict else 2  # lookups give up quickly so an outage cannot eat the whole run
    for attempt in range(tries):
        data = http_json(LASTFM_URL, q)
        if not isinstance(data, dict):
            if attempt < tries - 1:
                nap(2 * (attempt + 1))
                continue
            if strict:
                die("Could not reach Last.fm after several tries. It is probably down for a while; "
                    "the next update will try again.")
            return None
        err = data.get("error")
        if err is None:
            return data
        if err in (8, 11, 16, 29) and attempt < tries - 1:  # temporary Last.fm trouble or rate limit
            nap(5 * (attempt + 1))
            continue
        if err == 10 or err == 26:
            die("Last.fm rejected the API key. Check the LASTFM_API_KEY secret for typos or spaces.")
        if err == 17:
            die("Last.fm says this profile is private. In Last.fm settings, under Privacy, "
                "turn off 'Hide recent listening information'.")
        if strict and err == 6:
            die("Last.fm has no user called %s. Check LASTFM_USER in the workflow file." % USER)
        if strict:
            die("Last.fm answered with error %s (%s). The next update will try again."
                % (err, str(data.get("message", ""))[:120]))
        return None
    if strict:
        die("Last.fm kept answering with temporary errors. The next update will try again.")
    return None


# --------------------------------------------------------------------------- matching

# A candidate that is a different version of the song has a different length, so a
# candidate carrying one of these words (that the wanted title lacks) is rejected.
VERSION_WORDS = {"live", "remix", "acoustic", "instrumental", "extended", "edit", "demo",
                 "karaoke", "cover", "reprise", "unplugged", "slowed", "sped", "reverb",
                 "nightcore", "mix", "session", "medley"}


def version_tokens(s):
    return set(re.sub(r"[^\w]+", " ", (s or "").lower()).split()) & VERSION_WORDS


def norm(s):
    original = (s or "").lower()
    original = re.sub(r"\s[-–]\s*(\d{4}\s+)?(remaster(ed)?|mono|stereo)\b.*$", " ", original)
    t = re.sub(r"\(.*?\)|\[.*?\]", " ", original)
    t = re.sub(r"\b(feat|ft|featuring)\b.*", " ", t)
    t = " ".join(re.sub(r"[^\w]+", " ", t).split())
    if t:
        return t
    return " ".join(re.sub(r"[^\w]+", " ", original).split())


def sim(a, b):
    return difflib.SequenceMatcher(None, norm(a), norm(b)).ratio()


def artist_ok(a, b):
    na, nb = norm(a), norm(b)
    if not na or not nb:
        return False
    return na in nb or nb in na or sim(a, b) >= 0.8


def pick_match(candidates, artist, title):
    """candidates: list of (cand_title, cand_artist, seconds). Returns seconds or None."""
    best, best_score = None, 0.0
    for c_title, c_artist, secs in candidates:
        if not secs or secs < 5 or secs > 4 * 3600:
            continue
        if version_tokens(c_title) - version_tokens(title):
            continue
        score = sim(c_title, title)
        exact = norm(c_title) == norm(title)
        if (exact or score >= 0.92) and artist_ok(c_artist, artist) and score > best_score:
            best, best_score = secs, score
    return best


def lucene_escape(s):
    return re.sub(r'([+\-&|!(){}\[\]^"~*?:\\/])', r"\\\1", s)


# --------------------------------------------------------------------------- durations

def dur_lastfm(artist, title):
    data = lastfm("track.getInfo", artist=artist, track=title, autocorrect=1)
    try:
        ms = int((data or {}).get("track", {}).get("duration") or 0)
    except (TypeError, ValueError):
        ms = 0
    secs = round(ms / 1000)
    return secs if 5 <= secs <= 4 * 3600 else None


def dur_deezer(artist, title):
    for q in ('artist:"%s" track:"%s"' % (artist.replace('"', ""), title.replace('"', "")),
              "%s %s" % (artist, title)):
        data = http_json(DEEZER_URL, {"q": q, "limit": 8})
        cands = []
        for r in as_list((data or {}).get("data")):
            cands.append((r.get("title", ""), (r.get("artist") or {}).get("name", ""), r.get("duration")))
        found = pick_match(cands, artist, title)
        if found:
            return found
    return None


def dur_itunes(artist, title):
    data = http_json(ITUNES_URL, {"term": "%s %s" % (artist, title), "entity": "song", "media": "music", "limit": 10},
                     pause=ITUNES_PAUSE)
    cands = []
    for r in as_list((data or {}).get("results")):
        ms = r.get("trackTimeMillis")
        cands.append((r.get("trackName", ""), r.get("artistName", ""), round(ms / 1000) if ms else None))
    return pick_match(cands, artist, title)


def dur_musicbrainz(artist, title):
    query = 'recording:"%s" AND artist:"%s"' % (lucene_escape(title), lucene_escape(artist))
    data = http_json(MB_URL, {"query": query, "fmt": "json", "limit": 8}, pause=MB_PAUSE)
    cands = []
    for r in as_list((data or {}).get("recordings")):
        credit = " ".join(c.get("name", "") for c in as_list(r.get("artist-credit")) if isinstance(c, dict))
        ms = r.get("length")
        cands.append((r.get("title", ""), credit, round(ms / 1000) if ms else None))
    return pick_match(cands, artist, title)


DURATION_SOURCES = [("lastfm", dur_lastfm), ("deezer", dur_deezer),
                    ("itunes", dur_itunes), ("musicbrainz", dur_musicbrainz)]


def lookup_duration(artist, title):
    for name, fn in DURATION_SOURCES:
        try:
            secs = fn(artist, title)
        except Exception as e:  # one bad source must not stop the run
            log("  %s lookup failed (%s)" % (name, type(e).__name__))
            secs = None
        if secs:
            return secs, name
    return None, None


# --------------------------------------------------------------------------- genres

def clean_genre(name):
    n = " ".join((name or "").lower().replace("_", " ").split())
    n = GENRE_ALIAS.get(n, n)
    return n


def display_genre(n):
    return GENRE_DISPLAY.get(n) or " ".join(w.capitalize() for w in n.split(" "))


def lookup_genres(artist):
    data = lastfm("artist.getTopTags", artist=artist, autocorrect=1)
    tags = as_list(((data or {}).get("toptags") or {}).get("tag"))
    out, seen = [], set()
    artist_n = clean_genre(artist)
    for tag in tags:
        if not isinstance(tag, dict):
            continue
        n = clean_genre(tag.get("name"))
        try:
            count = int(tag.get("count") or 0)
        except (TypeError, ValueError):
            count = 0
        if not n or n in GENRE_BLOCK or n == artist_n or len(n) > 28 or count < 20:
            continue
        if re.fullmatch(r"\d{2,4}s?", n) or n in seen:
            continue
        seen.add(n)
        out.append(display_genre(n))
        if len(out) == 3:
            break
    return out


# --------------------------------------------------------------------------- library

def tkey(a, t, al):
    return "\x1f".join(s.strip().lower() for s in (a, t, al))


def atkey(a, t):
    return "\x1f".join(s.strip().lower() for s in (a, t))


def empty_library():
    return {"meta": {}, "tracks": [], "plays": [], "genres": {}, "genre_tried": {}}


def load_library():
    for p in (STORE_FILE, LEGACY_STORE):
        if p.exists():
            lib = json.loads(p.read_text("utf-8"))
            for k, v in empty_library().items():
                lib.setdefault(k, v)
            # plays are [timestamp, track]; older files also carried a derived third value
            lib["plays"] = [[int(p_[0]), int(p_[1])] for p_ in lib["plays"]]
            lib["meta"].pop("generated", None)
            return lib
    return empty_library()


def dumps(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"), sort_keys=False)


def write_text(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, "utf-8")
    tmp.replace(path)


def save_store(lib):
    """Write the history only when it changed, so quiet runs make no commit."""
    text = dumps(lib)
    if STORE_FILE.exists() and STORE_FILE.read_text("utf-8") == text:
        log("History unchanged; nothing new to save.")
        return False
    write_text(STORE_FILE, text)
    log("History saved to %s." % STORE_FILE)
    return True


def fetch_recent(from_ts, to_ts):
    """Plays from from_ts (or the beginning) up to to_ts, newest first from Last.fm,
    and how many plays Last.fm says there are.

    Fixing the end time stops new scrobbles from shifting pages while we read them.
    """
    plays, page, total, reported = [], 1, 1, 0
    while page <= total:
        params = {"user": USER, "limit": 200, "page": page, "to": to_ts}
        if from_ts:
            params["from"] = from_ts
        data = lastfm("user.getrecenttracks", strict=True, **params)
        rt = data.get("recenttracks") or {}
        attr = rt.get("@attr") or {}
        try:
            total = int(attr.get("totalPages", 1) or 1)
        except (TypeError, ValueError):
            total = 1
        if page == 1:
            try:
                reported = int(attr.get("total") or 0)
            except (TypeError, ValueError):
                reported = 0
        for t in as_list(rt.get("track")):
            if not isinstance(t, dict) or (t.get("@attr") or {}).get("nowplaying") == "true":
                continue
            uts = (t.get("date") or {}).get("uts")
            if not uts:
                continue
            artist = t.get("artist") or {}
            album = t.get("album") or {}
            plays.append((int(uts),
                          (artist.get("#text") or artist.get("name") or "").strip(),
                          (t.get("name") or "").strip(),
                          (album.get("#text") or album.get("name") or "").strip()))
        log("  page %d of %d" % (page, max(total, 1)))
        page += 1
    return plays, reported


def fetch_complete(from_ts, to_ts):
    """fetch_recent, checked against the count Last.fm reports.

    Last.fm occasionally answers a page with no plays and no error. Reading on regardless
    would lose those plays for good on the first run, or delete them from the saved history
    on a re-read. So a short read is read again, and the update stops if the two reads disagree.
    """
    def short(got, reported):
        return reported and got < reported - max(5, reported // 100)

    plays, reported = fetch_recent(from_ts, to_ts)
    if not short(len(plays), reported):
        return plays
    log("Last.fm sent %d of the %d plays it reports; reading again" % (len(plays), reported))
    again, reported2 = fetch_recent(from_ts, to_ts)
    if not short(len(again), reported2) or len(again) == len(plays):
        return again  # complete now, or the same both times (Last.fm's count is simply off)
    die("Last.fm sent only %d of the %d plays it reports, so this update stopped to keep your "
        "saved history safe. The next update will try again." % (max(len(plays), len(again)), reported2))


def merge_plays(lib, recent, from_ts):
    """Replace everything from from_ts on with what Last.fm says now (from_ts 0 = everything)."""
    tracks = lib["tracks"]
    index = {tkey(t["a"], t["t"], t["al"]): i for i, t in enumerate(tracks)}
    plays = lib["plays"]
    if from_ts is not None:
        plays = [p for p in plays if p[0] < from_ts]
    seen = set()
    for uts, a, t, al in recent:
        if not a or not t:
            continue
        if from_ts is not None and uts < from_ts:
            continue  # already kept above; Last.fm's "from" may include the boundary second
        k = tkey(a, t, al)
        ti = index.get(k)
        if ti is None:
            tracks.append({"a": a, "t": t, "al": al, "d": None, "ds": None})
            ti = index[k] = len(tracks) - 1
        if (uts, ti) in seen:
            continue
        seen.add((uts, ti))
        plays.append([uts, ti])
    plays.sort(key=lambda p: (p[0], p[1]))
    lib["plays"] = plays


def out_of_time():
    return time.time() - STARTED > ENRICH_BUDGET


def enrich_durations(lib, plays):
    """Look up song lengths, songs heard on Last.fm first (their time depends on it), most played first."""
    tracks, now = lib["tracks"], int(time.time())
    on_lastfm = Counter(p[1] for p in plays if not p[2])
    on_spotify = Counter(p[1] for p in plays if p[2])
    by_at = {}
    for t in tracks:
        if t.get("d"):
            by_at.setdefault(atkey(t["a"], t["t"]), (t["d"], t.get("ds")))
    for t in tracks:  # same song on another album: reuse the length
        if not t.get("d") and atkey(t["a"], t["t"]) in by_at:
            t["d"], t["ds"] = by_at[atkey(t["a"], t["t"])]
    todo = [i for i, t in enumerate(tracks)
            if not t.get("d") and (on_lastfm[i] or on_spotify[i])
            and (t.get("x") is None or now - t["x"] > RETRY_MISSING_DAYS * 86400)]
    todo.sort(key=lambda i: (0 if on_lastfm[i] else 1, -on_lastfm[i], -on_spotify[i]))
    log("Track lengths: %d tracks still need one (limit %d this run)" % (len(todo), MAX_LOOKUPS))
    found = 0
    for n, i in enumerate(todo[:MAX_LOOKUPS], 1):
        if out_of_time():
            log("  time budget used up; the rest continue next run")
            break
        t = tracks[i]
        secs, src = lookup_duration(t["a"], t["t"])
        t["x"] = int(time.time())
        if secs:
            t["d"], t["ds"] = secs, src
            found += 1
        if n % 25 == 0:
            log("  %d of %d looked up" % (n, min(len(todo), MAX_LOOKUPS)))
    log("  found %d lengths" % found)


def enrich_genres(lib, plays):
    now = int(time.time())
    plays_by_artist = Counter(lib["tracks"][p[1]]["a"] for p in plays)
    todo = [a for a in plays_by_artist
            if a not in lib["genres"] and now - lib["genre_tried"].get(a, 0) > RETRY_MISSING_DAYS * 86400]
    todo.sort(key=lambda a: -plays_by_artist[a])
    log("Genres: %d artists still need tags (limit %d this run)" % (len(todo), MAX_GENRE_LOOKUPS))
    for a in todo[:MAX_GENRE_LOOKUPS]:
        if out_of_time():
            log("  time budget used up; the rest continue next run")
            break
        try:
            genres = lookup_genres(a)
        except FetchError:
            raise
        except Exception as e:  # one odd reply must not stop the other artists
            log("  genre lookup failed (%s)" % type(e).__name__)
            genres = []
        lib["genre_tried"][a] = int(time.time())
        if genres:
            lib["genres"][a] = genres


# --------------------------------------------------------------------------- Spotify backlog

def load_spotify():
    """Rows (start time, seconds played, artist, title, album) from the import page's file.

    Returns (rows, problem). A missing file is normal; a broken one is reported but never
    stops the Last.fm update.
    """
    if not SPOTIFY_FILE.exists():
        return [], None
    try:
        raw = json.loads(SPOTIFY_FILE.read_text("utf-8"))
        if not isinstance(raw, dict) or raw.get("source") != "spotify" or not isinstance(raw.get("plays"), list):
            raise ValueError("not made by the import page")
        rows, latest = [], time.time() + 86400
        for r in raw["plays"]:
            if not isinstance(r, list) or len(r) < 4:
                continue
            start, secs = int(r[0]), int(r[1])
            artist, title = str(r[2] or "").strip(), str(r[3] or "").strip()
            album = str(r[4] or "").strip() if len(r) > 4 else ""
            if secs < SPOTIFY_MIN_SECONDS or secs > 6 * 3600 or not artist or not title:
                continue
            if start < 946684800 or start > latest:  # before 2000 or in the future
                continue
            rows.append((start, secs, artist, title, album))
        log("Spotify history: %d plays in %s" % (len(rows), SPOTIFY_FILE))
        return rows, None
    except Exception as e:
        return [], ("The Spotify history file could not be read (%s). Make it again with the import "
                    "page and upload it once more." % (type(e).__name__ if not isinstance(e, ValueError) else e))


def match_key(artist, title):
    return norm(artist) + "\x1f" + norm(title)


def combine(lib, sp_rows):
    """All plays in time order as [time, track, seconds heard], seconds 0 for Last.fm plays.

    A Spotify play is left out when Last.fm already has the same song within 10 minutes
    (Pano or Spotify itself may have scrobbled it), or when Spotify lists it twice within 2 minutes.
    Spotify songs are added to the track list so they get lengths and genres too.
    Returns (plays, number of duplicates left out).
    """
    tracks = lib["tracks"]
    index = {tkey(t["a"], t["t"], t["al"]): i for i, t in enumerate(tracks)}
    lastfm_by_title = defaultdict(list)  # song title -> [(time, artist)], oldest first
    for uts, ti in lib["plays"]:
        t = tracks[ti]
        lastfm_by_title[norm(t["t"])].append((uts, " %s " % norm(t["a"])))
    for v in lastfm_by_title.values():
        v.sort()

    def on_lastfm(artist, title, x):
        """Last.fm has this song within SAME_PLAY_WINDOW of x. The artists match when one name
        holds the other, because Spotify gives the main artist and a scrobble may list
        everyone ("Artist A" and "Artist A, Artist B")."""
        rows, a = lastfm_by_title.get(norm(title)), " %s " % norm(artist)
        if not rows or not a.strip():
            return False
        j = bisect_left(rows, (x - SAME_PLAY_WINDOW,))
        while j < len(rows) and rows[j][0] <= x + SAME_PLAY_WINDOW:
            b = rows[j][1]
            if b.strip() and (a in b or b in a):
                return True
            j += 1
        return False

    out = [[p[0], p[1], 0] for p in lib["plays"]]
    dup, last_seen = 0, {}
    for start, secs, a, t, al in sorted(sp_rows):
        k = match_key(a, t)
        if on_lastfm(a, t, start):
            dup += 1
            continue
        if k in last_seen and start - last_seen[k] < 120:
            dup += 1
            continue
        last_seen[k] = start
        key = tkey(a, t, al)
        ti = index.get(key)
        if ti is None:
            tracks.append({"a": a, "t": t, "al": al, "d": None, "ds": None})
            ti = index[key] = len(tracks) - 1
        out.append([start, ti, secs])
    out.sort(key=lambda p: (p[0], p[1]))
    return out, dup


def listened(lib, plays):
    """Estimated seconds heard per play.

    Spotify says exactly how long you listened. For Last.fm plays it is the song length, or the
    gap to the next play if that is shorter; unknown length gives None. The page does the same.
    """
    tracks, out = lib["tracks"], []
    for i, p in enumerate(plays):
        if p[2]:
            out.append(p[2])
            continue
        d = tracks[p[1]].get("d")
        if not d:
            out.append(None)
            continue
        gap = plays[i + 1][0] - p[0] if i + 1 < len(plays) else None
        out.append(gap if (gap is not None and 0 < gap < d) else d)
    return out


def fmt_hm(seconds):
    seconds = int(seconds)
    h, m = seconds // 3600, (seconds % 3600) // 60
    return "%dh %02dm" % (h, m) if h else "%dm" % m


def build_summary(lib, plays, est, generated, status):
    tz = ZoneInfo(TZ_NAME)
    now = datetime.now(tz)
    today0 = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week0 = today0 - timedelta(days=today0.weekday())
    month0 = today0.replace(day=1)
    tracks = lib["tracks"]

    def since(start):
        ts = int(start.timestamp())
        return [i for i, p in enumerate(plays) if p[0] >= ts]

    def secs(idx):
        return sum(est[i] or 0 for i in idx)

    month = since(month0)
    by_artist, by_track = Counter(), Counter()
    for i in month:
        t = tracks[plays[i][1]]
        by_artist[t["a"]] += est[i] or 0
        by_track[t["a"] + " - " + t["t"]] += est[i] or 0
    if month and not any(by_artist.values()):  # no lengths known: fall back to play counts
        by_artist = Counter(tracks[plays[i][1]]["a"] for i in month)
        by_track = Counter(tracks[plays[i][1]]["a"] + " - " + tracks[plays[i][1]]["t"] for i in month)
    total = secs(range(len(plays)))
    today, week = since(today0), since(week0)
    return {
        "user": USER, "updated": generated, "ok": status["ok"], "tz": TZ_NAME,
        "total_plays": len(plays), "total_seconds": total, "total_hours": round(total / 3600, 1),
        "today_seconds": secs(today), "today_text": fmt_hm(secs(today)), "today_plays": len(today),
        "week_seconds": secs(week), "week_text": fmt_hm(secs(week)),
        "month_seconds": secs(month), "month_text": fmt_hm(secs(month)), "month_plays": len(month),
        "month_top_artist": by_artist.most_common(1)[0][0] if by_artist else "",
        "month_top_track": by_track.most_common(1)[0][0] if by_track else "",
    }


def build_site_data(lib, plays, dup, generated, status):
    """The compact file the dashboard downloads.

    Names are listed once and referred to by number, and play times are stored as gaps
    from the previous play, which keeps the download small. Only songs that were played are
    included. The page rebuilds the rest.
    """
    tracks = lib["tracks"]
    used = sorted({p[1] for p in plays})
    t_new = {ti: j for j, ti in enumerate(used)}
    artists, a_idx = [], {}
    albums, album_artist, al_idx = [""], [-1], {}
    ta, tt, tal, td = [], [], [], []
    for ti in used:
        t = tracks[ti]
        a = t["a"]
        if a not in a_idx:
            a_idx[a] = len(artists)
            artists.append(a)
        ai = a_idx[a]
        al = t.get("al") or ""
        if al:
            k = (ai, al.lower())
            if k not in al_idx:
                al_idx[k] = len(albums)
                albums.append(al)
                album_artist.append(ai)
            ali = al_idx[k]
        else:
            ali = 0
        ta.append(ai)
        tt.append(t["t"])
        tal.append(ali)
        td.append(int(t["d"]) if t.get("d") else 0)
    g_names, g_idx, genres = [], {}, []
    for a in artists:
        row = []
        for g in lib["genres"].get(a, []):
            if g not in g_idx:
                g_idx[g] = len(g_names)
                g_names.append(g)
            row.append(g_idx[g])
        genres.append(row)
    t0 = plays[0][0] if plays else 0
    dt, tr, heard, prev = [], [], [], t0
    for p in plays:
        dt.append(p[0] - prev)
        prev = p[0]
        tr.append(t_new[p[1]])
        heard.append(p[2])
    n_sp = sum(1 for p in plays if p[2])
    out = {
        "v": 2, "user": USER, "generated": generated,
        # the day the data is complete up to; unknown after a failed update
        "asOf": generated if status["ok"] else None,
        "status": status,
        "sources": {"lastfm": len(plays) - n_sp, "spotify": n_sp, "spotifyDuplicates": dup},
        "artists": artists, "genreNames": g_names, "genres": genres,
        "albums": albums, "albumArtist": album_artist,
        "tracks": {"a": ta, "t": tt, "al": tal, "d": td},
        "plays": {"t0": t0, "dt": dt, "tr": tr},
    }
    if n_sp:
        out["plays"]["h"] = heard  # seconds actually played, from Spotify; 0 for Last.fm plays
    return out


def build_meta(lib):
    plays, tracks = lib["plays"], lib["tracks"]
    missing = {i for i, t in enumerate(tracks) if not t.get("d")}
    return {
        "user": USER,
        "plays": len(plays),
        "tracks": len(tracks),
        "first_uts": plays[0][0] if plays else None,
        "last_uts": plays[-1][0] if plays else None,
        "tracks_without_length": len(missing),
        "plays_without_length": sum(1 for p in plays if p[1] in missing),
    }


def update(lib, sp_rows):
    if not API_KEY:
        die("The LASTFM_API_KEY secret is missing. Add it under Settings, Secrets and variables, Actions.")
    now = int(time.time())
    if FULL_RESYNC:
        from_ts = 0
        log("Full resync: reading your whole Last.fm history again")
    elif lib["plays"]:
        from_ts = max(0, lib["plays"][-1][0] - LOOKBACK_DAYS * 86400)
        log("Fetching scrobbles for %s from the last %d days" % (USER, LOOKBACK_DAYS))
    else:
        from_ts = None
        log("Fetching the whole history for %s" % USER)
    recent = fetch_complete(from_ts - 1 if from_ts else None, now)
    merge_plays(lib, recent, from_ts)
    log("Last.fm history now has %d plays and %d distinct tracks" % (len(lib["plays"]), len(lib["tracks"])))
    if os.environ.get("SKIP_ENRICH"):
        return
    plays, _ = combine(lib, sp_rows)
    try:
        enrich_durations(lib, plays)
        enrich_genres(lib, plays)
    except FetchError as e:
        log("Warning: lookups stopped early (%s). Scrobbles are still saved." % e)
    except Exception as e:  # keep the scrobbles even if a lookup breaks
        log("Warning: lookups stopped early (%s). Scrobbles are still saved." % type(e).__name__)


def main():
    status = {"ok": True, "message": "", "notes": []}
    lib = load_library()
    sp_rows, sp_problem = load_spotify()
    if sp_problem:
        status["notes"].append(sp_problem)
        log("WARNING: " + sp_problem)
    try:
        update(lib, sp_rows)
    except FetchError as e:
        status.update(ok=False, message=str(e))
        log("ERROR: " + str(e))
        lib = load_library()  # publish the saved history unchanged
    except Exception as e:
        traceback.print_exc()
        status.update(ok=False, message="The update script hit an unexpected problem (%s). "
                                        "Your saved history is unchanged." % type(e).__name__)
        log("ERROR: " + status["message"])
        lib = load_library()

    plays, dup = combine(lib, sp_rows)  # adds any new Spotify songs to the track list
    lib["meta"] = build_meta(lib)
    if status["ok"] or STORE_FILE.exists() or LEGACY_STORE.exists():
        save_store(lib)
    generated = datetime.now(timezone.utc).isoformat(timespec="seconds")
    est = listened(lib, plays)
    write_text(SITE_DIR / "listening.json", dumps(build_site_data(lib, plays, dup, generated, status)))
    write_text(SITE_DIR / "summary.json", dumps(build_summary(lib, plays, est, generated, status)))
    m = lib["meta"]
    n_sp = sum(1 for p in plays if p[2])
    log("Published %d plays (%d from Last.fm, %d from Spotify; %d Spotify plays already on Last.fm left out)."
        % (len(plays), m["plays"], n_sp, dup))
    log("%d tracks still without a length (%d Last.fm plays)." % (m["tracks_without_length"], m["plays_without_length"]))
    return 0 if status["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
