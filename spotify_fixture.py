"""Make a fake Spotify data download for testing the import page.

Usage: python3 spotify_fixture.py <output folder>
Writes my_spotify_data.zip and Streaming_History_Audio_2026_0.json, plus expected.json.
"""
import json
import sys
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
T0 = datetime(2026, 3, 1, 20, 0, tzinfo=timezone.utc)
iso = lambda d: d.strftime("%Y-%m-%dT%H:%M:%SZ")
private = {"ip_addr": "203.0.113.7", "conn_country": "US", "platform": "android", "username": "secretuser",
           "user_agent_decrypted": "SecretPhone/1.0", "offline": False, "incognito_mode": False}


def ext(end, ms, artist, track, album):
    r = dict(private, ts=iso(end), ms_played=ms, master_metadata_track_name=track,
             master_metadata_album_artist_name=artist, master_metadata_album_album_name=album,
             spotify_track_uri="spotify:track:x", episode_name=None, episode_show_name=None,
             reason_start="trackdone", reason_end="trackdone", shuffle=False, skipped=False)
    return r


songs = [("Artist %d" % (k % 6), "Song %d" % k, "Album %d" % (k % 4)) for k in range(30)]
audio = [ext(T0 + timedelta(seconds=400 * k + 200), 200000, *songs[k]) for k in range(30)]
audio += [ext(T0 + timedelta(days=1, seconds=60 * k), 5000, "Skipper", "Skipped %d" % k, "") for k in range(5)]
pod = dict(private, ts=iso(T0 + timedelta(days=2)), ms_played=1800000, master_metadata_track_name=None,
           master_metadata_album_artist_name=None, master_metadata_album_album_name=None,
           episode_name="An Episode", episode_show_name="A Show")
audio += [dict(pod) for _ in range(3)]
audio_2 = [audio[0], audio[1]]  # the same two plays again in a second file
video = [dict(private, ts=iso(T0 + timedelta(days=3)), ms_played=60000, master_metadata_track_name=None,
              master_metadata_album_artist_name=None, episode_name="Clip") for _ in range(2)]
acc = []
for k in range(10):  # the same plays as the extended history, to the minute
    end = T0 + timedelta(seconds=400 * k + 200)
    acc.append({"endTime": end.strftime("%Y-%m-%d %H:%M"), "artistName": songs[k][0], "trackName": songs[k][1], "msPlayed": 200000})
for k in range(4):  # plays only the account data has
    end = T0 - timedelta(days=10, seconds=-300 * k)
    acc.append({"endTime": end.strftime("%Y-%m-%d %H:%M"), "artistName": "Old Artist", "trackName": "Old Song %d" % k, "msPlayed": 150000})
acc.append({"endTime": "2026-02-01 10:00", "artistName": "Unknown Artist", "trackName": "Unknown Track", "msPlayed": 100000})

with zipfile.ZipFile(out / "my_spotify_data.zip", "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("Spotify Extended Streaming History/Streaming_History_Audio_2025-2026_0.json", json.dumps(audio))
    z.writestr("Spotify Extended Streaming History/Streaming_History_Audio_2026_1.json", json.dumps(audio_2))
    z.writestr("Spotify Extended Streaming History/Streaming_History_Video_2026.json", json.dumps(video))
    z.writestr("Spotify Extended Streaming History/ReadMeFirst_ExtendedStreamingHistory.pdf", b"%PDF-1.4 not really")
    z.writestr("Spotify Account Data/StreamingHistory_music_0.json", json.dumps(acc))
    z.writestr("Spotify Account Data/Userdata.json", json.dumps({"username": "secretuser", "email": "x@example.com"}))
(out / "Streaming_History_Audio_2026_0.json").write_text(json.dumps(audio))
first_start = int((T0 + timedelta(seconds=200)).timestamp()) - 200
(out / "expected.json").write_text(json.dumps({
    "zip": {"plays": 34, "short": 5, "other": 6, "dupes": 12},
    "json": {"plays": 30, "short": 5, "other": 3, "dupes": 0},
    "first_extended_start": first_start,
    "private": ["203.0.113.7", "secretuser", "SecretPhone", "android", "x@example.com"],
}))
print("fixture written to", out)
