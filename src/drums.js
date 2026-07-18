// Percussion rows, ordered top-to-bottom as they render in the drum grid.
//
// `gm` is the General MIDI channel-10 note for each sound — the default for
// export, but remappable in the UI since some hardware and soundfonts put
// kick/snare elsewhere.

export const DRUMS = [
  { id: "hatOpen", label: "Open Hat", gm: 46 },
  { id: "hatClosed", label: "Closed Hat", gm: 42 },
  { id: "snare", label: "Snare", gm: 38 },
  { id: "kick", label: "Kick", gm: 36 },
];

export const DRUM_ROWS = DRUMS.length;

export function defaultDrumMap() {
  return DRUMS.map((d) => d.gm);
}
