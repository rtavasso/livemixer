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

## Ableton mix with one group per song

`scripts/ableton-stem-set.py` writes a Live 12 set that plays the chosen songs as one continuous, beat-matched mix. It reads a folder of song folders (default `.fadr/groop-show/ableton-import`, as built by `fadr-ableton-import.py`); each song becomes a collapsed group named "Artist - Title" containing one audio track per stem, with a `SONG: <name> · <BPM> · <Camelot key>` locator where it enters. The design is in [docs/superpowers/specs/2026-09-24-ableton-transitions-design.md](superpowers/specs/2026-09-24-ableton-transitions-design.md).

```sh
python3 scripts/ableton-stem-set.py --list                        # folder names to choose from
python3 scripts/ableton-stem-set.py ladders 3 "if i ain't" 1 -o "Mix.als"
python3 scripts/ableton-stem-set.py --order setlist.txt -o "Mix.als" --overlap-bars 8
npm run test:ableton-set
```

Selectors are a folder number, an exact name, or a unique part of a name; `--order` takes one per line (`#` comments allowed). Only listed songs are included; with none, every numbered folder is used in folder order.

**Render.** Every stem is decoded and written as 16-bit WAV in `rendered-stems/` beside the stems folder. All stems of a song get exactly the same length: the latest point where any of its stems is above `--silence-db` (default −60 dBFS). Longer stems are cut there with a 10 ms fade; shorter stems are padded with silence. The Groop Show renders take about 6.6 GB. WAV is required: Live cannot stream FLAC or MP3 and must first decode them into `~/Library/Caches/Ableton/Cache/Decoding`, so on a large set most clips stay silent until selected.

**Analyse.** Tempo, beats and downbeats come from librosa, run through `uv` in an isolated environment (librosa 0.10.2 with numba 0.60, the last numba with Intel macOS wheels). Beats are tracked on the drum stems, started from the tempo in `tempo-key.json` beside the stems folder; downbeats are where kicks and bass notes land on beat 1 and snares on 2 and 4. `tempo-key.json` holds each song's listed tempo and key (from sites republishing Spotify's audio features) and can be edited by hand; songs missing from it use the analysed tempo and an unknown key.

**Mix.** Clips are warped on their downbeats (Beats mode for drum stems, Complex Pro for the rest). Each song plays at its own tempo; the master tempo ramps from one song's tempo to the next across the overlap. A song listed at double or half time is played at half or double when that makes the ramp much smaller (Innuendo's 148 BPM is played as 74 next to Back To Us). Overlaps are `--overlap-bars` long (default 16) and start on the outgoing song's last 8-bar phrase that fits before its end; the incoming song's first bar with sound lands there. The style is chosen per transition:

| Condition | Style |
|---|---|
| Keys clash (not the same, adjacent or relative on the Camelot wheel) | Stem handover without melodic overlap; a 4-bar crossfade if either song lacks drums there |
| Compatible keys, tempos within 8% | EQ Three low swap on the song groups |
| Compatible keys, drums and bass in both | Stem handover with the melodies blending |
| Beat grid doubtful, or otherwise | Crossfade |

A stem handover brings the incoming drums in over the first quarter, fades the outgoing melodies and vocals out, swaps the basses on the middle downbeat (never both at once), brings the incoming melodies and vocals in, and fades the outgoing drums over the last quarter. All of it is Arrangement automation on track volumes, group volumes and the EQ Three low gain, so it can be edited in Live.

The script prints each song's tempo, played tempo, key and warnings (an uncertain beat grid, or a bar start that may be a beat off), then each transition's bar, style and reason; the same report is written as `<set>.transitions.json`. Renders (`_render.json`) and analyses (`_analysis.json`) are cached per song, so a new order or overlap length rebuilds in seconds; the first analysis of the 19 songs takes about two minutes. Rendered files are referenced in place; use **File → Collect All and Save** to gather them into a project.
