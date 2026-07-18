# Tone Matrix

A small, dependency-free music toy inspired by **Rolling Tones** / the classic
ToneMatrix and Tenori-on grid sequencers — with the one feature the original
never got: **MIDI export**.

- 16×16 melody grid: rows are pitches on the selected scale, columns are
  16th-note steps.
- 4×16 percussion grid underneath: open hat, closed hat, snare, kick — all
  synthesized in Web Audio (no samples).
- Seven scales: Major/Minor Pentatonic, Blues, Dorian, Harmonic Minor,
  Hungarian Minor, Phrygian Dominant — any root note.
- Web Audio synth with a lookahead scheduler for tight, drift-free timing.
- Tempo control (40–240 BPM); patterns and settings auto-save to
  `localStorage`.
- **Export MIDI** writes a Standard MIDI File (format 1) by hand: melody on
  channel 1, drums on channel 10, with a tempo meta event so the file opens
  at your BPM in any DAW. Downloads as `tone-matrix.mid`.
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

The production build in `dist/` can be wrapped with
[Capacitor](https://capacitorjs.com/) to produce an installable APK:

```sh
npm install @capacitor/core @capacitor/cli @capacitor/android
npx cap init tone-matrix com.example.tonematrix --web-dir=dist
npx cap add android
npm run build && npx cap sync && npx cap open android
```

## How MIDI export works

Each active cell becomes a 16th note. Melody rows map to MIDI note numbers on
the selected scale (bottom row lowest); drum rows map to the configurable
channel-10 note numbers. The writer in `src/midi.js` emits an `MThd` header
(format 1, 128 PPQ) and two `MTrk` chunks — melody with a tempo meta event and
program change, percussion on channel 10 — as delta-timed note-on/note-off
pairs.
