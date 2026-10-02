# LiveMixer: notes for Claude

An interactive Pepper's-ghost installation. A visitor's hand (Leap Motion) moves creatures in a browser simulation
and reshapes a continuous DJ set playing in Ableton Live. It must run **unattended for hours on an M3 Pro MacBook**;
anything you add must recover from drops by itself. The owner develops on a Windows PC (Live 11 Suite) and shows on
the Mac. Read [docs/SHOW.md](docs/SHOW.md) first on the Mac.

## The chain

```
Leap (Ultraleap Hyperion, LeapC)
 └ bridge/depth_bridge.py --source leap   (bridge/run-leap.sh loops it)   WebSocket → sim page
sim.html  (src/sim/: host, input conditioning, Tide / Lantern / Murmuration)   hands, palmUp, grip, signals
 └ BroadcastChannel "livemixer-sim" telemetry (same origin AND same browser profile)
ableton.html  (src/ableton/main.ts, living.ts, link.ts; src/living/governor.ts + hands.ts)
 └ WebSocket 9001 → scripts/ableton-bridge.py
      ├ MIDI CC20 vocals / CC21 space / CC23 gain, channel 16 → IAC Driver "LiveMixer" (Mac) / loopMIDI (Windows)
      └ OSC UDP 7403 /fx/values (16 floats) → Max for Live "LiveMixer Living FX" (devices/…/living-fx.js) in Live
           Living FX → UDP 7401 /livemixer/state (beat, playing, vocal gain, bound) + /livemixer/levels (meters)
             → bridge status → page → sim music message (beat follow, Murmuration pulses with the levels)
```

- Music design: [docs/LIVING-MUSIC.md](docs/LIVING-MUSIC.md) (axes, fx contract, gesture table). Gesture design and
  its revision: `docs/superpowers/specs/2026-10-02-hand-gesture-audio-design.md`.
- Simulations: [docs/LIVING.md](docs/LIVING.md), [docs/SIMULATIONS.md](docs/SIMULATIONS.md).
- Set building and Fadr: [docs/FADR.md](docs/FADR.md). Show operations: [docs/SHOW.md](docs/SHOW.md).
  Leap bridge: [bridge/README.md](bridge/README.md).

## Commands

| What | Command |
|---|---|
| Whole show (supervised, Mac) | `npm run show` (`-- --dry-run`, `-- --no-browser`); `npm run show:install` = LaunchAgent |
| Dev pages | `npm run dev` → http://127.0.0.1:4178/sim.html?source=pointer&sim=murmuration, /ableton.html?connect=1 |
| Ableton bridge alone | `uv run scripts/ableton-bridge.py --midi-port "IAC Driver LiveMixer"` (`--fail-safe living` is default) |
| Leap bridge alone | `sh bridge/run-leap.sh` |
| Get audio + build the show set | `scripts/sync-and-build-set.sh` (Drive → `.fadr/`, then builds `.fadr/groop-show/LiveMixer Show.als`) |
| Build a set by hand | `python scripts/ableton-stem-set.py --from-rendered --merge --live 11 --gestures --natural-speed --style crossfade --overlap-bars 2 --order .fadr/groop-show/order-camelot.txt -o "<set>.als" --force` (needs numpy) |
| Regenerate Live 11 templates | `python scripts/make-live11-templates.py` (Windows: reads Live 11's own presets; output is committed) |

Tests (all should pass; run what you touch):

```sh
npx tsc --noEmit -p tsconfig.json && npx vitest run            # 512 TS tests
python -m pytest -q tests/test_ableton_set_xml.py tests/test_ableton_transitions.py
python -m unittest discover -s tests -p "test_ableton_bridge.py"
node --test tests/living-fx.test.mjs                           # Max JS against a mock LiveAPI
cd bridge && python -m pytest -q test_bridge.py test_leap_stereo.py
```

`bridge/test_bridge.py::UprightDumpTests::test_upright_dump_matches_the_protocol` is flaky (fails ~1 in 4 runs,
`scanModelFraction` 1.0); rerun it before treating it as a regression.

## Mac bring-up checklist (first session on the MacBook)

Nothing below has been run on a Mac yet; it was all built and tested on Windows.

1. `npm ci`; install uv, Chrome, Ultraleap Hyperion, Google Drive for desktop; IAC bus **LiveMixer**, Remote on in Live.
2. `scripts/sync-and-build-set.sh`; check it finds `~/Library/CloudStorage/GoogleDrive-*/My Drive/livemixer`.
3. **Live 12.** The Mac probably runs Live 12. The sets are written for Live 11 (`--live 11`; there is no Live 12
   device XML for the gesture layout); Live 12 opens them. Living FX finds parameters **by name**, and names differ
   between versions (Utility's gain is `Gain` in Live 11, `Output` in Live 12; the vocal mirror already accepts
   both). After opening the set, Living FX's status must read `vocals 48/48 · gestures 12/12`. If not, read the real
   names: stop the bridge (it owns UDP 7401), listen on 7401, send OSC `/fx/command dumpparams` to 7403, and adjust
   the `param(...)` names in `living-fx.js` (`init`, the `gref` block) to accept both. `/fx/command compile` then
   `/fx/command init` reloads the script in the running device. Scales (Live 11, measured with `str_for_value`):
   Auto Filter Frequency 20..135 (135 ≈ 19.9 kHz, 70 ≈ 450 Hz, 113 ≈ 5.5 kHz); Utility Gain −1..1 ≈ 35 dB/unit;
   Utility Stereo Width v → 100·v² %; EQ Eight band frequency 0..1 log 10 Hz–22 kHz, gains ±15 dB; Auto Filter LFO
   Frequency 0..1 doubling per 0.1 (0.8 = 2.5 Hz, 1 = 10 Hz), LFO Amount 0..30; Spectral Time `Frozen`, `Dry Wet`,
   `Fade In` (0.3 ≈ 230 ms). Re-measure on Live 12 rather than assume.
4. `npm run show`; check the controls window says **Live connected** (Living FX sends bound = 1) and moves with a hand.
5. Unplug/replug the Leap, quit Chrome, `kill` a bridge: each must come back (see "What recovers by itself" in SHOW.md).
6. Calibrate the hologram in the show's Chrome window (calibration is per profile and port 4179).

## Conventions

- Max JS (`living-fx.js`) is ES5 (no let/const/arrows). It writes LiveAPI values only through `put()` (cached ids,
  write-on-change); never read `LiveAPI.id` or loop over every song per tick — that froze Live 11's main thread once
  (thousands of LiveAPI calls a second). Per-song writes go only to the songs near the playhead (from the `SONG:`
  locators) and at most 64 per tick; writing all 48 songs whenever a hand moved froze Live again. Diagnostic dumps are
  slow and run only on request.
- The `/fx/values` contract grows by **appending**; a missing value means home on every side (page, bridge,
  device), so old pages and devices keep working. Keep `GESTURE_KEYS` (governor.ts), `FX`/`FX_HOME` (bridge) and
  `GHOME` (living-fx.js) in the same order.
- Set builder output for existing flags must not change unless intended; the XML tests pin layout, ids, sends,
  envelopes, routing (nested groups must route `AudioOut/GroupTrack`, never Master) and the arrangement loop.
- Pointer source fakes gestures for desk testing: Shift = fist, hold U / D = palm up / down.

## Things learned the hard way

- **Live can't open sets from a newer Live.** Porting XML down by hand crashed Live 11; build from genuine
  templates of the target version instead (`make-live11-templates.py`). Live's log
  (`%APPDATA%/Ableton/Live x.y/Preferences/Log.txt`, Mac `~/Library/Preferences/Ableton/Live x.y/Log.txt`) shows
  load errors with line/column.
- **Natural speed** (`--natural-speed`): clips are unwarped (loop points in seconds, positions in beats) and Live's
  tempo steps at each overlap's end, so a wrong tempo estimate (e.g. "red": 84 BPM analysed as 112) never bends audio.
  Beat-synced effects (Beat Repeat) are unreliable on such songs; the freeze uses Spectral Time for that reason.
- **Analysis cache** (`_analysis.json`) is keyed on the worker's hash with line endings normalised, so caches made
  on either OS are reused. Builder file I/O is UTF-8 everywhere (Windows cp1252 garbled names like FORLÖRN).
- **Fadr** (`npm run fadr -- split …`) drives fadr.com in Chrome; Google sign-in fails in an automated browser, so
  sign in once in a normal Chrome with `--user-data-dir=.fadr/chrome` and pass `--profile .fadr/chrome` with
  `LIVEMIXER_BROWSER_EXECUTABLE`. Fadr redesigned in 2026; the upload/Pro selectors were updated then.
- **python-rtmidi 1.5.8** only has wheels up to Python 3.12; a source build on 3.13 crashed on import, so the
  bridge pins `requires-python <3.13`.
- **Ports:** dev server 4178, show server 4179, page↔bridge 9001, bridge→device 7403, device→bridge 7401. Only one
  process can listen on 7401; stop the bridge before listening there yourself.
- Windows-only: in Git Bash heredocs, backslashes in inline Python get mangled — write helper files instead.

## Audio data

Not in git (`.fadr/` is ignored). Source of truth is Google Drive `My Drive/livemixer/`: `groop-show/` (finished
renders `rendered-stems/NN Artist - Title/` with `_render.json` + `_analysis.json`, `tempo-key.json`,
`order-camelot.txt`, `songs.csv`) and `additions/` (Fadr batch for songs added later: 48 Patrick Watson – Ode to
Vivian (Rework), YouTube Gr1FRsL6D_M trimmed 0:00–1:36; 49 KAI – red). The old "48 Patrick Watson - Ode to Vivian"
render is still on Drive but unused (the setlist names the Rework explicitly). When adding a song, put its render,
analysis and the updated `tempo-key.json` / `order-camelot.txt` on Drive so the Mac can rebuild.
