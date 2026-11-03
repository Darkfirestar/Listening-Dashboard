/* Data engine: turns data/listening.json into the numbers the dashboard shows.
 *
 * Built to be light on a phone:
 * - plays live in typed number arrays (a few bytes each), not one object per play
 * - plays are in time order, so any period is a contiguous run found by binary search
 * - each result is worked out once and cached; taps that only change the view reuse it
 * - local dates and hours are worked out once per listening hour, not once per play
 *
 * No DOM. Dates use the viewing device's time zone (set TZ when testing in Node). */
(function (root) {
  'use strict';
  const S = (typeof require !== 'undefined' && typeof module !== 'undefined') ? require('./stats.js') : root.Stats;

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const DAY_MS = 86400000;
  const SESSION_GAP = 30 * 60; // seconds of silence that ends a listening session
  const CACHE_MAX = 32;
  const pad = (n) => (n < 10 ? '0' + n : '' + n);

  // ---------------------------------------------------------------- calendar helpers
  function dayNumber(y, m, d) { return Math.floor(Date.UTC(y, m, d) / DAY_MS); }
  function dayParts(dn) { const d = new Date(dn * DAY_MS); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), wd: (d.getUTCDay() + 6) % 7 }; }
  function weekdayOf(dn) { return ((dn % 7) + 10) % 7; } // day 0 (1 Jan 1970) was a Thursday; Monday = 0
  function dayLabel(dn) { const p = dayParts(dn); return WEEKDAYS[p.wd] + ' ' + MONTHS[p.m] + ' ' + p.d + ', ' + p.y; }
  function localDay(ms) { const d = new Date(ms); return dayNumber(d.getFullYear(), d.getMonth(), d.getDate()); }

  // first index whose value is >= x, in a sorted typed array
  function lowerBound(arr, x, lo, hi) {
    lo = lo || 0; hi = hi == null ? arr.length : hi;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
    return lo;
  }

  // ---------------------------------------------------------------- loading
  function prepare(raw) {
    if (!raw || (raw.v !== 1 && raw.v !== 2) || !raw.plays || !raw.tracks) throw new Error('This data file is in a format the page does not know.');
    const P = raw.plays, T = raw.tracks, H = P.h || null; // H: seconds actually played (Spotify), 0 = estimate
    const n = P.dt.length, nT = T.t.length;
    const ts = new Float64Array(n), tr = new Int32Array(n), day = new Int32Array(n);
    const hour = new Uint8Array(n), wd = new Uint8Array(n), full = new Float64Array(n), est = new Float64Array(n);
    const tA = Int32Array.from(T.a), tAl = Int32Array.from(T.al), tDur = Int32Array.from(T.d);

    // local calendar: ask the Date object only when a play falls in a new clock hour
    let t = P.t0, hourStart = Infinity, hourEnd = -Infinity, cDay = 0, cHour = 0, cWd = 0;
    for (let i = 0; i < n; i++) {
      t += P.dt[i];
      ts[i] = t; tr[i] = P.tr[i];
      if (t < hourStart || t >= hourEnd) {
        const d = new Date(t * 1000);
        cDay = dayNumber(d.getFullYear(), d.getMonth(), d.getDate());
        cHour = d.getHours(); cWd = (d.getDay() + 6) % 7;
        hourStart = t - d.getMinutes() * 60 - d.getSeconds();
        hourEnd = hourStart + 3600;
      }
      day[i] = cDay; hour[i] = cHour; wd[i] = cWd;
      full[i] = tDur[tr[i]] || (H ? H[i] : 0);
    }
    // seconds heard: what Spotify reports, else the track length, or the gap to the next play when shorter
    let nSpotify = 0;
    for (let i = 0; i < n; i++) {
      if (H && H[i] > 0) { est[i] = H[i]; nSpotify++; continue; }
      const d = full[i];
      if (!d) continue;
      const gap = i + 1 < n ? ts[i + 1] - ts[i] : 0;
      est[i] = gap > 0 && gap < d ? gap : d;
    }

    const nA = raw.artists.length;
    const artistFirstDay = new Int32Array(nA).fill(2147483647);
    for (let i = 0; i < n; i++) { const a = tA[tr[i]]; if (artistFirstDay[a] > day[i]) artistFirstDay[a] = day[i]; }

    const lastPlayDay = n ? day[n - 1] : 0;
    let asOfDay = lastPlayDay;
    if (raw.asOf) { const g = Date.parse(raw.asOf); if (!isNaN(g)) asOfDay = Math.max(asOfDay, localDay(g)); }

    // typical song length, used to give unknown-length songs a length for sessions
    let known = 0;
    for (let i = 0; i < n; i++) if (full[i]) known++;
    const kl = new Float64Array(known);
    for (let i = 0, k = 0; i < n; i++) if (full[i]) kl[k++] = full[i];
    kl.sort();
    const fallbackLen = known ? (known % 2 ? kl[(known - 1) / 2] : (kl[known / 2 - 1] + kl[known / 2]) / 2) : 200;

    return {
      n, ts, tr, day, hour, wd, full, est, v: est, mode: 'est',
      nT, tA, tAl, tDur, tTitle: T.t,
      artists: raw.artists, nA, albums: raw.albums, nAl: raw.albums.length, albumArtist: Int32Array.from(raw.albumArtist || []),
      genreNames: raw.genreNames || [], genres: (raw.genres || []).map((g) => Int32Array.from(g)),
      artistFirstDay, firstDay: n ? day[0] : 0, lastPlayDay, asOfDay, fallbackLen, unknownPlays: n - known,
      user: raw.user || '', generated: raw.generated || null, status: raw.status || { ok: true, message: '' },
      heard: H ? Float64Array.from(H) : null, nSpotify, sources: raw.sources || null,
      cache: new Map(),
      scratch: { tN: new Int32Array(nT), tV: new Float64Array(nT), aN: new Int32Array(nA), aV: new Float64Array(nA), lN: new Int32Array(raw.albums.length), lV: new Float64Array(raw.albums.length) },
    };
  }

  function setMode(data, mode) {
    data.mode = mode === 'full' ? 'full' : 'est';
    data.v = data.mode === 'full' ? data.full : data.est;
  }

  function cached(data, key, make) {
    const k = data.mode + '|' + key;
    if (data.cache.has(k)) { const val = data.cache.get(k); data.cache.delete(k); data.cache.set(k, val); return val; }
    const val = make();
    data.cache.set(k, val);
    if (data.cache.size > CACHE_MAX) data.cache.delete(data.cache.keys().next().value);
    return val;
  }

  // ---------------------------------------------------------------- periods
  function keyOfDay(dn, grain) {
    if (grain === 'all') return 'all';
    const p = dayParts(dn);
    if (grain === 'year') return String(p.y);
    if (grain === 'quarter') return p.y + '-Q' + (Math.floor(p.m / 3) + 1);
    return p.y + '-' + pad(p.m + 1);
  }
  function labelOf(key, grain) {
    if (grain === 'year') return key;
    if (grain === 'quarter') { const [y, q] = key.split('-'); return q + ' ' + y; }
    if (grain === 'month') { const [y, m] = key.split('-'); return MONTHS[+m - 1] + ' ' + y; }
    return 'All time';
  }
  function shortLabel(key, grain) {
    if (grain === 'month') { const [y, m] = key.split('-'); return MONTHS[+m - 1] + (m === '01' ? " '" + y.slice(2) : ''); }
    if (grain === 'quarter') { const [y, q] = key.split('-'); return q + " '" + y.slice(2); }
    return key;
  }
  // first and last day number (inclusive) a period covers
  function boundsOf(key, grain) {
    if (grain === 'year') { const y = +key; return [dayNumber(y, 0, 1), dayNumber(y + 1, 0, 1) - 1]; }
    if (grain === 'quarter') { const [y, q] = key.split('-Q').map(Number); return [dayNumber(y, (q - 1) * 3, 1), dayNumber(y, q * 3, 1) - 1]; }
    if (grain === 'month') { const [y, m] = key.split('-').map(Number); return [dayNumber(y, m - 1, 1), dayNumber(y, m, 1) - 1]; }
    return [-Infinity, Infinity];
  }
  function nextKey(key, grain) {
    if (grain === 'year') return String(+key + 1);
    if (grain === 'quarter') { let [y, q] = key.split('-Q').map(Number); q++; if (q > 4) { q = 1; y++; } return y + '-Q' + q; }
    let [y, m] = key.split('-').map(Number); m++; if (m > 12) { m = 1; y++; } return y + '-' + pad(m);
  }
  function periodKeys(data, grain) {
    if (!data.n || grain === 'all') return grain === 'all' ? ['all'] : [];
    return cached(data, 'keys|' + grain, () => {
      const first = keyOfDay(data.firstDay, grain), last = keyOfDay(data.asOfDay, grain), keys = [];
      for (let k = first; ; k = nextKey(k, grain)) { keys.push(k); if (k === last || keys.length > 600) break; }
      return keys;
    });
  }
  // plays [lo, hi) that fall in a period
  function range(data, grain, key) {
    if (grain === 'all') return [0, data.n];
    const [b0, b1] = boundsOf(key, grain);
    return [lowerBound(data.day, b0), lowerBound(data.day, b1 + 1)];
  }

  // ---------------------------------------------------------------- one pass over a run of plays
  function tally(data, lo, hi, wantDetail) {
    const { tr, tA, tAl, v, scratch } = data;
    const { tN, tV, aN, aV, lN, lV } = scratch;
    const tk = [], ak = [], lk = [];
    let total = 0;
    for (let i = lo; i < hi; i++) {
      const t = tr[i], a = tA[t], al = tAl[t], x = v[i];
      total += x;
      if (tN[t]++ === 0) tk.push(t); tV[t] += x;
      if (aN[a]++ === 0) ak.push(a); aV[a] += x;
      if (al > 0) { if (lN[al]++ === 0) lk.push(al); lV[al] += x; }
    }
    // copy out the touched entries and reset the shared buffers for the next pass
    const pack = (keys, N, V) => {
      const ids = Int32Array.from(keys), n = new Int32Array(keys.length), val = new Float64Array(keys.length);
      for (let j = 0; j < keys.length; j++) { const id = keys[j]; n[j] = N[id]; val[j] = V[id]; N[id] = 0; V[id] = 0; }
      return { ids, n, v: val };
    };
    if (!wantDetail) {
      // only the leaders and the counts (for the per-period table)
      const best = (keys, N, V) => { let b = -1, bv = -1, bn = -1; for (const id of keys) { if (V[id] > bv || (V[id] === bv && N[id] > bn)) { b = id; bv = V[id]; bn = N[id]; } } return b; };
      const out = { total, n: hi - lo, tracks: tk.length, artists: ak.length, topArtist: best(ak, aN, aV), topTrack: best(tk, tN, tV) };
      for (const id of tk) { tN[id] = 0; tV[id] = 0; }
      for (const id of ak) { aN[id] = 0; aV[id] = 0; }
      for (const id of lk) { lN[id] = 0; lV[id] = 0; }
      return out;
    }
    return { total, tracks: pack(tk, tN, tV), artists: pack(ak, aN, aV), albums: pack(lk, lN, lV) };
  }

  /* Per-period table rows for one grain (months, quarters or years). */
  function periodRows(data, grain) {
    return cached(data, 'rows|' + grain, () => periodKeys(data, grain).map((k) => {
      const [lo, hi] = range(data, grain, k), [b0, b1] = boundsOf(k, grain);
      const s = tally(data, lo, hi, false);
      return {
        key: k, label: labelOf(k, grain), short: shortLabel(k, grain), v: s.total, n: s.n,
        artists: s.artists, tracks: s.tracks,
        topArtist: s.topArtist >= 0 ? data.artists[s.topArtist] : '',
        topTrack: s.topTrack >= 0 ? data.tTitle[s.topTrack] + ' – ' + data.artists[data.tA[s.topTrack]] : '',
        inProgress: b1 > data.asOfDay, start: b0, end: b1,
      };
    }));
  }

  const DAYPARTS = [
    { name: 'Morning', range: '5am–12pm', hours: [5, 6, 7, 8, 9, 10, 11] },
    { name: 'Afternoon', range: '12–5pm', hours: [12, 13, 14, 15, 16] },
    { name: 'Evening', range: '5–10pm', hours: [17, 18, 19, 20, 21] },
    { name: 'Night', range: '10pm–5am', hours: [22, 23, 0, 1, 2, 3, 4] },
  ];

  /* All statistics for one period. Cached: asking again is free. */
  function analyze(data, grain, key) {
    return cached(data, 'an|' + grain + '|' + key, () => compute(data, grain, key));
  }

  function compute(data, grain, key) {
    const [lo, hi] = range(data, grain, key);
    const { v, day, hour, wd, ts, full } = data;
    const lastDay = data.asOfDay;
    const [b0, b1] = boundsOf(key, grain);
    const t = tally(data, lo, hi, true);
    const total = t.total;

    // genres: each artist's time and plays are shared evenly across its tags
    const nG = data.genreNames.length, gV = new Float64Array(nG + 1), gN = new Float64Array(nG + 1);
    for (let j = 0; j < t.artists.ids.length; j++) {
      const g = data.genres[t.artists.ids[j]], av = t.artists.v[j], an = t.artists.n[j];
      if (!g || !g.length) { gV[nG] += av; gN[nG] += an; continue; }
      for (let q = 0; q < g.length; q++) { gV[g[q]] += av / g.length; gN[g[q]] += an / g.length; }
    }
    const gIds = [];
    for (let q = 0; q <= nG; q++) if (gN[q] > 0) gIds.push(q);
    const genres = { ids: Int32Array.from(gIds), n: Float64Array.from(gIds, (q) => gN[q]), v: Float64Array.from(gIds, (q) => gV[q]) };

    // time of day and weekday
    const sec = new Float64Array(24), hPlays = new Int32Array(24), heat = new Float64Array(168), heatN = new Int32Array(168);
    const wdSec = new Float64Array(7), wdN = new Int32Array(7);
    for (let i = lo; i < hi; i++) {
      const h = hour[i], w = wd[i], x = v[i];
      sec[h] += x; hPlays[h]++; heat[w * 24 + h] += x; heatN[w * 24 + h]++; wdSec[w] += x; wdN[w]++;
    }

    // day by day, every calendar day from the start of the data (or period) to the newest data
    const dStart = Math.max(data.firstDay, b0), dEnd = Math.min(lastDay, b1);
    const len = data.n && dEnd >= dStart ? dEnd - dStart + 1 : 0;
    const dV = new Float64Array(len), dN = new Int32Array(len), dAvg = new Float64Array(len);
    for (let i = lo; i < hi; i++) { const k = day[i] - dStart; if (k >= 0 && k < len) { dV[k] += v[i]; dN[k]++; } }
    // the trend line averages 7 days, or 30 once a period is longer than about six months
    const win = len > 180 ? 30 : 7;
    let run = 0;
    for (let k = 0; k < len; k++) { run += dV[k]; if (k >= win) run -= dV[k - win]; dAvg[k] = run / Math.min(k + 1, win); }
    let active = 0, maxV = 0, maxK = -1;
    for (let k = 0; k < len; k++) { if (dN[k]) active++; if (dV[k] > maxV || maxK < 0) { maxV = dV[k]; maxK = k; } }
    const dArr = Array.from(dV);
    const dayStats = {
      count: len, active, mean: S.mean(dArr), median: S.median(dArr), sd: S.sd(dArr), p90: S.percentile(dArr, 0.9),
      max: len ? maxV : 0, maxDay: len ? dStart + maxK : null,
    };
    dayStats.cv = dayStats.mean > 0 ? dayStats.sd / dayStats.mean : NaN;

    let trend = null;
    if (len >= 14) {
      const xs = new Array(len); for (let k = 0; k < len; k++) xs[k] = k;
      const lr = S.linreg(xs, dArr);
      if (lr) trend = { perWeek: lr.slope * 7, r2: lr.r2, p: lr.p, n: lr.n };
    }
    let weekend = null;
    const wk = [], we = [];
    for (let k = 0; k < len; k++) (weekdayOf(dStart + k) < 5 ? wk : we).push(dV[k]);
    const wl = S.welch(wk, we);
    if (wl) weekend = { weekday: wl.meanA, weekend: wl.meanB, p: wl.p, d: wl.d, nWeekday: wk.length, nWeekend: we.length };

    // variety, by time when any time is known, else by plays
    const useTime = total > 0;
    const weights = Array.from(useTime ? t.artists.v : t.artists.n);
    const ent = S.entropy(weights), wsum = S.sum(weights);
    const sortedW = weights.slice().sort((x, y) => y - x);
    const mix = {
      effectiveArtists: ent.effective, gini: S.gini(weights),
      top5Share: wsum > 0 ? S.sum(sortedW.slice(0, 5)) / wsum : 0,
      topArtistShare: wsum > 0 ? sortedW[0] / wsum : 0,
      replayRate: hi > lo ? 1 - t.tracks.ids.length / (hi - lo) : 0,
    };
    let discovery = null;
    if (b0 > data.firstDay) {
      let fresh = 0;
      for (const a of t.artists.ids) { const f = data.artistFirstDay[a]; if (f >= b0 && f <= b1) fresh++; }
      discovery = { fresh, of: t.artists.ids.length };
    }

    // sessions: runs of listening with no break longer than SESSION_GAP
    let sCount = 0, sTotal = 0, sTracks = 0, longest = null, curStart = 0, curEnd = 0, curN = 0;
    const durs = [];
    for (let i = lo; i < hi; i++) {
      const x = v[i], l = x > 0 ? x : (full[i] ? 0 : data.fallbackLen);
      if (curN && ts[i] - curEnd <= SESSION_GAP) { curEnd = Math.max(curEnd, ts[i] + l); curN++; }
      else {
        if (curN) { const dur = curEnd - curStart; durs.push(dur); sTotal += dur; sTracks += curN; sCount++; if (!longest || dur > longest.dur) longest = { start: curStart, dur, n: curN }; }
        curStart = ts[i]; curEnd = ts[i] + l; curN = 1;
      }
    }
    if (curN) { const dur = curEnd - curStart; durs.push(dur); sTotal += dur; sTracks += curN; sCount++; if (!longest || dur > longest.dur) longest = { start: curStart, dur, n: curN }; }
    const sessions = sCount ? { count: sCount, mean: sTotal / sCount, median: S.median(durs), longest, tracksMean: sTracks / sCount } : null;

    const activeDays = [];
    for (let i = lo; i < hi; i++) if (!activeDays.length || activeDays[activeDays.length - 1] !== day[i]) activeDays.push(day[i]);
    const streak = S.streaks(activeDays, Math.min(lastDay, b1));

    let peak = 0;
    for (let h = 1; h < 24; h++) if (sec[h] > sec[peak]) peak = h;
    const dayparts = DAYPARTS.map((dp) => {
      let s = 0; for (const h of dp.hours) s += sec[h];
      return { name: dp.name, range: dp.range, v: s, share: total > 0 ? s / total : 0 };
    });
    let unknownPlays = 0;
    for (let i = lo; i < hi; i++) if (!full[i]) unknownPlays++;

    const lists = { tracks: t.tracks, artists: t.artists, albums: t.albums, genres };
    const sorts = {};
    return {
      grain, key, label: labelOf(key, grain), lo, hi, n: hi - lo, total, unknownPlays,
      uniq: { tracks: t.tracks.ids.length, artists: t.artists.ids.length, albums: t.albums.ids.length },
      hr: { sec, plays: hPlays, heat, heatN, wd: wdSec, wdN },
      daily: { start: dStart, v: dV, n: dN, avg: dAvg, avgDays: win, length: len },
      day: dayStats, trend, weekend, mix, discovery, sessions, streak,
      periodOver: grain !== 'all' && b1 < lastDay,
      peakHour: total > 0 ? peak : null, dayparts, lastDay,
      count(kind) { return lists[kind].ids.length; },
      /* positions in lists[kind], best first; rank 'time' or 'plays'. Sorted once per kind and rank. */
      order(kind, rank) {
        const k = kind + rank;
        if (sorts[k]) return sorts[k];
        const L = lists[kind], idx = Array.from(L.ids, (_, j) => j);
        // ties go alphabetically, then by id, so the order never changes between taps
        const byName = (x, y) => { const a = itemName(data, kind, L.ids[x]), b = itemName(data, kind, L.ids[y]); return a < b ? -1 : a > b ? 1 : L.ids[x] - L.ids[y]; };
        idx.sort(rank === 'plays'
          ? (x, y) => L.n[y] - L.n[x] || L.v[y] - L.v[x] || byName(x, y)
          : (x, y) => L.v[y] - L.v[x] || L.n[y] - L.n[x] || byName(x, y));
        return (sorts[k] = Int32Array.from(idx));
      },
      item(kind, j) {
        const L = lists[kind], id = L.ids[j];
        return { id, name: itemName(data, kind, id), sub: itemSub(data, kind, id), v: L.v[j], n: L.n[j], untagged: kind === 'genres' && id === data.genreNames.length };
      },
    };
  }

  function itemName(data, kind, id) {
    if (kind === 'tracks') return data.tTitle[id];
    if (kind === 'artists') return data.artists[id];
    if (kind === 'albums') return data.albums[id];
    return id === data.genreNames.length ? 'No genre tag' : data.genreNames[id];
  }
  function itemSub(data, kind, id) {
    if (kind === 'tracks') return data.artists[data.tA[id]];
    if (kind === 'albums') return data.artists[data.albumArtist[id]] || '';
    return '';
  }

  /* Songs with no known length, most played first (for the About section). */
  function missingLengths(data, limit) {
    return cached(data, 'missing', () => {
      const cnt = new Map();
      for (let i = 0; i < data.n; i++) if (!data.full[i]) cnt.set(data.tr[i], (cnt.get(data.tr[i]) || 0) + 1);
      return Array.from(cnt.entries()).sort((a, b) => b[1] - a[1]).slice(0, limit || 25)
        .map(([t, c]) => ({ title: data.tTitle[t], artist: data.artists[data.tA[t]], plays: c }));
    });
  }

  // ---------------------------------------------------------------- formatting
  function fmtHMS(sec) {
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h > 0) return h + 'h ' + pad(m) + 'm ' + pad(s) + 's';
    if (m > 0) return m + 'm ' + pad(s) + 's';
    return s + 's';
  }
  function fmtHM(sec) {
    sec = Math.round(sec / 60) * 60;
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    return h > 0 ? h + 'h ' + pad(m) + 'm' : m + 'm';
  }
  function fmtHour(h) { return (h % 12 === 0 ? 12 : h % 12) + (h < 12 ? ' AM' : ' PM'); }
  function fmtP(p) { return !isFinite(p) ? 'n/a' : p < 0.001 ? 'p < 0.001' : 'p = ' + p.toFixed(3); }

  const api = {
    MONTHS, WEEKDAYS, DAYPARTS, SESSION_GAP, prepare, setMode, labelOf, shortLabel, boundsOf, periodKeys, range,
    periodRows, analyze, missingLengths, dayParts, dayLabel, dayNumber, weekdayOf, lowerBound,
    fmtHMS, fmtHM, fmtHour, fmtP,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Engine = api;
})(typeof self !== 'undefined' ? self : this);
