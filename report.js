/* Listening reports: a PDF (through the phone's print window), an image card, and a CSV of every play.
 * Loaded only when a save button is first tapped. Works from the numbers the page already has. */
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) if (attrs[k] != null && attrs[k] !== false) el.setAttribute(k, attrs[k]);
    for (let i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, k) {
    if (k == null || k === false) return;
    if (Array.isArray(k)) { k.forEach((x) => add(el, x)); return; }
    el.appendChild(k.nodeType ? k : document.createTextNode(String(k)));
  }
  function sv(tag, attrs) {
    const el = document.createElementNS(NS, tag);
    for (const k of Object.keys(attrs || {})) el.setAttribute(k, attrs[k]);
    for (let i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  const num = (n) => Math.round(n).toLocaleString();
  const pct = (x) => Math.round(x * 100) + '%';
  const days = (n) => num(n) + (n === 1 ? ' day' : ' days');

  function save(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
  }
  const fileName = (kind, key, ext) => 'listening-' + kind + '-' + String(key).replace(/[^\w-]+/g, '') + '.' + ext;

  function topItems(view, kind, rank, k) {
    const order = view.order(kind, rank), out = [];
    for (let j = 0; j < order.length && out.length < k; j++) { const it = view.item(kind, order[j]); if (!it.untagged) out.push(it); }
    return out;
  }

  /* Rows for the "over time" part of a report: months, or days for a single month. */
  function breakdown(ctx) {
    const { data, view, state, E } = ctx;
    if (state.grain === 'month') {
      const d = view.daily, rows = [];
      for (let k = 0; k < d.length; k++) rows.push({ label: E.dayLabel(d.start + k).replace(/, \d{4}$/, ''), short: String(E.dayParts(d.start + k).d), v: d.v[k], n: d.n[k] });
      return { title: 'Day by day', rows };
    }
    const [b0, b1] = state.grain === 'all' ? [-Infinity, Infinity] : E.boundsOf(state.key, state.grain);
    const rows = E.periodRows(data, 'month').filter((r) => r.start >= b0 && r.end <= b1)
      .map((r) => ({ label: r.label + (r.inProgress ? ' (so far)' : ''), short: r.short, v: r.v, n: r.n, top: r.topArtist }));
    return { title: 'Month by month', rows };
  }

  function barChart(rows, w, hgt, labelEvery) {
    const max = rows.reduce((m, r) => Math.max(m, r.v), 0) || 1, n = rows.length, L = 4, B = 16, slot = (w - L) / Math.max(n, 1);
    const svg = sv('svg', { viewBox: '0 0 ' + w + ' ' + hgt, width: '100%', class: 'pr-chart', role: 'img', 'aria-label': 'Time listened' });
    svg.appendChild(sv('line', { x1: L, x2: w, y1: hgt - B, y2: hgt - B, stroke: '#999', 'stroke-width': 0.6 }));
    rows.forEach((r, i) => {
      const bh = (r.v / max) * (hgt - B - 6), x = L + i * slot + slot * 0.15;
      if (bh > 0) svg.appendChild(sv('rect', { x: x.toFixed(1), y: (hgt - B - bh).toFixed(1), width: Math.max(0.8, slot * 0.7).toFixed(1), height: bh.toFixed(1), fill: '#333' }));
      if (i % labelEvery === 0) svg.appendChild(sv('text', { x: (x + slot * 0.35).toFixed(1), y: hgt - 4, 'text-anchor': 'middle', 'font-size': 7.5, fill: '#555' }, r.short));
    });
    return svg;
  }

  // columns before `left` are left-aligned text; the rest are right-aligned numbers
  function table(head, rows, cls, left) {
    left = left || 1;
    return h('table', { class: 'pr-table ' + (cls || '') },
      h('thead', null, h('tr', null, head.map((t, i) => h('th', { class: i >= left ? 'r' : '' }, t)))),
      h('tbody', null, rows.map((r) => h('tr', null, r.map((c, i) => h('td', { class: i >= left ? 'r' : '' }, c))))));
  }
  // long tables go in two columns side by side
  function splitTable(head, rows) {
    if (rows.length <= 12) return table(head, rows);
    const half = Math.ceil(rows.length / 2);
    return h('div', { class: 'pr-grid' }, table(head, rows.slice(0, half)), table(head, rows.slice(half)));
  }

  // ------------------------------------------------------------------ PDF
  function pdf(ctx) {
    const { data, view: a, state, E } = ctx;
    const fmt = E.fmtHMS, rank = a.total > 0 ? 'time' : 'plays';
    const old = document.getElementById('print-report');
    if (old) old.remove();
    const made = new Date().toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
    const bd = breakdown(ctx);
    const list = (title, kind, col, withSub) => {
      const items = topItems(a, kind, rank, 10);
      if (!items.length) return null;
      return h('div', { class: 'pr-block' }, h('h3', null, title),
        table(['#', col, 'Time', 'Plays'],
          items.map((it, i) => [String(i + 1), withSub && it.sub ? it.name + ' – ' + it.sub : it.name, fmt(it.v), num(it.n)]), 'pr-top', 2));
    };
    const facts = [
      ['Average day', fmt(a.day.mean)], ['Typical day (median)', fmt(a.day.median)],
      ['Biggest day', fmt(a.day.max) + (a.day.maxDay != null ? ' (' + E.dayLabel(a.day.maxDay) + ')' : '')],
      ['Days with music', num(a.day.active) + ' of ' + num(a.day.count)],
      ['Longest streak', days(a.streak.longest)],
      a.sessions ? ['Sessions', num(a.sessions.count) + ', typically ' + fmt(a.sessions.median)] : null,
      a.peakHour != null ? ['Busiest hour', E.fmtHour(a.peakHour)] : null,
      a.weekend ? ['Weekday and weekend average', E.fmtHM(a.weekend.weekday) + ' and ' + E.fmtHM(a.weekend.weekend)] : null,
      ['Effective number of artists', a.mix.effectiveArtists.toFixed(1) + ' of ' + num(a.uniq.artists)],
      ['Top artist share', pct(a.mix.topArtistShare)], ['Replay rate', pct(a.mix.replayRate)],
    ].filter(Boolean);
    const hours = Array.from(a.hr.sec, (v, i) => ({ v, short: i % 6 === 0 ? E.fmtHour(i).replace(' ', '') : '' }));
    const label = state.grain === 'all' ? 'All time' : ctx.label;
    const doc = h('div', { id: 'print-report' },
      h('header', { class: 'pr-head' },
        h('p', { class: 'pr-kicker' }, (data.user || 'My') + ' listening report'),
        h('h1', null, label),
        h('p', { class: 'pr-total' }, fmt(a.total), h('span', null, ' listened')),
        h('p', { class: 'pr-sub' }, num(a.n) + ' plays of ' + num(a.uniq.tracks) + ' songs by ' + num(a.uniq.artists) + ' artists, from ' + num(a.uniq.albums) + ' albums.')),
      h('div', { class: 'pr-block pr-flow' }, h('div', { class: 'pr-keep' }, h('h3', null, bd.title),
        bd.rows.length > 1 ? barChart(bd.rows, 520, 110, Math.max(1, Math.ceil(bd.rows.length / 14))) : null),
        splitTable([bd.title === 'Day by day' ? 'Day' : 'Month', 'Time', 'Plays'], bd.rows.filter((r) => r.n > 0 || bd.title !== 'Day by day').map((r) => [r.label, fmt(r.v), num(r.n)]))),
      h('div', { class: 'pr-grid' }, list('Top songs', 'tracks', 'Song and artist', true), list('Top artists', 'artists', 'Artist'),
        list('Top albums', 'albums', 'Album and artist', true), list('Top genres', 'genres', 'Genre')),
      h('div', { class: 'pr-block' }, h('h3', null, 'When you listen'), barChart(hours, 520, 90, 1),
        h('p', { class: 'pr-sub' }, a.dayparts.map((p) => p.name + ' ' + pct(p.share)).join(', ') + '.')),
      h('div', { class: 'pr-block' }, h('h3', null, 'Statistics'), table(['', ''], facts, 'pr-facts')),
      h('footer', { class: 'pr-foot' },
        'Made ' + made + '. Time is ' + (state.mode === 'full' ? 'counted as the full length of each song' : 'the estimated time heard (exact for Spotify plays)') +
        '. Plays come from Last.fm' + (data.nSpotify ? ' and Spotify' : '') + '. Dates and hours use the time zone of the device that made this report.'));
    document.body.appendChild(doc);
    const original = window.__ldTitle || (window.__ldTitle = document.title);
    document.title = 'Listening report ' + label; // the print window offers this as the PDF's file name
    const restore = () => { document.title = original; window.removeEventListener('pointerdown', restore); };
    window.addEventListener('pointerdown', restore);
    if (typeof window.print === 'function') window.print();
    return 'In the print window, choose Save as PDF, then Download.';
  }

  // ------------------------------------------------------------------ image card
  const CARD = {
    hifi: { bg: '#24211d', ink: '#efe6d6', sub: '#c4b9a5', accent: '#ffb03b', panel: '#110e0a', pInk: '#efe6d6', pSub: '#c4b9a5', pAccent: '#ffb03b', panel2: '#110e0a',
      big: '"Share Tech Mono", monospace', text: '"Barlow Semi Condensed", system-ui, sans-serif', glow: 'rgba(255,176,59,0.55)', bigWeight: 400, textWeight: 600 },
    wrapped: { bg: '#2a1a6e', ink: '#fbf9ff', sub: '#dcd5ff', accent: '#ff8a3d', panel: '#ffd84d', pInk: '#1d1240', pSub: '#33265f', pAccent: '#1d1240', panel2: '#ff7a6b',
      big: '"Bricolage Grotesque", system-ui, sans-serif', text: '"Bricolage Grotesque", system-ui, sans-serif', glow: null, bigWeight: 800, textWeight: 800 },
    swiss: { bg: '#ffffff', ink: '#000000', sub: '#3b3b3b', accent: '#e2231a', panel: '#ffffff', pInk: '#000000', pSub: '#3b3b3b', pAccent: '#000000', panel2: '#ffffff',
      big: '"Inter", system-ui, sans-serif', text: '"Inter", system-ui, sans-serif', glow: null, bigWeight: 800, textWeight: 800, rules: true },
  };

  async function image(ctx) {
    const { data, view: a, state, E } = ctx;
    const look = CARD[state.design] || CARD.hifi;
    const fams = [look.big, look.text].map((f) => f.split(',')[0]);
    try { await Promise.all([document.fonts.load(look.bigWeight + ' 100px ' + fams[0]), document.fonts.load(look.textWeight + ' 40px ' + fams[1]), document.fonts.load('400 40px ' + fams[1])]); } catch (e) { /* system font instead */ }
    const W = 1080, H = 1920, M = 84, c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const font = (w, px, fam) => { g.font = w + ' ' + px + 'px ' + fam; };
    const fit = (text, max) => { if (g.measureText(text).width <= max) return text; let t = text; while (t.length > 1 && g.measureText(t + '…').width > max) t = t.slice(0, -1); return t + '…'; };
    const rect = (x, y, w, hh, r, col) => { g.fillStyle = col; g.beginPath(); g.roundRect ? g.roundRect(x, y, w, hh, r) : g.rect(x, y, w, hh); g.fill(); };
    g.fillStyle = look.bg; g.fillRect(0, 0, W, H);
    g.textBaseline = 'alphabetic';

    // heading
    const label = state.grain === 'all' ? 'All time' : ctx.label;
    g.fillStyle = look.sub; font(look.textWeight === 800 ? 600 : 400, 38, look.text);
    g.fillText(fit((data.user || 'My') + ' listening report', W - 2 * M), M, 150);
    g.fillStyle = look.ink; font(look.textWeight, 92, look.text);
    g.fillText(fit(label, W - 2 * M), M, 255);
    if (look.rules) { g.fillStyle = '#000'; g.fillRect(M, 290, W - 2 * M, 12); }

    // total time (layout: heading to 300, total to 600, two lists of five, a row of facts)
    const tot = Math.round(a.total), hrs = Math.floor(tot / 3600), mins = Math.floor((tot % 3600) / 60);
    const parts = hrs > 0 ? [[String(hrs), 'h'], [String(mins).padStart(2, '0'), 'm']] : [[String(mins), 'm'], [String(tot % 60).padStart(2, '0'), 's']];
    let size = 190;
    const measure = () => { let w = 0; parts.forEach(([n, u]) => { font(look.bigWeight, size, look.big); w += g.measureText(n).width; font(500, size * 0.38, look.text); w += g.measureText(u).width + size * 0.12; }); return w; };
    while (measure() > W - 2 * M - 40 && size > 80) size -= 8;
    let x = M;
    const base = 310 + 190;
    if (state.design === 'hifi') rect(M - 20, base - size - 14, W - 2 * M + 40, size + 50, 18, look.panel);
    parts.forEach(([n, u]) => {
      font(look.bigWeight, size, look.big);
      g.fillStyle = state.design === 'hifi' ? look.accent : look.ink;
      if (look.glow) { g.shadowColor = look.glow; g.shadowBlur = 24; }
      g.fillText(n, x, base); x += g.measureText(n).width; g.shadowBlur = 0;
      font(500, size * 0.38, look.text); g.fillStyle = state.design === 'swiss' ? look.accent : look.sub;
      g.fillText(u, x + 6, base); x += g.measureText(u).width + size * 0.12;
    });
    g.fillStyle = look.sub; font(400, 38, look.text);
    g.fillText(fit('listened, ' + num(a.n) + ' plays, ' + num(a.uniq.tracks) + ' songs, ' + num(a.uniq.artists) + ' artists', W - 2 * M), M, base + 76);

    // two lists of five
    const rank = a.total > 0 ? 'time' : 'plays', STEP = 84, PANEL = 70 + 5 * STEP + 34;
    const drawList = (title, items, panelTop, panel, sub) => {
      if (panel !== look.bg) rect(M - 24, panelTop, W - 2 * M + 48, PANEL, 28, panel);
      if (look.rules) { g.fillStyle = '#000'; g.fillRect(M, panelTop, W - 2 * M, 6); }
      const top = panelTop + 64, onPanel = state.design === 'wrapped';
      g.fillStyle = onPanel ? look.pInk : look.sub; font(look.textWeight === 800 ? 700 : 600, 38, look.text);
      g.fillText(title, M, top);
      const key = rank === 'time' ? 'v' : 'n', maxV = items.length ? (items[0][key] || 1) : 1;
      items.forEach((it, i) => {
        const y = top + 70 + i * STEP;
        g.fillStyle = onPanel ? look.pInk : (state.design === 'swiss' && i > 0 ? look.ink : look.accent);
        font(look.bigWeight, 50, look.big); g.fillText(String(i + 1), M, y);
        const right = rank === 'time' ? E.fmtHM(it.v) : num(it.n) + ' plays';
        font(500, 32, look.text); const rw = g.measureText(right).width;
        g.fillStyle = onPanel ? look.pSub : look.sub; g.fillText(right, W - M - rw, y);
        g.fillStyle = onPanel ? look.pInk : look.ink; font(look.textWeight === 800 ? 700 : 600, 42, look.text);
        g.fillText(fit(it.name, W - 2 * M - 90 - rw - 24), M + 90, y);
        if (sub && it.sub) { g.fillStyle = onPanel ? look.pSub : look.sub; font(400, 29, look.text); g.fillText(fit(it.sub, W - 2 * M - 90), M + 90, y + 36); }
        else rect(M + 90, y + 18, Math.max(8, (W - 2 * M - 90) * (it[key] / maxV)), 9, 4.5, onPanel ? look.pInk : look.accent);
      });
    };
    drawList('Top artists', topItems(a, 'artists', rank, 5), 620, look.panel, false);
    drawList('Top songs', topItems(a, 'tracks', rank, 5), 620 + PANEL + 36, look.panel2, true);

    // a row of three facts
    const genre = topItems(a, 'genres', rank, 1)[0];
    const facts = [['Top genre', genre ? genre.name : 'None yet'], ['Busiest hour', a.peakHour != null ? E.fmtHour(a.peakHour) : 'None yet'], ['Longest streak', days(a.streak.longest)]];
    const colW = (W - 2 * M) / 3, fy = 620 + 2 * PANEL + 36 + 76;
    facts.forEach(([k, v], i) => {
      g.fillStyle = look.sub; font(400, 28, look.text); g.fillText(k, M + i * colW, fy);
      g.fillStyle = look.ink; font(look.textWeight === 800 ? 700 : 600, 38, look.text); g.fillText(fit(v, colW - 20), M + i * colW, fy + 46);
    });
    g.fillStyle = look.sub; font(400, 26, look.text);
    g.fillText('Made ' + new Date().toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }), M, H - 48);

    const blob = await new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('The image could not be made.'))), 'image/png'));
    const name = fileName('card', ctx.fileKey, 'png');
    save(blob, name);
    return 'Saved ' + name + ' to your downloads.';
  }

  // ------------------------------------------------------------------ CSV of every play
  function cell(v) {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // so a spreadsheet never treats a song name as a formula
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function csv(ctx) {
    const { data, view: a, E } = ctx;
    const two = (n) => (n < 10 ? '0' : '') + n;
    const lines = ['Date,Time,Weekday,Artist,Song,Album,Seconds heard,Song length (seconds),Source,How time was counted'];
    for (let i = a.lo; i < a.hi; i++) {
      const t = data.tr[i], d = new Date(data.ts[i] * 1000), sp = data.heard && data.heard[i] > 0;
      const len = data.tDur[t];
      lines.push([
        d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()), two(d.getHours()) + ':' + two(d.getMinutes()),
        E.WEEKDAYS[(d.getDay() + 6) % 7], data.artists[data.tA[t]], data.tTitle[t], data.albums[data.tAl[t]],
        Math.round(data.est[i]), len || '', sp ? 'Spotify' : 'Last.fm',
        sp ? 'Exact, from Spotify' : (len ? 'Estimate' : 'No song length known'),
      ].map(cell).join(','));
    }
    const blob = new Blob(['﻿' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
    const name = fileName('plays', ctx.fileKey, 'csv');
    save(blob, name);
    return 'Saved ' + name + ' (' + num(a.hi - a.lo) + ' plays) to your downloads.';
  }

  window.LDReport = { pdf, image, csv };
})();
