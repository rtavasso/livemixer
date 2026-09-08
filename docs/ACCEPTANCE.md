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
