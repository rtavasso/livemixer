# Running the show

One command starts everything the installation needs on the show Mac and keeps it running unattended:
`npm run show`. It is written for macOS (the show machine is an Apple Silicon MacBook). What the visitor
meets is in [LIVING.md](LIVING.md), and the music side is in [LIVING-MUSIC.md](LIVING-MUSIC.md).

## Set up the Mac (once)

1. **Repository.** Clone it outside Desktop, Documents and Downloads, for example `~/livemixer`. If launchd
   runs the show from one of those folders, macOS blocks it unless `/bin/bash` has Full Disk Access.
   Then run `npm ci`.
2. **Tools.** Install Node (Homebrew `brew install node`, or nvm), uv (`brew install uv`), Google Chrome in
   `/Applications`, and **Ultraleap Hyperion** (Leap Motion Controller software, from
   ultraleap.com/downloads/leap-controller). Run `sh bridge/run-leap.sh` once by hand to check that the Leap
   bridge sees the controller, and let `uv` download its packages.
3. **IAC Driver.** Open Audio MIDI Setup, choose Window > Show MIDI Studio, and double-click **IAC Driver**.
   Tick *Device is online*, then add a port named **LiveMixer**. The bridge finds it as
   `IAC Driver LiveMixer`. If you use another name, set `LIVEMIXER_MIDI_PORT`.
4. **Audio and the set.** Install Google Drive for desktop and sign in, so `My Drive/livemixer` appears under
   `~/Library/CloudStorage`. Then run `scripts/sync-and-build-set.sh`. It copies `groop-show/` (the finished
   renders with their cached beat analysis, `tempo-key.json`, `order-camelot.txt`) and `additions/` (the Fadr
   files for songs added later) from Drive into `.fadr/`, about 7 GB the first time, and builds
   `.fadr/groop-show/LiveMixer Show.als`: 48 songs, merged stems, natural speed, 2-bar crossfades, the
   RHYTHM / MELODIC gesture layout, and an arrangement loop over the whole set. Run it again after any song
   changes on Drive (`--no-sync` rebuilds from what is already local).
5. **Live.** In Settings > Link, Tempo & MIDI, find the input *IAC Driver (LiveMixer)* and turn **Remote**
   on. Open `LiveMixer Show.als` (it is written for Live 11; Live 12 opens it and asks to save a copy), check
   that **LiveMixer Living FX** on Main reads *Ready · 48 songs · vocals 48/48 · gestures 12/12 …*, and save
   the set. If gestures or vocals read less than all, Live 12 names those parameters differently: see
   *Live 12* in [CLAUDE.md](../CLAUDE.md).
6. **macOS.** Turn on Do Not Focus / Do Not Disturb, turn off automatic macOS updates, and set the
   hologram display's arrangement in Displays. `caffeinate` stops sleep while the show runs, so you do not
   need to change the energy settings. For a show that comes back after a power cut, turn on automatic
   login (this requires FileVault to be off) and install the LaunchAgent (see below).
7. **Calibrate the hologram** once per setup, as described in [LIVING.md](LIVING.md#run-the-show). Do it in
   the simulation window that the show opens. The calibration and the settings are saved in the browser,
   separately for each Chrome profile and address. A calibration made in another browser, or on the dev
   server's port 4178, does not apply to the show.

## Every show

1. Open the Live set and press **Play**. The set loops over all its songs by itself, so it never stops at
   the end.
2. In the repository, run `npm run show`. If the LaunchAgent is installed, it is already running.
3. Do the attendant check from [LIVING.md](LIVING.md#run-the-show). Keep the box empty for the first few
   seconds, because the Leap bridge learns the empty scene.

`npm run show` builds the pages if the source changed since the last show build (`logs/build.log`). It then
starts and supervises these services:

| Service | What it runs |
|---|---|
| `web` | `vite preview` of the production build on http://127.0.0.1:4179. There are no dev-server reloads. |
| `bridge` | `uv run scripts/ableton-bridge.py --midi-port "IAC Driver LiveMixer" --fail-safe living` |
| `leap` | `sh bridge/run-leap.sh` |
| `caffeinate` | `caffeinate -dims`, which prevents display, idle and system sleep |
| `chrome` | One Chrome (its own profile, `~/Library/Application Support/LiveMixerShow`) with two app windows: the simulation, fullscreen, at `sim.html?source=depth&sim=tide&overlay=0`, and the controls page at `ableton.html?connect=1`. The controls page connects to the bridge and selects Living mode by itself. Chrome runs with background throttling off, so neither window slows down when it is hidden. |

To stop the show, press **Ctrl-C**, or run `launchctl bootout gui/$(id -u)/com.livemixer.show` for the
LaunchAgent. Every service stops, and the bridge leaves Live at the fail-safe mix.
`npm run show -- --dry-run` prints what would start without starting anything. Use `--no-browser` to skip
Chrome.

### Settings (environment)

| Variable | Default | |
|---|---|---|
| `LIVEMIXER_SIM` | `tide` | `tide`, `lantern` or `murmuration` |
| `LIVEMIXER_SIM_PARAMS` | | More sim.html query, for example `rotate=20&rotation=tide,lantern,murmuration` |
| `LIVEMIXER_SIM_POSITION` | | `x,y` of the hologram display, for example `1920,0`, so the fullscreen simulation opens there |
| `LIVEMIXER_MIDI_PORT` | `IAC Driver LiveMixer` | The MIDI output to Live |
| `LIVEMIXER_FAIL_SAFE` | `living` | `living`: instrumental (vocals 0, space 0, gain 1). `full`: full vocals, for the old two-song sets |
| `LIVEMIXER_CHROME` | `/Applications/Google Chrome.app/…` | The Chrome binary |

For the LaunchAgent, put these settings in the `EnvironmentVariables` of `scripts/show/LiveMixerShow.plist`
before you install it.

### Start at login (LaunchAgent)

Run `npm run show:install` (or `bash scripts/show/install-launch-agent.sh`). This installs
`~/Library/LaunchAgents/com.livemixer.show.plist` and starts it. launchd starts the show at every login and
starts it again if `show.sh` itself ever exits. `npm run show:uninstall` removes it. While the LaunchAgent
is running, do not also run `npm run show`, because both would compete for the same ports.

## What recovers by itself

| Failure | What happens |
|---|---|
| Any service exits or crashes | It is restarted after 1 s. If it keeps failing, the delay doubles up to 30 s, and it goes back to 1 s once the service has stayed up for a minute. |
| The controls page stops sending (closed, frozen or crashed) | After 1.5 s, the bridge sets Live to the fail-safe mix: instrumental, dry, every FX at home. |
| The bridge restarts | It sends the fail-safe mix as soon as its MIDI port opens. The controls page retries the bridge every 2 s and reconnects by itself. |
| The IAC / loopMIDI port is missing or disappears | The bridge retries every 2 s, logs this once a minute, and sends the whole mix again when the port is back. |
| A MIDI or UDP send fails | The failure is logged and the bridge continues. A failed control is sent again on the next tick. |
| Port 9001 or 7401 is in use | The bridge waits for it and retries every 2 s. While only 7401 is busy, the controls still work, but the beat relay is missing. |
| The Leap service re-enumerates the camera | `run-leap.sh` restarts the depth bridge, and the supervisor restarts `run-leap.sh` if it exits. |
| Chrome quits or crashes, or a show window is closed | Within about 30 s, Chrome is restarted with both windows. |
| `show.sh` itself dies | launchd restarts it after 10 s (LaunchAgent only). |
| Display or system sleep | Prevented by `caffeinate`. |

These failures need a person:
- **Live** crashes or stops playing.
- A page shows **"Aw, Snap!"** or freezes while its window stays open. Press **Cmd-R** in that window, or
  quit Chrome with Cmd-Q; it comes back with both windows.
- The Mac reboots without automatic login.

## Logs

All logs are in `logs/` in the repository (not in git). A file is rotated at 10 MB, and three old copies
are kept (`.1` … `.3`).

| File | Contents |
|---|---|
| `logs/show.log` | Service starts, exits and restarts, plus a health line every minute, for example `health: web=up/0 bridge=up/2 leap=up/0 caffeinate=up/0 chrome=up/0 (service=status/restarts); http://127.0.0.1:4179 answers` |
| `logs/<service>.log` | Everything that service printed (`web`, `bridge`, `leap`, `caffeinate`, `chrome`) |
| `logs/build.log` | The last builds |
| `logs/launchd.log` | Output of show.sh when launchd runs it |

To follow the show, run `tail -f logs/show.log`. To see what the bridge did, run `tail -f logs/bridge.log`.

## Troubleshooting

| Symptom | Check |
|---|---|
| `bridge.log` repeats *MIDI output 'IAC Driver LiveMixer' is unavailable (outputs: …)* | Check that the IAC Driver is online and that its port is named LiveMixer. The log lists the outputs that exist. Set `LIVEMIXER_MIDI_PORT` to one of them. |
| The song does not react, but `bridge.log` is clean | In Live, check that Remote is on for *IAC Driver (LiveMixer)* and that the set is playing. Look at the controls window: it should be connected and in Living mode. |
| Vocals stay off | That is the Living home (instrumental) when nobody is at the box. For a two-song set, use `LIVEMIXER_FAIL_SAFE=full`. |
| `show.log` reports *build: FAILED* | Read `logs/build.log`. The show serves the previous build if there is one. Without one, show.sh exits (and launchd retries it). |
| `web` restarts every few seconds with *port 4179 in use* | Another server is running on 4179, such as a stray `npm run preview` or a second show. Stop it. |
| No Chrome windows appear | Check `logs/chrome.log`. If Chrome is not in /Applications, set `LIVEMIXER_CHROME`. Without Chrome, `show.log` prints the two URLs to open by hand (use one browser profile, in separate windows). |
| The simulation opens on the wrong display | Set `LIVEMIXER_SIM_POSITION` to a point on the hologram display (Displays shows the arrangement). |
| The simulation shows no hands | Check `logs/leap.log` and that Ultraleap Hyperion is running (its menu-bar icon). |
| The LaunchAgent does nothing | Read `logs/launchd.log`. *Operation not permitted* means the repository is in a protected folder (see setup step 1). Check its status with `launchctl print gui/$(id -u)/com.livemixer.show`. |
