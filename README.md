# Sonic Squares

A dependency-free grid music maker inspired by **Rolling Tones** / the classic
ToneMatrix and Tenori-on sequencers — with the features the original never
got: **MIDI and WAV export**, multiple tracks, a full drum kit, and
**RollingTones `.tmx` import** so old songs get a second life. Published on
Google Play; built as a web app wrapped with Capacitor.

- 16-row melody grid: rows are pitches on the selected scale, columns are
  16th-note steps. Patterns can be 16, 32, or 64 steps, paged 16 columns at a
  time with a follow-the-playhead mode.
- **Three melody tracks** play simultaneously, color-coded (cyan, green,
  pink) with ghost dots showing the other tracks' notes while you edit.
  Each track has its own **instrument** (bell, music box, marimba, plucked
  string, organ, pad, square, triangle, saw) and its own **octave shift**
  (±2), and exports as its own MIDI track/channel with a matching GM program.
  Tap a track tab to select it, hold to mute.
- **Track mixer** (Track panel): per-track and drum volume plus a global
  delay-effect level, so you can bring a bassline forward or dry out the
  ambience. The mix applies to playback and to WAV export.
- 7×16 percussion grid underneath: crash, open hat, closed hat, tambourine,
  clap, snare, kick — all synthesized in Web Audio (no samples).
- **16 scales** — Major/Minor Pentatonic, Blues, the church modes (Ionian,
  Dorian, Phrygian, Lydian, Mixolydian, Aeolian, Locrian), Harmonic and
  Melodic Minor, Hungarian Minor, Phrygian Dominant, and Whole-Half
  Diminished — at any root, plus a **custom scale builder** (Settings) that
  assigns any MIDI note to each of the 16 rows.
- **Import RollingTones songs**: the Projects Import button reads `.tmx`
  save files (both the older multi-page and newer container formats),
  mapping their melody, drums, tempo, and waveform into the app. See
  `docs/tmx-format.md` for the reverse-engineered spec.
- An in-app **Help & tutorial** panel covers everything above.
- **Projects**: save named projects in-app for instant load, and
  export/import them as `.sonicsquares.json` files — on Android the share
  sheet lets you save them to any folder (Files, Drive, …) or send them to
  a friend, who can Import them back. Projects carry everything: patterns,
  song chain, scale (custom included), drum mapping, tempo, swing.
- Web Audio synth with a lookahead scheduler for tight, drift-free timing.
- Tempo control (40–240 BPM) and swing (50–75%, applied to playback and
  export alike); patterns and settings auto-save to `localStorage`.
- Press and hold a cell to accent it (higher velocity, brighter glow); hold
  again to un-accent.
- A **Tie tool** joins a melody note to its right-hand neighbour, merging
  runs of cells into single sustained notes — by choice, so repeated 16ths
  stay repeated unless you tie them. Tied notes sustain in the synth and
  export as one long MIDI note.
- **Twelve pattern slots (A–L)** with one-tap switching, a Duplicate button,
  and a **song mode**: chain patterns in any order (tap + to append the
  selected pattern, tap a chip to remove it) and the chain plays — and
  exports — as one continuous piece.
- **Per-row mute/solo** via the dot to the left of each row: tap to mute,
  hold to solo. Muted rows dim in the grid and are left out of the export —
  the file contains what you hear.
- Optional **pitch-preserving scale changes** (Settings): when switching
  scale or root, notes move to the row nearest their old pitch instead of
  keeping their grid position, so the melody keeps its sound.
- **Web MIDI output** (Settings): pick a connected MIDI device and live
  playback drives it instead of the built-in synth — melody on channel 1,
  drums on channel 10 with your custom note mapping, with the same
  lookahead-accurate timing via timestamped messages. Chrome/Edge only;
  other browsers fall back to the built-in synth.
- **Export WAV** renders the piece offline through the exact same synth
  voices (OfflineAudioContext, stereo 16-bit 44.1 kHz) — no re-recording,
  no dropouts, includes the delay tail.
- **Export MIDI** writes a Standard MIDI File (format 1) by hand: melody on
  channel 1, drums on channel 10, with a tempo meta event so the file opens
  at your BPM in any DAW. Downloads as `sonic-squares.mid`.
- **Remappable drum notes**: exported percussion defaults to General MIDI
  (kick 36, snare 38, hats 42/46) but each lane's note number can be changed
  in the "Percussion MIDI mapping" panel for instruments with nonstandard
  drum layouts.

## Run it

```sh
npm install
npm run dev      # local dev server (works in Termux too)
npm run build    # static production build in dist/
```

The runtime code has zero dependencies — Vite is only the dev server/bundler.
The `dist/` output is plain static files and works fully offline.

## Packaging for Android

The repo ships with a ready-made [Capacitor](https://capacitorjs.com/)
Android project in `android/` (app id `com.grazitheman.sonicsquares`). To
build an installable APK you need the Android SDK — either Android Studio
or command-line tools:

```sh
npm install          # brings in @capacitor/android
npm run build        # produce dist/
npx cap sync android # copy dist/ into the Android project

# then either open it in Android Studio:
npx cap open android
# or build straight from the CLI (requires ANDROID_HOME):
cd android && ./gradlew assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk
```

Install the debug APK directly on your device (enable "install unknown
apps"). The app runs fully offline.

## How MIDI export works

Each active cell becomes a 16th note; tied melody cells merge into one longer
note. In song mode the whole chain is written back to back as one continuous
sequence. Melody rows map to MIDI note numbers on the selected scale (bottom row
lowest); drum rows map to the configurable channel-10 note numbers. Accents
export at velocity 118 (normal notes at 88), and swing shifts offbeat 16ths
later by the same ratio the synth plays. The writer in `src/midi.js` emits an
`MThd` header (format 1, 128 PPQ) and two `MTrk` chunks — melody with a tempo
meta event and program change, percussion on channel 10 — as delta-timed
note-on/note-off pairs.
