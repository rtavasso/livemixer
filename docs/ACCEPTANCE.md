# Base demo acceptance record

Measured September 5, 2026 on **Microsoft Windows 10 Education 10.0.19045 (build 19045)**, Node.js **22.16.0**, Playwright **1.63.0**, and its Chromium **153.0.8010.12** (build 1243). Dependencies are exactly pinned in package.json and package-lock.json. MediaPipe Tasks Vision **1.0.1**, float16 hand model version **1**, SHA-256 `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1`.

## Measured engineering results

The initial completed base suite contains 42 passing pure-logic cases and 14 passing Chromium cases. Further library-workspace regression cases are recorded separately as implementation proceeds.

The library extension adds 9 pure-logic tests and 3 Chromium GUI tests, including a real directory-picker import of 50 generated song folders. The combined suite is 51 logic cases and 17 browser cases. See [LIBRARY.md](LIBRARY.md) for its measured scope and limitations.

The production build was also served with `npm run preview` and checked with `npx tsx scripts/check-production.ts`: audio start/stop, built library-analysis worker, and local hand-model initialization all passed in Chromium 153.0.8010.12. The check observed zero page errors and zero requests to external origins. It does not access a real camera or establish detection quality.

| Check | Observed result |
|---|---|
| Production build | TypeScript check and Vite build passed |
| Same-start and native loops | Marker positions matched exactly across three channels and 20 loops: 0 samples of relative displacement |
| Mute/unmute | Pre-unmute output exactly zero; re-exposed waveform matches current phase within 1e-6 amplitude |
| Native reset | No samples with both scenes audible; outgoing output exactly zero at/after incoming start; incoming marker spacing 28,800 samples at 48 kHz |
| Ownership | Filter sweeps preserve the recipe endpoint and zero deck gain at scene exit |
| Automation fallback | Replaced ramps hold 0.5 at the replacement sample without a discontinuity exceeding 0.001 amplitude |
| Generation/cleanup | Old deck disposed, one new deck and three sources retained; old-generation command rejected |
| Decode resampling | 24 kHz source metadata validated against 44.1 kHz decode with permitted one-frame rounding |
| Fixture headroom | 84 recipe, seam, filter-sweep, directed-boundary, and edge cases; highest sample peak **−24.874316 dBFS**, zero nonfinite samples |
| Decoded fixture memory | 10,137,600 bytes at 48 kHz |
| Camera worker | Local WASM/model initialized; blank test frame returned no hand and preserved sequence 17 / timestamp 1234 ms |
| GUI | Slider, performance approval gate, stopped-edit rule, stale approval, trace export/verification, missing-media errors, and 768 px layout passed |

Browser results and screenshots are generated into ignored `test-results/`; the headroom JSON is attached to the Playwright report. The fixtures are deterministic engineering signals, intentionally conservative in level, not authored user music.

## Not measured or approved

- No user recordings were in the repository during base implementation. Actual recipes, filter range, all boundary positions, vocal phrases, seams, and reset edges have not been listened to or approved.
- A blank-frame worker test verifies execution and missing-hand output. It does not measure real-hand detection reliability, comfortable calibration, or camera hardware behavior.
- Physical motion-to-audible onset was not measured. Internal producer timestamps measure freshness, not exposure time or acoustic response. The proposed median <150 ms / p95 <250 ms target remains unverified.
- A real 30-minute foreground performance with camera inference, repeated advances, tracking loss, listening, and deliberate short main-thread stalls has not been completed. Source-count tests are not a substitute for that trial.
- Sample peaks are measured; intersample true peaks and artistic quality are not established.

## Real-content checklist

For each actual scene, use the GUI to listen to all three recipes, sweep the full filter range, inspect the loop seam, and audition all six directed changes at every allowed bar. Check clipped words, bleed, bass masking, transients, level changes, endings, and anchor audibility. For each edge, hear all nine recipe pairs. Save notes and fingerprints only after this review. If a case fails, adjust the excerpt, balance, filter range, or grid and repeat the affected review.

Then test slider, timbre-only, structure-only, combined, and camera mappings. Compare a trace replay and briefly hide diagnostics to check whether movement is audible without visual cues. Measure physical latency with an external recording or loopback setup. Run the 30-minute trial in a foreground desktop Chromium tab, monitor deck/source counts, and export its trace. Document actual observations rather than adopting the engineering defaults as measured facts.


## Initial single-passage Sun recordings, 2026-09-08

The local LOVE SUPREME - Sun Fadr exports were decoded to native 44,100 Hz stereo float WAV. All six source components contain exactly 10,711,040 frames (242.880726 seconds). Guitar + Piano + Pro-other were summed into the harmonic stem; the Instrumental reference was excluded. Original MP3 and ASD files were not modified.

The draft takes the same 953,750-frame range from all four runtime stems, starting at source frame 1,844,072 (41.815692 seconds), using an 8-bar grid hypothesis of 88.778 BPM. Full-song library analysis estimates 89 BPM in all three windows and tentatively C major. These estimates and the phrase/seam have not received listening approval.

Chromium exercised four-source playback, quantized vocal entry, full-song project/analysis restoration, vocal solo audition, and loading the restored mix back into the instrument. All 15 permitted recipe/seam/filter/change render cases passed: worst sample peak -9.72587069754165 dBFS, zero nonfinite samples. Report: test-results/sun-measurements.json. The build, 53 logic tests, and 19 browser tests passed. The user-recording browser case is skipped when its ignored media is absent.

This is a prepared musical draft, not completion of the proposed Ambient mode. Presence-dependent vocal gating, room listening, verified downbeats/phrasing, and physical camera interaction remain pending.

## Performance view and three Sun passages, 2026-09-08

The default local collection now contains three real Sun excerpts, starting at 41.8157, 85.0697, and 106.6966 seconds. Each uses the same 953,750-frame range across its four stems. The three-passage path repeats only when requested with Next passage; each current passage otherwise continues looping. Synthetic fixtures are explicitly labeled and never substituted on a normal empty launch.

Sound shape defaults to a separate tone-only mapping at 75%. Prepared passages use a 180–12,000 Hz low-pass on the entire instrumental bed, with vocals routed directly around it. An offline stereo regression verifies more than 40 dB attenuation of a 4 kHz instrumental test signal between the endpoints, unchanged vocals, and reversible bypass. This establishes electrical contrast, not audibility on the installation speakers.

All 53 logic tests and 22 browser tests passed. The real-content check exercised each passage's shared audio graph and all 72 recipe, seam, filter, and directed transition cases; every case stayed below -1 dBFS with zero nonfinite samples. The final two performance-view checks also passed after label refinements and a regression assertion that editing the filter preserves its instrumental target. Desktop and 430-pixel layouts were inspected, and the mobile layout has no horizontal overflow.

The simple view exposes Sound shape, Vocals, and passage selection/advancement. It shows the waiting time for vocal and passage changes; engineering controls remain in the closed Studio tools panel. Musical phrasing, seams, and room audibility still require listening review. Automatic camera-presence vocal gating is not part of this change.


## Reactive main playing controls, 2026-09-09

The reported bass-like single-tone behavior exposed a weakness in the fully wet 180 Hz instrumental low-pass: it could remove nearly all attacks and upper harmonics. The graph now blends 35% unfiltered instrumental with 65% filtered instrumental, while keeping vocals dry. This supersedes the earlier greater-than-40-dB endpoint attenuation check. The graph version is included in approval fingerprints so earlier listening approval cannot silently carry over.

Normal music opens with Next beat timing; Immediate is also available. Both allow a passage change during the first loop. Immediate recipe/reset actions complete 80 ms after the planning tick with default settings (plus UI tick/output latency); beat mode uses the next eligible beat. The old phrase grid remains selectable as Phrase endings. Short fades preserve continuous source phase for vocal changes and avoid overlapping songs on passage resets.

The linked 90-110% Speed & pitch control changes every source at the same render quantum and rebases the beat clock without a phase jump. Pure tests cover rapid reversals, canceled and committed intentions, scene resets, rate changes, restart preferences, and replay at the recorded sample rate. Four-channel waveform regression verifies identical stem phase after two speed changes and a later vocal unmute, within 1e-7 relative amplitude error; comparison to the expected resampled phase remains within 1e-4.

The full build, 61 logic cases and 25 browser cases passed. After refining metronome scheduling, the build and all six focused performance/reactivity browser cases passed, including a new waveform check that future clicks cancel and a current click finishes normally (26 distinct browser cases overall). The Sun authoring suite rendered all 72 cases with a worst sample peak of -10.088497 dBFS and zero nonfinite samples. Separate eight-second Sun sequences exercise both live timing modes, two instrumental passage resets, vocal reversals, and two speed changes. At minimum shape, upper-band RMS remained 32-34% of the corresponding bypass render in all three passages; peaks stayed below -10.74 dBFS with no nonfinite samples. Independent renders with vocals muted agree within 2e-6 amplitude. These are signal-level checks, not room listening or physical latency measurements.

The main-control browser test covers next-beat vocals/passage changes, Immediate mode, speed/pitch readout and reset. Engineering fixtures remain explicitly labeled. Independent pitch/key shifting, camera-presence vocal gating, and in-room evaluation remain outside this change.


## Clearer Play, Build mix and Setup views, 2026-09-09

Sun's sparse and pulse recipes contain identical stem levels. The listening buttons now group identical recipes and show descriptive Instrumental / With vocals choices, with actual stem gains in Setup. Saved-combination buttons are disabled while stopped, since they cannot change audible playback then. Internal recipe IDs and saved configurations remain compatible.

The former lower Studio tools panel is now a separate Setup tab with collapsed sections. Play retains only performance controls; Build mix groups song import, stem previews, section selection and playing order. Detailed levels/tempo/key are under analysis details. Open full song & waveforms describes opening the source recordings for editing and disables itself once loaded, preserving library edits. Restore saved passages is a separate Setup action. Stop all audio works across tabs, including during asynchronous preview decoding, and stopped previews clear their looping status.

Validation: the build and 61 logic tests passed. Sixteen performance, reactivity, library and UI browser tests passed; the final eight focused checks passed after preview cleanup, including three clarity regressions, the 50-song import, saved project/ZIP flow, and both prepared-collection tests (19 distinct browser cases across these runs). Sun's 72 authoring renders remained finite and below -1 dBFS. Play, Setup and the full-song workspace were visually inspected; all three views fit the 430-pixel regression viewport without horizontal overflow. No audio-engine changes or new source-file processing were needed for this UI revision.

## Bounded hand space, 2026-09-09

The default musical playing view now provides continuous palm height/depth and presence, with Leap Motion, pointer, touch, keyboard and slider preview. Both accompaniment and available vocals feed a dotted-eighth echo and diffuse convolution reverb. Inactive presence keeps vocals silent; movement still changes the instrumental during vocal rests. Stillness preserves the chosen sound. Loss holds for 250 ms, then the send and voice release over 650 ms; effects already in flight decay naturally. Stop and scene exits mute the complete graph, including tails.

Prepared passage activity is measured while loading, outside the playback tick. Setup visualizes quarter-second RMS coverage for instrumental, harmonic and vocal sources and lists instrumental gaps of at least 0.5 seconds below -50 dBFS. Authored trims and highest permitted stem levels are honored. The new graph version invalidates prior listening fingerprints. The existing manual audition suite still measures manual recipes; the hand-space waveform cases are separate and do not constitute listening approval.

Regression renders forced all Sun vocal buffers to zero in every passage. Entry, height and depth all changed the output: entry RMS differences were 0.00660-0.01022, height 0.01545-0.02356, and depth 0.01591-0.02501. Restoring the vocals produced further differences of 0.01336-0.01694. These 15 full-passage hand-space renders at 24 kHz contained no nonfinite samples, with worst sample peak -13.45 dBFS. Synthetic tests verify negligible inactive vocal leakage (below 1e-7), audible effects on the accompaniment, natural decay after withdrawal, and exactly zero output after Stop or a completed deck exit. These checks establish waveform changes, not audibility in an outdoor installation.

The installed Windows Ultraleap service and LeapC SDK were exercised directly and through the app's localhost event stream; the device returned actual palm coordinates. Native tracking frames in the bounded check were approximately 140-155 ms old. This is not an end-to-end movement-to-speaker latency measurement. The reader uses packed SDK structs, copies data before the next poll, requests tabletop tracking, sends no images and exits with the browser connection. The frontend rejects stale/reordered frames and retains one hand across brief occlusion. Outdoor sunlight, enclosure lining, mounting orientation, comfortable reach and sustained installation use still need physical testing.

The broader regression run exposed unused convolution processing in Manual controls and a nested control-update trace timestamp ordering issue. Manual effects are now allocated only when needed, activity analysis runs during loading, and hand-space passage scheduling reserves 75 ms of graph preparation time. The rerun passed all 16 prepared/reactivity/UI/hand-space cases, including Sun's 72 manual authoring renders. A further live hand-space test passed immediate passage changes at 110% speed, presence persistence, gain diagnostics, and exported-trace decision replay. Together with the other passing cases from the broader run, 35 distinct Chromium cases passed across these runs. Desktop playing and activity views were visually inspected; touch drag/release and 430-pixel layout checks passed.

Final validation: all 68 pure logic tests and the production build passed. The built app was served with `npm run preview` and checked with `npx tsx scripts/check-production.ts http://127.0.0.1:4179 --leap`: audio Start/Stop, hand-space controls, native Leap sensor connection, library analysis and local camera worker initialization passed in Chromium 153.0.8010.12. The check observed zero page errors and zero external-origin requests.

## Buzz at the first loop restart, 2026-09-09

Reproduced in installed Brave 152.1.94.121: Sun plays normally on the first pass, then the output repeats an identical 128-frame block at the first loop restart. At 48 kHz its decoded length is 1,038,095 frames; converting its duration back to frames gives 1,038,095.0000000001. A minimal native-source reproduction confirmed that both an explicit duration and the default loop endpoint fail at unity playback rate. Earlier headroom and finite-sample checks did not detect this sustained buzz.

Performance playback and library previews now share a full-buffer loop helper. Only endpoints that round above the decoded frame count are moved inward by floating-point precision, without cropping or padding audio or changing the transport clock. Preview metronomes use the same correction. The playback fingerprint was updated.

The waveform regression compares three native loops against a non-looping buffer containing three copies of the same mix. It covers Manual controls and the hand-space instrumental bed at 44.1/48 kHz and 90/100/110% speed. It failed before the fix at normal speed (up to 0.332 peak sample error), then passed after it. The comparison excludes three samples around discontinuous seams because native interpolation can differ there. A separate live Sun regression inspects the existing output meter across two complete loop restarts and detects a frozen 128-frame block. Both tests passed in installed Brave, including 48 seconds of live Sun playback. All 69 logic tests, 18 focused Chromium audio/reactivity/hand-space cases, type checking and the production build passed. The development server remains at http://127.0.0.1:4178/.

To run these checks with an installed browser in PowerShell:

```powershell
$env:LIVEMIXER_BROWSER_EXECUTABLE = 'C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe'
npx playwright test tests/loop.spec.ts
```

## Leap tracking resilience and diagnostics, 2026-09-09

Investigated the installed LM-010 and Ultraleap service 6.2.0 without asking the user to move a hand. A 15-second native sample delivered approximately 7.26 tracking frames/second with median age 149.7 ms. An unthrottled reader showed no skipped native frame IDs; the low delivery rate originated before the app's bridge. The SDK separately reported approximately 115 camera frames/second. No device warning flags were reported, which does not establish that lighting or power management is harmless. All samples in this investigation contained zero detected hands, so these rates cannot establish moving-hand performance or optical detection accuracy.

Short comparative samples requested hand fidelity, background-light robustness plus hand fidelity, and service defaults. The API accepted the requests, but empty-scene tracking remained about 7.3 FPS. Bright room is the new UI default; hints are scoped to the reader connection, use the selected device, and leave global service configuration unchanged. The SDK documents hints as requests that may affect performance, not guarantees: [hinting API](https://docs.ultraleap.com/hand-tracking/Hyperion/hintingapi.html). Infrared lighting and reflections remain physical considerations: [camera placement](https://docs.ultraleap.com/touchfree-user-manual/camera-placement.html).

The former 250 ms loss grace could expire after two missed frames at this cadence. Leap now holds position for 300-650 ms based on native/received cadence, recovers a nearby hand with a changed ID, confirms newly appearing hands and large position jumps, and smooths resting noise while responding faster to larger movements. A detected exit from the bounds still withdraws immediately through the existing audio release. Long loss freezes position and withdraws presence. Useful delayed frames have a cadence-dependent age limit of 200-400 ms; malformed, older and reordered frames are ignored. The bridge output cap increased from 30 to 60 Hz. None of this reconstructs a hand that the optical tracker cannot detect.

Setup now displays camera, tracking and received rates separately, frame age, device flags, held jumps and loss grace. A downloadable report keeps approximately 30 seconds of metrics without images or palm coordinates. `npm run inspect:leap -- --seconds 8 --profile bright-room` produced 57 frames at 7.275 FPS, median age 149.509 ms, p95 156.23 ms and no frames over 200 ms. Camera rate was 115 FPS and the hint request was accepted.

All 77 logic tests passed, including eight imperfect-tracking cases with injected losses, ID changes, false arrivals, glitches, resting noise and deliberate sweeps. Seven focused Chromium browser cases passed, covering the audio effects, pointer/touch controls, native-adapter simulation, malformed packets, preset/report behavior, immediate passage changes and trace replay. The new native sensor test passed in installed Brave along with both simulated tracking cases and four existing interaction cases. It observed the real camera/tracking rates, exported a report and checked the 430-pixel layout without needing a physical hand. The native Setup screenshot was visually inspected.

An existing synthetic offline-audio comparison in Brave exceeded its 1e-7 inactive-vocal-leak threshold (2.27e-5); that same regression passed in Chromium. Its tolerance was not weakened. This discrepancy is separate from the passing tracking tests, and the Brave run is not reported as a completely passing audio suite. Physical movement-to-speaker latency, sunlight detection accuracy and installation listening remain unmeasured.

The final production build and built-app check passed: audio Start/Stop, hand-space controls, the native Leap connection, library analysis and camera-worker initialization all succeeded in Chromium 153.0.8010.12, with zero page errors and zero external-origin requests. The development server remains available at http://127.0.0.1:4178/.
