/* Spotify import: reads Spotify's data download on the phone and makes spotify-history.json.
 * Keeps only start time, seconds played, artist, song and album. Leaves out IP addresses,
 * devices, country, account names and podcasts. Nothing is uploaded by this page. */
(function () {
  'use strict';
  const MIN_MS = 30000; // Spotify counts a stream from 30 seconds; shorter plays are skips
  const input = document.getElementById('files');
  const result = document.getElementById('result');
  const steps = document.getElementById('upload-steps');
  if (/[?&]demo/.test(location.search)) document.getElementById('back').href = './?demo=1';

  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) { if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), attrs[k]); else el.setAttribute(k, attrs[k]); }
    for (let i = 2; i < arguments.length; i++) { const k = arguments[i]; if (k != null) el.appendChild(k.nodeType ? k : document.createTextNode(String(k))); }
    return el;
  }
  const num = (n) => n.toLocaleString();
  const day = (t) => new Date(t * 1000).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });

  // ---------------------------------------------------------------- reading a zip file (no library needed)
  async function inflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function readZip(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let end = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (dv.getUint32(i, true) === 0x06054b50) { end = i; break; }
    if (end < 0) throw new Error(file.name + ' does not look like a zip file.');
    const count = dv.getUint16(end + 10, true), cd = dv.getUint32(end + 16, true);
    if (count === 0xffff || cd === 0xffffffff) throw new Error(file.name + ' is too large to read here. Unzip it and choose the JSON files inside.');
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot open zip files. Unzip it and choose the JSON files inside.');
    const out = [];
    for (let k = 0, p = cd; k < count; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error(file.name + ' seems damaged. Download it again from Spotify.');
      const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), noteLen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + noteLen;
      if (!/\.json$/i.test(name) || /__MACOSX/.test(name)) continue;
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const raw = buf.subarray(start, start + size);
      const bytes = method === 0 ? raw : method === 8 ? await inflate(raw) : null;
      if (bytes) out.push({ name: name.split('/').pop(), text: new TextDecoder().decode(bytes) });
    }
    return out;
  }

  // ---------------------------------------------------------------- understanding Spotify's files
  /* Two kinds exist. Extended streaming history: records with ts (when the stream ended, UTC)
     and ms_played. Account data: records with endTime ("YYYY-MM-DD HH:MM", UTC) and msPlayed. */
  function parse(entries, tally) {
    const ext = [], acc = [];
    for (const e of entries) {
      let list;
      try { list = JSON.parse(e.text); } catch (err) { continue; }
      if (!Array.isArray(list) || !list.length || typeof list[0] !== 'object') continue;
      const kind = 'ms_played' in list[0] && 'ts' in list[0] ? 'ext' : 'msPlayed' in list[0] && 'endTime' in list[0] ? 'acc' : null;
      if (!kind) continue;
      tally.files++;
      for (const r of list) {
        tally.records++;
        const artist = String((kind === 'ext' ? r.master_metadata_album_artist_name : r.artistName) || '').trim();
        const song = String((kind === 'ext' ? r.master_metadata_track_name : r.trackName) || '').trim();
        const ms = Number(kind === 'ext' ? r.ms_played : r.msPlayed) || 0;
        if (!artist || !song || artist === 'Unknown Artist' || song === 'Unknown Track') { tally.other++; continue; }
        if (ms < MIN_MS) { tally.short++; continue; }
        const endMs = kind === 'ext' ? Date.parse(r.ts) : Date.parse(String(r.endTime).replace(' ', 'T') + ':00Z');
        if (!isFinite(endMs)) { tally.other++; continue; }
        const row = [Math.round((endMs - ms) / 1000), Math.round(ms / 1000), artist, song, kind === 'ext' ? String(r.master_metadata_album_album_name || '').trim() : ''];
        (kind === 'ext' ? ext : acc).push(row);
      }
    }
    return { ext, acc };
  }

  /* One list, oldest first, with each play once. Account data only has times to the minute,
     so its plays are dropped when the extended history already has the same song within 3 minutes. */
  function merge(ext, acc, tally) {
    const key = (r) => r[2].toLowerCase() + '\u001f' + r[3].toLowerCase();
    const seen = new Set(), times = new Map(), out = [];
    for (const r of ext) {
      const k = key(r) + '\u001f' + r[0];
      if (seen.has(k)) { tally.dupes++; continue; }
      seen.add(k); out.push(r);
      const t = times.get(key(r)); if (t) t.push(r[0]); else times.set(key(r), [r[0]]);
    }
    for (const r of acc) {
      const t = times.get(key(r));
      if (t && t.some((x) => Math.abs(x - r[0]) <= 180)) { tally.dupes++; continue; }
      const k = key(r) + '\u001f' + r[0];
      if (seen.has(k)) { tally.dupes++; continue; }
      seen.add(k); out.push(r);
    }
    out.sort((a, b) => a[0] - b[0] || (a[3] < b[3] ? -1 : 1));
    return out;
  }

  function save(blob, name) {
    const a = h('a', { href: URL.createObjectURL(blob), download: name, style: 'display:none' });
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
  }

  function show(plays, tally) {
    result.textContent = '';
    if (!plays.length) {
      result.appendChild(h('p', { class: 'banner warn' }, tally.files
        ? 'No songs were found in these files. Podcasts and plays shorter than 30 seconds are left out.'
        : 'These do not look like Spotify history files. Choose the zip from Spotify, or the files named Streaming_History_Audio or StreamingHistory inside it.'));
      steps.hidden = true;
      return;
    }
    const secs = plays.reduce((s, r) => s + r[1], 0);
    const by = new Map();
    for (const r of plays) by.set(r[2], (by.get(r[2]) || 0) + r[1]);
    const top = Array.from(by.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3).map((x) => x[0]);
    const file = JSON.stringify({ source: 'spotify', v: 1, made: new Date().toISOString(), plays });
    const blob = new Blob([file], { type: 'application/json' });
    result.appendChild(h('div', { class: 'import-summary' },
      h('p', { class: 'import-big' }, num(plays.length) + ' plays found'),
      h('p', null, 'From ' + day(plays[0][0]) + ' to ' + day(plays[plays.length - 1][0]) + ', ' + Math.round(secs / 3600).toLocaleString() + ' hours of music. Most played: ' + top.join(', ') + '.'),
      h('p', { class: 'cap' }, 'Left out: ' + num(tally.short) + ' plays under 30 seconds (skips), ' + num(tally.other) + ' podcasts, videos or unnamed items, and ' + num(tally.dupes) + ' plays listed twice. IP addresses, devices, country and account details are not kept.'),
      h('p', { style: 'margin-top:12px' }, h('button', { class: 'pill', type: 'button', id: 'download', onclick: () => save(blob, 'spotify-history.json') },
        'Download spotify-history.json (' + Math.max(1, Math.round(blob.size / 1024)).toLocaleString() + ' KB)'))));
    steps.hidden = false;
  }

  input.addEventListener('change', async () => {
    const files = Array.from(input.files || []);
    if (!files.length) return;
    result.textContent = '';
    result.appendChild(h('p', { class: 'cap' }, 'Reading ' + files.length + (files.length === 1 ? ' file' : ' files') + '…'));
    const tally = { files: 0, records: 0, short: 0, other: 0, dupes: 0 };
    try {
      const entries = [];
      for (const f of files) {
        if (/\.zip$/i.test(f.name) || f.type === 'application/zip' || f.type === 'application/x-zip-compressed') entries.push(...await readZip(f));
        else entries.push({ name: f.name, text: await f.text() });
      }
      const { ext, acc } = parse(entries, tally);
      show(merge(ext, acc, tally), tally);
    } catch (err) {
      result.textContent = '';
      result.appendChild(h('p', { class: 'banner warn' }, err.message || 'These files could not be read.'));
      steps.hidden = true;
    }
  });

  window.LDImport = { parse, merge, readZip }; // used by the tests
})();
