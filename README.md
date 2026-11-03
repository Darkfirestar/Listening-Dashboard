# Listening dashboard

A personal "Spotify Wrapped" for everything you play, built on the scrobbles that
Pano Scrobbler already sends to Last.fm (account: Mungusx), plus your older Spotify history
if you add it. You can save any period as a PDF report, an image card or a spreadsheet.

## How it works

1. Pano Scrobbler records each song you play in Samsung Music and sends it to Last.fm.
   The first update reads your entire Last.fm history, not only recent plays.
2. A GitHub Action runs four times a day. It runs `fetch.py`, which downloads your
   new scrobbles, looks up each song's length (Last.fm, then Deezer, iTunes, MusicBrainz)
   and each artist's genres (Last.fm tags). It saves your history to `data/library.json`
   and writes a compact copy for the page to `docs/data/listening.json`.
3. GitHub Pages publishes the `docs/` folder. The dashboard page reads the compact file
   and does the calculations in your browser when you open it.

If Last.fm is down or something is set up wrong, the site still updates with your saved
history, the dashboard shows a note saying what went wrong, and the run is marked with a red
cross so you notice.

Everything is free. Your Last.fm API key lives in a GitHub secret and is never written
to any file.

**Privacy:** free GitHub Pages needs a public repository, so the page and the data file
(your play history) are readable by anyone with the link. Last.fm profiles are public by
default, so this normally reveals nothing new.

## One-time setup (about 15 minutes, no coding)

Do these in order. A computer is easier than a phone for steps 4 and 5.

### 1. Create the repository
1. Sign in at github.com and press the **+** at the top right, then **New repository**.
2. Repository name: `listening-dashboard`.
3. Choose **Public**. Leave every other box unticked.
4. Press **Create repository**.

### 2. Add your Last.fm API key as a secret
1. In the repository, open **Settings**, then **Secrets and variables**, then **Actions**.
2. Press **New repository secret**.
3. Name: `LASTFM_API_KEY` (exactly, capital letters). Secret: your API key.
4. Press **Add secret**.

### 3. Turn on GitHub Pages
1. In **Settings**, open **Pages**.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
   (Wording can differ slightly. You want the option that deploys from a workflow, not from a branch.)

### 4. Upload the project
**Use a computer for this step.** A phone browser can only pick single files, not folders, so
every file would land in the top level and the site would not work.

1. Unzip `listening-dashboard.zip` on your computer.
2. In the repository, press **Add file**, then **Upload files**.
3. Drag in everything that is inside the unzipped folder (the `docs` folder, `fetch.py`,
   `README.md`, `tests`, and the hidden `.github` folder). Dragging the folders keeps their layout.
4. Press **Commit changes**.

**If the `.github` folder did not upload** (hidden folders are sometimes skipped), add it by hand:
press **Add file**, then **Create new file**. In the name box type
`.github/workflows/update.yml` (typing each `/` makes a folder), paste the contents of
`update.yml` from this project, and press **Commit changes**.

### 5. Run the first update
1. Open the **Actions** tab. Uploading the files normally starts a run called
   **Update listening data**. If you do not see one, choose it in the left list and press **Run workflow**.
2. Wait for a green check mark. The first run downloads your whole history and looks up
   every song, so allow 10 to 30 minutes.
3. Open **Settings**, then **Pages**. The address of your dashboard is shown at the top. It
   should be `https://darkfirestar.github.io/listening-dashboard/`.

### 6. Put it on your Galaxy home screen
1. Open that address in Chrome on the S23+.
2. Open the three-dot menu and choose **Add to Home screen** (or **Install app**).

Until the first run finishes, the page shows a "No listening data yet" message with a link to
sample data, so you can preview the design.

## What the dashboard shows

- Total time listened to the second, for all time, any year, quarter or month.
- Month by month, quarter by quarter and year by year tables and bar charts. Tap a bar to open that period.
- Day-by-day chart with a 7-day average (30-day once a period is longer than six months).
- A 24-hour clock and an hour-by-weekday heat map showing when you listen.
- Top songs, artists, albums and genres, by time or by plays.
- Statistics: average, median and spread of daily listening, trend with a significance test,
  weekday versus weekend test, how concentrated your taste is, sessions and streaks.
- An "About this data" section showing how many songs have no known length.

## Looks

Choose between three looks with the buttons at the top of the dashboard: **Hi-fi** (a 1970s
stereo with glowing amber numbers; the default), **Wrapped** (bold blocks of flat color) and
**Swiss** (black, white and red). Your choice is remembered on that phone, and switching
redraws nothing, so it is instant. Every look has every feature.

To preview a look with sample data, add `?demo=1&design=hifi` (or `wrapped`, `swiss`) to the
address.

## Saving a report

Pick a period at the top (all time, a year, a quarter or a month), then use **Save this period**:

- **PDF report**: a printable report with the total, month-by-month (or day-by-day for a
  month) breakdown, top 10 songs, artists, albums and genres, when you listen, and the key
  statistics. Your phone's print window opens; choose **Save as PDF**, then **Download**.
- **Image card**: a 1080 by 1920 picture in the look you are using, sized for stories and
  sharing. It goes to your downloads.
- **Spreadsheet (CSV)**: every play in the period with date, time, artist, song, album,
  seconds heard, song length and source. Opens in Google Sheets or Excel.

The report code only downloads the first time you use one of these buttons.

## Adding your Spotify history

Your Last.fm history starts when Pano Scrobbler started. To add what you played on Spotify
before that:

1. On spotify.com, open your account's Privacy settings. Under **Download your data**, tick
   **Extended streaming history** and request it. Spotify says it can take up to 30 days.
2. When the email arrives, download the zip to your phone.
3. On the dashboard, scroll to **About this data** and tap **Add Spotify history**. Choose the
   zip (or the JSON files inside it). It is read on the phone only. The page shows what it
   found and makes **spotify-history.json**, keeping only times, seconds played, artists,
   songs and albums. Skips under 30 seconds, podcasts and videos are left out, and so are your
   IP addresses, devices and account details.
4. On github.com, open your repository's **data** folder, press **Add file**, then
   **Upload files**, choose spotify-history.json and press **Commit changes**. An update starts
   by itself.

Spotify plays count the exact seconds you listened. A Spotify play that Last.fm already has (the
same song within 10 minutes) is left out, so nothing counts twice. To refresh it later, make a
new file the same way and upload it; it replaces the old one. Like your Last.fm history, the
file is readable by anyone who finds the public repository.

## Battery and data use

Nothing from this project runs on your phone in the background. The only app that runs in the
background is Pano Scrobbler, which you were already using. The dashboard does work only while
it is open and only when you tap or scroll. It has no timers, no polling and no animations.

- Opening it downloads one compact data file. The browser keeps it, so reopening within 10
  minutes downloads nothing. After that the browser asks "has it changed?" and gets a tiny
  "no" unless an update has run (at most four times a day).
- Each look downloads only its own fonts (two or three small files), once.
- Taps only redraw the part of the page they change, and results are reused.
- Measured on three years of heavy listening (66,000 plays) with the processor slowed four
  times to mimic a slower phone: first view about 0.7 seconds, most taps under 0.1 seconds,
  about 6 MB of memory.

Only if scrobbles go missing: Pano may be getting stopped by battery saving. Open Settings,
Apps, Pano Scrobbler, Battery and choose Unrestricted. Otherwise leave it as it is.

## Three honest limits

- **Time is an estimate.** Last.fm stores when a song started, not how long you heard it.
  The default mode counts the full song length unless the next song started sooner. A pause
  cannot be detected. You can switch to full song length at the bottom of the page.
- **Songs skipped early are not counted at all.** Last.fm only records a song once you have
  played about half of it (or four minutes). Pano Scrobbler has its own setting for this
  threshold. Anything skipped before that point never reaches Last.fm, so total time runs
  slightly low if you skip a lot.
- **History starts when Pano first ran.** Nothing from before can be recovered.

## Fixing problems

| What you see | What to do |
| --- | --- |
| A note at the top of the dashboard saying the last update did not finish | It says why. Fix that if it is a setup problem; if Last.fm was down, nothing is needed and the next run tries again. |
| Red cross on a run in the Actions tab | Open the run, open the step "Pull new scrobbles", and read the last lines. The site was still updated with your saved history. |
| "Last.fm sent only ... of the ... plays it reports" | Nothing. Last.fm skipped part of your history twice in a row, so the update stopped rather than save or delete the wrong plays. The next run tries again. |
| "Last.fm says this profile is private" | In Last.fm settings under Privacy, untick "Hide recent listening information". |
| "Last.fm rejected the API key" | Check the `LASTFM_API_KEY` secret for typos or extra spaces. |
| "Get Pages site failed" or "Not Found" in the deploy step | Redo step 3. Source must be GitHub Actions. |
| Dashboard says "No listening data yet" | Run the workflow (Actions tab, Update listening data, Run workflow), then reload. |
| Some songs have no length | They are listed in "About this data". They count as plays but add no time. Runs retry them every 14 days. |
| Updates stopped | GitHub pauses scheduled runs after 60 days with no repository activity. Open the Actions tab and press Enable. |
| A note saying the Spotify history file could not be read | Make the file again with the import page and upload it once more. Your Last.fm data is not affected. |
| Spotify plays do not appear after uploading | Check the file is in the **data** folder and named exactly `spotify-history.json`, and that the update run after the upload has a green check. |
| The PDF button does nothing visible | Your phone's print window should open. If it does not, try Chrome's menu, Share, then Print, and choose Save as PDF. |
| A play you deleted on Last.fm long ago still shows | Each run re-reads the last 14 days. For older deletions, open Actions, choose Update listening data, press Run workflow, tick "Re-read the whole Last.fm history", and run it. |

A very large history may need more than one run for all lookups. Each run does up to 800 song
lookups and 800 artist lookups, stops looking things up after 90 minutes so it always has time
to save, and carries on at the next run.

## Changing settings

Open `.github/workflows/update.yml` and edit it on GitHub with the pencil icon.

- `LASTFM_USER`: the Last.fm username.
- `TZ_NAME`: only used for `summary.json` (today, this week, this month). The dashboard itself
  uses the time zone of the device you view it on.
- `cron`: when it runs. `17 */6 * * *` means minute 17 of every sixth hour, in UTC.

## Home-screen widget

Each run also writes `docs/data/summary.json`, a tiny file with today's, this week's and this
month's listening time, the total, and this month's top artist and song. A widget app can read it
at `https://darkfirestar.github.io/listening-dashboard/data/summary.json`. Building the widget
itself is a separate step that has not been tested yet.

## For developers

```
fetch.py                    Last.fm, Spotify backlog, lengths and genres; saves data/library.json,
                            writes docs/data/
data/library.json           your saved Last.fm history (created by the first run; committed, not published)
data/spotify-history.json   optional Spotify backlog you upload (made by docs/import.html)
docs/                       the dashboard (index.html, app.js, engine.js, stats.js, style.css)
docs/report.js              PDF, image and CSV reports (downloaded only when used)
docs/import.html, import.js the Spotify import page
docs/fonts/                 fonts for the three looks (SIL Open Font License, see LICENSE.txt)
docs/data/listening.json    compact data for the page (written by every run, not committed)
docs/data/demo.json         sample data, shown at ?demo=1
tests/run_fetch_test.py     end-to-end test of fetch.py against fake Last.fm, Deezer, iTunes, MusicBrainz,
                            including Last.fm down, bad key, missing secret, empty pages, quiet runs,
                            full resync and the Spotify backlog
tests/stats.test.js         statistics checked against scipy reference values
tests/engine.test.js        dashboard numbers checked against an independent Python calculation
tests/browser.test.js       the dashboard, reports and import page in a phone-sized browser (needs Playwright)
tests/spotify_fixture.py    a fake Spotify download used by the browser tests
```

Run the tests with:

```
python3 tests/run_fetch_test.py
node tests/stats.test.js
TZ=America/Los_Angeles node tests/engine.test.js
node tests/browser.test.js        # after: npm install playwright && npx playwright install chromium
```

To preview locally: `python3 -m http.server 8000 --directory docs` and open
`http://localhost:8000/?demo=1`.
