# Back To Us → Ladders: drum transition

Open `~/Music/LiveMixer/Back To Us Project/LiveMixer - Drum Transition.als` in Live. The original FX Playground and Two Song Trial sets are separate files.

Two top-level groups contain each song's stems independently: **A - Back To Us** and **B - Ladders**. Each contains DRUM FX (Kick, Snare, Other Drums), Bass, TEXTURE FX (Guitar, Piano, Melodies), and VOCALS (Lead and Background). All files are collected WAVs in the existing project.

## Audition

Jump to **LISTEN FROM HERE**, bar **66.1.1**, and press Play. Keep Auto audition off to hear the transition without extra effect gestures.

| Arrangement position | What happens |
|---|---|
| 66.1.1 | Listening starts, four bars before the overlap. |
| 70.1.1 | A four-bar Ladders drum passage enters at 74 BPM, at −9 dB clip gain, underneath Back To Us. |
| 74.1.1 | Ladders drums repeat at normal clip gain; Back To Us's drum clips end. Its bass, instruments and vocals continue at their original speed. |
| 78.1.1 | Back To Us ends. The next repeat of the Ladders drums accelerates from 74 BPM. |
| 82.1.1 | The ramp reaches exactly 104 BPM. All nine original Ladders stems begin together, from source time zero. |

The orange clips use the same source passage (source beats 128–144, source bars 33–37) from all three Ladders drum stems. They are three adjacent four-bar copies, not an added full Drums stem layered over its subdivisions. Ladders' full song remains intact, including its original intro. Consequently, the full-song entry returns to the quieter original intro rather than jumping to a chorus/drop.

Back To Us's final four bars of **drums only** are replaced by the incoming drums. Its other six stems retain their previous full extent. The outgoing drum clip ends can be extended back to bar 78 if desired.

## How to edit it in Ableton

1. Expand **B - Ladders → DRUM FX** to see the three orange rows. Select the same four-bar block across Kick, Snare and Other Drums when moving or copying it, to keep the parts aligned. Command-D duplicates a selected block.
2. Double-click an orange clip. **Warp** is enabled and the warp mode is **Beats**. The source timing is **104 BPM**. It plays at 74 BPM because it follows the arrangement's tempo. Keep source BPM at 104; changing that to 74 would describe the source incorrectly.
3. Right-click the top-left tempo field and choose **Show Automation**. On **Main**, the automation chooser should show **Mixer → Song Tempo**.
4. The line stays at **74** through **78.1.1**, then rises to **104** at **82.1.1**. Right-click an automation breakpoint → **Edit Value** to type an exact BPM. Move the endpoints horizontally to change how long the acceleration takes.
5. If moving the full Ladders entry, move all nine full-song clips together and move the **104 BPM endpoint** and **SONG: Ladders** locator to the same position. Extend/repeat the drum bridge as needed, then press **Refresh songs** on the stutter device.

Live has one global tempo. Every warped clip playing during the ramp follows it. This example starts the acceleration after Back To Us ends, so its vocals and instruments never accelerate. Moving the ramp earlier would also speed up its remaining warped clips; their existing Re-Pitch mode would also raise pitch.

The orange drum clips use Beats mode to preserve drum pitch while following the tempo. Their source offsets and warp maps are identical across the three stems. The full songs retain their original warp maps and play at native tempo.

## Existing simulation effects

Main contains **LiveMixer Two Song Stutter** and **LiveMixer Two Song FX**. The shared stutter controller drives both DRUM FX Beat Repeat devices from one audio-rate clock. Vocals and bass bypass the repeats. The FX controller applies Dub/Dive/Halo to both banks and mirrors the original vocal-presence Utility control to the second vocal group. The FX audition cycle discovers `SONG:` locators rather than assuming a hard-coded Ladders start.

The OSC ports remain 7400 for stutter and 7403 for FX. Reverb and Main gain keep their existing controls. Transition timing belongs to the Arrangement; effect controls do not move the clips or change the tempo ramp.

Source and built devices are in `devices/LiveMixer Two Song Controls/`, with collected copies under the project's Presets folder. Rebuild using `python3 scripts/build-two-song-controls.py`. The builder derives these variants from the original devices, which remain unchanged.
