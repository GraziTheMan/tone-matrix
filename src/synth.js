import { midiToFreq } from "./scale.js";

// The instrument voices, decoupled from any particular AudioContext so the
// live engine and the offline WAV renderer share identical sound.

// Master bus + the gentle feedback delay that gives the airy ToneMatrix
// ambience. Works on both AudioContext and OfflineAudioContext.
export function createChain(ctx) {
  const master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(ctx.destination);

  const delay = ctx.createDelay(1.0);
  delay.delayTime.value = 0.28;
  const feedback = ctx.createGain();
  feedback.gain.value = 0.3;
  const wet = ctx.createGain();
  wet.gain.value = 0.35;
  delay.connect(feedback);
  feedback.connect(delay);
  delay.connect(wet);
  wet.connect(master);

  return { ctx, master, delay, noise: createNoiseBuffer(ctx) };
}

function createNoiseBuffer(ctx) {
  const len = ctx.sampleRate; // 1 second of white noise
  const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

// Melody instruments. "bell" is the classic ToneMatrix voice (sine + quiet
// octave partial); the raw waveforms get a lowpass and a gain trim so they
// sit at a comparable loudness.
export const INSTRUMENTS = {
  bell: { label: "Bell", type: "sine", gain: 1.0, partial: 0.18 },
  square: { label: "Square", type: "square", gain: 0.4, filterMult: 6 },
  triangle: { label: "Triangle", type: "triangle", gain: 0.9 },
  sawtooth: { label: "Saw", type: "sawtooth", gain: 0.45, filterMult: 5 },
};

// Sharp attack; single steps get the classic exponential-decay pluck, tied
// notes sustain for their full length before releasing.
export function playNote(chain, { midi, when, velocity = 0.7, durSteps = 1, stepDur, instrument = "bell" }) {
  const { ctx } = chain;
  const voice = INSTRUMENTS[instrument] ?? INSTRUMENTS.bell;
  const freq = midiToFreq(midi);
  const peak = 0.32 * velocity * voice.gain;
  const release = 0.35;
  let end;

  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, when);
  env.gain.exponentialRampToValueAtTime(peak, when + 0.008);
  if (durSteps <= 1) {
    end = when + Math.max(0.35, stepDur * 3);
    env.gain.exponentialRampToValueAtTime(0.0001, end);
  } else {
    const hold = stepDur * durSteps;
    env.gain.exponentialRampToValueAtTime(peak * 0.45, when + hold);
    end = when + hold + release;
    env.gain.exponentialRampToValueAtTime(0.0001, end);
  }

  const osc = ctx.createOscillator();
  osc.type = voice.type;
  osc.frequency.value = freq;

  let head = env; // node the oscillators feed into
  if (voice.filterMult) {
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = Math.min(freq * voice.filterMult, 12000);
    filter.connect(env);
    head = filter;
  }
  osc.connect(head);

  let partial = null;
  if (voice.partial) {
    partial = ctx.createOscillator();
    partial.type = "sine";
    partial.frequency.value = freq * 2;
    const partialGain = ctx.createGain();
    partialGain.gain.value = voice.partial;
    partial.connect(partialGain);
    partialGain.connect(head);
  }

  env.connect(chain.master);
  env.connect(chain.delay);

  osc.start(when);
  osc.stop(end + 0.05);
  if (partial) {
    partial.start(when);
    partial.stop(end + 0.05);
  }
}

function noiseSource(chain, when, dur, { type, freq, gain }) {
  const { ctx } = chain;
  const src = ctx.createBufferSource();
  src.buffer = chain.noise;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  const env = ctx.createGain();
  env.gain.setValueAtTime(gain, when);
  env.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  src.connect(filter);
  filter.connect(env);
  env.connect(chain.master);
  src.start(when);
  src.stop(when + dur + 0.05);
}

// Synthesized drum kit, kept dry (no delay send) so the groove stays tight.
// Gains are tuned for velocity 0.7; accents scale up from there.
export function playDrum(chain, { id, when, velocity = 0.7 }) {
  const { ctx } = chain;
  const v = velocity / 0.7;
  switch (id) {
    case "kick": {
      const osc = ctx.createOscillator();
      osc.frequency.setValueAtTime(150, when);
      osc.frequency.exponentialRampToValueAtTime(45, when + 0.11);
      const env = ctx.createGain();
      env.gain.setValueAtTime(Math.min(0.85 * v, 1.1), when);
      env.gain.exponentialRampToValueAtTime(0.0001, when + 0.3);
      osc.connect(env);
      env.connect(chain.master);
      osc.start(when);
      osc.stop(when + 0.35);
      break;
    }
    case "snare": {
      noiseSource(chain, when, 0.18, { type: "bandpass", freq: 1800, gain: 0.5 * v });
      const body = ctx.createOscillator();
      body.type = "triangle";
      body.frequency.value = 185;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.35 * v, when);
      env.gain.exponentialRampToValueAtTime(0.0001, when + 0.12);
      body.connect(env);
      env.connect(chain.master);
      body.start(when);
      body.stop(when + 0.15);
      break;
    }
    case "hatClosed":
      noiseSource(chain, when, 0.05, { type: "highpass", freq: 7000, gain: 0.3 * v });
      break;
    case "hatOpen":
      noiseSource(chain, when, 0.32, { type: "highpass", freq: 6500, gain: 0.26 * v });
      break;
  }
}
