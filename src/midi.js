// Minimal Standard MIDI File writer — no dependencies.
//
// Format 1, two tracks: melody on channel 1 and percussion on channel 10
// (the GM drum channel), so DAWs import them as separate instrument lanes.
// The melody track leads with a tempo meta event so the file opens at the
// composed BPM, not a DAW default. Each active cell becomes one 16th note.

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

// Turn a grid into absolute-tick note events on the given channel.
// grid: 2D array [row][step] of booleans; rowNotes: MIDI note per row.
function gridEvents(grid, rowNotes, steps, channel) {
  const events = [];
  for (let row = 0; row < grid.length; row++) {
    for (let step = 0; step < steps; step++) {
      if (!grid[row][step]) continue;
      const note = rowNotes[row];
      events.push({ tick: step * TICKS_PER_STEP, off: false, note, channel });
      events.push({ tick: (step + 1) * TICKS_PER_STEP, off: true, note, channel });
    }
  }
  // Sort by time; note-offs before note-ons at the same tick so a note
  // repeated on consecutive steps retriggers instead of truncating itself.
  events.sort((a, b) => a.tick - b.tick || (a.off ? -1 : 1) - (b.off ? -1 : 1));
  return events;
}

// Delta-encode events into an MTrk chunk. `prefix` holds already-encoded
// tick-zero events (tempo, program change).
function trackChunk(events, steps, prefix = []) {
  const track = [...prefix];
  let lastTick = 0;
  for (const ev of events) {
    track.push(...varLen(ev.tick - lastTick));
    lastTick = ev.tick;
    track.push((ev.off ? 0x80 : 0x90) | ev.channel, ev.note, ev.off ? 0 : 100);
  }
  track.push(...varLen(steps * TICKS_PER_STEP - lastTick), 0xff, 0x2f, 0x00);
  return [
    0x4d, 0x54, 0x72, 0x6b, // MTrk
    (track.length >> 24) & 0xff, (track.length >> 16) & 0xff,
    (track.length >> 8) & 0xff, track.length & 0xff,
    ...track,
  ];
}

export function gridToMidi({ melodyGrid, rowNotes, drumGrid, drumNotes, steps, bpm }) {
  // Tempo meta event: microseconds per quarter note.
  const usPerQuarter = Math.round(60_000_000 / bpm);
  const melodyPrefix = [
    0x00, 0xff, 0x51, 0x03,
    (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff,
    // Program change: music box (GM patch 11) suits the bell timbre.
    0x00, 0xc0, 10,
  ];

  const melodyTrack = trackChunk(gridEvents(melodyGrid, rowNotes, steps, 0), steps, melodyPrefix);
  const drumTrack = trackChunk(gridEvents(drumGrid, drumNotes, steps, 9), steps);

  return new Uint8Array([
    // MThd: format 1, two tracks, PPQ division.
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 2, (PPQ >> 8) & 0xff, PPQ & 0xff,
    ...melodyTrack,
    ...drumTrack,
  ]);
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
