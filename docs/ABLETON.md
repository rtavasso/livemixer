# Ableton simulation mix

For the newer set with separate song groups and a 74 → 104 BPM drum transition, see [Back To Us → Ladders: drum transition](ABLETON-TRANSITIONS.md). The instructions below describe the earlier consecutive mix.

Open `~/Music/LiveMixer/Back To Us Project/LiveMixer - Two Song Trial.als` in Live 12 Trial. Max for Live is included in this trial. The earlier one-song sets are retained. `LiveMixer - Before Quick Stutters.als` preserves the longer repeat behavior and the effect settings from before this adjustment.

## Try it

The control app is in `/Users/rtavasso/atiercorp/livemixer`. From that repository, run these in separate terminals:

```sh
npm run dev
uv run scripts/ableton-bridge.py
```

Open **http://127.0.0.1:4178/ableton.html**, click **Connect to Live**, and start playback in Ableton. Use the page's four sliders. The Beat Repeat slider controls a quick burst of sixteenth-note slices: 25% = one stutter, 50% = two, 75% = three, 100% = four. At maximum, the whole burst lasts **one quarter-note beat**: about **0.58 seconds at 104 BPM**, or **0.81 seconds at 74 BPM**. Each burst is followed by at least four dry quarter-note beats; the next burst waits for a quarter-note boundary. Holding the slider up keeps cycling. **Release & reset** immediately releases the effect and restores full vocals, dry reverb, and unity mix gain.

To use gestures, open **http://127.0.0.1:4178/sim.html** in another tab of the same browser/profile and select **Simulation** on the controls page. Choose each control's source in its signal dropdown. Defaults are hand presence → vocals, hand motion → reverb and repeat, and a manual value of 1 → mix gain. Signal ranges come from the simulation's telemetry schema; continuous changes are smoothed over about 120 ms. Keep both tabs on the same origin (`127.0.0.1`, not one on `localhost`).

The bridge sends sound controls only. Playback, tempo, song order, and transitions stay in Ableton. Leave Arrangement Record off unless deliberately recording a performance.

## Arrangement

| Song | Start | Tempo | Musical length |
|---|---|---:|---:|
| Rec Hall — Back To Us | 1.1.1 | 74 BPM | 308 quarter notes / 77 bars |
| Mac Miller — Ladders | 78.1.1 | 104 BPM | Full extracted audio, about 4:46.38 |

The second song starts at arrangement beat 308, about **4:09.73** into the mix. Total audio length is about **8:56.11**. This is a consecutive transition; both songs use their own native tempo.

Nine tracks are reused for both songs: Kick, Snare, Other Drums, Bass, Guitar, Piano, Melodies, Lead Vocals, Background Vocals. The two vocal tracks feed the VOCALS group. Redundant full Drums/Vocals/Instrumental stems are excluded. Both songs' nine clips use identical warp maps throughout the used audio within each song, so their stems retain alignment.

Drum-onset analysis supported 74.001 BPM for Back To Us and 104.0005 BPM for Ladders, consistent with 74/104. Back To Us's first beat is aligned to source time 0.216 s; its final approximately 20 ms are outside the 77-bar region. Ladders starts at source time zero. Shorter decoded Ladders stems were padded only at the end by 1,919 samples (43.5 ms). No stem was shifted independently.

Clips use **Re-Pitch Warp** at their native tempo, preserving the timing relationship between stems. If introducing tempo ramps or overlaps later, choose a common tempo during the overlap; Re-Pitch also changes pitch when the tempo changes. Use a suitable pitch-preserving Warp mode across the stems if that is desired.

## Controls and effects

| Control | Channel 16 CC | Destination | Range |
|---|---:|---|---|
| Vocal presence | 20 | VOCALS → Vocal Presence → Gain | Silence to 0 dB |
| Reverb | 21 | Main → Space → Dry/Wet | 0–20% wet |
| Repeat amount | 22 | Main → LiveMixer Quick Stutter → Amount | 0–1 |
| Mix gain | 23 | Main → Mix Gain → Gain | −12 to 0 dB |

MIDI input is **IAC Driver LiveMixer**, with Remote enabled and Track/Sync disabled. CC22 now controls the **Amount knob**, replacing its old direct assignment to Beat Repeat's Repeat button. The web bridge sends repeat amount over local OSC, which also supplies a heartbeat; the other controls use MIDI. Direct MIDI remains available for manual use:

```sh
uv run scripts/ableton-midi.py send stutter 0.5
uv run scripts/ableton-midi.py send stutter 0
uv run scripts/ableton-midi.py reset
```

Normal amount changes are latched at the start of the next burst. Zero prevents another burst and lets the current one finish. Transport stop, the Release button, a song boundary, or a lost connection can release an active burst immediately. After a song boundary, the controller allows four dry beats before capturing the new song. An emergency release followed by immediate resumed input waits until a beat boundary at least four full beats later. At full amount, one beat on plus four off is a five-beat cycle. At half amount, half a beat on is followed by 4.5 dry beats, keeping the next start on a quarter note. Starts need not always be bar downbeats.

Beat Repeat uses Insert mode, **1/16 slices**, No Triplets, zero Chance, zero Variation/Pitch/Decay, and 0 dB repeat level. The Interval and Gate settings you adjusted are preserved, but native **Repeat bypasses Interval, Chance, and Gate**. The Max controller sets how long Repeat stays on, so lowering Gate alone cannot shorten these bursts. Keep Grid at 1/16 for the displayed stutter count to match; changing Grid changes the number and speed of slices inside the same burst duration. Its **Repeat** parameter is controlled by the Max device; use **Amount** to perform with it. Space retains a 2.4 s decay and 20 ms predelay. Main's Utility and True Peak Limiter retain the existing gain settings: limiter ceiling −1 dB, Main fader −6 dB.

## Adding more songs

1. Put the next song's stems on the matching tracks at a whole-beat boundary. Keep their source offsets and warp maps identical, and verify the BPM and first beat.
2. Add a Song Tempo automation step on Main at that boundary. The audio and Live's beat grid must agree.
3. Add a locator named **`SONG: Artist - Title`** at the same boundary.
4. Click **Refresh songs** on LiveMixer Quick Stutter after adding or moving locators. It supports up to 32 songs, including the first song. Keep exactly one Beat Repeat and one Quick Stutter device on Main.

The two-song names in the web page describe this trial set; the Max controller's boundary list is read from the arrangement locators. Use the Live arrangement for the authoritative running order.

## Implementation and verification

`devices/LiveMixer Beat Cycle/` contains the editable Gen source, the Max JavaScript binding helper, and the built `LiveMixer Quick Stutter.amxd`. The original `LiveMixer Beat Cycle.amxd` is retained for the older set. Rebuild with `python3 scripts/build-ableton-device.py`. Keep `livemixer-bind.js` beside the `.amxd` when copying the device. A copy is inside the Live project under `Presets/LiveMixer Quick Stutter/`.

`plugphasor~` supplies Live's quarter-note phase. The counter and gate run in Gen at audio rate; JavaScript only discovers the Repeat parameter and song locators. `live.remote~` controls the native effect with its documented audio-buffer latency. No browser timer or BPM-to-milliseconds estimate determines the burst length.

The local bridge listens on WebSocket 9001 and receives device status on UDP 7401; the Max device receives OSC on UDP 7400. Controls messages contain `{ "type": "controls", "vocals": 1, "space": 0, "stutter": 0.5, "gain": 1 }`. Values must be finite and within 0–1. One control window owns the connection at a time. A missing controls stream or bridge heartbeat times out after 1.5 seconds. The page detects missing simulation frames after 750 ms and requests a release. Direct MIDI/manual knob control intentionally has no heartbeat timeout.

The device can capture an explicit diagnostic recording via OSC `/livemixer/capture 1` and stop with `0`. It writes `/tmp/livemixer-cycle-capture.wav`: stereo audio, beat phase, repeat gate, remaining on beats, remaining off beats, arrangement beat, and transport state. Recording is off by default. These channels permit checking real Live timing and audio together.

Validation results are recorded in `docs/ABLETON-QUICK-STUTTER-VERIFICATION.json` (short bursts) and `docs/ABLETON-VERIFICATION.json` (the original longer-burst setup). Unit tests cover control normalization, MIDI midpoint rounding, invalid inputs, exclusive control ownership, and disconnect reset. The production build and a browser integration check cover the control page, actual simulation telemetry, and stale-input recovery. Audio verification checks repeat behavior and timing; musical balance and effect taste still need a listening pass.

References: [Live Trial includes Max for Live](https://help.ableton.com/hc/en-us/articles/209071129-Installing-the-Live-Trial), [host-synchronized phase](https://docs.cycling74.com/reference/plugphasor~/), [real-time parameter control](https://docs.cycling74.com/reference/live.remote~/), [tempo automation](https://www.ableton.com/en/manual/automation-and-editing-envelopes/), [Beat Repeat](https://www.ableton.com/en/manual/live-audio-effect-reference/#beat-repeat).
