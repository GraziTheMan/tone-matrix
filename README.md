# Tone Matrix

A small, dependency-free music toy inspired by **Rolling Tones** / the classic
ToneMatrix and Tenori-on grid sequencers — with the one feature the original
never got: **MIDI export**.

- 16×16 grid: rows are pitches on a major pentatonic scale (so every pattern
  sounds good), columns are 16th-note steps.
- Web Audio synth with a lookahead scheduler for tight, drift-free timing.
- Tempo (40–240 BPM) and root-note selection.
- Patterns auto-save to `localStorage`.
- **Export MIDI** writes a Standard MIDI File (format 0) by hand — including a
  tempo meta event so the file opens at your BPM in any DAW — and downloads it
  as `tone-matrix.mid`.

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

Each active cell becomes a 16th note. Rows map to MIDI note numbers on the
selected pentatonic scale (bottom row lowest). The writer in `src/midi.js`
emits an `MThd` header and a single `MTrk` chunk: tempo meta event, program
change, then delta-timed note-on/note-off pairs at 128 PPQ.
