// Minimal Standard MIDI File (format 0) writer — no dependencies.
//
// Layout: an MThd header chunk, then one MTrk chunk containing a tempo meta
// event (so the file opens at the composed BPM, not a DAW default) followed
// by note-on/note-off pairs. Each active cell becomes one 16th note.

const PPQ = 128; // ticks per quarter note
const TICKS_PER_STEP = PPQ / 4; // a step is a 16th note

function varLen(value) {
  // MIDI variable-length quantity, 7 bits per byte, MSB flags continuation.
  const bytes = [value & 0x7f];
  while ((value >>= 7)) {
    bytes.unshift((value & 0x7f) | 0x80);
  }
  return bytes;
}

// grid: 2D array [row][step] of booleans; rowNotes: MIDI note per row.
export function gridToMidi(grid, rowNotes, steps, bpm) {
  // Collect absolute-tick events, then delta-encode.
  const events = [];
  for (let row = 0; row < grid.length; row++) {
    for (let step = 0; step < steps; step++) {
      if (!grid[row][step]) continue;
      const note = rowNotes[row];
      events.push({ tick: step * TICKS_PER_STEP, off: false, note });
      events.push({ tick: (step + 1) * TICKS_PER_STEP, off: true, note });
    }
  }
  // Sort by time; note-offs before note-ons at the same tick so a note
  // repeated on consecutive steps retriggers instead of truncating itself.
  events.sort((a, b) => a.tick - b.tick || (a.off ? -1 : 1) - (b.off ? -1 : 1));

  const track = [];
  // Tempo meta event: microseconds per quarter note.
  const usPerQuarter = Math.round(60_000_000 / bpm);
  track.push(0x00, 0xff, 0x51, 0x03,
    (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff);
  // Program change: music box (GM patch 11) suits the bell timbre.
  track.push(0x00, 0xc0, 10);

  let lastTick = 0;
  for (const ev of events) {
    track.push(...varLen(ev.tick - lastTick));
    lastTick = ev.tick;
    if (ev.off) {
      track.push(0x80, ev.note, 0);
    } else {
      track.push(0x90, ev.note, 100);
    }
  }
  // End of track.
  track.push(...varLen(steps * TICKS_PER_STEP - lastTick), 0xff, 0x2f, 0x00);

  const bytes = [
    // MThd: format 0, one track, PPQ division.
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (PPQ >> 8) & 0xff, PPQ & 0xff,
    // MTrk header + length.
    0x4d, 0x54, 0x72, 0x6b,
    (track.length >> 24) & 0xff, (track.length >> 16) & 0xff,
    (track.length >> 8) & 0xff, track.length & 0xff,
    ...track,
  ];
  return new Uint8Array(bytes);
}

export function downloadMidi(bytes, filename = "tone-matrix.mid") {
  const blob = new Blob([bytes], { type: "audio/midi" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
