// Pitch mapping for the melody grid rows.
//
// Pentatonic scales keep the original Rolling Tones "no wrong notes" feel;
// the seven-note scales trade a little of that safety for stronger flavor.

export const ROWS = 16;
export const VIEW_COLS = 16; // columns visible at once (one page)
export const MAX_STEPS = 64;
export const PATTERN_LENGTHS = [16, 32, 64];

export const SCALES = [
  { label: "Major Pentatonic", intervals: [0, 2, 4, 7, 9] },
  { label: "Minor Pentatonic", intervals: [0, 3, 5, 7, 10] },
  { label: "Blues", intervals: [0, 3, 5, 6, 7, 10] },
  { label: "Dorian", intervals: [0, 2, 3, 5, 7, 9, 10] },
  { label: "Harmonic Minor", intervals: [0, 2, 3, 5, 7, 8, 11] },
  { label: "Hungarian Minor", intervals: [0, 2, 3, 6, 7, 8, 11] },
  { label: "Phrygian Dominant", intervals: [0, 1, 4, 5, 7, 8, 10] },
];

export const ROOT_CHOICES = [
  { label: "C", midi: 48 },
  { label: "C#", midi: 49 },
  { label: "D", midi: 50 },
  { label: "D#", midi: 51 },
  { label: "E", midi: 52 },
  { label: "F", midi: 53 },
  { label: "F#", midi: 54 },
  { label: "G", midi: 43 },
  { label: "G#", midi: 44 },
  { label: "A", midi: 45 },
  { label: "A#", midi: 46 },
  { label: "B", midi: 47 },
];

// Returns an array of MIDI note numbers, one per row, where index 0 is the
// TOP row of the grid (highest pitch) — matching how the grid renders.
export function buildRowNotes(rootMidi, intervals) {
  const notes = [];
  for (let i = 0; i < ROWS; i++) {
    const octave = Math.floor(i / intervals.length);
    const degree = i % intervals.length;
    notes.push(rootMidi + octave * 12 + intervals[degree]);
  }
  return notes.reverse();
}

export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function midiNoteName(midi) {
  return NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
}
