# FX Playground

Listen at **http://127.0.0.1:4178/fx-auditions/index.html**. The page has a dry reference and four candidates on the same passages from Back To Us (74 BPM) and Ladders (104 BPM). Each example is 24 beats: 16 beats of the effect gesture and eight beats to settle. The examples are rendered from the actual Live devices and matched in loudness using gain only.

Open **`~/Music/LiveMixer/Back To Us Project/LiveMixer - FX Playground.als`** to try the editable effects. On **Main**, the **LiveMixer FX Playground** device has four knobs and **Auto audition**. Press Play with Auto audition enabled to cycle through Dry → Flicker → Dub → Dive → Halo, changing every 16 beats. The cycle restarts at the Ladders locator. **Dry / reset** releases the controls and lets delay/reverb tails fade. Moving a playground knob switches to manual control.

| Candidate | Sound | Routing | Gesture idea |
|---|---|---|---|
| Drum Flicker | Four fast sixteenth-note drum slices, gently decaying, with space between bursts | Beat Repeat and Quick Stutter on DRUM FX | A brief accent when movement peaks |
| Dub Throw | Filtered dotted-eighth ping-pong repeats with a little tape movement | Texture, snare, and other-drums sends into the DUB THROW return | A quick throw, then release the input and let the echo answer |
| Velvet Dive | A smooth resonant dip and reopening of the harmonic textures | Auto Filter on TEXTURE FX | Close/open a hand over a bar or two |
| Halo Bloom | A wide, filtered reverb swell with an octave-up component | Texture send into the HALO BLOOM return | Slow sustained movement, then a gradual release |

The original vocal stems bypass all four candidates; the bass stem stays dry too. Stem separation can leave some vocal leakage in the instrumental stems. Echo and reverb filter out low frequencies so they have less opportunity to obscure the bass. Octave shimmer avoids committing to a fixed musical key. Musical taste still needs your listening judgment; these are candidates, not a claim that one setting fits every track.

The full original arrangements remain intact in the playground. DRUM FX groups Kick, Snare, and Other Drums. TEXTURE FX groups Guitar, Piano, and Melodies. The two vocal tracks stay in VOCALS. The Main limiter and gain stage are retained. The first cycle's effect changes are labeled with FX locators; the controller's status displays subsequent cycles.

## Performance and automation

The four knobs are exposed as Max for Live parameters (`FX Flicker`, `FX Dub`, `FX Dive`, `FX Halo`) and can be automated or MIDI mapped. **Auto audition is a listening aid**; turn it off when performing with a simulation or other controls. The existing mix-control page still operates vocal presence, Main reverb, drum stutter amount, and mix gain; the new Dub/Dive/Halo mappings are separate candidates for the next gesture design.

Quick Stutter still uses Live's audio-rate musical phase for slice timing. The playground applies slower filter and send gestures using Live's transport position. The echo uses Live's synchronized delay time, and the effect pattern follows the 74-to-104 BPM transition. No external server is required to use the playground knobs or auto audition inside Live.

`devices/LiveMixer FX Playground/` contains the device and JavaScript. Rebuild with `python3 scripts/build-fx-playground.py`; keep `fx-playground.js` next to the `.amxd`. A copy of each is collected under the project's Presets folder. Refresh discovers the prepared buses and parameters after loading.

The local OSC input on port 7403 accepts `/fx/values` with four values, `/fx/auto`, and `/fx/release`. Diagnostic capture is off by default; `/fx/capture 1` writes stereo Main audio plus transport position/state to `/tmp/livemixer-fx-capture.wav`, and `0` stops. The comparison renders and their measurements are in the project's **FX Auditions** folder.

The corrected quick-repeat setup is also saved separately in **LiveMixer - Two Song Trial.als**. **LiveMixer - Before Quick Stutters.als** preserves the longer-burst setup with your earlier Beat Repeat settings.
