# Spotify playlist to Fadr stems

The local workflow imports a public Spotify song list, matches full songs on YouTube, saves MP3s, then operates Fadr's visible web interface to upload, split, download ZIPs, and extract a separate folder for each song.

Install the project's dependencies (`npm ci`), Chromium (`npx playwright install chromium`), Python 3, and `uv`. The audio command uses an isolated `uv` environment with yt-dlp and a bundled FFmpeg. Credentials, source audio, archives, browser profile, and progress stay in ignored `.fadr/`, outside Vite's public directory.

```sh
npm run fadr -- import "https://open.spotify.com/playlist/PLAYLIST_ID" --output .fadr/my-playlist
npm run fadr:audio -- .fadr/my-playlist/playlist.local.json
npm run fadr -- split .fadr/my-playlist/playlist.local.json
```

The split command opens a dedicated browser. Sign in directly there when prompted. Use your existing Fadr Plus subscription for Pro; the script does not purchase a subscription. Close any earlier automation browser before starting another command with the same profile. `LIVEMIXER_BROWSER_EXECUTABLE` can select an installed Chromium browser.

Google may reject sign-in inside an automation browser. In that case, sign in manually using a normal installed browser with a dedicated profile, quit that browser instance, then reuse its profile for Fadr. For Brave on macOS:

```sh
"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" --user-data-dir="$PWD/.fadr/brave" --no-first-run https://fadr.com/login
# After signing in and quitting that dedicated browser instance:
LIVEMIXER_BROWSER_EXECUTABLE="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" npm run fadr -- split .fadr/my-playlist/playlist.local.json --profile .fadr/brave
```

The normal sign-in window has no automation connection. This does not change browser security settings or access another browser profile's cookies.

If large browser uploads stall or reset, add `--upload-transport curl` to the split command. This sends the exact verified MP3 through `curl` for the storage PUT initiated by Fadr's upload control, using the same destination and request headers. Login, upload initiation, stem processing, and downloads still use Fadr's web interface. It requires `curl` on PATH, limits simultaneous file transfers to three, and retries interrupted storage transfers without retrying authorization failures.

Pro is the default. The script requests every available **More Stems** subdivision and selects all stems for download as MP3. It refreshes Fadr’s download list after processing and checks that the additional vocal and drum stems are present before exporting. Add `--six-only` for the initial Pro set, or `--format wav` for WAV exports. Import with `--basic` for a Basic playlist. The Spotify embed importer rejects potentially truncated lists of 100 or more tracks.

YouTube matches use title, artist/channel, and duration and reject named alternate versions such as live, clean, cover, and slowed edits. These are metadata checks, not a guarantee of identical mastering or recording. `audio.local.json` records the selected URL and alternatives. A second quoted-title search handles poor initial results. Ambiguous tracks are left incomplete, with an error in the progress file; other tracks continue.

Rerun the same commands to resume. Each stage saves progress; existing MP3s and extracted files are verified with SHA-256. Fadr uploads have stable identifiers in their filenames. On a resumed session, the script searches the Fadr library for the prior upload. If a submitted upload cannot be found, it stops so the song can be reopened in Fadr rather than submitted twice. Do not change source audio or export settings in a completed batch; use a new output folder for a different version.

The output layout is:

```text
.fadr/my-playlist/
  playlist.local.json
  audio.local.json
  stems.local.json
  sources/TRACK_ID/Artist _ Song [TRACK_ID].mp3
  archives/TRACK_ID.zip
  stems/TRACK_ID/Bass - Song.mp3
  stems/TRACK_ID/…
  stems/TRACK_ID/_stems.local.json
```

The extraction step rejects unsafe paths, duplicate names, incomplete archives, and missing selected stem roles. It stages each song before publishing its folder and retains the ZIP. It does not convert stems to WAV or add them to a Live Mixer scene. The existing `prepare:fadr` command can prepare supported Pro exports afterward.

`npm run test:fadr` covers matching, safe archive extraction and resumption, and a local browser fixture that exercises Pro subdivisions, selecting all stems, choosing MP3, downloading, and resuming. The fixture is not a live Fadr integration test; Fadr interface changes may require selector updates.
