# Hand-Controlled Stem Performance Demo

> Update, 2026-09-09: The user requested responsive main playing controls. Live performance now defaults to next-beat recipe/passage changes, offers Immediate timing, and supports linked 90-110% speed/pitch. The original phrase-only, fixed-rate rules below describe Phrase endings behavior at 100% and the base acceptance auditions. See README.md and tests/reactivity.* for the current interaction contract.

> Installation update, 2026-09-09: The current default is a bounded hand space using Leap palm height/depth and presence, with a mouse/touch/keyboard preview. Both instrumental and available vocal audio feed an echo/reverb transformation. Stillness holds the chosen sound; withdrawal fades back to the instrumental bed. The optional local LeapC reader supersedes the original webcam-only/no-backend scope. Manual controls preserve the original scalar mapping. See README.md for the implemented interaction, setup and limitations.

> Tracking update, 2026-09-09: Leap input now conditions palm motion, confirms new hands and position outliers, recovers nearby hand-ID changes, and adapts loss hold to 300-650 ms. Native frame-age acceptance adapts to tracking cadence with a 400 ms hard cap. Setup provides per-connection tracking presets, camera/tracking/receive metrics and a diagnostic export. These changes supersede earlier Leap timing notes; the legacy webcam rules below remain separate. Synthetic trajectories and native no-hand checks validate control behavior and connection health, not physical detection accuracy in sunlight.

**Version:** 0.1 · **Date:** September 5, 2026  
**Deliverable:** A local, single-user desktop-browser instrument, not a general-purpose automatic DJ.  
**Status:** Base implementation and subsequent user-requested extensions are implemented. Sun recordings have automated waveform validation, and the installed Leap service has returned live palms. Musical approval and outdoor enclosure/latency testing remain open. Historical v0 requirements below are superseded where noted above.

## 1. Product decision

Build an instrument in which one continuous external control changes the character and arrangement of an authored musical scene. A deliberate event can advance along a predetermined scene path.

The question for this prototype is:

> Can a person reliably hear their movement changing a musically coherent arrangement, without requiring every change to happen immediately?

Do not begin by asking a model to discover which arbitrary stems belong together. In v0, the author supplies that knowledge through a small number of approved scenes and mix recipes. The engine determines **which approved change the control requests, when it may happen, and how to execute it without losing synchronization**.

There are three distinct forms of control:

| Control | Meaning | Timing |
|---|---|---|
| Continuous `openness` | Darker/clearer timbre on the current harmonic anchor | Immediately, with short parameter ramps |
| Desired recipe | Sparse / pulse / open arrangement of the current synchronized stems | Next approved musical boundary |
| `advance` event | Proceed to the next authored scene | Next eligible end-of-loop transition |

These are not three camera measurements. They are three interpretations of one normalized input. Keep gesture-driven advancement disabled initially so the arrangement experiment can be understood independently; enable it after the first mapping works.

The original research brief supplies the recording-based premise and desired-state scheduling idea. This specification deliberately narrows that proposal: no whole-library normalization, compatibility model, automatic fragment search, or general audio middleware is required.

## 2. Scope and stack

### Required v0 scope

One RGB webcam; one visible hand; one normalized scalar; one active scene; three authored recipes; one continuous filter mapping; two or three scenes in a fixed path; a manual slider; deterministic replay; and tests of synchronization, scheduling, and failure handling.

Start the real-audio experiment with **three stems from one instrumental passage: other, bass, and drums**. A fourth vocal stem is supported, but it has stricter boundary requirements described below. Start with four-bar loops; use eight bars only when the source needs a longer complete phrase.

### Chosen implementation

Use TypeScript, Vite, a small DOM-based interface, native Web Audio, and MediaPipe Hand Landmarker in a dedicated Web Worker. Use Vitest for pure logic and Playwright/Chromium for browser and offline-audio tests. Do not add Tone.js, a backend, a database, OSC, TouchDesigner, SuperCollider, or an LLM to this prototype.

This is a scope choice, not a claim that a browser is the best final installation platform. Web Audio supplies scheduled buffer playback and an audio processing graph; those primitives are sufficient for this deliberately small runtime [1, 2].

Target a foreground desktop Chromium browser on the developer's machine. Pin tested dependencies in the lockfile, document the exact tested browser and operating system, and serve the hand model and matching WASM assets locally. Do not depend on an unversioned runtime CDN.

Use an explicit **Start audio** button. Request video only, never microphone input. Serve through localhost during development; browser camera access requires a secure context and permission [6].

### Explicit non-goals

No separation, source separation evaluation, automatic key detection, automatic chord matching, live pitch shifting, live time stretching, arbitrary inter-song stem layering, independent per-stem resequencing, granular processing, network synchronization, mobile-browser support, or unattended multi-day reliability claim.

Do not silently implement a playback-rate change as pitch-preserving tempo matching. v0 uses `playbackRate = 1` throughout.

## 3. What “musically allowed” means

### Scene

A scene is one reviewed passage from one source recording, exported as synchronized stem loops. Every stem has the same source origin, loop duration, beat grid, and playback phase. A scene includes three approved gain recipes, an approved range for its filter control, and reviewed entry, exit, and loop seams.

Same-source synchronization preserves the original temporal relationship; it is not a certificate of aesthetic quality. Soloed separation artifacts, an unsuitable excerpt, or a poor gain balance can still sound bad. Listening is a required authoring step.

### Recipe

A recipe is a complete gain vector over the scene's stems. It is not a set of independent random mute choices. All changed gains begin and finish their short transition together.

Example starting values, relative to per-stem static trims:

| Stem | sparse | pulse | open |
|---|---:|---:|---:|
| other / harmonic anchor | 0 dB | 0 dB | 0 dB |
| bass | muted | -6 dB | -2 dB |
| drums | muted | -10 dB | -3 dB |
| vocals, when included | muted | muted | -8 dB |

These numbers are tuning defaults, not mix prescriptions. Adjust them for each recording. JSON uses `null` for muted, never a string such as `"-inf"`.

The harmonic anchor remains present in all recipes. Do not substitute another song when the anchor becomes sparse. Choose an appropriate excerpt, or accept its reviewed musical silence. If low-pass movement is inaudible on the proposed anchor, select a different anchor or passage.

### Approval rules

A scene's approval covers all three recipes, the continuous filter range, all six directed recipe changes, the permitted boundary positions, and the loop seam. For bar-quantized changes, audition each allowed bar position within the loop. Approval of endpoints alone is insufficient.

In normal performance mode, reject unapproved scenes or transition edges. Provide a visibly marked authoring mode that permits auditioning unapproved material. Approval is never set automatically by an analysis score.

Within a scene, the runtime eligibility predicate is:

```text
approved scene
AND requested recipe belongs to this scene
AND all required stems are decoded and share one loop length
AND the requested boundary belongs to the scene's approved grid
AND no scene transition owns the deck at that time
```

Across scenes, v0 never overlaps source material. Thus it does not need to infer cross-song harmonic compatibility. This limitation must remain visible in the README.

## 4. Preparing existing stems

This is content preparation, not a new demixing pipeline.

For each scene, use an audio editor or DAW to select the same contiguous four- or eight-bar interval in every stem. Export WAV files beginning on the same reviewed downbeat, with identical sample rate and frame count. Do not independently trim leading silence, normalize stems, or estimate separate grids.

Preserve the source-relative balance initially. Apply one common scene trim to establish headroom, then make modest stem-specific corrections while auditioning the recipes. Retain the original full mix or a stem sum outside the runtime as an audition reference.

Use a stable-tempo passage in 4/4 for v0. Listen with a metronome at the beginning, middle, and end. When no constant grid fits, either choose another passage or warp the entire aligned stem group offline before export. Do not let a nominal BPM tag override the actual timing.

Require a musically usable loop seam. A click detector or a tiny edge fade does not establish harmonic or lyrical continuity. Do not implement a blind loop crossfade that shortens the loop and changes the beat grid. For v0, reject bad excerpts and choose better boundaries rather than building an automatic loop repair system.

**Vocals:** a bar boundary can be inside a word or lyric phrase. For a scene in which recipes toggle vocals, set `recipeQuantizationBars` equal to the whole loop and author the loop as a complete vocal phrase. The whole recipe changes atomically on that grid. Do not introduce independent vocal/rhythm scheduling in v0; it would create additional intermediate configurations to qualify.

Keep the first instrumental scene bar-quantized, so the basic arrangement response can be heard without waiting a whole phrase.

## 5. Configuration contract

Use a small JSON manifest, not a general graph language. The accompanying `scene_manifest.example.json` is a template with nonexistent media paths and **false approval flags**, not ready-to-play content.

```ts
type StemId = "other" | "bass" | "drums" | "vocals";
type RecipeId = "sparse" | "pulse" | "open";
type GainDb = number | null; // null -> linear gain 0

interface StemAsset {
  file: string;
  trimDb: number;
}

interface Scene {
  id: string;
  sourceSongId: string;
  label: string;
  sourceSampleRate: number;
  sourceFrameCount: number;
  loopBars: 4 | 8;
  beatsPerBar: 4;
  nominalBpm?: number; // display / authoring check, not the runtime clock
  keyLabel?: string;   // annotation only; never used as compatibility proof
  recipeQuantizationBars: number;
  anchorStem: StemId;
  stems: Partial<Record<StemId, StemAsset>>;
  recipes: Record<RecipeId, Partial<Record<StemId, GainDb>>>;
  filter: {
    minHz: number;
    maxHz: number;
    q: number; // BiquadFilterNode.Q parameter, not textbook linear Q
  };
  sceneTrimDb: number;
  approval: {
    recipes: boolean;
    recipeTransitions: boolean;
    loopSeam: boolean;
    filterRange: boolean;
    reviewedFingerprint?: string;
    notes: string;
  };
}

interface ResetEdge {
  from: string;
  to: string;
  kind: "fade_to_zero_reset";
  fadeOutBeats: 1;
  fadeInMs: number;
  approved: boolean;
  reviewedFingerprint?: string;
  notes: string;
}
```

The manifest also contains a scene path, explicit transition edges, master trim, and the control defaults in Section 14. Each scene ID appears once in the path. Repeating the path is optional; when enabled, an explicit approved last-to-first edge is required.

Validation must reject missing recipe gains for any loaded stem, recipes that mention absent stems, invalid numbers, a muted anchor, invalid filter bounds, nonpositive lengths, a quantization interval that does not divide the loop, and unresolved path/edge IDs. For v0, require trim and recipe gains to be at most 0 dB. Missing optional stems are omitted, not silently synthesized.

After fetching and decoding, verify equal buffer lengths within each scene. Preserve the metadata's source-frame meaning: do not compare source frame counts directly to resampled buffer frame counts. `decodeAudioData` resamples into the audio context's sample rate [5]. Compare source duration against decoded duration with a small resampling tolerance, and reject inconsistent stems.

Compute a fingerprint over media bytes and playback-affecting scene configuration. Save it on manual approval; a mismatch makes approval stale. Edge approval includes both scene fingerprints and edge settings. A local hash and JSON field suffice—no registry service.

## 6. Audio graph and playback ownership

```text
for each stem in the active deck:
  looping AudioBufferSourceNode
    -> static stem trim
    -> low-pass filter only when this is the anchor
    -> recipe gain
    -> scene sum

scene sum
  -> static scene trim
  -> deck transition gain
  -> master trim
  -> meters
  -> output
```

Use one `AudioContext`. Prepare all buffers before enabling Start. With two or three short scenes, preload the whole demo; do not implement streaming or an LRU cache. Show estimated decoded memory and fail cleanly on load errors.

At scene entry, create one looping source per stem and call `start(T, 0)` on all of them with the **same future audio timestamp**. All have the same loop bounds and playback rate. Native buffer sources can be scheduled against the audio-context timeline and configured to loop [1, 2].

Derive the full-buffer endpoint from decoded frame count and sample rate. If converting that endpoint back to frames rounds above the buffer length, move it inward by floating-point precision only. Explicitly apply this bound to performance stems, library previews and preview metronomes; the browser's default endpoint can exhibit the same rounding error. Regress repeated-loop waveform fidelity at 44.1/48 kHz and 90/100/110% playback speed, including frame lengths whose seconds-to-frames conversion rounds upward.

**Muted stems continue to play silently.** A recipe change moves gains, not source positions. Unmuting bass exposes the bass at the current harmonic position, rather than replaying the bass from the beginning.

Do not use separate HTML audio elements, independent JavaScript loop timers, or camera frames as playback clocks.

Keep separate nodes and ownership for static trim, recipe gain, filter automation, and deck fade. A camera filter update must never cancel a scheduled recipe gain or scene-exit fade.

No delay or reverb in the required graph. This makes the no-overlap transition contract easy to test. Later effects must live inside a deck, upstream of its transition gain, so muting the deck also mutes its tails.

Do not treat a stock compressor as a certified true-peak limiter. Start with conservative master attenuation, render the permitted paths, and adjust headroom from measured results. Do not automatically normalize every stem or every recipe to equal loudness.

## 7. One authoritative musical clock

After decoding, let:

```text
L = common decoded frame count / AudioContext.sampleRate
B = loopBars * beatsPerBar
beatSeconds = L / B
barSeconds = L / loopBars
boundary(k, quantumBars) = sceneStart + k * quantumBars * barSeconds
```

`L` is the same for every stem in the scene. Using the common decoded duration avoids introducing a second duration from a rounded BPM value.

Calculate boundaries from the scene start and an integer boundary index. Do not repeatedly add an independently rounded beat duration. The incoming scene gets a new clock origin and its own `L`; there is no global tempo modulation in v0.

Use a scheduling loop every 25 ms, initially looking 150 ms ahead. These are proposed tuning values. The timer only submits events for future audio timestamps; the audio engine executes them. This separation follows the two-clock scheduling model described by the Web Audio scheduling guide [3].

Long-running sources loop natively even when the UI pauses briefly. A late scheduler must defer an unsubmitted change, not start a catch-up change mid-bar. A stalled browser can still stop new control updates; the prototype makes no unlimited-stall guarantee.

## 8. Desired-state scheduler

Maintain these concepts separately:

```text
desiredRecipe     // latest accepted control interpretation
currentRecipe     // recipe fully reached in audible playback
pendingRecipe     // tentative plan; replaceable
committedRecipe   // submitted audio automation; cannot be rewritten casually
pendingAdvance    // at most one path-advance intent
committedAdvance  // one atomic outgoing/incoming transition
```

For a recipe change, choose the next allowed boundary `T` with sufficient lead time. Ramp all changed gains from `T - 20 ms` to `T`, so the incoming downbeat begins at its target level. The 20 ms envelope is an engineering default and must be auditioned with the content.

Commit a recipe event only when its ramp start enters the lookahead window. Require at least 50 ms between the current audio time and the ramp start. When too late, select the following allowed boundary. A pending, uncommitted request is replaced by the newest desired recipe; it is not appended to a FIFO.

Once submitted, let the short recipe transition complete. If the hand reverses afterward, schedule the newest desired recipe for the next allowed boundary. The UI must distinguish desired, pending, committed, and current values.

Vocal scenes use whole-loop recipe boundaries as described earlier. Instrumental scenes normally use every bar. At 80 BPM in 4/4, the next bar may be almost three seconds away. That intentional structural wait is why the continuous timbre response exists.

### Conflict rules

At most one automation writer owns each parameter. Before committing a scene transition, ensure already-committed recipe changes complete before the exit-fade start; otherwise choose a later loop end. Clear any uncommitted outgoing recipe plan. Freeze new outgoing recipe changes once the scene transition commits, while allowing bounded timbre updates until the old deck is silent.

Commands carry IDs and a transport generation. Stop, restart, or reset increments the generation; callbacks from an old generation cannot change the new transport's state.

The reducer and planner must be deterministic functions of prior state, timestamped inputs, readiness, and audio time. No randomness and no wall-clock reads inside the musical decision logic.

## 9. Continuous control

Call the input `openness`, not `handAngle`. The audio system must know nothing about landmarks.

For normalized `u` in `[0,1]`, compute:

```text
cutoffHz = minHz * (maxHz / minHz)^u
```

Start with 800–8,000 Hz on the harmonic anchor, fixed filter resonance, and no sensor-controlled master gain. Clamp the upper cutoff below 0.45 times the actual context sample rate. Biquad Q's meaning depends on filter type; use the API's units, not a generic audio-library Q assumption [9].

Smooth input with a time-aware exponential filter:

```text
alpha = 1 - exp(-dtSeconds / 0.060)
uSmooth = previous + alpha * (uRaw - previous)
```

Then apply short, approximately 30 ms audio-parameter ramps to the cutoff. Do not impose the discrete scheduler's 150 ms lookahead on these immediate changes. Tune the combined input and parameter smoothing by measurement, rather than adding several unspecified low-pass stages.

When replacing an active automation ramp, preserve its value at the replacement time. A feature-tested `cancelAndHoldAtTime` can do this; alternatively track the owned piecewise-linear envelope, evaluate it, cancel future events, and install the held value plus new ramp. The method is not universally available across browsers [7].

Avoid scheduling a new event for numerically insignificant target changes, and do not maintain an unbounded history of obsolete automation in application memory.

## 10. Mapping openness to recipe

Use hysteresis plus a short dwell, not a threshold evaluated independently every camera frame.

| Accepted desired recipe | Downward change | Upward change |
|---|---|---|
| sparse | — | pulse above 0.38; open above 0.72 |
| pulse | sparse below 0.28 | open above 0.72 |
| open | pulse below 0.62; sparse below 0.28 | — |

When two conditions apply, choose the farther state. A sufficiently large hand movement can request sparse directly from open or vice versa; it need not spend a bar in the middle state.

Require a new candidate recipe to remain unchanged for 120 ms of valid input before accepting it. The hysteresis reference is the accepted **desired** recipe, not the lagging audible recipe. Changes in the candidate reset the dwell timer.

The accepted recipe is a target, not a playback command. Section 8 owns execution timing.

At startup use sparse. When a later scene starts, initialize it with the latest accepted recipe captured when its transition is committed; do not mute an incoming vocal halfway through a phrase merely because the control changes while the transition is in flight. Newer desired values can take effect on the new scene's next approved boundary.

## 11. Path advancement and different keys / BPMs

### Path semantics

The path is `scene_a -> scene_b -> scene_c`. A scalar change does not scrub backwards through recordings. Returning the hand to a low value makes the current scene sparse; it does not undo a completed scene advance.

Provide a **Next scene** button first. Add an **Enable hold-to-advance** toggle, off by default.

With hold-to-advance enabled, a high hold emits the same `advance` intent as the button:

```text
openness > 0.92 continuously for 1,200 ms
AND valid, fresh input throughout
AND at least one complete loop has played in the current scene
AND the gesture is armed
AND no advance is pending or committed
```

Rearm only after valid openness stays below 0.75 for 500 ms. Disarm on entry into a new scene, enabling the toggle, calibration changes, input-adapter changes, tracking loss, and event emission. Thus holding the hand high cannot automatically consume the whole path. Show arm state and hold progress.

Before the minimum residence time, do not accumulate the hold timer. Do not turn an old ineligible hold into an immediate event when the scene becomes eligible.

### The only cross-song transition in v0

Use `fade_to_zero_reset`, not an unrestricted equal-power crossfade.

Choose a reviewed outgoing loop end `T`. During the last beat before `T`, fade the outgoing deck from its existing level to exactly zero. Stop its sources at `T`. Start the incoming scene at offset zero at `T`, using its own native-duration grid, and ramp its deck gain from zero to one over approximately 10 ms.

There is deliberately no time interval with two audible source scenes. Their keys and tempos can differ because this is an authored ending and re-entry, not a beatmatched mashup. The change can still be aesthetically abrupt; audition the edge and select material whose ending/re-entry works. A smooth gain envelope is not proof of a good musical transition.

All outgoing processing is upstream of the outgoing deck gain. No old effect tail may bypass the zero-gain boundary.

### Commit timing

The transition begins at `E = T - outgoingBeatSeconds`, not at `T`. Select a loop end far enough away to prepare and commit before `E`, accounting for the 50 ms minimum lead time and any committed recipe ramp.

When `E` enters the lookahead window, commit the **entire transaction**: outgoing fade and stops, incoming source starts, incoming initial recipe, incoming deck ramp, and new clock origin. Do not wait until the handoff itself to schedule the incoming scene.

Before committing, all incoming buffers and approvals must be valid. On failure, keep looping the current scene and display the reason. After committing, sensor dropout must not leave the outgoing deck faded out without an incoming scene.

At `T`, derive transport state from the scheduled audio timeline; do not depend on an exactly-on-time JavaScript callback to establish the new clock. Source cleanup may occur later.

## 12. Camera adapter

### Measurement

Use **screen-plane hand tilt**: lean an open, visible hand left/right. This is not wrist pronation or a metric 3D palm-normal estimate.

Configure MediaPipe for one hand and video input. Its web result supplies landmarks; inference calls are synchronous, so run inference outside the main UI thread [4]. Transfer one video frame at a time to the worker; do not accumulate a frame backlog. Release transferred image resources when finished.

Using wrist landmark 0 and middle-finger MCP landmark 9, first convert normalized image differences into pixel geometry:

```text
vx = (x9 - x0) * videoWidth
vy = -(y9 - y0) * videoHeight
angle = atan2(vx, vy)  // relative to image-up
```

The width/height conversion prevents the camera aspect ratio from changing the measured tilt. Keep preview mirroring separate from inference geometry.

Provide low and high calibration captures using short stable holds. Unwrap angles around a neutral orientation, map the two endpoints to 0 and 1, and support either endpoint ordering. Reject a calibration with too little span or one that crosses an ambiguous wrap interval. As initial UI limits, request a comfortable 30–120 degree total sweep with the palm visible.

Return `valid = false` for missing landmarks, implausibly small wrist-to-MCP distance, invalid geometry, or stale results. A handedness score is not a generic landmark-quality confidence; do not label it as such [4]. Begin with the documented detection/tracking defaults, then tune using actual failures rather than inventing a confidence field.

### Input contract

```ts
interface ControlFrame {
  sequence: number;
  observedAtMs: number; // monotonic producer timestamp; not camera exposure time
  receivedAtMs: number;
  valid: boolean;
  values: { openness: number };
  source: "camera" | "slider" | "replay";
}
```

The main thread owns the observation timestamp and frame sequence and sends them with the worker input. Preserve them in the result. Reject out-of-order or older-than-200-ms results. These timestamps diagnose processing freshness, but are not a measurement of the sensor's actual exposure time.

Camera, slider, and replay adapters feed this same contract and the same control conditioning. Switching adapters clears gesture timers and structural candidates, seeds smoothing from the current control value, and avoids an immediate discontinuity.

### Tracking loss

On an invalid frame, stop accumulating discrete dwell and gesture timers and suppress new structural requests. Hold the last continuous value for 250 ms. If loss continues, move openness toward a neutral 0.3 over approximately one second while **freezing the desired recipe**. The neutral fallback must not create a high-hold or a new arrangement request.

Drop uncommitted camera-originated requests on sustained loss; let already committed audio transitions complete. Keep the current scene running. After reacquisition, require 250 ms of stable valid tracking, resume continuous control smoothly, and require an explicit low-position rearm before another advance gesture.

## 13. User interface and authoring workflow

Use one practical control screen, not a polished installation visualization.

Show camera preview/landmarks; raw and smoothed openness; validity and sample age; active adapter; current scene; loop/bar phase; current, desired, and scheduled recipe; next boundary countdown; cutoff; stem gain and activity meters; advance arm/progress; pending transition; audio-context state; and visible load or scheduling errors.

Provide Start/Stop, manual slider, recipe audition buttons, Next scene, hold-to-advance toggle, calibration, metronome, filter bypass, mapping mode (`timbre_only`, `structure_only`, `combined`), trace export/replay, and configuration export.

Authoring mode additionally permits editing static trims, the three recipe vectors, filter endpoints, and approval notes. Include previews of loop seams and all recipe/scene transitions. Do not build a waveform editor or a DAW-style timeline. Media preparation remains external.

When playback is stopped, configuration edits take effect immediately. During normal performance, playback-affecting edits require stopping and revalidation; do not hot-swap loop lengths or assets into running sources.

The first musical evaluation is done with the slider. If the slider produces bad music, changing the hand tracker will not solve that problem.

## 14. Default values and their status

All values here are **initial engineering settings to tune**, not findings about universal perception or musicality.

| Setting | Initial value |
|---|---:|
| Scene size | 4 bars, 4/4 |
| Recipe grid for instrumental scene | 1 bar |
| Recipe grid when vocals toggle | Whole loop |
| Input smoothing time constant | 60 ms |
| Continuous parameter ramp | 30 ms |
| Recipe-change dwell | 120 ms |
| Recipe gain ramp | 20 ms, ending on boundary |
| Scheduler interval / lookahead | 25 ms / 150 ms |
| Minimum submission lead before ramp | 50 ms |
| Maximum accepted camera-result age | 200 ms |
| Tracking-loss hold / neutral return | 250 ms / 1,000 ms |
| Reacquisition stabilization | 250 ms |
| High-hold threshold / duration | 0.92 / 1,200 ms |
| Rearm threshold / duration | 0.75 / 500 ms |
| Minimum scene residence | One complete loop |
| Outgoing scene fade | Last beat of outgoing loop |
| Incoming scene fade | 10 ms |
| Initial master attenuation | -9 dB, then verify headroom |
| Anchor filter range | 800–8,000 Hz, then audition |

## 15. Module structure

```text
src/
  main.ts
  config.ts              # manifest validation, load state, approvals
  control/
    types.ts
    hand.worker.ts
    camera.ts
    slider.ts
    replay.ts
    conditioning.ts      # calibration, smoothing, validity handling
  music/
    mapping.ts           # hysteresis, dwell, advance latch
    planner.ts           # pure desired-state/boundary decisions
    transport.ts         # scene origins and integer grid indices
  audio/
    assets.ts            # WAV fetch/decode/validation
    deck.ts              # synchronized sources and routing
    automation.ts        # bounded, owned envelopes
    engine.ts            # execute plans using the audio clock
    offline.ts           # same graph + plans in OfflineAudioContext
  ui/
    controls.ts
    diagnostics.ts
  trace.ts
public/
  scenes/                # ignored real audio; manifests and fixtures separate
  models/                # setup script retrieves pinned model/WASM assets
scripts/
  create-fixtures.ts
  setup-models.ts
tests/
  mapping.test.ts
  planner.test.ts
  manifest.test.ts
  audio.spec.ts
```

Keep these as small modules, not separate services. Do not create a plugin architecture or a generic constraint-solver framework.

The planner emits typed actions such as `RampRecipe`, `CommitSceneReset`, and `StopTransport`. The audio engine interprets them. The UI renders state; it must not secretly initiate additional audio actions.

Implement a reusable graph builder accepting a `BaseAudioContext`, so offline rendering and live playback share routing and envelope code. OfflineAudioContext renders a graph into an audio buffer rather than a sound device [8].

## 16. Trace and replay contract

Record compact JSONL with session-relative timestamps for raw control frames, accepted desired states, discarded stale data, tentative and committed actions, scene origins, actual scheduled audio times, and errors. Include config fingerprint, input mode, context sample rate, and build version.

Use one declared monotonic origin per session. Store mappings between observation timestamps and audio-context time; do not subtract unrelated clock epochs. Suspend/resume requires a fresh mapping and transport generation. Replay uses its own controlled origin.

A raw-control replay bypasses only the camera: it still runs through smoothing, hysteresis, dwell, and the planner. A separate event-plan replay may bypass control logic for audio regression tests; name these modes distinctly.

An identical control trace and readiness/timing simulation must produce an identical event plan. Numerical audio comparisons may use tolerances appropriate to the pinned browser; do not demand bit-identical output across different browser implementations.

## 17. Tests and acceptance criteria

### Engineering fixtures

Generate small synthetic, clearly labeled test scenes with known impulses, sustained tones, and rhythm markers. Include two different native tempi and pitches. These fixtures test the implementation only; they are not a substitute for the user's recordings or an artistic music-generation feature.

### Automated tests

| Test | Required behavior |
|---|---|
| Same-start alignment | Corresponding marker impulses across stems align within one output sample in offline rendering. |
| Loop clock | Markers remain phase-aligned over repeated loops; boundaries derive from the same decoded loop duration. |
| Mute/unmute | Re-exposed audio matches the current loop phase, not the start of the file. |
| Boundary scheduling | Every recipe ramp ends on an approved boundary; late requests defer. |
| Latest-wins | Rapid uncommitted low/high/low requests do not play a FIFO of old intentions. |
| Committed event | A reversal cannot partially cancel an already-submitted recipe transition. |
| Hysteresis | Noise that stays within the hysteresis band causes no repeated recipe changes. |
| Gesture latch | A sustained high value emits at most one advance until rearmed. |
| Tracking loss | No new camera-triggered structure events; playback continues and committed transitions finish. |
| Native-tempo reset | No audible outgoing-deck contribution at/after incoming start; the incoming clock uses its own duration. |
| Failed incoming scene | The outgoing scene never fades out for an unready or unapproved target. |
| Automation ownership | Filter changes cannot overwrite recipe or deck-fade automation. |
| Stop/restart | Old callbacks cannot mutate the new transport; sources are stopped and disconnected. |
| Manifest errors | Bad lengths, absent stems, stale approvals, illegal grids, and nonfinite parameters fail clearly. |

Use offline rendering for precise waveform checks and pure simulated clocks for scheduler tests. Do not rely on browser timers to prove sample-accurate scheduling in a unit test.

### Real-content audition gate

For each actual scene, audition all recipes, the full filter sweep, the loop seam, and all permitted directed recipe changes at their allowed bar positions. For each scene edge, audition all outgoing/incoming recipe combinations. Keep approval notes.

Check for clipped words, exposed bleed, masked bass, doubled transients, overly dramatic loudness changes, awkward harmonic endings, and an anchor that becomes inaudible. Any unacceptable case narrows the content or control range; it is not excused by the fact that the stems have the same song ID.

Render every permitted recipe and transitions plus representative fast control sweeps. Initial sample-peak acceptance is below -1 dBFS, with no nonfinite samples. This is a sample-peak check, not an intersample true-peak guarantee and not a complete musical-quality metric. Avoid a naive universal adjacent-sample jump threshold that flags legitimate transients as clicks.

### Interaction gate

Test slider control first, then camera control. In combined mode, a clear tilt should produce an immediate, audible timbral response and a visibly pending structural response that arrives on the declared grid.

Use timbre-only and structure-only modes as ablations. Hide the control display briefly to check whether the sound, rather than the animation, communicates the action. Compare live control with a recorded trace replay. Ask the participant what they think their movement changes, without naming the mappings first.

Proposed target: continuous camera movement-to-audible-response onset has median below 150 ms and 95th percentile below 250 ms on the target setup. Measure physical end-to-end behavior with an external recording or appropriate loopback arrangement; internal frame timestamps alone are not that measurement. Report actual observations and tune or simplify when the target is missed.

Run a 30-minute foreground session with camera inference, repeated scene advances, invalid tracking, and deliberate short main-thread stalls. Require no unexplained audible dropout, no progressive source/node growth, and intelligible error reporting. Long UI stalls may defer structure and temporarily freeze continuous updates; they must not trigger a late off-grid catch-up transition.

## 18. Build sequence

**Milestone 1 — Audio before vision.** Generate fixtures, load one scene, start synchronized loops, add slider-driven filter movement and bar-quantized recipe changes. Deliver a real runnable page, not only type definitions.

**Milestone 2 — Actual music.** Prepare one instrumental passage from the user's stems, tune three recipes and the filter range, verify seams and grid, and approve it. The instrument must already be enjoyable with the slider.

**Milestone 3 — Hand control.** Add the worker, two-point calibration, one scalar, dropout handling, diagnostics, and raw-control replay. Camera and slider feed identical musical logic.

**Milestone 4 — Flow.** Add a second native-tempo scene, the approved reset edge, manual Next, then opt-in high-hold advancement and latch tests.

**Milestone 5 — One deliberate extension.** Only after the above passes, add either a second external control or one additional effect—not both simultaneously. Preserve the planner/engine interface and qualification rules.

Required repository commands are `npm run dev`, `npm run build`, `npm test`, `npm run test:browser`, `npm run fixtures`, and `npm run setup:models`. Document setup, media preparation, calibration, constraints, and measured acceptance results. Keep user recordings out of source control.

## 19. Extension boundary

A later simulation replaces the input adapter and emits the same normalized values. Add a second dimension with a distinct responsibility—for example, openness still controls arrangement while spatial position controls bounded panning. Add an effect only with declared range, smoothing, ownership, and tail behavior.

For future cross-song simultaneous stems, create a new **explicitly authored hybrid scene** whose rendered assets share an exact time grid and have been auditioned together, including local chord progression and offsets. Do not weaken v0's rules by allowing an arbitrary bass from the next song because the global key names match.

Automatic compatibility ranking can later propose hybrid scenes for review. It should not be placed between the camera and playback before this simpler instrument demonstrates useful interaction.

## 20. Definition of done

The user can start the page, play synchronized stems, move a slider or tilt a visible hand, hear immediate timbral change, hear musically timed arrangement changes, and deliberately advance along a reviewed path without simultaneous incompatible songs. The display explains pending actions, and replay reproduces the decision sequence.

The result does **not** establish that arbitrary stems are compatible or that universal musicality has been solved. It establishes a working performance engine whose choices are expressive because the allowed choices and their timing have been authored.

## Sources and evidence boundaries

All numerical control settings, state machines, scope choices, acceptance targets, and content rules in this document are proposed design decisions. The references establish relevant API behavior; they do not validate the proposed musical mapping. No external musical-quality benchmark is claimed.

The supplied research brief, *Research Brief: Sensor-Driven Live Mixing of Demixed Commercial Music*, provides the recording-based constraint (lines 18–20), desired-state scheduling (line 61), and arrangement-preserving/recombining distinction (line 69). This spec is a new, narrower engineering proposal, not a summary of every claim in that brief.

[1] MDN, **AudioBufferSourceNode: start()**. Scheduled start timestamps and offsets. https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode/start

[2] MDN, **AudioBufferSourceNode** and **loop**. Reusable buffers, single-use source nodes, and looping behavior. https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode · https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode/loop

[3] Chris Wilson / web.dev, **A tale of two clocks**. Separating timer-driven scheduling from audio-time execution. https://web.dev/articles/audio-scheduling

[4] Google AI Edge, **Hand landmarks detection guide for Web**. MediaPipe setup, outputs, and synchronous inference behavior. https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/web_js

[5] MDN, **BaseAudioContext: decodeAudioData()**. Decoding and resampling to the context rate. https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/decodeAudioData

[6] MDN, **MediaDevices: getUserMedia()**. Permissions, media constraints, and secure contexts. https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia

[7] MDN, **AudioParam: cancelAndHoldAtTime()**. Automation replacement and compatibility limitation. https://developer.mozilla.org/en-US/docs/Web/API/AudioParam/cancelAndHoldAtTime

[8] MDN, **OfflineAudioContext**. Offline graph rendering. https://developer.mozilla.org/en-US/docs/Web/API/OfflineAudioContext

[9] W3C, **Web Audio API 1.1**, BiquadFilterNode section (working draft), and MDN **BiquadFilterNode.Q**. Filter-type-specific Q semantics. https://www.w3.org/TR/webaudio-1.1/#BiquadFilterNode · https://developer.mozilla.org/en-US/docs/Web/API/BiquadFilterNode/Q
