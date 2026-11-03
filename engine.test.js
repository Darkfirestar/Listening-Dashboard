/* Engine checks against an independent Python calculation, plus edge cases.
 * Run: TZ=America/Los_Angeles node tests/engine.test.js [optional big data file] */
const fs = require('fs'), cp = require('child_process');
const E = require('../docs/engine.js');
const DEMO = __dirname + '/../docs/data/demo.json';
const raw = JSON.parse(fs.readFileSync(DEMO, 'utf8'));
let fails = 0;
const near = (a, b, tol, msg) => { const ok = Math.abs(a - b) <= tol; if (!ok) fails++; console.log((ok ? 'PASS  ' : 'FAIL  ') + msg + (ok ? '' : '   got ' + a + ' want ' + b)); };
const same = (a, b, msg) => { const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) fails++; console.log((ok ? 'PASS  ' : 'FAIL  ') + msg + (ok ? '' : '   got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b))); };
const top = (a, kind, k, rank) => Array.from(a.order(kind, rank || 'time').slice(0, k), (j) => a.item(kind, j));

for (const mode of ['est', 'full']) {
  console.log('--- mode ' + mode);
  const exp = JSON.parse(cp.execSync('python3 ' + __dirname + '/expected.py ' + DEMO + ' ' + mode, { maxBuffer: 1e8 }).toString());
  const data = E.prepare(raw); E.setMode(data, mode);
  const a = E.analyze(data, 'all', 'all');
  near(a.total, exp.total, 1e-6, 'total seconds');
  same(a.n, exp.n, 'play count');
  for (const grain of ['month', 'quarter', 'year']) {
    const rows = E.periodRows(data, grain);
    const ok = Object.keys(exp[grain]).every((k) => Math.abs((rows.find((r) => r.key === k) || { v: -1 }).v - exp[grain][k]) < 1e-6)
      && rows.every((r) => r.v === 0 || exp[grain][r.key] !== undefined);
    near(ok ? 1 : 0, 1, 0, grain + ' totals match (' + rows.length + ' periods)');
  }
  same(Array.from(a.hr.sec, Math.round), exp.hour.map(Math.round), 'hour of day totals');
  same(Array.from(a.hr.wd, Math.round), exp.wd.map(Math.round), 'weekday totals');
  near(a.hr.heat.reduce((s, x) => s + x, 0), exp.total, 1e-6, 'heat map sums to total');
  same(top(a, 'artists', 3).map((x) => [x.name, x.v]), exp.top_artist, 'top 3 artists');
  same(top(a, 'tracks', 3).map((x) => [x.sub + ' | ' + x.name, x.v]), exp.top_track, 'top 3 tracks');
  same([a.uniq.tracks, a.uniq.artists, a.uniq.albums], exp.uniq, 'unique tracks, artists, albums');
  const g = top(a, 'genres', 4).filter((x) => !x.untagged).slice(0, 3);
  g.forEach((x, i) => near(x.v, exp.top_genre[i][1], 1e-6, 'genre #' + (i + 1) + ' ' + x.name + ' time'));
  same(g.map((x) => x.name), exp.top_genre.map((x) => x[0]), 'top 3 genre names');
  near(a.day.count, exp.days, 0, 'calendar days in range'); near(a.day.mean, exp.day_mean, 1e-6, 'mean per day');
  near(a.day.sd, exp.day_sd, 1e-6, 'sd per day'); near(a.day.median, exp.day_median, 1e-6, 'median per day');
  near(a.weekend.weekday, exp.wk_mean, 1e-6, 'weekday mean'); near(a.weekend.weekend, exp.we_mean, 1e-6, 'weekend mean');
  near(a.sessions.count, exp.sessions, 0, 'session count'); near(a.sessions.longest.dur, exp.longest_session, 0, 'longest session');
  near(a.streak.longest, exp.longest_streak, 0, 'longest streak'); near(a.unknownPlays, exp.unknown_plays, 0, 'plays without a length');
}

const data = E.prepare(raw); E.setMode(data, 'est');
console.log('--- periods, caching and edge cases');
near(E.analyze(data, 'quarter', '2026-Q2').day.count, E.dayNumber(2026, 5, 30) - data.firstDay + 1, 0, 'Q2 only counts days from the first play (' + E.dayLabel(data.firstDay) + ') to Jun 30');
near(data.nSpotify, raw.sources.spotify, 0, 'Spotify plays recognised (' + data.nSpotify + ')');
let okH = true; for (let i = 0; i < data.n; i++) if (data.heard[i] > 0 && (data.est[i] !== data.heard[i] || data.full[i] <= 0)) okH = false;
near(okH ? 1 : 0, 1, 0, 'Spotify plays count the seconds actually played');
near(E.analyze(data, 'month', '2026-10').day.count, 28, 0, 'October counts only up to the newest data');
const rows = E.periodRows(data, 'month');
near(rows[rows.length - 1].inProgress ? 1 : 0, 1, 0, 'current month flagged as in progress');
near(rows[0].inProgress ? 1 : 0, 0, 0, 'first month not in progress');
near(E.analyze(data, 'month', '2026-09').periodOver ? 1 : 0, 1, 0, 'September is over');
near(E.analyze(data, 'month', '2026-10').periodOver ? 1 : 0, 0, 0, 'October is not over yet');
near(E.analyze(data, 'all', 'all') === E.analyze(data, 'all', 'all') ? 1 : 0, 1, 0, 'repeat requests reuse the cached result');
E.setMode(data, 'full'); const af = E.analyze(data, 'all', 'all'); E.setMode(data, 'est');
near(af !== E.analyze(data, 'all', 'all') && af.total > E.analyze(data, 'all', 'all').total ? 1 : 0, 1, 0, 'each time mode has its own result');

// binary-search periods hold exactly the plays a slow scan finds
let okRange = true;
for (const grain of ['month', 'quarter', 'year']) {
  for (const k of E.periodKeys(data, grain)) {
    const [lo, hi] = E.range(data, grain, k), [b0, b1] = E.boundsOf(k, grain);
    let cnt = 0; for (let i = 0; i < data.n; i++) if (data.day[i] >= b0 && data.day[i] <= b1) cnt++;
    if (hi - lo !== cnt) okRange = false;
  }
}
near(okRange ? 1 : 0, 1, 0, 'every period holds exactly the right plays');

// quiet days after the last play count once the data has been refreshed past them
const raw2 = JSON.parse(JSON.stringify(raw));
const last = raw2.plays.t0 + raw2.plays.dt.reduce((s, x) => s + x, 0);
raw2.asOf = new Date((last + 5 * 86400) * 1000).toISOString();
const quiet = E.prepare(raw2);
const a1 = E.analyze(data, 'all', 'all'), a2 = E.analyze(quiet, 'all', 'all');
near(a2.day.count, a1.day.count + 5, 0, 'five quiet days after the last play count as zero days');
near(a2.streak.current, 0, 0, 'current streak resets after days without music');
near(a2.total, a1.total, 1e-6, 'total time unchanged by quiet days');
raw2.asOf = null;
near(E.analyze(E.prepare(raw2), 'all', 'all').day.count, a1.day.count, 0, 'after a failed update, quiet days are not assumed');

// the once-per-hour clock shortcut agrees with asking for every play, across both 2026 clock changes
function tiny(times) {
  return { v: 1, artists: ['A'], genreNames: [], genres: [[]], albums: [''], albumArtist: [-1],
    tracks: { a: [0], t: ['x'], al: [0], d: [180] }, plays: { t0: times[0], dt: times.map((t, i) => (i ? t - times[i - 1] : 0)), tr: times.map(() => 0) } };
}
function checkClock(times, label) {
  const d = E.prepare(tiny(times));
  let bad = 0;
  times.forEach((t, i) => {
    const x = new Date(t * 1000);
    if (d.hour[i] !== x.getHours() || d.day[i] !== E.dayNumber(x.getFullYear(), x.getMonth(), x.getDate()) || d.wd[i] !== (x.getDay() + 6) % 7) bad++;
  });
  near(bad, 0, 0, label + ' (' + times.length + ' plays)');
}
const span = (fromIso, hours, step) => { const s = Date.parse(fromIso) / 1000, out = []; for (let t = s; t < s + hours * 3600; t += step) out.push(t); return out; };
checkClock(span('2026-03-07T22:00:00-08:00', 30, 397), 'hours and days right through the spring clock change');
checkClock(span('2026-10-31T22:00:00-07:00', 30, 397), 'hours and days right through the autumn clock change');
checkClock(span('2026-10-28T00:00:00-07:00', 72, 59), 'hours and days with plays every minute');

const BIG = process.argv[2];
if (BIG && fs.existsSync(BIG)) {
  const big = E.prepare(JSON.parse(fs.readFileSync(BIG, 'utf8')));
  let bad = 0;
  for (let i = 0; i < big.n; i++) {
    const x = new Date(big.ts[i] * 1000);
    if (big.hour[i] !== x.getHours() || big.day[i] !== E.dayNumber(x.getFullYear(), x.getMonth(), x.getDate())) bad++;
  }
  near(bad, 0, 0, 'clock shortcut matches on every one of ' + big.n + ' plays in three years of history');
}

same(E.fmtHMS(3725), '1h 02m 05s', 'format 1h 02m 05s'); same(E.fmtHour(0), '12 AM', '12 AM'); same(E.fmtHour(12), '12 PM', '12 PM');
console.log(fails + ' failure(s)'); process.exit(fails ? 1 : 0);
