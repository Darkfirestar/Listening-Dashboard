/* Listening dashboard UI. Draws everything from data/listening.json using engine.js.
 *
 * Kept light on the phone:
 * - no timers, polling or animation; nothing runs unless you tap, scroll or resize
 * - a tap rebuilds only the section it changes, and results are cached by the engine
 * - each chart has one set of listeners (event delegation), not one per bar or cell
 * - long tables are only built when you open them
 * - the data file is cached by the browser and re-checked cheaply, and still works offline */
(function () {
  'use strict';
  const E = window.Engine;
  const NS = 'http://www.w3.org/2000/svg';
  const pad = (n) => (n < 10 ? '0' + n : '' + n);

  // ------------------------------------------------------------------ DOM helpers
  function build(el, attrs, kids) {
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (k.slice(0, 5) === 'aria-' && typeof v === 'boolean') { el.setAttribute(k, String(v)); continue; }
        if (v == null || v === false) continue;
        if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    append(el, kids);
    return el;
  }
  function append(el, kids) {
    for (const k of kids) {
      if (k == null || k === false) continue;
      if (Array.isArray(k)) append(el, k);
      else el.appendChild(k.nodeType ? k : document.createTextNode(String(k)));
    }
  }
  function h(tag, attrs) { return build(document.createElement(tag), attrs, Array.prototype.slice.call(arguments, 2)); }
  function sv(tag, attrs) { return build(document.createElementNS(NS, tag), attrs, Array.prototype.slice.call(arguments, 2)); }

  // ------------------------------------------------------------------ state
  const state = { grain: 'all', key: 'all', mode: 'est', tab: 'tracks', rank: 'time', limit: 10, trendGrain: 'month', allPeriods: false, design: 'hifi' };
  const LOOKS = [['hifi', 'Hi-fi'], ['wrapped', 'Wrapped'], ['swiss', 'Swiss']];
  let data = null, offline = false, view = null;
  const TZ = (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'this device'; } catch (e) { return 'this device'; } })();
  const app = document.getElementById('app');
  const tip = document.getElementById('tip');

  function store(k, d) { try { return localStorage.getItem('ld.' + k) || d; } catch (e) { return d; } }
  function keep(k, v) { try { localStorage.setItem('ld.' + k, v); } catch (e) { /* private mode: fine */ } }
  const fmt = E.fmtHMS;
  const num = (n) => Math.round(n).toLocaleString();
  const pct = (x, d) => (x * 100).toFixed(d == null ? 0 : d) + '%';
  const plays = (n) => num(n) + (Math.round(n) === 1 ? ' play' : ' plays');
  function chartWidth() { return Math.min(760, document.documentElement.clientWidth || 390) - 32; }

  // ------------------------------------------------------------------ looks
  // All three looks live in style.css; switching only flips an attribute, so nothing is redrawn.
  function applyLook() {
    document.documentElement.setAttribute('data-design', state.design);
    const bg = getComputedStyle(document.body).backgroundColor; // match the phone's status bar to the page
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', bg);
  }
  function setLook(d) {
    state.design = d; keep('design', d);
    applyLook();
    replace('bar', topBar());
  }

  // ------------------------------------------------------------------ tooltip (one element, shown on demand)
  let tipOn = false;
  function showTip(x, y, title, rows) {
    tip.textContent = '';
    if (title) tip.appendChild(h('div', { class: 't' }, title));
    for (const r of rows) tip.appendChild(h('div', { class: 'r' }, h('strong', null, r[0]), h('span', null, r[1])));
    tip.hidden = false; tipOn = true;
    const b = tip.getBoundingClientRect();
    let left = x + 14, top = y - b.height - 12;
    if (left + b.width > window.innerWidth - 8) left = x - b.width - 14;
    if (left < 8) left = 8;
    if (top < 8) top = y + 18;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }
  function hideTip() { if (tipOn) { tip.hidden = true; tipOn = false; } }

  /* One set of listeners per chart. Marks carry data-i; info(i) gives the tooltip,
     activate(i), if given, runs on tap, Enter or Space. */
  function delegate(svg, info, activate) {
    svg.setAttribute('data-tipzone', '');
    const markOf = (e) => (e.target.closest ? e.target.closest('[data-i]') : null);
    const show = (e) => { const m = markOf(e); if (!m) return hideTip(); const d = info(+m.getAttribute('data-i')); showTip(e.clientX, e.clientY, d.title, d.rows); };
    svg.addEventListener('pointermove', show);
    svg.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hideTip(); });
    svg.addEventListener('focusin', (e) => { const m = markOf(e); if (!m) return; const b = m.getBoundingClientRect(), d = info(+m.getAttribute('data-i')); showTip(b.left + b.width / 2, b.top, d.title, d.rows); });
    svg.addEventListener('focusout', hideTip);
    if (activate) {
      svg.addEventListener('click', (e) => { const m = markOf(e); if (m) activate(+m.getAttribute('data-i')); });
      svg.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const m = markOf(e); if (!m) return; e.preventDefault(); activate(+m.getAttribute('data-i'));
      });
    }
  }

  // ------------------------------------------------------------------ chart helpers
  function niceScale(max, n) {
    if (!(max > 0)) return { max: 1, step: 0.25 };
    const raw = max / n, mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
    const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
    return { max: step * Math.ceil(max / step - 1e-9), step };
  }
  function fmtTick(v) {
    if (v >= 1000) return (v / 1000).toFixed(v % 1000 ? 1 : 0).replace(/\.0$/, '') + 'K';
    return Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, '');
  }
  function fmtUnit(sec, unit) { return unit === 3600 ? (sec / 3600).toFixed(1) + 'h' : Math.round(sec / 60) + 'm'; }
  function roundTop(x, y, w, hgt, r) {
    r = Math.min(r, w / 2, hgt);
    const y0 = y + hgt;
    return 'M' + x + ',' + y0 + 'V' + (y + r) + 'Q' + x + ',' + y + ' ' + (x + r) + ',' + y + 'H' + (x + w - r) + 'Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + r) + 'V' + y0 + 'Z';
  }
  function yAxis(g, L, W, T, ih, sc, unitName, noLabels) {
    const ticks = Math.round(sc.max / sc.step);
    for (let i = 0; i <= ticks; i++) {
      const v = i * sc.step, y = T + ih - (v / sc.max) * ih;
      if (W > L) g.appendChild(sv('line', { class: i === 0 ? 'axis-line' : 'grid-line', x1: L, x2: W, y1: y, y2: y }));
      if (!noLabels) g.appendChild(sv('text', { x: L - 6, y: y + 4, 'text-anchor': 'end' }, fmtTick(v)));
    }
    if (!noLabels) g.appendChild(sv('text', { x: 0, y: 9, class: 'strong' }, unitName));
  }
  /* A table that is only built the first time it is opened. */
  function lazyDetails(summary, make) {
    let built = false;
    const d = h('details', null, h('summary', null, summary));
    d.addEventListener('toggle', () => { if (d.open && !built) { built = true; append(d, [make()]); } });
    return d;
  }
  function table(headers, rows) {
    return h('table', { class: 'tbl plain' },
      h('thead', null, h('tr', null, headers.map((t, i) => h('th', { class: i ? 'r' : '' }, t)))),
      h('tbody', null, rows.map((r) => h('tr', null, r.map((c, i) => h('td', { class: (i ? 'r ' : '') + 'num' }, h('span', null, c)))))));
  }

  // ------------------------------------------------------------------ rendering in parts
  const SECTIONS = ['hero', 'glance', 'save', 'over-time', 'daily', 'when', 'top', 'stats', 'about'];
  function builderFor(id) {
    return { hero: hero, glance: glance, save: saveSection, 'over-time': overTime, daily: dailySection, when: whenSection, top: topSection, stats: statsSection, about: aboutSection }[id];
  }
  function rowsFor(grain) { return E.periodRows(data, grain); }

  /* Swap one part of the page in place, keeping scroll position and keyboard focus. */
  function replace(id, el) {
    const old = document.getElementById(id);
    if (!old || !el) return;
    const fid = document.activeElement && old.contains(document.activeElement) ? document.activeElement.getAttribute('data-fid') : null;
    el.id = id;
    hideTip();
    old.replaceWith(el);
    if (fid) { const f = el.querySelector('[data-fid="' + CSS.escape(fid) + '"]'); if (f) f.focus({ preventScroll: true }); }
  }
  function renderPart(id) {
    view = E.analyze(data, state.grain, state.key);
    replace(id, builderFor(id)(view));
  }
  function renderAll() {
    const fid = document.activeElement && document.activeElement.getAttribute ? document.activeElement.getAttribute('data-fid') : null;
    const y = window.scrollY;
    hideTip();
    view = E.analyze(data, state.grain, state.key);
    const main = h('main');
    const parts = view.n === 0 ? ['hero', 'over-time'] : SECTIONS;
    for (const id of parts) {
      const el = builderFor(id)(view);
      if (!el) continue;
      el.id = id;
      main.appendChild(el);
    }
    if (view.n === 0) main.insertBefore(h('p', { class: 'empty' }, 'There is no listening in this period. Pick another period above.'), main.children[1] || null);
    const top = topBar(); top.id = 'bar';
    app.textContent = '';
    append(app, [top, banner(), filters(), main]);
    if (fid) { const f = app.querySelector('[data-fid="' + CSS.escape(fid) + '"]'); if (f) f.focus({ preventScroll: true }); }
    window.scrollTo(0, y);
  }

  // ------------------------------------------------------------------ scope
  function setScope(grain, key) {
    state.grain = grain;
    if (grain === 'all') state.key = 'all';
    else {
      const keys = E.periodKeys(data, grain);
      state.key = keys.indexOf(key) >= 0 ? key : keys[keys.length - 1];
      state.trendGrain = grain;
    }
    state.limit = 10;
    renderAll();
  }

  function topBar() {
    const looks = h('div', { class: 'seg small looks', role: 'group', 'aria-label': 'Look' },
      LOOKS.map((l) => h('button', { type: 'button', 'data-fid': 'look-' + l[0], 'aria-pressed': state.design === l[0], onclick: () => setLook(l[0]) }, l[1])));
    return h('header', { class: 'bar', id: 'bar' },
      h('h1', null, data.user || 'Listening', h('span', null, ' listening stats')), looks);
  }

  function whenText(iso) {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function banner() {
    const notes = [];
    if (window.LD_DEMO) notes.push(h('div', { class: 'banner' }, 'You are looking at sample data, not real listening. ', h('a', { href: './' }, 'Back to my data')));
    if (offline) notes.push(h('div', { class: 'banner' }, 'No connection. Showing the copy saved on this phone' + (data.generated ? ' from ' + whenText(data.generated) : '') + '.'));
    if (data.status && data.status.ok === false) {
      notes.push(h('div', { class: 'banner warn', role: 'status' },
        h('strong', null, 'The last update did not finish' + (data.generated ? ' (' + whenText(data.generated) + ')' : '') + '. '),
        data.status.message || '', ' Your saved history is shown and the next update will try again.'));
    }
    for (const note of (data.status && data.status.notes) || []) notes.push(h('div', { class: 'banner warn', role: 'status' }, note));
    return notes.length ? h('div', { class: 'banners' }, notes) : null;
  }

  function filters() {
    const grains = [['all', 'All time'], ['year', 'Year'], ['quarter', 'Quarter'], ['month', 'Month']];
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Time range' },
      grains.map((g) => h('button', { type: 'button', 'data-fid': 'g-' + g[0], 'aria-pressed': state.grain === g[0], onclick: () => setScope(g[0], state.key) }, g[1])));
    let sel = null;
    if (state.grain !== 'all') {
      const keys = E.periodKeys(data, state.grain).slice().reverse();
      sel = h('select', {
        class: 'period', 'aria-label': 'Choose a period', 'data-fid': 'period',
        onchange: (e) => { state.key = e.target.value; state.limit = 10; renderAll(); },
      }, keys.map((k) => h('option', { value: k, selected: k === state.key }, E.labelOf(k, state.grain))));
    }
    return h('div', { class: 'filters' }, seg, sel);
  }

  // ------------------------------------------------------------------ hero
  function hero(a) {
    const total = Math.round(a.total);
    const H = Math.floor(total / 3600), M = Math.floor((total % 3600) / 60), S = total % 60;
    const small = (t) => h('small', null, t);
    const parts = H > 0 ? [String(H), small('h'), pad(M), small('m'), pad(S), small('s')]
      : M > 0 ? [String(M), small('m'), pad(S), small('s')] : [String(S), small('s')];
    const notes = [];
    if (state.grain !== 'all') {
      const rows = rowsFor(state.grain);
      const i = rows.findIndex((r) => r.key === state.key);
      const cur = rows[i], prev = rows[i - 1];
      if (cur && cur.start < data.firstDay) notes.push('Your data starts on ' + E.dayLabel(data.firstDay) + ', so this period is only partly covered.');
      if (prev && prev.start < data.firstDay) {
        notes.push(prev.label + ' is only partly covered by your data, so there is no fair comparison with it.');
        if (cur.inProgress) notes.push('This period is still in progress.');
      } else if (prev && prev.v > 0) {
        if (cur.inProgress) notes.push('So far this is ' + pct(a.total / prev.v) + ' of ' + prev.label + ', and the period is still in progress.');
        else {
          const d = a.total / prev.v - 1;
          notes.push((d >= 0 ? 'Up ' : 'Down ') + Math.abs(d * 100).toFixed(0) + '% on ' + prev.label + '.');
        }
      } else if (cur && cur.inProgress) notes.push('This period is still in progress.');
    }
    if (total >= 86400) notes.push('That is ' + (total / 86400).toFixed(1) + ' days of nonstop music.');
    if (a.unknownPlays > 0) notes.push(num(a.unknownPlays) + ' plays have no known track length, so they are left out of this time.');
    const items = [
      [num(a.n), 'Plays'], [num(a.uniq.tracks), 'Songs'], [num(a.uniq.artists), 'Artists'],
      [num(a.uniq.albums), 'Albums'], [E.fmtHM(a.day.mean || 0), 'Per day'], [num(a.day.active), 'of ' + num(a.day.count) + ' days'],
    ];
    return h('section', { class: 'hero' },
      h('p', { class: 'what' }, state.grain === 'all' ? 'Time listened, all time' : 'Time listened in ' + a.label),
      h('div', { class: 'hero-num', 'aria-label': fmt(total) }, parts),
      notes.map((n) => h('p', { class: 'note' }, n)),
      h('div', { class: 'kpis' }, items.map((k) => h('div', { class: 'kpi' }, h('div', { class: 'v' }, k[0]), h('div', { class: 'l' }, k[1])))));
  }

  function glance(a) {
    const rank = a.total > 0 ? 'time' : 'plays', rows = [];
    const add = (label, kind, sub) => {
      const o = a.order(kind, rank);
      for (let j = 0; j < o.length; j++) {
        const it = a.item(kind, o[j]);
        if (it.untagged) continue;
        rows.push(h('div', { class: 'glance-row' }, h('div', { class: 'l' }, label), h('div', { class: 'n' }, it.name), h('div', { class: 's' }, sub(it))));
        return;
      }
    };
    const tail = (it) => fmt(it.v) + ', ' + plays(it.n);
    add('Top artist', 'artists', tail);
    add('Top song', 'tracks', (it) => it.sub + ', ' + tail(it));
    add('Top album', 'albums', (it) => it.sub + ', ' + tail(it));
    add('Top genre', 'genres', tail);
    return rows.length ? h('section', { class: 'glance' }, rows) : null;
  }

  // ------------------------------------------------------------------ saving a report
  // The report code is only downloaded the first time one of these buttons is used.
  let reportCode = null;
  function loadReport() {
    if (!reportCode) {
      reportCode = new Promise((resolve, reject) => {
        const s = h('script', { src: 'report.js' });
        s.addEventListener('load', () => resolve(window.LDReport));
        s.addEventListener('error', () => { reportCode = null; reject(new Error('The report code could not be downloaded. Check your connection.')); });
        document.head.appendChild(s);
      });
    }
    return reportCode;
  }
  function saveSection(a) {
    const status = h('p', { class: 'cap save-status', role: 'status' });
    const run = (kind) => (e) => {
      const btn = e.currentTarget;
      btn.disabled = true; status.textContent = 'Making your report\u2026';
      loadReport()
        .then((R) => R[kind]({ data, view: a, state, E, label: a.label, fileKey: state.grain === 'all' ? 'all-time' : state.key }))
        .then((msg) => { status.textContent = msg || ''; }, (err) => { status.textContent = err.message; })
        .then(() => { btn.disabled = false; });
    };
    const label = state.grain === 'all' ? 'all time' : a.label;
    return h('section', { class: 'save' },
      h('div', { class: 'head' }, h('div', null, h('h2', null, 'Save this period'),
        h('p', { class: 'cap' }, 'Download a report of ' + label + '. Pick another period above to save that one instead.'))),
      h('div', { class: 'save-row' },
        h('button', { class: 'pill', type: 'button', 'data-fid': 'save-pdf', onclick: run('pdf') }, 'PDF report'),
        h('button', { class: 'pill', type: 'button', 'data-fid': 'save-image', onclick: run('image') }, 'Image card'),
        h('button', { class: 'pill', type: 'button', 'data-fid': 'save-csv', onclick: run('csv') }, 'Spreadsheet (CSV)')),
      status);
  }

  // ------------------------------------------------------------------ over time
  function overTime() {
    const g = state.trendGrain, rows = rowsFor(g);
    const tabs = [['month', 'Months'], ['quarter', 'Quarters'], ['year', 'Years']];
    const seg = h('div', { class: 'seg small', role: 'group', 'aria-label': 'Group by' },
      tabs.map((t) => h('button', { type: 'button', 'data-fid': 't-' + t[0], 'aria-pressed': g === t[0], onclick: () => { state.trendGrain = t[0]; state.allPeriods = false; renderPart('over-time'); } }, t[1])));
    const selecting = state.grain === g;
    const legend = [];
    if (selecting) { legend.push(h('span', null, h('i', { class: 'sq acc' }), 'Selected')); legend.push(h('span', null, h('i', { class: 'sq' }), 'Other periods')); }
    if (rows.some((r) => r.inProgress)) legend.push(h('span', null, h('i', { class: 'sq part' }), 'Still in progress'));
    const newestFirst = rows.slice().reverse(), SHOW = 12;
    const shownRows = state.allPeriods ? newestFirst : newestFirst.slice(0, SHOW);
    const body = shownRows.map((r) => {
      const isSel = selecting && r.key === state.key;
      return h('tr', { class: isSel ? 'sel' : '' },
        h('td', null, h('button', { class: 'rowbtn', type: 'button', 'data-fid': 'row-' + r.key, 'aria-pressed': isSel, onclick: () => setScope(g, r.key) }, r.label + (r.inProgress ? ' (so far)' : ''))),
        h('td', { class: 'num' }, h('span', null, fmt(r.v))),
        h('td', { class: 'r num' }, h('span', null, num(r.n))),
        h('td', { class: 'gap' }, h('span', { class: 'trunc' }, r.topArtist || 'None')));
    });
    return h('section', { id: 'over-time' },
      h('div', { class: 'head' }, h('div', null, h('h2', null, 'Over time'), h('p', { class: 'cap' }, 'Tap a bar or a row to look at that period.')), seg),
      h('div', { class: 'chart' }, columnChart(rows, g)),
      legend.length ? h('div', { class: 'legend' }, legend) : null,
      h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, h('th', null, 'Period'), h('th', null, 'Time listened'), h('th', { class: 'r' }, 'Plays'), h('th', { class: 'gap' }, 'Top artist'))),
        h('tbody', null, body)),
      newestFirst.length > SHOW ? h('div', { class: 'more' }, h('button', {
        class: 'pill', type: 'button', 'data-fid': 'all-periods', 'aria-expanded': state.allPeriods,
        onclick: () => { state.allPeriods = !state.allPeriods; renderPart('over-time'); },
      }, state.allPeriods ? 'Show the latest ' + SHOW : 'Show all ' + newestFirst.length)) : null);
  }

  function columnChart(rows, g) {
    const maxSec = rows.reduce((m, r) => Math.max(m, r.v), 0);
    const unit = maxSec >= 5400 ? 3600 : 60, unitName = unit === 3600 ? 'hours' : 'minutes';
    const sc = niceScale(maxSec / unit, 4);
    const L = 38, R = 8, T = 22, B = 28, Ht = 230;
    const slot = Math.max(26, (chartWidth() - L - R) / Math.max(rows.length, 1));
    const W = Math.round(L + R + slot * rows.length), ih = Ht - T - B;
    const scrolls = W > chartWidth();
    const svg = sv('svg', { viewBox: '0 0 ' + W + ' ' + Ht, width: W, height: Ht, role: 'group', 'aria-label': 'Time listened by ' + g });
    yAxis(svg, L, W - R, T, ih, sc, unitName, scrolls);
    const step = Math.max(1, Math.ceil(46 / slot)), selecting = state.grain === g;
    const maxIdx = rows.findIndex((r) => r.v === maxSec);
    rows.forEach((r, i) => {
      const cx = L + i * slot + slot / 2, bw = Math.min(24, slot - 6);
      const hgt = (r.v / unit / sc.max) * ih, y = T + ih - hgt;
      const sel = selecting && r.key === state.key;
      const col = sv('g', { class: 'col', 'data-i': i, 'data-fid': 'col-' + r.key, tabindex: 0, role: 'button', 'aria-label': r.label + ': ' + fmt(r.v) + ', ' + plays(r.n) + '. Press Enter to open this period.' });
      col.appendChild(sv('rect', { class: 'hit', x: L + i * slot, y: T - 4, width: slot, height: ih + B + 4 }));
      if (r.v > 0) col.appendChild(sv('path', { class: 'bar-mark' + (selecting && !sel ? ' dim' : '') + (r.inProgress ? ' part' : ''), d: roundTop(cx - bw / 2, y, bw, hgt, 4) }));
      if (i % step === 0 || sel) col.appendChild(sv('text', { x: cx, y: Ht - 9, 'text-anchor': 'middle', class: sel ? 'strong' : '' }, r.short));
      if (r.v > 0 && (sel || (!selecting && i === maxIdx))) col.appendChild(sv('text', { x: cx, y: y - 6, 'text-anchor': 'middle', class: 'strong' }, fmtUnit(r.v, unit)));
      svg.appendChild(col);
    });
    delegate(svg, (i) => {
      const r = rows[i];
      return { title: r.label + (r.inProgress ? ' (so far)' : ''), rows: [[fmt(r.v), 'listened'], [plays(r.n), ''], [num(r.artists) + ' artists', '']] };
    }, (i) => setScope(g, rows[i].key));
    const wrap = h('div', { class: 'scroll' }, svg);
    if (!scrolls) return wrap;
    // the chart is wider than the screen: keep the hour scale in place while the bars scroll
    const scale = sv('svg', { class: 'y-fixed', viewBox: '0 0 ' + L + ' ' + Ht, width: L, height: Ht, 'aria-hidden': 'true' });
    yAxis(scale, L, L, T, ih, sc, unitName);
    requestAnimationFrame(() => { wrap.scrollLeft = wrap.scrollWidth; });
    return h('div', { class: 'scroll-wrap' }, wrap, scale);
  }

  // ------------------------------------------------------------------ day by day
  function dailySection(a) {
    const d = a.daily;
    const head = h('div', { class: 'head' }, h('div', null, h('h2', null, 'Day by day'),
      h('p', { class: 'cap' }, 'Each bar is one calendar day. The line is the average of the last ' + d.avgDays + ' days.')));
    if (d.length < 3) return h('section', null, head, h('p', { class: 'empty' }, 'There are not enough days in this period to draw a chart yet.'));
    return h('section', null, head,
      h('div', { class: 'chart' }, dailyChart(d)),
      h('div', { class: 'legend' }, h('span', null, h('i', { class: 'sq' }), 'Day total'), h('span', null, h('i', { class: 'ln' }), d.avgDays + '-day average, now ' + E.fmtHM(d.avg[d.length - 1]))),
      lazyDetails('Table view', () => {
        const shown = Math.min(d.length, 200), rows = [];
        for (let k = d.length - 1; k >= d.length - shown; k--) rows.push([E.dayLabel(d.start + k), fmt(d.v[k]), num(d.n[k]), fmt(d.avg[k])]);
        return h('div', null, table(['Day', 'Time listened', 'Plays', d.avgDays + '-day average'], rows),
          d.length > 200 ? h('p', { class: 'cap' }, 'Showing the latest 200 days.') : null);
      }));
  }

  function dailyChart(d) {
    const W = chartWidth(), Ht = 220, L = 38, R = 12, T = 22, B = 28, iw = W - L - R, ih = Ht - T - B;
    let maxSec = 0; for (let k = 0; k < d.length; k++) if (d.v[k] > maxSec) maxSec = d.v[k];
    const unit = maxSec >= 3 * 3600 ? 3600 : 60, unitName = unit === 3600 ? 'hours' : 'minutes';
    const sc = niceScale(maxSec / unit || 1, 4);
    const slot = iw / d.length, bw = Math.max(0.6, Math.min(24, slot - Math.min(2, slot * 0.3)));
    const svg = sv('svg', { class: 'fluid', viewBox: '0 0 ' + W + ' ' + Ht, role: 'group', 'aria-label': 'Daily time listened with a 7-day average' });
    yAxis(svg, L, W - R, T, ih, sc, unitName);
    const yOf = (sec) => T + ih - (sec / unit / sc.max) * ih;
    const xOf = (k) => L + k * slot + slot / 2;
    // every day's bar in one path: one element however many days there are
    let bars = '';
    for (let k = 0; k < d.length; k++) if (d.v[k] > 0) bars += 'M' + xOf(k).toFixed(1) + ',' + (T + ih) + 'V' + yOf(d.v[k]).toFixed(1);
    svg.appendChild(sv('path', { class: 'day-bars', d: bars, 'stroke-width': bw.toFixed(2) }));
    let line = '';
    for (let k = 0; k < d.length; k++) line += (k ? 'L' : 'M') + xOf(k).toFixed(1) + ',' + yOf(d.avg[k]).toFixed(1);
    svg.appendChild(sv('path', { class: 'avg-line', d: line }));
    svg.appendChild(sv('circle', { class: 'dot', cx: xOf(d.length - 1), cy: yOf(d.avg[d.length - 1]), r: 4 }));
    const ticks = Math.min(4, d.length - 1), long = d.length > 300; // past about ten months, show the year instead of the day
    for (let i = 0; i <= ticks; i++) {
      const k = Math.round((i / ticks) * (d.length - 1)), p = E.dayParts(d.start + k);
      svg.appendChild(sv('text', { x: Math.min(Math.max(xOf(k), L + 14), W - R - 14), y: Ht - 9, 'text-anchor': 'middle' }, E.MONTHS[p.m] + (long ? " '" + String(p.y).slice(2) : ' ' + p.d)));
    }
    const cross = sv('line', { class: 'cross', y1: T, y2: T + ih, visibility: 'hidden' });
    const over = sv('rect', { x: L, y: T - 6, width: iw, height: ih + 6, fill: 'transparent', style: 'touch-action: pan-y' });
    const move = (e) => {
      const r = svg.getBoundingClientRect(), px = (e.clientX - r.left) * (W / r.width);
      const k = Math.max(0, Math.min(d.length - 1, Math.floor((px - L) / slot)));
      cross.setAttribute('x1', xOf(k)); cross.setAttribute('x2', xOf(k)); cross.setAttribute('visibility', 'visible');
      showTip(e.clientX, e.clientY, E.dayLabel(d.start + k), [[fmt(d.v[k]), 'listened'], [plays(d.n[k]), ''], [fmt(d.avg[k]), d.avgDays + '-day average']]);
    };
    svg.setAttribute('data-tipzone', '');
    over.addEventListener('pointermove', move);
    over.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { hideTip(); cross.setAttribute('visibility', 'hidden'); } });
    svg.appendChild(cross);
    svg.appendChild(over);
    return svg;
  }

  // ------------------------------------------------------------------ time of day
  function polar(c, r, deg) { const a = (deg - 90) * Math.PI / 180; return [c + r * Math.cos(a), c + r * Math.sin(a)]; }
  function wedge(c, r0, r1, d0, d1) {
    const p0 = polar(c, r1, d0), p1 = polar(c, r1, d1), p2 = polar(c, r0, d1), p3 = polar(c, r0, d0);
    return 'M' + p0 + 'A' + r1 + ',' + r1 + ' 0 0 1 ' + p1 + 'L' + p2 + 'A' + r0 + ',' + r0 + ' 0 0 0 ' + p3 + 'Z';
  }

  function whenSection(a) {
    const head = h('div', { class: 'head' }, h('div', null, h('h2', null, 'When you listen'), h('p', { class: 'cap' }, 'Hours follow the clock on this device (' + TZ + ').')));
    if (a.total <= 0) return h('section', null, head, h('p', { class: 'empty' }, 'There is no listening time in this period yet.'));
    const hr = a.hr, tot = a.total;
    let maxH = 0; for (let i = 0; i < 24; i++) if (hr.sec[i] > maxH) maxH = hr.sec[i];
    return h('section', null, head,
      h('div', { class: 'pair' },
        h('div', null, clock(a, maxH), h('p', { class: 'cap', style: 'text-align:center' }, 'The longest bar is the ' + E.fmtHour(a.peakHour) + ' hour with ' + fmt(maxH) + '.')),
        h('div', { class: 'dayparts' }, a.dayparts.map((p) => h('div', { class: 'daypart' }, h('div', { class: 'v' }, pct(p.share)), h('div', { class: 'l' }, p.name + ' (' + p.range + ')'), h('div', { class: 'l' }, fmt(p.v)))))),
      h('div', { class: 'chart', style: 'margin-top:22px' }, h('p', { class: 'cap', style: 'margin-bottom:6px' }, 'Hour by weekday'), heatmap(a)),
      h('div', { class: 'legend' }, h('span', null, 'Less', h('i', { class: 'ramp' }), 'More')),
      lazyDetails('Table view', () => h('div', null,
        table(['Hour', 'Time listened', 'Plays', 'Share'], Array.from(hr.sec, (s, i) => [E.fmtHour(i), fmt(s), num(hr.plays[i]), pct(s / tot, 1)])),
        table(['Weekday', 'Time listened', 'Plays', 'Share'], Array.from(hr.wd, (s, i) => [E.WEEKDAYS[i], fmt(s), num(hr.wdN[i]), pct(s / tot, 1)])))));
  }

  function clock(a, maxH) {
    const S = 340, c = S / 2, r0 = 50, rMax = 118, hr = a.hr;
    const svg = sv('svg', { class: 'fluid', viewBox: '0 0 ' + S + ' ' + S, style: 'max-width:340px;margin:0 auto', role: 'group', 'aria-label': 'Listening by hour of day' });
    svg.appendChild(sv('circle', { class: 'axis-line', cx: c, cy: c, r: r0, fill: 'none' }));
    svg.appendChild(sv('circle', { class: 'grid-line', cx: c, cy: c, r: rMax, fill: 'none' }));
    for (let i = 0; i < 24; i++) {
      const v = hr.sec[i], hgt = maxH > 0 ? (v / maxH) * (rMax - r0) : 0;
      const g = sv('g', { 'data-i': i, tabindex: 0, role: 'img', 'aria-label': E.fmtHour(i) + ' hour: ' + fmt(v) + ', ' + plays(hr.plays[i]) });
      g.appendChild(sv('path', { fill: 'transparent', d: wedge(c, r0, rMax, i * 15 + 0.7, (i + 1) * 15 - 0.7) }));
      if (v > 0) g.appendChild(sv('path', { class: 'wedge' + (i === a.peakHour ? ' peak' : ''), d: wedge(c, r0, r0 + Math.max(2, hgt), i * 15 + 0.7, (i + 1) * 15 - 0.7) }));
      svg.appendChild(g);
    }
    [[0, '12 AM', 'middle', -6], [6, '6 AM', 'start', 4], [12, '12 PM', 'middle', 14], [18, '6 PM', 'end', 4]].forEach((l) => {
      const p = polar(c, rMax + 12, l[0] * 15);
      svg.appendChild(sv('text', { x: p[0] + (l[2] === 'start' ? 2 : l[2] === 'end' ? -2 : 0), y: p[1] + l[3], 'text-anchor': l[2] }, l[1]));
    });
    svg.appendChild(sv('text', { x: c, y: c + 6, 'text-anchor': 'middle', class: 'big' }, E.fmtHour(a.peakHour)));
    svg.appendChild(sv('text', { x: c, y: c + 24, 'text-anchor': 'middle' }, 'busiest hour'));
    delegate(svg, (i) => ({ title: E.fmtHour(i) + ' to ' + E.fmtHour((i + 1) % 24), rows: [[fmt(hr.sec[i]), 'listened'], [plays(hr.plays[i]), ''], [pct(hr.sec[i] / a.total, 1), 'of the total']] }));
    return svg;
  }

  function heatmap(a) {
    const W = chartWidth(), labW = 34, topH = 18, cw = (W - labW) / 24, ch = 20, gap = 2;
    const Ht = topH + 7 * (ch + gap), hr = a.hr;
    let max = 0; for (let i = 0; i < 168; i++) if (hr.heat[i] > max) max = hr.heat[i];
    const svg = sv('svg', { class: 'fluid', viewBox: '0 0 ' + W + ' ' + Ht, role: 'group', 'aria-label': 'Listening by weekday and hour. The table view has the same numbers.' });
    ['12a', '3a', '6a', '9a', '12p', '3p', '6p', '9p'].forEach((t, i) => svg.appendChild(sv('text', { x: labW + i * 3 * cw + cw / 2, y: 11, 'text-anchor': 'middle' }, t)));
    for (let w = 0; w < 7; w++) {
      svg.appendChild(sv('text', { x: 0, y: topH + w * (ch + gap) + ch / 2 + 4 }, E.WEEKDAYS[w]));
      for (let i = 0; i < 24; i++) {
        const v = hr.heat[w * 24 + i];
        const fill = v > 0 ? 'color-mix(in srgb, var(--accent) ' + Math.round(14 + 86 * (v / max)) + '%, var(--surface))' : 'var(--grid)';
        svg.appendChild(sv('rect', { class: 'cell', 'data-i': w * 24 + i, x: (labW + i * cw).toFixed(1), y: topH + w * (ch + gap), width: Math.max(1, cw - gap).toFixed(1), height: ch, rx: 2, style: 'fill:' + fill }));
      }
    }
    delegate(svg, (k) => ({ title: E.WEEKDAYS[Math.floor(k / 24)] + ', ' + E.fmtHour(k % 24) + ' hour', rows: [[fmt(hr.heat[k]), 'listened'], [plays(hr.heatN[k]), '']] }));
    return svg;
  }

  // ------------------------------------------------------------------ top lists
  function topSection(a) {
    const tabs = [['tracks', 'Songs'], ['artists', 'Artists'], ['albums', 'Albums'], ['genres', 'Genres']];
    const useTime = a.total > 0 && state.rank === 'time';
    const seg = h('div', { class: 'seg small', role: 'group', 'aria-label': 'List type' },
      tabs.map((t) => h('button', { type: 'button', 'data-fid': 'tab-' + t[0], 'aria-pressed': state.tab === t[0], onclick: () => { state.tab = t[0]; state.limit = 10; renderPart('top'); } }, t[1])));
    const rank = a.total > 0 ? h('div', { class: 'seg small', role: 'group', 'aria-label': 'Rank by' },
      [['time', 'By time'], ['plays', 'By plays']].map((t) => h('button', { type: 'button', 'data-fid': 'rank-' + t[0], 'aria-pressed': state.rank === t[0], onclick: () => { state.rank = t[0]; state.limit = 10; renderPart('top'); } }, t[1]))) : null;
    const order = a.order(state.tab, useTime ? 'time' : 'plays'), count = order.length;
    const key = useTime ? 'v' : 'n';
    const items = [];
    for (let j = 0; j < Math.min(state.limit, count); j++) items.push(a.item(state.tab, order[j]));
    const topVal = items.length ? items[0][key] || 1 : 1;
    const li = items.map((it, i) => h('li', null,
      h('span', { class: 'rk' }, i + 1),
      h('div', null, h('div', { class: 'nm' }, it.name), it.sub ? h('div', { class: 'sb' }, it.sub) : null),
      h('div', { class: 'vl' }, useTime ? fmt(it.v) : plays(it.n), h('small', null, useTime ? plays(it.n) : fmt(it.v))),
      h('div', { class: 'trk' }, h('b', { style: 'width:' + Math.max(2, (it[key] / topVal) * 100).toFixed(1) + '%' }))));
    const more = count > state.limit ? h('div', { class: 'more' }, h('button', { class: 'pill', type: 'button', 'data-fid': 'more', onclick: () => { state.limit = Math.min(100, state.limit + 15); renderPart('top'); } }, 'Show more')) : null;
    return h('section', null,
      h('div', { class: 'head' }, h('div', null, h('h2', null, 'Top lists'),
        state.tab === 'genres' ? h('p', { class: 'cap' }, 'Time and plays are shared evenly across the top tags of each artist, so genres add up to the total.') : null)),
      h('div', { class: 'head', style: 'margin-bottom:0' }, seg, rank),
      count ? h('ol', { class: 'toplist' }, li) : h('p', { class: 'empty' }, 'Nothing to list for this period' + (state.tab === 'albums' ? '. Plays without an album name are left out.' : '.')),
      more);
  }

  // ------------------------------------------------------------------ statistics
  function fact(label, value, note) {
    return h('div', { class: 'fact' }, h('dt', null, label), h('dd', { class: 'v' }, value), note ? h('dd', { class: 'n' }, note) : null);
  }
  function effectWord(d) { const x = Math.abs(d); return x < 0.2 ? 'negligible' : x < 0.5 ? 'small' : x < 0.8 ? 'medium' : 'large'; }
  function clockTime(ts) { return new Date(ts * 1000).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }

  function statsSection(a) {
    const head = h('div', { class: 'head' }, h('div', null, h('h2', null, 'Statistics'),
      h('p', { class: 'cap' }, 'Everything here covers ' + (state.grain === 'all' ? 'all time' : a.label) + '. Days with no music count as zero.')));
    const d = a.day, m = a.mix;
    const daily = [
      fact('Average day', fmt(d.mean), 'Across ' + num(d.count) + ' calendar days.'),
      fact('Typical day (median)', fmt(d.median), 'Half of your days are above this and half are below.'),
      fact('Spread (standard deviation)', fmt(d.sd), isFinite(d.cv) ? 'That is ' + pct(d.cv) + ' of the average. A higher share means more uneven days.' : null),
      fact('Biggest day', fmt(d.max), d.maxDay != null ? E.dayLabel(d.maxDay) : null),
      fact('Top 10% of days', 'Above ' + E.fmtHM(d.p90), 'On your heaviest days you listen at least this much.'),
      fact('Days with music', num(d.active) + ' of ' + num(d.count), pct(d.count ? d.active / d.count : 0) + ' of days.'),
    ];
    const patterns = [];
    if (a.trend) {
      const up = a.trend.perWeek >= 0;
      patterns.push(fact('Trend', (up ? '+' : '-') + E.fmtHM(Math.abs(a.trend.perWeek)) + ' per week',
        'Straight-line fit to daily totals. R² ' + a.trend.r2.toFixed(2) + ' means the trend explains that share of day-to-day change; ' + E.fmtP(a.trend.p) + '. Daily data is not independent from one day to the next, so treat the p-value as a rough guide.'));
    } else patterns.push(fact('Trend', 'Not yet', 'A trend needs at least 14 days in the period.'));
    if (a.weekend) {
      const w = a.weekend, more = w.weekend > w.weekday ? 'weekends' : 'weekdays';
      patterns.push(fact('Weekdays and weekends', E.fmtHM(w.weekday) + ' and ' + E.fmtHM(w.weekend),
        'Average per day, weekday first. You listen more on ' + more + '. Welch t-test: ' + E.fmtP(w.p) + '; effect size d = ' + Math.abs(w.d).toFixed(2) + ' (' + effectWord(w.d) + ').' +
        (Math.min(w.nWeekday, w.nWeekend) < 30 ? ' With fewer than 30 weekend days, be cautious.' : '')));
    }
    if (a.peakHour != null) patterns.push(fact('Busiest hour', E.fmtHour(a.peakHour), pct(a.hr.sec[a.peakHour] / a.total, 1) + ' of your listening time falls in this hour.'));
    patterns.push(fact('Morning share', pct(a.dayparts[0].share), a.dayparts[0].range));
    patterns.push(fact('Late-night share', pct(a.dayparts[3].share), a.dayparts[3].range));

    const variety = [
      fact('Effective number of artists', m.effectiveArtists.toFixed(1), 'Out of ' + num(a.uniq.artists) + ' artists. This is how many equally played artists would give the same variety, so lower means a more focused taste.'),
      fact('Top artist share', pct(m.topArtistShare, 1), 'Share of ' + (a.total > 0 ? 'time' : 'plays') + ' that goes to your number one artist.'),
      fact('Top 5 artists share', pct(m.top5Share, 1), null),
      fact('Concentration (Gini)', m.gini.toFixed(2), '0 means every artist gets the same share and values near 1 mean one artist takes nearly everything.'),
      fact('Replay rate', pct(m.replayRate), 'Share of plays that repeat a song already played in this period.'),
    ];
    if (a.discovery) variety.push(fact('New artists', a.discovery.fresh + ' of ' + a.discovery.of, 'Artists whose first play in your whole history falls in this period.'));

    const sessions = [];
    if (a.sessions) {
      const s = a.sessions;
      sessions.push(fact('Sessions', num(s.count), 'A session is a run of listening with no break longer than ' + (E.SESSION_GAP / 60) + ' minutes.'));
      sessions.push(fact('Typical session', fmt(s.median), 'Median length. The average is ' + fmt(s.mean) + ' with about ' + s.tracksMean.toFixed(1) + ' songs.'));
      sessions.push(fact('Longest session', fmt(s.longest.dur), 'Started ' + clockTime(s.longest.start) + ' with ' + num(s.longest.n) + ' songs.'));
    }
    sessions.push(fact('Longest streak', a.streak.longest + (a.streak.longest === 1 ? ' day' : ' days'), a.streak.longestEnd != null ? 'Ended ' + E.dayLabel(a.streak.longestEnd) + '.' : null));
    const days = a.streak.current + (a.streak.current === 1 ? ' day' : ' days');
    if (a.periodOver) sessions.push(fact('Streak at the end of ' + a.label, days, 'Days in a row with music up to the last day of the period.'));
    else sessions.push(fact('Current streak', days, 'Days in a row with music up to the latest update. Today counts once you play something.'));

    const group = (title, items) => h('div', { class: 'group' }, h('h3', null, title), h('dl', null, items));
    return h('section', null, head, group('Daily listening', daily), group('Patterns', patterns), group('Variety', variety), group('Sessions and streaks', sessions));
  }

  // ------------------------------------------------------------------ about the data
  function aboutSection() {
    const total = data.n;
    const first = data.ts[0], last = data.ts[total - 1];
    const dateOnly = (ts) => new Date(ts * 1000).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
    const modeSeg = h('div', { class: 'seg small', role: 'group', 'aria-label': 'How time is counted' },
      [['est', 'Estimated heard'], ['full', 'Full track length']].map((t) => h('button', {
        type: 'button', 'data-fid': 'mode-' + t[0], 'aria-pressed': state.mode === t[0],
        onclick: () => { state.mode = t[0]; keep('mode', t[0]); E.setMode(data, t[0]); renderAll(); },
      }, t[1])));
    const unknown = data.unknownPlays;
    const unknownNote = unknown
      ? num(unknown) + ' of ' + num(total) + ' plays (' + pct(unknown / total, 1) + ') are songs whose length no source knows. They count as plays but add no time. At the typical song length of ' + fmt(data.fallbackLen) + ' they would add about ' + fmt(unknown * data.fallbackLen) + '.'
      : 'Every song in your history has a known length.';
    return h('section', null,
      h('div', { class: 'head' }, h('div', null, h('h2', null, 'About this data'))),
      h('dl', null,
        fact('History covered', dateOnly(first) + ' to ' + dateOnly(last), num(total) + ' plays of ' + num(data.nT) + ' songs.'),
        fact('From Last.fm', num(total - data.nSpotify) + ' plays', 'Everything Pano Scrobbler (and any other app) has sent to your Last.fm account.'),
        fact('From Spotify', num(data.nSpotify) + ' plays', data.nSpotify
          ? 'Your Spotify history, with the seconds you actually played.' + (data.sources && data.sources.spotifyDuplicates ? ' ' + num(data.sources.spotifyDuplicates) + ' Spotify plays that Last.fm already had were left out, so nothing counts twice.' : '')
          : 'None yet. You can add your older Spotify listening with the import page below.'),
        data.generated ? fact('Last checked', whenText(data.generated), data.status && data.status.ok === false ? 'That update did not finish; see the note at the top.' : 'Updates run about four times a day. Nothing runs on your phone in the background.') : null),
      h('div', { class: 'group' }, h('h3', null, 'How time is counted'), h('div', { style: 'margin-top:10px' }, modeSeg),
        h('p', { class: 'cap', style: 'margin-top:10px' }, state.mode === 'est'
          ? 'Last.fm records when each song started, not how long you heard it. This mode counts the full song length unless the next song started sooner, in which case it counts the gap. Skips and cut-short plays are therefore trimmed, but pauses cannot be detected. Songs skipped before Pano scrobbles them never reach Last.fm. Spotify plays use the exact seconds Spotify recorded.'
          : 'Every play counts as the full length of the song, even if you skipped ahead. This is the upper bound.')),
      h('p', { class: 'cap', style: 'margin-top:14px' }, unknownNote),
      unknown ? lazyDetails('Songs without a known length', () => table(['Song', 'Artist', 'Plays'], E.missingLengths(data, 25).map((m) => [m.title, m.artist, num(m.plays)]))) : null,
      h('div', { class: 'group' }, h('h3', null, 'Spotify history'),
        h('p', { class: 'cap', style: 'margin-top:10px' }, data.nSpotify ? 'To add a newer Spotify download, use the import page again; it replaces the old one.' : 'Bring in everything you played on Spotify before you started scrobbling.'),
        h('p', { style: 'margin-top:10px' }, h('a', { class: 'pill link-pill', href: 'import.html' + (window.LD_DEMO ? '?demo=1' : '') }, data.nSpotify ? 'Update Spotify history' : 'Add Spotify history'))),
      h('p', { class: 'foot' }, 'Plays come from Last.fm through Pano Scrobbler, and from your Spotify download if you added one. Song lengths come from Last.fm, then Deezer, iTunes and MusicBrainz. Genres are the top tags Last.fm lists for each artist. Dates and hours use the time zone of this device (' + TZ + ').'));
  }

  // ------------------------------------------------------------------ page states
  function renderMessage(title, kids) {
    app.textContent = '';
    app.appendChild(h('div', { class: 'state' }, h('h2', null, title), kids));
  }
  function renderMissing(reason) {
    renderMessage('No listening data yet', [
      h('p', { class: 'cap', style: 'margin-bottom:12px' }, 'The page could not load its data (' + reason + '). This is normal before the first update has run.'),
      h('ol', null,
        h('li', null, 'Open the Actions tab of your GitHub repository.'),
        h('li', null, 'Choose Update listening data, then press Run workflow.'),
        h('li', null, 'Wait for the run to finish, then reload this page.')),
      h('p', { class: 'cap', style: 'margin-top:14px' }, 'To see what the dashboard looks like, ', h('a', { href: '?demo=1' }, 'open the sample data'), '.')]);
  }
  function renderEmpty() {
    const st = data.status || {};
    renderMessage(st.ok === false ? 'The update could not run' : 'No plays found yet', [
      h('p', { class: 'cap' }, st.ok === false ? st.message : 'Last.fm returned no scrobbles. Check that Pano Scrobbler is signed in to Last.fm, then run the update again.'),
      st.ok === false ? h('p', { class: 'cap', style: 'margin-top:12px' }, 'After fixing it, open the Actions tab of your GitHub repository, choose Update listening data and press Run workflow.') : null]);
  }

  // ------------------------------------------------------------------ start
  async function loadData() {
    let res;
    try { res = await (window.LD_DATA || Promise.resolve({ error: new Error('no request') })); } catch (e) { res = { error: e }; }
    if (res.error && !res.status) {
      // no connection: fall back to the copy the browser already has, if any
      try {
        const r = await fetch(window.LD_DEMO ? 'data/demo.json' : 'data/listening.json', { cache: 'force-cache' });
        if (r.ok) { res = { json: await r.json() }; offline = true; }
      } catch (e) { /* nothing cached */ }
    }
    return res;
  }

  async function init() {
    state.mode = store('mode', 'est');
    state.design = document.documentElement.getAttribute('data-design') || 'hifi';
    applyLook();
    const res = await loadData();
    if (!res.json) return renderMissing(res.status ? 'HTTP ' + res.status : res.error && res.error.name === 'SyntaxError' ? 'the download was cut short; reload to try again' : 'no connection');
    try { data = E.prepare(res.json); } catch (e) { return renderMissing(e.message); }
    if (!data.n) return renderEmpty();
    E.setMode(data, state.mode);
    renderAll();
    let lastW = document.documentElement.clientWidth, timer = null;
    window.addEventListener('resize', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { const w = document.documentElement.clientWidth; if (w !== lastW) { lastW = w; renderAll(); } }, 200);
    });
    document.addEventListener('pointerdown', (e) => { if (!(e.target.closest && e.target.closest('[data-tipzone]'))) hideTip(); }, { passive: true });
    window.addEventListener('scroll', hideTip, { passive: true });
  }

  init();
})();
