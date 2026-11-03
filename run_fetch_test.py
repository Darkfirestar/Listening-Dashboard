"""End-to-end test of fetch.py against fake Last.fm, Deezer, iTunes and MusicBrainz.

Run: python3 tests/run_fetch_test.py
Each scenario runs fetch.py in its own folder with the real default paths
(data/library.json, docs/data/listening.json, docs/data/summary.json).
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import mock_services  # noqa: E402

ROOT = HERE.parent
FAILS = []


def check(cond, msg):
    print(("PASS  " if cond else "FAIL  ") + msg)
    if not cond:
        FAILS.append(msg)


def run_fetch(env, cwd):
    cwd.mkdir(parents=True, exist_ok=True)
    full = {k: v for k, v in os.environ.items() if k not in ("STORE_FILE", "SITE_DIR", "FULL_RESYNC")}
    full.update(env)
    return subprocess.run([sys.executable, "-I", str(ROOT / "fetch.py")], env=full, cwd=str(cwd),
                          capture_output=True, text=True, timeout=600)


def store(cwd):
    return cwd / "data" / "library.json"


def site(cwd):
    return json.loads((cwd / "docs" / "data" / "listening.json").read_text())


def decode(s):
    """Plays from the compact site file, as [timestamp, track] pairs."""
    out, t = [], s["plays"]["t0"]
    for d, tr in zip(s["plays"]["dt"], s["plays"]["tr"]):
        t += d
        out.append([t, tr])
    return out


def named(s):
    """Plays from the page file as (time, artist, title, album, length, seconds heard)."""
    h = s["plays"].get("h") or [0] * len(s["plays"]["dt"])
    T = s["tracks"]
    return [(t, s["artists"][T["a"][tr]], T["t"][tr], s["albums"][T["al"][tr]], T["d"][tr], hh)
            for (t, tr), hh in zip(decode(s), h)]


def named_store(lib):
    return [(p[0], lib["tracks"][p[1]]["a"], lib["tracks"][p[1]]["t"], lib["tracks"][p[1]]["al"] or "",
             lib["tracks"][p[1]]["d"] or 0, 0) for p in lib["plays"]]


def get(base, path):
    return json.loads(urllib.request.urlopen(base + path).read())


def main():
    srv, state = mock_services.start(0)
    base = "http://127.0.0.1:%d" % srv.server_address[1]
    work = Path(tempfile.mkdtemp(prefix="fetchtest-"))
    env = {
        "LASTFM_API_KEY": "TESTKEY", "LASTFM_USER": "Mungusx", "TZ_NAME": "America/Los_Angeles",
        "LASTFM_URL": base + "/2.0/", "DEEZER_URL": base + "/deezer", "ITUNES_URL": base + "/itunes",
        "MB_URL": base + "/mb", "REQUEST_PAUSE": "0", "MB_PAUSE": "0", "ITUNES_PAUSE": "0",
        "RETRY_SCALE": "0", "MAX_LOOKUPS": "1000",
    }

    # --- setup mistakes show up on the dashboard itself
    nk = run_fetch(dict(env, LASTFM_API_KEY=""), work / "nokey")
    s = site(work / "nokey")
    check(nk.returncode == 1 and not s["status"]["ok"] and "LASTFM_API_KEY secret is missing" in s["status"]["message"],
          "missing secret: run fails and the page explains it")
    check(not store(work / "nokey").exists() and s["plays"]["dt"] == [], "missing secret: no empty history is saved")

    bad = run_fetch(dict(env, LASTFM_API_KEY="WRONG"), work / "bad")
    s = site(work / "bad")
    check(bad.returncode == 1 and "rejected the API key" in s["status"]["message"], "wrong key: run fails and the page explains it")
    check("WRONG" not in bad.stdout + bad.stderr, "the API key never appears in the log")

    nu = run_fetch(dict(env, LASTFM_USER="NoSuchUser"), work / "nouser")
    check(nu.returncode == 1 and "no user called NoSuchUser" in site(work / "nouser")["status"]["message"],
          "unknown username: clear message")

    # --- time budget of zero: scrobbles still saved, no lookups done
    nb = run_fetch(dict(env, ENRICH_BUDGET="0"), work / "nobudget")
    nb_lib = json.loads(store(work / "nobudget").read_text()) if nb.returncode == 0 else {"plays": [], "tracks": []}
    check(nb.returncode == 0 and len(nb_lib["plays"]) == len(state.plays) and all(t["d"] is None for t in nb_lib["tracks"]),
          "no time budget left: plays are saved and lookups wait for the next run")

    # --- Last.fm answers one page with nothing: the history is read again, so no play is lost
    get(base, "/admin/drop?pages=2")
    gp = run_fetch(dict(env, SKIP_ENRICH="1"), work / "gap")
    gp_plays = json.loads(store(work / "gap").read_text())["plays"] if gp.returncode == 0 else []
    check(gp.returncode == 0 and len(gp_plays) == len(state.plays) and "reading again" in gp.stdout,
          "an empty page from Last.fm is noticed and read again; every play is saved")

    # --- first full run
    main_dir = work / "main"
    expected = len(state.plays)
    r = run_fetch(env, main_dir)
    print(r.stdout[-500:], r.stderr[-500:])
    check(r.returncode == 0, "first run exits cleanly")
    lib = json.loads(store(main_dir).read_text())
    plays, tracks = lib["plays"], lib["tracks"]
    check(len(plays) == expected, "all %d plays stored (got %d); now-playing row skipped" % (expected, len(plays)))
    check(all(len(p) == 2 for p in plays), "saved plays hold only time and track")
    check("generated" not in lib["meta"], "saved history carries no run time, so quiet runs change nothing")
    check(len({(p[0], p[1]) for p in plays}) == len(plays), "no duplicate plays")
    check(all(plays[i][0] <= plays[i + 1][0] for i in range(len(plays) - 1)), "plays sorted by time")
    check(not (main_dir / "docs" / "data" / "library.json").exists(), "the full history is not inside the published folder")

    truth = {(t["artist"], t["title"]): t for t in state.by_key.values()}
    by_src, wrong = Counter(), 0
    for t in tracks:
        real = truth[(t["a"], t["t"])]
        if real["avail"] == "none":
            wrong += 0 if t["d"] is None else 1
        elif t["d"] is not None:
            by_src[t["ds"]] += 1
            if t["d"] != real["dur"] or t["ds"] != {"mb": "musicbrainz"}.get(real["avail"], real["avail"]):
                wrong += 1
        else:
            wrong += 1
    check(wrong == 0, "every length matches its source and the wrong-match trap was rejected (%d wrong)" % wrong)
    check(set(by_src) == {"lastfm", "deezer", "itunes", "musicbrainz"}, "all four length sources were used: %s" % dict(by_src))

    g = lib["genres"]
    check(len(g) == len(state.artists), "genres found for all %d artists" % len(state.artists))
    flat = {x for v in g.values() for x in v}
    check("Seen Live" not in flat and "2010s" not in flat and "Obscure" not in flat, "junk tags filtered out")
    check(state.artists[5]["name"] in g and len(g[state.artists[5]["name"]]) == 1, "single-tag artist (lone dict reply) handled")

    # the compact page file holds exactly the same history
    s = site(main_dir)
    check(s["v"] == 2 and s["status"]["ok"] and s["asOf"], "page file marked ok with an as-of time")
    check(named(s) == named_store(lib), "page file holds exactly the saved plays with every artist, title, album and length")
    check("h" not in s["plays"] and s["sources"] == {"lastfm": expected, "spotify": 0, "spotifyDuplicates": 0},
          "without a Spotify file, every play is from Last.fm")
    ok_alb = all(s["albumArtist"][s["tracks"]["al"][i]] == s["tracks"]["a"][i] for i in range(len(tracks)) if s["tracks"]["al"][i])
    check(ok_alb, "albums are kept apart per artist")
    ok_gen = all([s["genreNames"][j] for j in s["genres"][i]] == g.get(a, []) for i, a in enumerate(s["artists"]))
    check(ok_gen, "page file keeps every genre")
    raw = (main_dir / "docs" / "data" / "listening.json").read_bytes()
    check(len(raw) < store(main_dir).stat().st_size, "page file (%d KB) is smaller than the history (%d KB)"
          % (len(raw) // 1024, store(main_dir).stat().st_size // 1024))
    summ = json.loads((main_dir / "docs" / "data" / "summary.json").read_text())
    check(summ["total_plays"] == expected and summ["total_seconds"] > 0 and summ["ok"], "summary.json written")
    texts = store(main_dir).read_text() + raw.decode() + json.dumps(summ)
    check("TESTKEY" not in texts, "no key in any data file")

    # --- quiet run: nothing new, so the history file is not rewritten (no commit)
    before = store(main_dir).read_bytes()
    mtime = store(main_dir).stat().st_mtime_ns
    q = run_fetch(env, main_dir)
    check(q.returncode == 0 and store(main_dir).read_bytes() == before and store(main_dir).stat().st_mtime_ns == mtime,
          "quiet run leaves the history file untouched")

    # --- second run: new plays, a deleted play and a late scrobble inside the window
    before_hits = get(base, "/admin/hits")
    info = get(base, "/admin/advance")
    now_state = get(base, "/admin/state")
    r2 = run_fetch(env, main_dir)
    check(r2.returncode == 0, "second run exits cleanly")
    p2 = json.loads(store(main_dir).read_text())["plays"]
    check(len(p2) == now_state["plays"], "second run matches Last.fm exactly (%d vs %d)" % (len(p2), now_state["plays"]))
    uts2 = {p[0] for p in p2}
    check(info["deleted"] not in uts2, "play deleted on Last.fm inside the window is gone")
    check(info["late"] in uts2, "late scrobble inside the window is picked up")
    check(len({(p[0], p[1]) for p in p2}) == len(p2), "still no duplicates")
    check(sum(1 for p in p2 if p[0] == state.trap_uts) == 1, "play on the window's boundary second is stored once")
    hits = get(base, "/admin/hits")[len(before_hits):]
    check(len([h for h in hits if "track.getInfo" in h]) <= 5, "second run looked up only new tracks")
    check(len([h for h in hits if "user.getrecenttracks" in h]) <= 3, "second run read only the recent window")

    # --- Last.fm down: the saved history is published again with a note, nothing is lost
    before = store(main_dir).read_bytes()
    plays_before = len(json.loads(before)["plays"])
    down = run_fetch(dict(env, LASTFM_URL="http://127.0.0.1:9/2.0/"), main_dir)
    s = site(main_dir)
    check(down.returncode == 1, "Last.fm down: the run is marked failed")
    check(store(main_dir).read_bytes() == before, "Last.fm down: saved history untouched")
    check(not s["status"]["ok"] and "Could not reach Last.fm" in s["status"]["message"] and s["asOf"] is None,
          "Last.fm down: the page says so")
    check(len(decode(s)) == plays_before, "Last.fm down: the page still has every play")

    # --- a play deleted long ago stays until a full resync, which removes it and keeps lengths
    old = get(base, "/admin/delete-old")
    run_fetch(env, main_dir)
    check(old["deleted"] in {p[0] for p in json.loads(store(main_dir).read_text())["plays"]},
          "normal run keeps a play deleted more than 14 days back (expected)")
    get(base, "/admin/drop?pages=2")
    get(base, "/admin/drop?pages=2,3")
    before = store(main_dir).read_bytes()
    bad_fr = run_fetch(dict(env, FULL_RESYNC="true"), main_dir)
    s = site(main_dir)
    check(bad_fr.returncode == 1 and store(main_dir).read_bytes() == before
          and "sent only" in s["status"]["message"] and len(decode(s)) == len(json.loads(before)["plays"]),
          "full resync with pages missing twice is stopped; nothing is deleted and the page explains it")
    before_hits = get(base, "/admin/hits")
    fr = run_fetch(dict(env, FULL_RESYNC="true"), main_dir)
    p3 = json.loads(store(main_dir).read_text())["plays"]
    hits = get(base, "/admin/hits")[len(before_hits):]
    check(fr.returncode == 0 and old["deleted"] not in {p[0] for p in p3} and len(p3) == old["plays"],
          "full resync removes it and matches Last.fm exactly (%d plays)" % len(p3))
    check(len([h for h in hits if "track.getInfo" in h]) == 0, "full resync reuses every known length")

    # --- Spotify backlog: older plays added, plays Last.fm already has left out, real seconds kept
    sp = work / "spotify"
    (sp / "data").mkdir(parents=True)
    lf = list(state.plays)
    first = lf[0][0]
    rows, cat = [], [t for a in state.artists for t in a["tracks"]]
    for k in range(40):  # May 2026, before Last.fm starts
        tr = cat[(k * 7) % len(cat)]
        rows.append([first - 40 * 86400 + k * 3600, 100 + k, tr["artist"], tr["title"], tr["album"]])
    for k in range(3):  # songs no lookup service knows
        rows.append([first - 5 * 86400 + k * 600, 200, "Spotify Only Artist", "Unknown Song %d" % k, "Rare Album"])
    for k in range(10):  # the same plays Last.fm has, named slightly differently
        uts, tr = lf[100 + k * 37]
        title = tr["title"] + (" - Remastered 2011" if k % 2 else " (feat. Guest)")
        rows.append([uts + 120, 180, tr["artist"], title, tr["album"]])
    uts, tr = lf[100 + 10 * 37]  # Spotify credits two artists where the scrobble has one: still the same play
    rows.append([uts + 60, 180, tr["artist"] + ", Guest Star", tr["title"], tr["album"]])
    uts, tr = lf[100 + 11 * 37]  # same title by someone else at the same moment: a different play, kept
    rows.append([uts + 60, 180, "Someone Else", tr["title"], ""])
    rows.append([rows[0][0] + 30, 90, rows[0][2], rows[0][3], rows[0][4]])  # Spotify listing one play twice
    rows += [[first - 86400, 10, "A", "Skip", ""], [first - 86400, 100, "", "No artist", ""], [0, 100, "A", "B", ""]]
    (sp / "data" / "spotify-history.json").write_text(json.dumps({"source": "spotify", "v": 1, "plays": rows}))
    rs = run_fetch(env, sp)
    s = site(sp)
    lib_sp = json.loads(store(sp).read_text())
    n_lf = get(base, "/admin/state")["plays"]
    check(rs.returncode == 0 and s["sources"] == {"lastfm": n_lf, "spotify": 44, "spotifyDuplicates": 12},
          "Spotify: 44 plays added, 12 already on Last.fm (even when named differently) or listed twice left out (%s)"
          % s["sources"])
    plays_sp = named(s)
    check(all(plays_sp[i][0] <= plays_sp[i + 1][0] for i in range(len(plays_sp) - 1)), "Spotify: all plays in time order")
    check(plays_sp[0][0] == rows[0][0] and plays_sp[0][5] == rows[0][1], "Spotify: history now starts with the Spotify backlog")
    sp_only = [p for p in plays_sp if p[5]]
    check(len(sp_only) == 44 and all(p[5] >= 30 for p in sp_only), "Spotify: each Spotify play keeps the seconds actually played")
    check(len(lib_sp["plays"]) == n_lf, "Spotify plays are not mixed into the saved Last.fm history")
    unk = [t for t in lib_sp["tracks"] if t["a"] == "Spotify Only Artist"]
    check(len(unk) == 3 and all(t.get("x") for t in unk), "Spotify-only songs get length lookups too")
    want = {(t["artist"], t["title"]): (t["dur"] if t["avail"] != "none" else 0) for t in cat}
    got = [(p[4], want[(p[1], p[2])]) for p in sp_only if p[1] not in ("Spotify Only Artist", "Someone Else")]
    check(len(got) == 40 and all(a == b for a, b in got), "Spotify songs get the right length (shared with Last.fm or looked up)")
    summ = json.loads((sp / "docs" / "data" / "summary.json").read_text())
    check(summ["total_plays"] == n_lf + 44, "summary.json counts both sources")
    before = store(sp).read_bytes()
    run_fetch(env, sp)
    check(store(sp).read_bytes() == before, "Spotify: quiet re-run leaves the history file untouched")
    (sp / "data" / "spotify-history.json").write_text("{not json")
    rb = run_fetch(env, sp)
    s = site(sp)
    check(rb.returncode == 0 and s["status"]["ok"] and s["sources"]["spotify"] == 0
          and any("Spotify history file could not be read" in n for n in s["status"]["notes"]),
          "a broken Spotify file is reported on the page and the Last.fm update still works")

    # --- a history in the first version's place and shape is picked up and moved
    leg = work / "legacy"
    (leg / "docs" / "data").mkdir(parents=True)
    old_lib = json.loads(store(main_dir).read_text())
    old_lib["plays"] = [[p[0], p[1], None] for p in old_lib["plays"]]
    old_lib["meta"]["generated"] = "2026-10-01T00:00:00+00:00"
    (leg / "docs" / "data" / "library.json").write_text(json.dumps(old_lib))
    lg = run_fetch(dict(env, SKIP_ENRICH="1"), leg)
    check(lg.returncode == 0 and store(leg).exists() and len(json.loads(store(leg).read_text())["plays"]) == len(p3),
          "history from the first version is carried over")

    shutil.rmtree(work, ignore_errors=True)
    print("\n%d failure(s)" % len(FAILS))
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
