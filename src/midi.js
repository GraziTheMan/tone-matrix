import { collectSong } from "./song.js";

// Minimal Standard MIDI File writer — no dependencies.
//
// Format 1, two tracks: melody on channel 1 and percussion on channel 10
// (the GM drum channel), so DAWs import them as separate instrument lanes.
// The melody track leads with a tempo meta event so the file opens at the
// composed BPM, not a DAW default.
//
// Export takes a list of pattern segments played back to back, so a song
// chain becomes one continuous file. Cell values carry velocity: 1 = normal,
// 2 = accent. Melody cells joined by ties export as one long note; untied
// neighbours stay separate 16ths. Swing shifts offbeat 16ths later, matching
// what the audio engine plays. Muted rows are skipped — the file contains
// what you hear.

const PPQ = 128; // ticks per quarter note
const TICKS_PER_STEP = PPQ / 4; // a step is a 16th note

export const MIDI_VELOCITY = { 1: 88, 2: 118 };

function varLen(value) {
  // MIDI variable-length quantity, 7 bits per byte, MSB flags continuation.
  const bytes = [value & 0x7f];
  while ((value >>= 7)) {
    bytes.unshift((value & 0x7f) | 0x80);
  }
  return bytes;
}

function sortEvents(events) {
  // Sort by time; note-offs before note-ons at the same tick so a note
  // repeated on consecutive steps retriggers instead of truncating itself.
  return events.sort(
    (a, b) => a.tick - b.tick || (a.off ? -1 : 1) - (b.off ? -1 : 1)
  );
}

// Delta-encode events into an MTrk chunk. `prefix` holds already-encoded
// tick-zero events (tempo, program change).
function trackChunk(events, totalTicks, prefix = []) {
  const track = [...prefix];
  let lastTick = 0;
  for (const ev of events) {
    track.push(...varLen(ev.tick - lastTick));
    lastTick = ev.tick;
    track.push((ev.off ? 0x80 : 0x90) | ev.channel, ev.note, ev.velocity);
  }
  track.push(...varLen(Math.max(totalTicks, lastTick) - lastTick), 0xff, 0x2f, 0x00);
  return [
    0x4d, 0x54, 0x72, 0x6b, // MTrk
    (track.length >> 24) & 0xff, (track.length >> 16) & 0xff,
    (track.length >> 8) & 0xff, track.length & 0xff,
    ...track,
  ];
}

// GM program per instrument, so DAWs pick a comparable sound.
const GM_PROGRAM = { bell: 10, square: 80, triangle: 72, sawtooth: 81 };

// segments: [{ tracks: [{ grid, tieGrid }], drumGrid, steps }] back to back.
// trackNotes: per melody track, the MIDI note for each row (octave applied).
// trackInstruments: per melody track, an instrument id for the GM program.
export function songToMidi({
  segments,
  trackNotes,
  trackInstruments,
  drumNotes,
  bpm,
  swing = 0.5, // ratio 0.5 (straight) … 0.75
  melodyAudible,
  drumAudible,
  trackAudible,
}) {
  const song = collectSong(segments, { melodyAudible, drumAudible, trackAudible });
  const swingTicks = Math.round((swing - 0.5) * 2 * TICKS_PER_STEP);
  const tickOf = (s) => s * TICKS_PER_STEP + (s % 2 ? swingTicks : 0);

  const melodyByTrack = trackNotes.map(() => []);
  for (const n of song.melody) {
    const note = trackNotes[n.track][n.row];
    const velocity = MIDI_VELOCITY[n.value] ?? MIDI_VELOCITY[1];
    const channel = n.track;
    melodyByTrack[n.track].push({ tick: tickOf(n.step), off: false, note, velocity, channel });
    melodyByTrack[n.track].push({ tick: tickOf(n.step + n.durSteps), off: true, note, velocity: 0, channel });
  }
  const drums = [];
  for (const d of song.drums) {
    const note = drumNotes[d.row];
    const velocity = MIDI_VELOCITY[d.value] ?? MIDI_VELOCITY[1];
    drums.push({ tick: tickOf(d.step), off: false, note, velocity, channel: 9 });
    drums.push({ tick: tickOf(d.step + 1), off: true, note, velocity: 0, channel: 9 });
  }
  const totalTicks = song.totalSteps * TICKS_PER_STEP;

  // Tempo meta event: microseconds per quarter note.
  const usPerQuarter = Math.round(60_000_000 / bpm);
  const tempoPrefix = [
    0x00, 0xff, 0x51, 0x03,
    (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff,
  ];

  const chunks = [];
  for (let t = 0; t < trackNotes.length; t++) {
    const prefix = [
      ...(t === 0 ? tempoPrefix : []),
      0x00, 0xc0 | t, GM_PROGRAM[trackInstruments[t]] ?? 10,
    ];
    chunks.push(trackChunk(sortEvents(melodyByTrack[t]), totalTicks, prefix));
  }
  chunks.push(trackChunk(sortEvents(drums), totalTicks));

  const ntrks = chunks.length;
  return new Uint8Array([
    // MThd: format 1, PPQ division.
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, (ntrks >> 8) & 0xff, ntrks & 0xff,
    (PPQ >> 8) & 0xff, PPQ & 0xff,
    ...chunks.flat(),
  ]);
}

