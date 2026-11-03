/* Browser checks for the dashboard, reports and Spotify import in a phone-sized Chromium.
 * Needs Playwright (npm install playwright; npx playwright install chromium) and Python 3.
 * Run from the project folder: node tests/browser.test.js */
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os'), cp = require('child_process');

const ROOT = path.join(__dirname, '..'), DOCS = path.join(ROOT, 'docs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-browser-'));
const demo = JSON.parse(fs.readFileSync(path.join(DOCS, 'data', 'demo.json'), 'utf8'));
let served = { listening: demo, dataMaxAge: 600 };
const requested = [];
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  requested.push(url);
  let body, maxAge = 600;
  if (url === '/data/listening.json') {
    if (served.listening === null) { res.writeHead(404); return res.end('not found'); }
    body = Buffer.from(served.raw != null ? served.raw : JSON.stringify(served.listening)); maxAge = served.dataMaxAge;
  } else {
    const p = path.join(DOCS, url.endsWith('/') ? url + 'index.html' : url);
    if (!p.startsWith(DOCS) || !fs.existsSync(p)) { res.writeHead(404); return res.end('not found'); }
    body = fs.readFileSync(p);
  }
  const etag = '"' + crypto.createHash('md5').update(body).digest('hex') + '"';
  const headers = { ETag: etag, 'Cache-Control': 'max-age=' + maxAge, 'Content-Type': types[path.extname(url)] || (url.endsWith('/') ? 'text/html' : 'application/octet-stream') };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  res.writeHead(200, headers); res.end(body);
}).listen(0);
const BASE = () => 'http://127.0.0.1:' + srv.address().port + '/';

let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pngSize = (buf) => [buf.readUInt32BE(16), buf.readUInt32BE(20)];

(async () => {
  const browser = await chromium.launch();
  const phone = { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: 'America/Los_Angeles', acceptDownloads: true };
  const problems = [];
  async function open(ctx, url) {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(m.type() + ': ' + m.text()); });
    await page.goto(BASE() + (url || ''), { waitUntil: 'load' });
    return page;
  }
  const fid = (page, f) => page.click('[data-fid="' + f + '"]');
  async function download(page, f) {
    const [d] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), fid(page, f)]);
    const file = path.join(TMP, d.suggestedFilename());
    await d.saveAs(file);
    return { name: d.suggestedFilename(), buf: fs.readFileSync(file), file };
  }

  // ---------------------------------------------------------------- main walk-through
  let ctx = await browser.newContext(phone);
  let page = await open(ctx);
  await page.waitForSelector('.hero-num');
  await page.evaluate(() => document.fonts.ready);
  const hero = () => page.$eval('.hero-num', (e) => e.getAttribute('aria-label'));
  const what = () => page.$eval('.hero .what', (e) => e.textContent);
  const allHero = await hero();
  ok(/^\d+h \d\dm \d\ds$/.test(allHero), 'first screen shows total time to the second: ' + allHero);
  ok(await page.evaluate(() => document.documentElement.getAttribute('data-design')) === 'hifi', 'opens in the Hi-fi look by default');
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'no sideways scrolling at phone width');
  const fontsLoaded = requested.filter((u) => u.startsWith('/fonts/'));
  ok(fontsLoaded.length > 0 && fontsLoaded.every((u) => /barlow|share-tech/.test(u)), 'only the Hi-fi fonts are downloaded (' + fontsLoaded.length + ' files)');
  ok(!requested.includes('/report.js'), 'the report code is not downloaded until a report is asked for');
  ok((await page.textContent('#about')).includes('From Spotify') && (await page.textContent('#about')).includes('426 plays'), 'About shows the Spotify plays in the history');

  await fid(page, 'g-quarter');
  ok((await what()).includes('Q4 2026'), 'quarter view opens on the newest quarter');
  await page.selectOption('select.period', '2026-Q3');
  ok((await what()).includes('Q3 2026') && (await hero()) !== allHero, 'choose a quarter from the menu');
  await fid(page, 'g-month');
  await page.selectOption('select.period', '2026-04');
  ok((await page.$$eval('.hero .note', (n) => n.map((x) => x.textContent).join(' '))).includes('only partly covered'), 'the first month (from the Spotify backlog) is flagged as partly covered');
  await fid(page, 'g-year');
  ok((await what()).includes('2026'), 'year view');
  await fid(page, 'g-all');

  // looks: switching changes colors without redrawing anything
  await page.evaluate(() => { document.getElementById('hero').__marker = 1; document.getElementById('top').__marker = 1; });
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const seen = {};
  for (const l of ['wrapped', 'swiss', 'hifi']) {
    await fid(page, 'look-' + l); await sleep(60);
    seen[l] = await bg();
    ok(await page.evaluate((x) => document.documentElement.getAttribute('data-design') === x && document.querySelector('[data-fid="look-' + x + '"]').getAttribute('aria-pressed') === 'true', l), 'look switch: ' + l);
  }
  ok(new Set(Object.values(seen)).size === 3, 'the three looks have different colors');
  ok(await page.evaluate(() => document.getElementById('hero').__marker === 1 && document.getElementById('top').__marker === 1), 'switching looks redraws nothing');
  ok(await page.evaluate(() => document.querySelector('meta[name="theme-color"]').content) === seen.hifi, 'the phone status bar color follows the look');

  // partial redraws
  for (const t of ['artists', 'albums', 'genres', 'tracks']) {
    await fid(page, 'tab-' + t);
    ok((await page.$$eval('.toplist li', (l) => l.length)) > 0, 'top list "' + t + '" has rows');
  }
  ok(await page.evaluate(() => document.getElementById('hero').__marker === 1), 'switching lists leaves the rest of the page untouched');
  await fid(page, 'tab-artists'); await fid(page, 'rank-plays');
  ok((await page.$eval('.toplist li .vl', (e) => e.textContent)).includes('plays'), 'rank by plays');
  await fid(page, 'more');
  ok((await page.$$eval('.toplist li', (l) => l.length)) === 25, 'show more adds 15 rows');
  ok(await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-fid') === 'more'), 'keyboard focus stays on Show more');

  await fid(page, 't-quarter');
  ok((await page.$$('#over-time .col')).length === 3, 'quarters chart has 3 bars');
  await fid(page, 't-month');
  const cols = await page.$$('#over-time .col');
  ok(cols.length === 7, 'months chart has 7 bars (April to October)');
  await cols[4].click();
  ok((await what()).includes('Aug 2026'), 'tapping a bar opens that month');
  await page.focus('[data-fid="col-2026-09"]');
  await page.keyboard.press('Enter');
  ok((await what()).includes('Sep 2026'), 'Enter on a focused bar opens that month');
  ok(await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-fid') === 'col-2026-09'), 'focus returns to the same bar after the redraw');
  await fid(page, 'g-all');

  // tooltips
  const tipText = () => page.$eval('#tip', (t) => (t.hidden ? '' : t.textContent));
  const hoverAt = async (sel, fx, fy) => { const el = await page.$(sel); await el.scrollIntoViewIfNeeded(); await sleep(150); const b = await el.boundingBox(); await page.mouse.move(b.x + b.width * fx, b.y + b.height * fy); await sleep(80); };
  await hoverAt('#over-time .col', 0.5, 0.6);
  ok(/listened/.test(await tipText()), 'bar tooltip');
  await hoverAt('#when .cell', 0.3, 0.3);
  ok(/Mon, 12 AM hour/.test(await tipText()), 'heat map cell tooltip');
  await hoverAt('#when svg g[data-i="9"] path', 0.5, 0.5);
  ok(/9 AM to 10 AM/.test(await tipText()), 'clock wedge tooltip');
  await hoverAt('#daily svg', 0.6, 0.5);
  ok(/-day average/.test(await tipText()), 'daily chart tooltip');
  await page.mouse.wheel(0, 300); await sleep(150);
  ok((await tipText()) === '', 'tooltip hides on scroll');
  ok((await page.$$('#daily details tbody tr')).length === 0, 'daily table is not built until opened');
  await page.$eval('#daily details', (d) => { d.open = true; }); await sleep(80);
  ok((await page.$$('#daily details tbody tr')).length > 100, 'daily table appears when opened');

  // time counting mode
  await page.evaluate(() => window.scrollTo(0, 0));
  const est = await hero();
  await page.$eval('[data-fid="mode-full"]', (b) => b.click());
  ok(est !== (await hero()), 'full-length mode differs from the estimate');
  await page.$eval('[data-fid="mode-est"]', (b) => b.click());
  ok((await hero()) === est, 'switching back restores the estimate');

  // ---------------------------------------------------------------- reports
  await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
  const csvAll = await download(page, 'save-csv');
  ok(requested.includes('/report.js'), 'the report code downloads on the first save');
  const csvText = csvAll.buf.toString('utf8');
  const csvLines = csvText.replace(/^﻿/, '').trim().split(/\r\n/);
  const playsAll = await page.$eval('.kpi .v', (e) => +e.textContent.replace(/,/g, ''));
  ok(csvAll.name === 'listening-plays-all-time.csv' && csvText.charCodeAt(0) === 0xfeff, 'CSV saved as ' + csvAll.name + ' with a marker so spreadsheets read accents correctly');
  ok(csvLines[0] === 'Date,Time,Weekday,Artist,Song,Album,Seconds heard,Song length (seconds),Source,How time was counted', 'CSV has a header row');
  ok(csvLines.length - 1 === playsAll, 'CSV has one row per play (' + (csvLines.length - 1) + ')');
  ok(csvLines.some((l) => l.includes(',Spotify,Exact, from Spotify') || l.includes(',Spotify,"Exact, from Spotify"')) && csvLines.some((l) => l.includes(',Last.fm,')), 'CSV marks Spotify and Last.fm plays');
  const csvSum = csvLines.slice(1).reduce((s, l) => { const m = l.match(/,(\d+),(\d*),(Spotify|Last\.fm),/); return s + (m ? +m[1] : 0); }, 0);
  const heroSecs = ((m) => +m[1] * 3600 + +m[2] * 60 + +m[3])(allHero.match(/(\d+)h (\d+)m (\d+)s/));
  ok(Math.abs(csvSum - heroSecs) <= playsAll * 0.5 + 1, 'CSV seconds add up to the total on screen (' + csvSum + ' vs ' + heroSecs + ')');

  const img = await download(page, 'save-image');
  const [iw, ih] = pngSize(img.buf);
  ok(img.name === 'listening-card-all-time.png' && iw === 1080 && ih === 1920, 'image card saved as ' + img.name + ', ' + iw + ' by ' + ih);
  fs.copyFileSync(img.file, path.join(TMP, 'card-hifi.png'));

  await page.emulateMedia({ media: 'print' });
  ok(await page.evaluate(() => getComputedStyle(document.getElementById('app')).display !== 'none'), 'printing before making a report prints the page, not a blank sheet');
  await page.emulateMedia({ media: 'screen' });
  await fid(page, 'save-pdf');
  await page.waitForSelector('#print-report', { state: 'attached' });
  ok(await page.evaluate(() => window.__printed) === 1, 'PDF report opens the print window');
  ok(await page.$eval('#print-report', (e) => getComputedStyle(e).display) === 'none', 'the printed report never shows on screen');
  await page.emulateMedia({ media: 'print' });
  ok(await page.evaluate(() => getComputedStyle(document.getElementById('print-report')).display === 'block' && getComputedStyle(document.getElementById('app')).display === 'none'), 'when printing, only the report is printed');
  const pdfFile = path.join(TMP, 'report-all.pdf');
  await page.pdf({ path: pdfFile, format: 'Letter', printBackground: false });
  await page.emulateMedia({ media: 'screen' });
  const pdfText = cp.execFileSync('pdftotext', ['-layout', pdfFile, '-']).toString();
  ok(/All time/.test(pdfText) && /Top songs/.test(pdfText) && /Top artists/.test(pdfText) && /Month by month/.test(pdfText) && /Statistics/.test(pdfText), 'the PDF has the title, top lists, months and statistics');
  ok(await page.evaluate(() => document.title) === 'Listening report All time', 'the PDF is offered as "Listening report All time"');

  // a month: the CSV holds only that month, and the PDF breaks it down by day
  await fid(page, 'g-month');
  await page.selectOption('select.period', '2026-09');
  const sepPlays = await page.$eval('.kpi .v', (e) => +e.textContent.replace(/,/g, ''));
  const csvSep = await download(page, 'save-csv');
  const sepRows = csvSep.buf.toString('utf8').trim().split(/\r\n/).slice(1);
  ok(csvSep.name === 'listening-plays-2026-09.csv' && sepRows.length === sepPlays && sepRows.every((l) => l.startsWith('2026-09-')), 'September CSV has only September (' + sepRows.length + ' plays)');
  await fid(page, 'save-pdf');
  await page.emulateMedia({ media: 'print' });
  const pdfSep = path.join(TMP, 'report-sep.pdf');
  await page.pdf({ path: pdfSep, format: 'Letter' });
  await page.emulateMedia({ media: 'screen' });
  ok(/Sep 2026/.test(cp.execFileSync('pdftotext', [pdfSep, '-']).toString()) && /Day by day/.test(cp.execFileSync('pdftotext', [pdfSep, '-']).toString()), 'September PDF is broken down by day');
  ok(await page.$$eval('#print-report', (l) => l.length) === 1, 'making a second report replaces the first');
  for (const l of ['wrapped', 'swiss']) {
    await fid(page, 'look-' + l);
    const c = await download(page, 'save-image');
    fs.copyFileSync(c.file, path.join(TMP, 'card-' + l + '.png'));
    ok(pngSize(c.buf)[0] === 1080, 'image card in the ' + l + ' look');
  }
  await fid(page, 'look-hifi');
  await fid(page, 'g-all');

  // memory does not grow with use
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  const snap = async () => { await cdp.send('HeapProfiler.collectGarbage'); return Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value])); };
  for (let i = 0; i < 6; i++) await page.$eval(i % 2 ? '[data-fid="tab-artists"]' : '[data-fid="tab-tracks"]', (b) => b.click());
  const m0 = await snap();
  for (let i = 0; i < 60; i++) await page.$eval(i % 2 ? '[data-fid="tab-artists"]' : '[data-fid="tab-tracks"]', (b) => b.click());
  for (let i = 0; i < 10; i++) await page.$eval(i % 2 ? '[data-fid="g-all"]' : '[data-fid="g-year"]', (b) => b.click());
  for (let i = 0; i < 9; i++) await page.$eval('[data-fid="look-' + ['wrapped', 'swiss', 'hifi'][i % 3] + '"]', (b) => b.click());
  const m1 = await snap();
  ok(m1.Nodes <= m0.Nodes * 1.15 && m1.JSEventListeners <= m0.JSEventListeners * 1.15,
    'no build-up after 79 taps (page elements ' + m0.Nodes + ' then ' + m1.Nodes + ', listeners ' + m0.JSEventListeners + ' then ' + m1.JSEventListeners + ')');

  // the chosen look is in place before the page draws, and remembered
  await fid(page, 'look-swiss');
  const p2 = await ctx.newPage();
  await p2.addInitScript(() => { document.addEventListener('DOMContentLoaded', () => { window.__early = document.documentElement.getAttribute('data-design'); }); });
  await p2.goto(BASE(), { waitUntil: 'load' }); await p2.waitForSelector('.hero-num');
  ok(await p2.evaluate(() => window.__early) === 'swiss', 'the saved look is in place before the page draws (no flash)');
  await p2.close();
  await fid(page, 'look-hifi');
  await ctx.close();

  // ---------------------------------------------------------------- problems shown on the page
  ctx = await browser.newContext(phone);
  served = { listening: Object.assign({}, demo, { status: { ok: false, message: 'Could not reach Last.fm after several tries.', notes: [] }, asOf: null }), dataMaxAge: 600 };
  page = await open(ctx); await page.waitForSelector('.hero-num');
  ok((await page.textContent('.banners')).includes('Could not reach Last.fm'), 'a failed update shows a note with the reason, and the history is still shown');
  await ctx.close();
  ctx = await browser.newContext(phone);
  served = { listening: Object.assign({}, demo, { status: { ok: true, message: '', notes: ['The Spotify history file could not be read (not made by the import page).'] } }), dataMaxAge: 600 };
  page = await open(ctx); await page.waitForSelector('.hero-num');
  ok((await page.textContent('.banners')).includes('Spotify history file could not be read'), 'a broken Spotify file is explained on the page');
  await ctx.close();
  ctx = await browser.newContext(phone);
  served = { listening: Object.assign({}, demo, { status: { ok: false, message: 'Last.fm rejected the API key.' }, asOf: null, plays: { t0: 0, dt: [], tr: [] } }), dataMaxAge: 600 };
  page = await open(ctx); await page.waitForSelector('.state h2');
  ok((await page.textContent('.state h2')) === 'The update could not run' && (await page.textContent('.state')).includes('rejected the API key'), 'a setup mistake before any data explains itself on the page');
  await ctx.close();
  ctx = await browser.newContext(phone);
  served = { listening: null, dataMaxAge: 600 };
  page = await open(ctx); await page.waitForSelector('.state h2');
  ok((await page.textContent('.state h2')) === 'No listening data yet', 'before the first update: instructions instead of a blank page');
  await ctx.close();
  ctx = await browser.newContext(phone);
  served = { listening: demo, raw: JSON.stringify(demo).slice(0, 5000), dataMaxAge: 600 };
  page = await open(ctx);
  const cut = await page.waitForSelector('.state h2', { timeout: 5000 }).then(() => true, () => false);
  ok(cut && (await page.textContent('.state')).includes('cut short'), 'a data download cut short says so instead of loading forever');
  await ctx.close();
  ctx = await browser.newContext(phone);
  served = { listening: demo, dataMaxAge: 0 };
  page = await open(ctx); await page.waitForSelector('.hero-num');
  await ctx.setOffline(true);
  const p3 = await ctx.newPage();
  await p3.goto(BASE(), { waitUntil: 'load' }).catch(() => {});
  const shown = await p3.waitForSelector('.hero-num', { timeout: 5000 }).then(() => true, () => false);
  ok(shown && (await p3.textContent('.banners')).includes('No connection'), 'offline: the saved copy is shown with a note');
  await ctx.close();
  served = { listening: demo, dataMaxAge: 600 };

  // ---------------------------------------------------------------- Spotify import page
  cp.execFileSync('python3', [path.join(__dirname, 'spotify_fixture.py'), TMP]);
  const expect = JSON.parse(fs.readFileSync(path.join(TMP, 'expected.json'), 'utf8'));
  ctx = await browser.newContext(phone);
  page = await open(ctx, 'import.html');
  ok(await page.evaluate(() => document.documentElement.getAttribute('data-design')) === 'hifi', 'import page uses the chosen look');
  await page.setInputFiles('#files', path.join(TMP, 'my_spotify_data.zip'));
  await page.waitForSelector('#download', { timeout: 15000 });
  const sum = await page.textContent('#result');
  ok(sum.includes(expect.zip.plays + ' plays found'), 'zip: ' + expect.zip.plays + ' plays found');
  ok(sum.includes(expect.zip.short + ' plays under 30 seconds') && sum.includes(expect.zip.other + ' podcasts') && sum.includes(expect.zip.dupes + ' plays listed twice'), 'zip: skips, podcasts and repeats are counted and left out');
  ok(await page.isVisible('#upload-steps'), 'upload steps appear');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
  const spFile = path.join(TMP, 'spotify-history.json');
  await dl.saveAs(spFile);
  const spText = fs.readFileSync(spFile, 'utf8'), sp = JSON.parse(spText);
  ok(dl.suggestedFilename() === 'spotify-history.json' && sp.source === 'spotify' && sp.plays.length === expect.zip.plays, 'downloads spotify-history.json with ' + sp.plays.length + ' plays');
  ok(expect.private.every((x) => !spText.includes(x)), 'no IP address, username, device or email in the file');
  ok(sp.plays.every((r, i) => r.length === 5 && (i === 0 || sp.plays[i - 1][0] <= r[0])), 'each play has time, seconds, artist, song and album, oldest first');
  const firstExt = sp.plays.find((r) => r[3] === 'Song 0');
  ok(firstExt && firstExt[0] === expect.first_extended_start && firstExt[1] === 200, 'start time is the end time minus the seconds played');
  const loaded = cp.execFileSync('python3', ['-I', '-c',
    'import importlib.util,sys;s=importlib.util.spec_from_file_location("f",sys.argv[1]);f=importlib.util.module_from_spec(s);s.loader.exec_module(f);r,p=f.load_spotify();print(len(r),p)',
    path.join(ROOT, 'fetch.py')], { env: Object.assign({}, process.env, { SPOTIFY_FILE: spFile }) }).toString().trim().split('\n').pop();
  ok(loaded === expect.zip.plays + ' None', 'the update script reads the downloaded file (' + loaded + ')');

  await page.setInputFiles('#files', path.join(TMP, 'Streaming_History_Audio_2026_0.json'));
  await page.waitForFunction((n) => document.getElementById('result').textContent.includes(n + ' plays found'), expect.json.plays);
  ok(true, 'a single JSON file from inside the zip works too (' + expect.json.plays + ' plays)');
  fs.writeFileSync(path.join(TMP, 'notes.json'), JSON.stringify({ hello: 'world' }));
  await page.setInputFiles('#files', path.join(TMP, 'notes.json'));
  await page.waitForFunction(() => document.getElementById('result').textContent.includes('do not look like Spotify history'));
  ok(!(await page.isVisible('#upload-steps')), 'a file that is not Spotify history gets a clear message');
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'import page fits the phone screen');
  await page.screenshot({ path: path.join(TMP, 'import.png'), fullPage: true });
  await ctx.close();

  const real = problems.filter((p) => !/404|Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(p));
  ok(real.length === 0, 'no script errors or warnings' + (real.length ? ': ' + JSON.stringify(real) : ''));
  await browser.close(); srv.close();
  console.log('Files for inspection in ' + TMP);
  console.log(fails + ' failure(s)');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('TEST SCRIPT FAILED', e); process.exit(1); });
