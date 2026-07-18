// Pitch mapping for the grid rows.
//
// Rows use a major pentatonic scale so any combination of active cells is
// consonant — the constraint that makes the original Rolling Tones /
// ToneMatrix instruments feel "unbreakable".

export const ROWS = 16;
export const STEPS = 16;

// Major pentatonic intervals within one octave.
const PENTATONIC = [0, 2, 4, 7, 9];

export const ROOT_CHOICES = [
  { label: "C", midi: 48 },
  { label: "D", midi: 50 },
  { label: "E", midi: 52 },
  { label: "F", midi: 53 },
  { label: "G", midi: 43 },
  { label: "A", midi: 45 },
  { label: "B", midi: 47 },
];

// Returns an array of MIDI note numbers, one per row, where index 0 is the
// TOP row of the grid (highest pitch) — matching how the grid renders.
export function buildRowNotes(rootMidi) {
  const notes = [];
  for (let i = 0; i < ROWS; i++) {
    const octave = Math.floor(i / PENTATONIC.length);
    const degree = i % PENTATONIC.length;
    notes.push(rootMidi + octave * 12 + PENTATONIC[degree]);
  }
  return notes.reverse();
}

export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}
