# Live Mixer

A local desktop-browser instrument for synchronized, authored stem scenes. The base demo uses TypeScript, Vite, native Web Audio, and a local MediaPipe worker. No microphone input, account, or runtime CDN is used. Leap input uses a small local Python reader behind the Vite server; the mouse preview needs no native software.

The **Build mix** tab adds the requested 50-song workflow: external-folder import, stem waveforms and levels, tentative tempo/key analysis, synchronized passage selection and solo audition, a reorderable mix path, project save/restore, and playable WAV/manifest ZIP export. See [the library guide](docs/LIBRARY.md). Tuning and reviews made in the instrument carry back into the library project.

## Run

Use Node.js 22.16 or later and desktop Chromium on Windows/macOS/Linux:

```sh
npm ci
npm run setup:models
npx playwright install chromium
npm run dev
```

Open **http://127.0.0.1:4178/**. It loads the last collection prepared by the Fadr command (Sun in this workspace). The playing view now opens in **Hand space**, with a **Passage** selector / **Next passage** button. Choose **Manual controls** to return to separate Sound shape and Vocals controls. Sound shape responds immediately. **Change timing** defaults to **Next beat** for vocals and passages; **Immediate** uses about 80 ms of scheduled audio time for manual changes, or 155 ms for a Hand space passage change, plus the scheduler tick and output latency. Hand movement itself stays continuous. **Speed & pitch** moves every stem together from 90% to 110%, showing BPM and semitone offset. The separate **Setup** tab groups optional editing, saved stem combinations, and diagnostics into collapsed sections. **Stop all audio** works from every tab, including library previews.

With no prepared collection, the app asks you to load music. It never silently substitutes sine tones. Engineering fixtures remain available explicitly in Setup or at `/?fixtures=1&tools=1`, with a visible test-signal notice.

`npm run dev` regenerates fixtures and bundles the camera worker. `npm run setup:models` downloads a versioned model, verifies its SHA-256, and copies matching WASM from the locked MediaPipe package. Setup needs internet; normal operation afterward is local. The worker is a classic bundled worker because the WASM loader uses `importScripts`.

| Command | Purpose |
|---|---|
| `npm run dev` | Local Vite server on port 4178 |
| `npm run build` | Type-check and build the production app into `dist/` |
| `npm run preview` | Serve the production build locally on port 4179 |
| `npm test` | Pure control, clock, planner, validation, and replay tests |
| `npm run test:browser` | Chromium waveform, worker, and GUI tests |
| `npm run fixtures` | Regenerate synthetic audio and an unapproved manifest |
| `npm run setup:models` | Install verified local hand model and matching WASM |
| `npm run inspect:stems -- "D:/My scenes"` | Read WAV metadata without modifying media |

## Prepared local songs

This workspace has a [LOVE SUPREME - Sun draft](http://127.0.0.1:4178/?collection=love-supreme-sun): three 8-bar passages starting at 41.816, 85.070, and 106.697 seconds, plus the full song in the prepared library. They repeat as a three-passage path when advanced manually. Start audio for the instrumental bed; reach into Hand space to transform the accompaniment and introduce available vocals. In Manual controls, **Bring in vocals** follows the selected Change timing. These are draft selections awaiting listening review.

A prepared collection opens directly with `http://127.0.0.1:4178/?collection=COLLECTION_ID` in Authoring mode. In **Build mix**, **Open full song & waveforms** opens its full-length WAV stems, analysis, and saved passages for editing. It does not start audio and becomes disabled after loading to preserve library edits. **Setup > Open or restore a saved mix > Restore saved passages** instead reloads the saved playing collection. The regular URL opens the collection named by ignored `public/scenes/default.local.json`, written by the preparation command.

For Fadr folders containing Bass, Drums, Vocals, Guitar, Piano, and Pro-other exports, install FFmpeg on PATH, then run the preparation command below. In Windows PowerShell use `npm.cmd` so script flags are forwarded correctly:

```powershell
npm.cmd run prepare:fadr -- "C:/path/to/Fadr stems" --id my-song --label "Artist - Song"
npm.cmd run prepare:fadr -- "C:/path/to/Fadr stems" --id my-song --label "Artist - Song" --reuse --bpm 120 --starts "32,64,96" --bars 8
```

The first pass decodes and checks identical native-rate frame counts, then analyzes full-song levels and tentative tempo/key. The second selects the same frame ranges in every stem and writes an unapproved performance draft plus a library project. Use `--start` for one passage or comma-separated `--starts` for several. `--reuse` checks that the source recordings are unchanged and regenerates the draft; export GUI edits before using it again.

Guitar + Piano + Pro-other become the harmonic **other** stem with no normalization. The full Instrumental export is excluded from the sum. Float WAV preserves decoder/sum headroom; all original files remain untouched. Generated audio, analysis, and configuration live under ignored `public/scenes/COLLECTION_ID/`. Keep them local; Vite includes public assets in a build.

The prepared recipes retain bass/drums/other throughout: the old internal **sparse** and **pulse** slots are identical, so Setup shows them once as **Instrumental**. **With vocals** adds the voice using the selected Change timing. Saved-combination buttons display their actual stem levels and are disabled until playback starts. Hand space now gates vocals with palm presence and continuously transforms the accompaniment. The older webcam tilt input remains available in Manual controls.

## Bring your stems

Your recordings do not need to live in this repository. Use **Setup > Open saved mix folder** to select an external folder containing `manifest.json` and its WAV files. The browser reads selected files locally. A folder layout such as the following works:

```text
My scenes/
  manifest.json
  scene_a/other.wav
  scene_a/bass.wav
  scene_a/drums.wav
  scene_b/other.wav
  scene_b/bass.wav
  scene_b/drums.wav
```

Copy [scene_manifest.example.json](scene_manifest.example.json) into that folder as `manifest.json`. Its paths are nonexistent examples, lengths are illustrative, and approval flags are **false**. Replace the metadata with actual values. The WAV inspector prints sample rate and source frame count; BPM is inferred only from your declared four-bar excerpt and is not a beat detector.

Alternatively, place media beneath ignored `public/scenes/` and use **Open manifest**. In that flow paths are relative to `public/scenes/`. Do not commit user audio. Both `public/scenes/` and generated fixtures/model assets are ignored by Git.

Prepare each scene in an external editor:

1. Start with aligned **other, bass, drums** from one instrumental passage. Export the same contiguous 4- or 8-bar section in every stem, on one reviewed downbeat, in stable 4/4.
2. Use identical sample rate, source frame count, and loop origin. Do not independently trim leading silence, normalize stems, or change playback rate. Keep a full-mix reference outside the runtime.
3. Check the beginning, middle, end, and seam with a metronome. Choose a different excerpt or warp the aligned group offline if a constant grid does not fit.
4. Add vocals only when the complete lyric phrase loops cleanly. Include every vocal gain in all three recipes. The manifest stores a whole-loop vocal grid for authored auditions; the live Next beat and Immediate choices override that wait.

The runtime verifies WAV metadata before decoding, then equal decoded frame counts and source-duration consistency with a small resampling tolerance. Chromium can resample an 8-second WAV to one frame less than a rounded expectation; the decoded duration is the authoritative clock.

## Perform and review

In **Manual controls**, **Sound shape** is a continuous tone change independent of the vocal button. Prepared Fadr passages blend 35% unfiltered instrumental with 65% low-pass filtered instrumental (180 to 12,000 Hz). Keeping a dry component preserves attacks and harmonics at the darkest setting; vocals bypass this filter. They open at 75% shape. Legacy manifests without `filter.target: "instrumental"` retain harmonic-anchor-only filtering. Editing filter settings preserves the target.

In **Setup**, the optional combined mapping changes both tone and arrangement; arrangement-only fixes the tone; tone-only keeps the vocal choice separate. Combined mapping uses hysteresis and a 120 ms dwell. Recipe ramps end on the selected beat, immediate response time, or authored grid. Current, desired, pending, and committed states are shown separately. Saved-combination buttons hold their manual selection until the input moves by more than 0.05 or you change adapters.

All stems share an audio start, loop bounds, and playback speed. Muted stems continue in phase. **Next passage** uses a 20 ms outgoing fade followed by the incoming entry fade (normally 10 ms), at the next beat or immediately; it can leave during the first loop. **Phrase endings** retains the original full-loop exit and one-beat fade for deliberate phrase endings and engineering fixtures. **There is no simultaneous cross-song audio.** Key names never grant compatibility, and this is not tempo matching or automatic DJ mixing.

**Speed & pitch** uses a shared [Web Audio playbackRate](https://www.w3.org/TR/webaudio/#dom-audiobuffersourcenode-playbackrate) change: 90% is approximately -1.82 semitones and 110% is +1.65 semitones. All sources change on one render quantum and the beat clock retains its phase. Reset to original returns to 100%. Speed and pitch are linked; independent key shifting and pitch-preserving tempo changes are not implemented. Timing and speed choices persist through Stop/Start and are recorded in traces.

Authoring mode permits unapproved material. Stop before changing trims, complete recipe vectors, filter settings, assets, or the manifest. Apply and revalidate edits before listening. Use the audition selector to preview:

- All three recipes, each filter sweep, and each loop seam.
- All six directed recipe changes at every allowed boundary within the loop.
- Every outgoing/incoming recipe combination for every edge.

The preview begins near the change when appropriate; WAV export includes the complete render. **Measure every permitted path** runs all cases through the same graph in `OfflineAudioContext` and checks finite samples and a sample peak below −1 dBFS. The report is exportable. These authoring auditions use the saved phrase/grid at 100% speed; reactive timing and rate changes have separate automated regressions in tests/reactivity.spec.ts. It is not a true-peak measurement or listening approval.

After listening, confirm and save each scene's manual approval; approve both endpoint scenes before saving an edge review. **Export configuration** to retain changes and fingerprints. Nothing is silently written to your stem folder. Media bytes and playback-affecting settings and the instrumental graph version are hashed; changed media, trims, recipes, filter controls, or scheduling settings make approval stale. Normal performance blocks unapproved scenes and edges. Notes and display labels do not change the playback fingerprint.

## Hand space for the installation

1. Open Play and press **Start audio**. Music opens in Hand space; the unattended sound is instrumental.
2. For the sensor, select **Leap Motion** and press **Connect Leap**. The app uses the installed Ultraleap tracking service with the sensor lying flat and facing up.
3. Move a hand upward to foreground melody and voice; lower it to foreground the rhythm. Reach deeper for a dotted-eighth echo and diffuse reverb. Both instrumental and vocal audio feed the same effects, so a vocal rest does not disable the interaction.
4. Hold still to preserve your sound. Withdraw to fade the voice and effects send over 650 ms; existing echoes and reverb finish naturally. Missing hand frames hold the last position for 300-650 ms, adapted to the tracking frame rate. A detected move outside the box withdraws immediately. Small resting tremors are smoothed, large position jumps require confirmation, and nearby hand-ID changes recover without dropping the sound. Changes enter with 90 ms audio ramps and do not wait for phrase boundaries.

The **Mouse / touch preview** uses the same audio graph: vertical position is height; horizontal position is depth. Hover inside and leave to withdraw, or drag and release on touch. A keyboard user can focus the pad, press Space to enter, use arrow keys, and Escape to withdraw. The two sliders and **Keep hand in space / Withdraw hand** also let you compare sounds without holding a pointer over the pad. Stopping audio clears the simulated presence. Live Leap presence can be reacquired while stopped; holding a real hand inside remains a deliberate input.

**Setup > Hand space & Leap bounds** defines the active volume in millimeters relative to the sensor. Defaults are 400 mm wide, 120-420 mm above it, with front Z +150 and back Z -150. The software adds a 25 mm fade at its edges, retains one hand through short occlusions, and ignores finger poses. Reverse the two Z endpoints if the mounting orientation reverses depth. Bounds and the tracking preset are saved in this browser; your audio and library project are not silently saved. A software bounding box does not shield the sensor from outdoor infrared light; the shaded physical enclosure still needs site testing.

Under **Tracking stability**, **Bright room** (default) requests the SDK's background-light robustness and hand-fidelity hints. **Responsive** requests hand fidelity alone; **Service default** clears this connection's hints. Reconnect to apply a changed preset. These are best-effort device requests, not guaranteed speed or detection improvements; global service configuration is not changed. Camera FPS, tracking FPS, received FPS, frame age, loss hold and device warnings help distinguish camera throughput from tracking or connection delays. **Save tracking report** downloads roughly the last 30 seconds of these metrics without images or palm coordinates. A single newly appearing hand frame must be confirmed unless the SDK reports it has already been visible for at least 100 ms.

For a bounded check without moving a hand, run `npm run inspect:leap -- --seconds 10 --profile bright-room`. It writes `test-results/leap-health.json`. The installed LM-010 reported about 115 camera FPS and 7 tracking FPS in an empty scene, with roughly 150 ms frame age; bright-room and hand-fidelity requests did not improve that empty-scene rate. Empty-scene measurements do not establish moving-hand performance or optical detection accuracy.

That same Setup section shows quarter-second signal coverage for the selected passage's instrumental bed, melody/harmony, and vocals. It flags instrumental gaps of at least half a second below -50 dBFS after saved stem levels. This is an energy measurement, not a musical quality score. Real silence cannot supply new effect material; existing tails can continue through it.

The hand mix takes each stem's loudest nonmuted saved recipe level, applies its static trim, and adds 6 dB of output headroom. Melody and drum gains respond continuously; bass keeps a dry foundation. The shared echo is band-limited, with bounded feedback; its duration follows the passage beat and linked playback speed. A deterministic stereo convolution tail supplies the cloud texture. This is reverb, not granular synthesis or a frozen vocal sample. Hand-space passage changes reserve an additional 75 ms to prepare the incoming effects before scheduling its fade; they retain beat alignment when selected and never require a whole phrase. All sources retain shared phase. Stop disconnects effects as well as stems; passage exits fade the complete outgoing graph to zero before the next passage.

The native reader requires **Windows, 64-bit Python, and an installed Ultraleap Hand Tracking SDK/service**. It reads palm coordinates through [LeapC](https://docs.ultraleap.com/api-reference/tracking-api/leapc-guide/using-leapc.html), without cameras/images or third-party Python packages. If installed elsewhere, set `LEAPC_DLL` to the full DLL path; set `LEAP_PYTHON` to a Python executable if it is not on PATH. Restart the dev/preview server after changing those environment variables. The Vite plugin starts the hidden reader only on connection and stops it when the last browser disconnects. Both `npm run dev` and `npm run preview` support Leap. A static-only deployment supports the mouse preview but needs this local bridge for the sensor.

Normalized hand-space control changes are recorded in the existing trace and replayed with their original timing. Live sensor frames normally expire after 200 ms; slow native tracking permits up to one measured frame interval beyond 150 ms, capped at 400 ms. Older, reordered and malformed frames are ignored without allowing a single corrupt packet to disconnect the sensor. No images or raw palm coordinates are recorded. Source switching and disconnects return through the same release envelope.

## Legacy webcam hand control

Choose **Manual controls**, then **Camera / hand** and **Start camera**. Keep one open hand visible. Lean it left and right in the image plane; this is not wrist pronation or a 3D palm-normal estimate. Hold low for half a second and capture it, then do the same at high. Either endpoint ordering works. The sweep must span 30–120 degrees and be stable. Preview mirroring does not alter inference geometry.

One frame is transferred at a time to the worker; frames are closed after processing. No backlog is accumulated. Missing/invalid geometry, stale or reordered results, worker errors, and stopped camera tracks produce loss handling. The last continuous value is held for 250 ms, then moves toward 0.3 over about one second. Desired structure freezes, uncommitted camera intentions are dropped on sustained loss, and committed transitions finish. Reacquisition needs 250 ms of stable valid input.

Hold-to-advance is off by default. Enable it, hold below 0.75 for 500 ms to arm, then hold above 0.92 for 1.2 seconds (after one full scene loop only in Phrase endings timing). Each event disarms it. Scene entry, calibration, adapter changes, enabling the toggle, and tracking loss also disarm it.

## Trace and replay

**Export trace** saves JSONL containing one session-relative monotonic origin, raw frames, discarded data, desired states, tentative plans, committed commands with audio timestamps, scene origins, errors, configuration fingerprint, sample rate, readiness, input mode, and build version. Each Start creates a fresh audio/observation mapping and generation. Context suspension stops the transport; restart requires Start audio.

**Play raw replay** bypasses the camera but runs frames through conditioning, mapping, and planning. Its audio submissions obey the live browser clock, so a stall can legitimately defer a boundary. **Verify decision replay** instead re-runs raw input with the recorded readiness and timing simulation and compares the entire event plan. This mode proves deterministic decisions; it does not claim cross-browser bit-identical audio. The separate `renderEventPlan` API in `src/audio/offline.ts` accepts typed audio actions for waveform regression tests.

Trace memory is capped at 300,000 records (enough for the initial 30-minute control trial at normal frame rates). The UI explicitly reports dropped records at the cap. Export and reload the collection to begin a new session. Traces contain no audio or camera images.

## Validation and remaining real-world gates

See [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) for measured results and unperformed physical/listening checks. The synthetic fixtures cannot establish that your passages are musically suitable. User-stem listening, physical movement-to-sound latency, and a real 30-minute foreground camera session remain required on the target setup.

The later request for responsive playing supersedes the base spec's phrase-only timing and fixed playback rate. The linked Speed & pitch control is now available. The later requested library tools add offline analysis and synchronized cropping, and raise the path ceiling to 50 short scenes. No source separation, live time stretching, independent pitch shifting, arbitrary inter-song stem layering, independent stem resequencing, loop repair, compressor-as-limiter, or universal musicality claim is part of the engine.

## Implementation notes

`src/music/planner.ts` and `src/music/session.ts` are deterministic reducers. Browser time enters through explicit arguments. `src/audio/engine.ts` alone executes typed commands. Decks own independent static trims, recipe envelopes, filter automation, and transition gain. Sources are disposed after their scheduled stops, and stale transport generations cannot modify a restart. The live graph and offline auditions share `createDeck` and `OwnedEnvelope`.

API behavior was checked against the official [MediaPipe web guide](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker/web_js), [Web Audio decoding documentation](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/decodeAudioData), and [automation replacement documentation](https://developer.mozilla.org/en-US/docs/Web/API/AudioParam/cancelAndHoldAtTime). These sources establish API behavior, not the musical or perceptual quality of the proposed mapping.

## Installation simulations

`sim.html` is a second, independent app in this repository: full-screen physics simulations (light trails, a sheer curtain, a bowl of water with ink, a prism) driven by a hand inside a physical bounding box watched by a depth camera, publishing their state for a separate audio-mix project. Open **http://127.0.0.1:4178/sim.html** after `npm run dev`, or `telemetry.html` in a second tab to watch the stream. The depth-camera bridge lives in `bridge/`, and `npx tsx scripts/telemetry-sink.ts` is a dependency-free WebSocket receiver to build the audio side on. See [docs/SIMULATIONS.md](docs/SIMULATIONS.md).
