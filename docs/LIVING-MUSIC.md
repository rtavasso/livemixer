# Living music: the song is the instrument

When nobody is at the installation, the song plays as it was mixed. A visitor moves it away from that mix on four slow axes. When they leave, it drifts back over a few seconds. The governor is in `src/living/governor.ts`. The controls page runs it in **Living** mode, the bridge carries its output, and the **LiveMixer Two Song FX** device applies it in Live.

## Axes

Every living simulation (Tide, Lantern, Murmuration) publishes `presence`, `reach`, `lift`, `closeness` and `agitation`, all 0..1.

| Axis | Home | Driven by | Time | Live target |
|---|---|---|---|---|
| Vocals | 0: instrumental | presence (gate from .15 to .5) | opens in 0.4 s, fades over 2.5 s | Vocal Presence, CC20 |
| Arrangement | .5: original balance | lift: high means textures lead, low means rhythm leads | τ 1.5 s | DRUM FX and TEXTURE FX group volumes, ±4 dB max, in opposite directions |
| Depth | 0: unfiltered | reach | τ 0.8 s | TEXTURE FX Auto Filter "Dive" |
| Space | 0: dry | closeness while present | rises with τ 2.5 s, falls with τ 3 s | Halo send, Dub echo sends (kept low), Main reverb |

**Allowance** is how far the song may leave home: `(0.35 + 0.65·closeness) × (1 − 0.7·agitation)`. Agitation is smoothed first (τ 0.6 s), so one flick of the hand does not collapse the song. Arrangement and depth are scaled by allowance, and space is capped by it. A patient visitor gets the transformed song. A flailing one gets something close to the plain song. When presence is 0, every target is home. Missing or invalid signals count as absent.

### Ceilings (`toLiveControls`)

| Value sent | At full axis | Notes |
|---|---|---|
| Main reverb (`space`) | 0.5 | Live already caps Main reverb at 20% wet, so the most this sends is about 10% wet |
| Dive | 0.8 | Auto Filter Control `.5 − .37·dive`, which reaches .204 at full depth |
| Halo | 0.6 | TEXTURE FX send B |
| Dub | 0.3 | A continuous low echo, never thrown |
| Flicker, stutter | always 0 | Living mode sends no one-shots |
| Balance | arrangement | ±4 dB at 0 and 1 |

These values are defaults in `DEFAULT_MAPPING` and `DEFAULT_GOVERNOR`.

## Protocol

- Page → bridge (WebSocket 9001): `{type:'controls', vocals, space, stutter, gain, fx:{flicker, dub, dive, halo, balance}}`. The `fx` object is optional. Every value must be finite and in 0..1, or the whole message is rejected.
- Bridge → Two Song FX (UDP 7403): `/fx/values flicker dub dive halo balance` whenever the values change, and every 250 ms as a heartbeat. The bridge sends `/fx/release` on release, timeout (1.5 s), disconnect, shutdown, or when messages stop carrying `fx`.
- Two Song FX eases back to home on its own if no `/fx/values` arrives for 1.5 s.
- Page → simulation (BroadcastChannel `livemixer-sim`): `{direction:'inbound', message:{type:'music', beat, playing}}`, relayed from every bridge status that includes Live's transport.

## FX QUIET zones: the song has the last word

To add one, create a locator in Live's Arrangement and name it **`FX QUIET`**. Anything after that prefix is allowed, for example `FX QUIET drum switch`. The zone runs from that locator to the next locator of any name. If there is no later locator, it runs to the end of the set. Inside a zone, the depth, space and arrangement effects fade out over 2 beats, and they fade back in over 2 beats after the zone ends. Vocals are not affected. Put the locator about half a bar before a pre-mixed transition so the effects are gone when the transition starts. Press **Refresh** on the device after adding or moving locators. The device status shows how many zones it found.

## Generated stem sets (`scripts/ableton-stem-set.py`)

The set builder adds the installation to every set it writes unless `--plain` is given:

- Each song group holds **DRUM FX** (Kick, Snare, Other Drums), **04 Bass**, **TEXTURE FX** (Guitar, Piano, Melodies; Auto Filter "Velvet Dive") and **VOCALS** (Lead, Background; Utility "Vocal Presence"), the layout of the hand-built sets. The song group keeps the EQ Three and the transition automation.
- The returns are **A-DUB THROW** (Echo) and **B-HALO BLOOM** (Hybrid Reverb); Main carries **Space** (Reverb, MIDI CC21), **Mix Gain** (Utility, CC23), the Limiter and **LiveMixer Living FX**.
- Only the first song's Vocal Presence is mapped to CC20 (Live maps a control to one parameter); Living FX mirrors its gain to every other VOCALS group.
- Every overlapping transition is wrapped in `FX QUIET` … `FX ON` locators, so the box never colours a handover. In Living FX a zone ends at the next locator that is **not** a `SONG:` locator (the incoming song's locator sits inside the zone).
- `LiveMixer Living FX.amxd` and `living-fx.js` are copied into a `LiveMixer Living FX` folder beside the set. The device drives all song groups together (only the playing song is heard), has no one-shots, and reports Live's position to the bridge (UDP 7401) so the simulations follow the beat.

The device templates are extracted from the hand-built Drum Transition set: `python3 scripts/extract-living-templates.py` (writes `scripts/ableton-templates/living.xml`). Rebuild the device with `npm run ableton:living-fx`. Tests: `npm run test:ableton-set` (set structure) and `node --test tests/living-fx.test.mjs` (the device script against a mock of Live's API).

## Try it

1. In Live, open a set built by `scripts/ableton-stem-set.py`; **LiveMixer Living FX** on Main should read `Ready · N songs · vocals N/N · M FX QUIET`; fewer vocals than songs means some songs' vocals will not follow the hand. Or, for the hand-built set, open `LiveMixer - Two Song Trial.als`. On Main, press **Refresh** on **LiveMixer Two Song FX**, or delete it and add it again from the project's Presets, so it loads the new `two-song-fx.js`. Its status should read `Ready - both song groups` and, when there are zones, `· N FX QUIET`. If it shows `balance off`, the DRUM FX groups were not found.
2. In this repository, run `npm run dev` and, in another terminal, `uv run scripts/ableton-bridge.py`.
3. Open http://127.0.0.1:4178/sim.html?sim=tide (or `lantern` or `murmuration`).
4. In the same browser, open http://127.0.0.1:4178/ableton.html and click **Connect to Live**. **Living** is selected automatically once the simulation's schema arrives. The meters show the song axes and the incoming signals.
5. Start playback in Live.

## Listening checklist (must be verified by ear in Live)

- [ ] With nobody present, the song is the original mix: instrumental, dry, unfiltered, with the group faders at home.
- [ ] Vocals enter smoothly within about half a second and fade over about 2.5 s after the hand leaves, without a dropout.
- [ ] Hand high: the textures come forward and the drums step back. Hand low: the reverse. Nothing is muted, and ±4 dB is tasteful rather than obvious.
- [ ] Reaching deep gives an underwater low-pass on the textures only. Bass, drums and the dry vocal stay clear.
- [ ] Space blooms slowly. The Dub echo is a quiet tail and never a throw. The Main reverb is not washy.
- [ ] Waving wildly keeps the song near home. A still, patient hand transforms it the most.
- [ ] In `FX QUIET` zones the transition plays as authored, and the effects return smoothly afterwards.
- [ ] Closing the controls page or stopping the bridge returns the effects and group balance to home within about 2 s. Vocals return to full, which is the bridge’s existing fail-safe default.
- [ ] The group volumes return to their original positions after Release, Refresh or deleting the device. Check that DRUM FX and TEXTURE FX volumes have no automation, because the device would override it.
- [ ] The Auto audition and the device dials still work as before.

## Operator notes

- Adjust DRUM FX or TEXTURE FX group volumes only while the song is at home, then press **Refresh**. That reading becomes the new home.
- Press **Release & reset** on the controls page before saving the set, so that offset group volumes are not saved.
- `scripts/build-two-song-controls.py` keeps the maintained `two-song-fx.js`; delete the file first only if you want its original derivation back.
