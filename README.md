# Live Mixer

A local desktop-browser instrument for synchronized, authored stem scenes. The base demo uses TypeScript, Vite, native Web Audio, and a local MediaPipe worker. No backend, microphone input, account, or runtime CDN is used.

The **Library & mix builder** tab adds the requested 50-song workflow: external-folder import, stem waveforms and levels, tentative tempo/key analysis, synchronized passage selection and solo audition, a reorderable mix path, project save/restore, and playable WAV/manifest ZIP export. See [the library guide](docs/LIBRARY.md). Tuning and reviews made in the instrument carry back into the library project.

## Run

Use Node.js 22.16 or later and desktop Chromium on Windows/macOS/Linux:

```sh
npm ci
npm run setup:models
npx playwright install chromium
npm run dev
```

Open **http://127.0.0.1:4178/**. It loads the last collection prepared by the Fadr command (Sun in this workspace). The playing view has **Sound shape**, **Vocals**, and a **Passage** selector / **Next passage** button. Sound shape responds immediately; vocal and passage changes show a countdown to their musical boundary. Technical controls are inside the closed **Studio tools** panel.

With no prepared collection, the app asks you to load music. It never silently substitutes sine tones. Engineering fixtures remain available explicitly in Studio tools or at `/?fixtures=1&tools=1`, with a visible test-signal notice.

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

This workspace has a [LOVE SUPREME - Sun draft](http://127.0.0.1:4178/?collection=love-supreme-sun): three 8-bar passages starting at 41.816, 85.070, and 106.697 seconds, plus the full song in the prepared library. They repeat as a three-passage path when advanced manually. Start audio for the instrumental bed; choose **Bring in vocals** to introduce vocals at the next loop boundary. These are draft selections awaiting listening review.

A prepared collection opens directly with `http://127.0.0.1:4178/?collection=COLLECTION_ID` in Authoring mode. In **Library & mix builder**, **Load prepared song** loads its full-length WAV stems, analysis, and saved draft passages. The regular URL opens the collection named by ignored `public/scenes/default.local.json`, written by the preparation command.

For Fadr folders containing Bass, Drums, Vocals, Guitar, Piano, and Pro-other exports, install FFmpeg on PATH, then run the preparation command below. In Windows PowerShell use `npm.cmd` so script flags are forwarded correctly:

```powershell
npm.cmd run prepare:fadr -- "C:/path/to/Fadr stems" --id my-song --label "Artist - Song"
npm.cmd run prepare:fadr -- "C:/path/to/Fadr stems" --id my-song --label "Artist - Song" --reuse --bpm 120 --starts "32,64,96" --bars 8
```

The first pass decodes and checks identical native-rate frame counts, then analyzes full-song levels and tentative tempo/key. The second selects the same frame ranges in every stem and writes an unapproved performance draft plus a library project. Use `--start` for one passage or comma-separated `--starts` for several. `--reuse` checks that the source recordings are unchanged and regenerates the draft; export GUI edits before using it again.

Guitar + Piano + Pro-other become the harmonic **other** stem with no normalization. The full Instrumental export is excluded from the sum. Float WAV preserves decoder/sum headroom; all original files remain untouched. Generated audio, analysis, and configuration live under ignored `public/scenes/COLLECTION_ID/`. Keep them local; Vite includes public assets in a build.

The prepared recipes retain bass/drums/other throughout: **sparse** and **pulse** are instrumental, and **open** adds vocals on the whole-loop boundary. Camera-presence vocal gating from the Ambient-mode discussion is a separate, pending feature; current tracking loss still holds the arrangement.

## Bring your stems

Your recordings do not need to live in this repository. Use **Open stem folder** to select an external folder containing `manifest.json` and its WAV files. The browser reads selected files locally. A folder layout such as the following works:

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
4. Add vocals only when the complete lyric phrase loops cleanly. If recipes toggle vocals, use a whole-loop recipe grid and include every vocal gain in all three recipes.

The runtime verifies WAV metadata before decoding, then equal decoded frame counts and source-duration consistency with a small resampling tolerance. Chromium can resample an 8-second WAV to one frame less than a rounded expectation; the decoded duration is the authoritative clock.

## Perform and review

The normal musical control is **Sound shape**: a continuous tone change independent of the vocal button. Prepared Fadr passages filter the whole instrumental bed from 180 to 12,000 Hz, with vocals routed around that filter. They open at 75% shape. Legacy manifests without `filter.target: "instrumental"` retain harmonic-anchor-only filtering. Editing filter settings preserves the target.

In **Studio tools**, the optional combined mapping changes both tone and arrangement; arrangement-only fixes the tone; tone-only keeps the vocal choice separate. Combined mapping uses hysteresis and a 120 ms dwell. Recipe ramps end on the declared grid. Current, desired, pending, and committed states are shown separately. Recipe audition buttons hold their manual selection until the input moves by more than 0.05 or you change adapters.

All stems start at the same audio timestamp, loop natively, and retain `playbackRate = 1`. Muted stems continue in phase. **Next scene** commits an outgoing fade over the last beat, stops it at the loop end, then starts the next native-tempo scene with a 10 ms entry fade. **There is no simultaneous cross-song audio.** Key names never grant compatibility, and this is not tempo matching or automatic DJ mixing.

Authoring mode permits unapproved material. Stop before changing trims, complete recipe vectors, filter settings, assets, or the manifest. Apply and revalidate edits before listening. Use the audition selector to preview:

- All three recipes, each filter sweep, and each loop seam.
- All six directed recipe changes at every allowed boundary within the loop.
- Every outgoing/incoming recipe combination for every edge.

The preview begins near the change when appropriate; WAV export includes the complete render. **Measure every permitted path** runs all cases through the same graph in `OfflineAudioContext` and checks finite samples and a sample peak below −1 dBFS. The report is exportable. It is not a true-peak measurement or listening approval.

After listening, confirm and save each scene's manual approval; approve both endpoint scenes before saving an edge review. **Export configuration** to retain changes and fingerprints. Nothing is silently written to your stem folder. Media bytes and playback-affecting settings are hashed; changed media, trims, recipes, filter controls, or scheduling settings make approval stale. Normal performance blocks unapproved scenes and edges. Notes and display labels do not change the playback fingerprint.

## Hand control

Choose **Camera**, then **Start camera**. Keep one open hand visible. Lean it left and right in the image plane; this is not wrist pronation or a 3D palm-normal estimate. Hold low for half a second and capture it, then do the same at high. Either endpoint ordering works. The sweep must span 30–120 degrees and be stable. Preview mirroring does not alter inference geometry.

One frame is transferred at a time to the worker; frames are closed after processing. No backlog is accumulated. Missing/invalid geometry, stale or reordered results, worker errors, and stopped camera tracks produce loss handling. The last continuous value is held for 250 ms, then moves toward 0.3 over about one second. Desired structure freezes, uncommitted camera intentions are dropped on sustained loss, and committed transitions finish. Reacquisition needs 250 ms of stable valid input.

Hold-to-advance is off by default. Enable it, hold below 0.75 for 500 ms to arm, then hold above 0.92 for 1.2 seconds after one full scene loop. Each event disarms it. Scene entry, calibration, adapter changes, enabling the toggle, and tracking loss also disarm it.

## Trace and replay

**Export trace** saves JSONL containing one session-relative monotonic origin, raw frames, discarded data, desired states, tentative plans, committed commands with audio timestamps, scene origins, errors, configuration fingerprint, sample rate, readiness, input mode, and build version. Each Start creates a fresh audio/observation mapping and generation. Context suspension stops the transport; restart requires Start audio.

**Play raw replay** bypasses the camera but runs frames through conditioning, mapping, and planning. Its audio submissions obey the live browser clock, so a stall can legitimately defer a boundary. **Verify decision replay** instead re-runs raw input with the recorded readiness and timing simulation and compares the entire event plan. This mode proves deterministic decisions; it does not claim cross-browser bit-identical audio. The separate `renderEventPlan` API in `src/audio/offline.ts` accepts typed audio actions for waveform regression tests.

Trace memory is capped at 300,000 records (enough for the initial 30-minute control trial at normal frame rates). The UI explicitly reports dropped records at the cap. Export and reload the collection to begin a new session. Traces contain no audio or camera images.

## Validation and remaining real-world gates

See [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) for measured results and unperformed physical/listening checks. The synthetic fixtures cannot establish that your passages are musically suitable. User-stem listening, physical movement-to-sound latency, and a real 30-minute foreground camera session remain required on the target setup.

The optional second control/effect in the spec is deliberately deferred until those real-content gates pass. The later requested library tools add offline analysis and synchronized cropping, and raise the path ceiling to 50 short scenes. No source separation, live time stretching, live pitch shifting, arbitrary inter-song stem layering, independent stem resequencing, loop repair, compressor-as-limiter, or universal musicality claim is part of the engine.

## Implementation notes

`src/music/planner.ts` and `src/music/session.ts` are deterministic reducers. Browser time enters through explicit arguments. `src/audio/engine.ts` alone executes typed commands. Decks own independent static trims, recipe envelopes, filter automation, and transition gain. Sources are disposed after their scheduled stops, and stale transport generations cannot modify a restart. The live graph and offline auditions share `createDeck` and `OwnedEnvelope`.

API behavior was checked against the official [MediaPipe web guide](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker/web_js), [Web Audio decoding documentation](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/decodeAudioData), and [automation replacement documentation](https://developer.mozilla.org/en-US/docs/Web/API/AudioParam/cancelAndHoldAtTime). These sources establish API behavior, not the musical or perceptual quality of the proposed mapping.

## Installation simulations

`sim.html` is a second, independent app in this repository: full-screen physics simulations (light trails, a sheer curtain, a bowl of water with ink, a prism) driven by a hand inside a physical bounding box watched by a depth camera, publishing their state for a separate audio-mix project. Open **http://127.0.0.1:4178/sim.html** after `npm run dev`, or `telemetry.html` in a second tab to watch the stream. The depth-camera bridge lives in `bridge/`, and `npx tsx scripts/telemetry-sink.ts` is a dependency-free WebSocket receiver to build the audio side on. See [docs/SIMULATIONS.md](docs/SIMULATIONS.md).
