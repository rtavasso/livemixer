# Library and mix workspace

The library extension was added after completing the base instrument, in response to the request to work with a folder of 50 demixed songs. It adds selection and analysis tools while retaining the engine's authored recipes and fade-to-zero scene changes.

## From a folder to a mix

1. Open **Build mix > Open songs folder (WAV)**. Select the external folder containing your demixed WAVs. The files remain local and are not uploaded or copied into the repository. **Setup > Engineering test audio > Synthetic tone library** exercises the interface with the two engineering fixtures.
2. Browse or search the song list. Automatic assignment supports folders such as `Library/Song Name/other.wav`, `bass.wav`, `drums.wav`, `vocals.wav`, as well as flat filenames such as `Song Name_bass.wav`. Use **Stem assignment** for unusual names. Missing roles, duplicate choices, unsupported files, or mismatched frame counts are shown explicitly.
3. Use **Analyze song** or **Analyze missing songs**. Analysis runs in a separate worker, one song at a time; it can be canceled while preserving completed results. Import itself reads WAV headers and does not decode all 50 songs.
4. Set **Grid BPM** and **Downbeat offset** by listening. Select a start bar and four or eight bars. Click a waveform to move to the nearest bar on your declared grid. Estimates are starting points, not an approved clock.
5. **Preview selection**, solo or mute stems, and enable **Grid metronome** to check timing against the excerpt. All audition stems share a start and loop phase. Adjust the grid or choose another passage if transients drift, the seam is poor, or a phrase is cut. This is a passage selector, not a waveform repair editor.
6. **Add passage to mix**. Optional vocals save a whole-loop grid for authored auditions; live playback defaults to Next beat and also offers Immediate timing. Add more passages, reorder them with the arrow buttons, write connection notes, and optionally repeat the path. Multiple passages from one song are supported.
7. **Audio checks** opens the corresponding transition audition in Setup. **Use this mix in Play** prepares the full path. Tune complete recipes, trims, and filter controls, render headroom checks, listen to all required cases, then save manual reviews. Instrument edits to these prepared scenes flow back into the library project and ZIP export.
8. **Save or reopen a project > Save project** retains song annotations, analysis, selections, order, recipe tuning, and saved review records in a JSON file. To restore, first select the same unchanged library folder, then **Open saved project**. **Save mix with audio (ZIP)** contains the aligned excerpts and `manifest.json`; extract it and select that folder in the instrument.

Changing a source length or introducing media outside the library project in the instrument's advanced manifest editor cannot be reconstructed by the library cutter. The UI reports this; export that instrument configuration separately. Normal trim, gain, filter, note, and approval edits are retained.

## Analysis provided

| Display | Meaning and limits |
|---|---|
| Source alignment | Equal WAV sample rates and frame counts; listening still has to establish that the sources share a downbeat and origin |
| Waveform overview | 768 maximum-amplitude bins per stem, spanning the full file; square-root display scaling helps expose quiet activity |
| Sample peak, RMS, crest factor | Whole-file levels in dBFS and peak-to-RMS difference; RMS is **not LUFS** and sample peaks are **not true peaks** |
| Quiet fraction | Fraction of source frames whose mean channel energy is below −50 dBFS |
| Near-full-scale samples | Samples with magnitude ≥0.9999; potential clipping/level issue, not a proof of clipping |
| Nonfinite samples | Invalid float data; performance loading and audition reject nonfinite audio |
| Tempo estimate and alternatives | Onset-envelope autocorrelation over approximately 60–180 BPM, with half/double-tempo ambiguity and three subwindow estimates visible |
| Tonal estimate and pitch-class bars | Spectral-peak chroma compared with small diatonic/triad-weighted major/minor templates; ambiguous results and weak thirds are labeled uncertain |
| Candidate next songs | Ordered by estimated tempo percentage difference plus anchor-RMS difference; annotations describe the change, not musical compatibility |

Level measurements and overview bins scan complete WAV files in approximately 4 MiB chunks. Tempo and tonal calculations use a mono, box-averaged signal near 8 kHz from the middle **up to 120 seconds** of the source. The exact analysis range is displayed. This bounds analysis memory without pretending that a global tag describes every chord or tempo change.

The implementation is an intentionally small local analyzer, not Essentia or librosa. Spectral pitch-class profiles are a common basis for key estimation; the [Essentia KeyExtractor documentation](https://essentia.upf.edu/reference/streaming_KeyExtractor.html) describes a more comprehensive implementation including tuning correction and profile choices. This project's simpler estimator lacks that full tuning/whitening pipeline and has not been benchmarked on your songs. Use the visible alternatives and your ears.

Connection hints never authorize arbitrary cross-song bass, drums, or vocals to overlap. The supported transition ends one source scene before the next starts at its native tempo multiplied by the current shared Speed & pitch setting. An actual simultaneous hybrid would require separately prepared, synchronized assets and its own reviewed scene.

## Files, memory, and persistence

- The importer supports mono/stereo PCM 16/24/32-bit and float 32/64-bit RIFF WAV files at 8–192 kHz. Other audio formats are skipped; RF64 and compressed WAV are not supported. Convert the aligned stem group externally when necessary.
- Cropping copies the **same integer source-frame interval** in each included stem and preserves sample format/rate. It does not independently normalize, move, fade, stretch, pitch-shift, or shorten loops. Source files are never modified.
- Library metadata and analysis do not retain decoded full-song buffers. Audition decodes only the selected loop; Stop disconnects its sources and gains. The performance deck still preloads all chosen short scenes, with a 512 MiB decoded-audio limit.
- The requested library extension increases the base manifest's scene/path ceiling from three to **50 prepared scenes**. This is not permission to load 50 whole songs into the performance engine. Choose short passages or a smaller set if decoded memory exceeds the limit.
- A library project contains source names, sizes, modification times, local analysis, and authored configuration, but no WAV bytes. It refuses a mismatching source inventory. Actual performance review freshness is separately checked with cryptographic hashes of the exported media and playback configuration.
- Project/ZIP/configuration exports are explicit downloads. There is no backend, database, cloud storage, or silent browser persistence. Save your project before closing or replacing the library.

## Verified extension behavior

Automated tests cover a 50-song generated folder through Chromium's real directory-picker control, both filename grouping conventions, exact frame-preserving WAV crops, 24-bit/float sample interpretation, known 120 BPM pulses, a C-major triad, silence/uncertain tonality, measured constant-signal RMS, project restore and mismatch rejection, ZIP contents, analysis cancellation, solo audition, path ordering, instrument transfer, and persistence of instrument tuning/reviews back into the project.

These tests establish implementation behavior on generated signals. No actual user library was available for import, tempo/key accuracy assessment, or musical review during implementation.

## Hand-space material checks

After loading a mix into Play, Setup > Hand space & Leap bounds shows instrumental, melodic and vocal signal coverage for the selected passage. Quarter-second RMS windows use the loudest saved level per stem and its trim; instrumental gaps of at least half a second below -50 dBFS are listed. A vocal rest is acceptable because the accompaniment supplies the effects. An entirely quiet instrumental passage cannot supply new effect material, so use the waveform editor to choose a different section if continuous response is important. This analysis does not invent notes or automatically layer unrelated stems. Hand-space bounds and the Leap tracking preset persist in browser storage; project and audio saving remains explicit.
