import { collectSong } from "./song.js";
import { createChain, playNote, playDrum } from "./synth.js";
import { DRUMS } from "./drums.js";

// Offline audio export: renders the song through the exact same synth voices
// as live playback using an OfflineAudioContext, then encodes 16-bit PCM WAV.

const AUDIO_VELOCITY = { 1: 0.7, 2: 1.0 };
const LEAD_IN = 0.05; // avoids clipping the first attack
const TAIL = 2.0; // room for the delay/release to ring out

export async function renderSongToWav({
  segments,
  trackNotes,
  trackInstruments,
  bpm,
  swing = 0.5,
  melodyAudible,
  drumAudible,
  trackAudible,
  sampleRate = 44100,
}) {
  const song = collectSong(segments, { melodyAudible, drumAudible, trackAudible });
  const stepDur = 60 / bpm / 4;
  const swingDelay = (swing - 0.5) * 2 * stepDur;
  const timeOf = (step) => LEAD_IN + step * stepDur + (step % 2 ? swingDelay : 0);

  const duration = LEAD_IN + song.totalSteps * stepDur + TAIL;
  const ctx = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);
  const chain = createChain(ctx);

  for (const n of song.melody) {
    playNote(chain, {
      midi: trackNotes[n.track][n.row],
      when: timeOf(n.step),
      velocity: AUDIO_VELOCITY[n.value] ?? AUDIO_VELOCITY[1],
      durSteps: n.durSteps,
      stepDur,
      instrument: trackInstruments[n.track],
    });
  }
  for (const d of song.drums) {
    playDrum(chain, {
      id: DRUMS[d.row].id,
      when: timeOf(d.step),
      velocity: AUDIO_VELOCITY[d.value] ?? AUDIO_VELOCITY[1],
    });
  }

  const buffer = await ctx.startRendering();
  return audioBufferToWav(buffer);
}

function audioBufferToWav(buffer) {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const blockAlign = channels * 2; // 16-bit
  const dataSize = frames * blockAlign;
  const bytes = new ArrayBuffer(44 + dataSize);
  const view = new DataView(bytes);

  const writeString = (offset, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  const data = [];
  for (let ch = 0; ch < channels; ch++) data.push(buffer.getChannelData(ch));
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < channels; ch++) {
      const sample = Math.max(-1, Math.min(1, data[ch][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Uint8Array(bytes);
}
