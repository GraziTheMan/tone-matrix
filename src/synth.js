import { midiToFreq } from "./scale.js";

// The instrument voices, decoupled from any particular AudioContext so the
// live engine and the offline WAV renderer share identical sound.

// Master bus + a per-track mixer and the gentle feedback delay that gives the
// airy ToneMatrix ambience. Works on both AudioContext and
// OfflineAudioContext. Each melody track has its own gain (fed dry to master
// and as a send to the delay, so track volume scales both), drums have their
// own dry gain, and `wet` is the global delay level.
export function createChain(ctx, trackCount = 3) {
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

  const trackGains = [];
  for (let t = 0; t < trackCount; t++) {
    const g = ctx.createGain();
    g.gain.value = 1;
    g.connect(master); // dry
    g.connect(delay); // send
    trackGains.push(g);
  }
  const drumGain = ctx.createGain();
  drumGain.gain.value = 1;
  drumGain.connect(master); // drums stay dry

  return { ctx, master, delay, wet, trackGains, drumGain, noise: createNoiseBuffer(ctx) };
}

// The gain node a melody voice on `channel` should feed into (falls back to
// master for previews without a channel).
function trackBus(chain, channel) {
  return chain.trackGains?.[channel] ?? chain.master;
}

function createNoiseBuffer(ctx) {
  const len = ctx.sampleRate; // 1 second of white noise
  const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

// Melody instruments — the family of sounds the classic grid sequencers use.
//
// Voice fields: `type` main oscillator; `gain` loudness trim; `partials`
// extra sine overtones [{ mult, amp }]; `filterMult` lowpass at freq*mult to
// tame bright waves; `detune` cents spread across a doubled oscillator;
// `sustain` holds at level instead of plucking; `attack`/`release` seconds;
// `pluckLen` decay length for single-step notes; `algorithm: "karplus"`
// switches to the plucked-string physical model.
export const INSTRUMENTS = {
  bell: { label: "Bell", type: "sine", gain: 1.0, partials: [{ mult: 2, amp: 0.18 }] },
  musicbox: {
    label: "Music Box",
    type: "triangle",
    gain: 0.85,
    partials: [{ mult: 2, amp: 0.22 }, { mult: 4, amp: 0.1 }],
    pluckLen: 0.9,
  },
  marimba: {
    label: "Marimba",
    type: "sine",
    gain: 1.0,
    partials: [{ mult: 4, amp: 0.15 }],
    pluckLen: 0.45,
  },
  pluck: { label: "Pluck", algorithm: "karplus", gain: 0.9 },
  organ: {
    label: "Organ",
    type: "sine",
    gain: 0.65,
    partials: [{ mult: 2, amp: 0.5 }, { mult: 3, amp: 0.25 }],
    sustain: true,
    attack: 0.02,
  },
  pad: {
    label: "Pad",
    type: "sawtooth",
    gain: 0.32,
    filterMult: 3,
    detune: 14,
    sustain: true,
    attack: 0.07,
    release: 0.8,
  },
  square: { label: "Square", type: "square", gain: 0.4, filterMult: 6 },
  triangle: { label: "Triangle", type: "triangle", gain: 0.9 },
  sawtooth: { label: "Saw", type: "sawtooth", gain: 0.45, filterMult: 5 },
};

// Sharp attack; single steps get an exponential-decay pluck (unless the
// voice sustains), tied notes hold for their full length before releasing.
export function playNote(chain, { midi, when, velocity = 0.7, durSteps = 1, stepDur, instrument = "bell", channel }) {
  const voice = INSTRUMENTS[instrument] ?? INSTRUMENTS.bell;
  const freq = midiToFreq(midi);
  if (voice.algorithm === "karplus") {
    playKarplus(chain, { freq, when, velocity, durSteps, stepDur, gain: voice.gain, channel });
    return;
  }

  const { ctx } = chain;
  const peak = 0.32 * velocity * voice.gain;
  const attack = voice.attack ?? 0.008;
  const release = voice.release ?? 0.35;
  let end;

  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, when);
  env.gain.exponentialRampToValueAtTime(peak, when + attack);
  if (!voice.sustain && durSteps <= 1) {
    end = when + (voice.pluckLen ?? Math.max(0.35, stepDur * 3));
    env.gain.exponentialRampToValueAtTime(0.0001, end);
  } else {
    const hold = stepDur * durSteps;
    const holdLevel = voice.sustain ? peak * 0.85 : peak * 0.45;
    env.gain.exponentialRampToValueAtTime(holdLevel, when + hold);
    end = when + hold + release;
    env.gain.exponentialRampToValueAtTime(0.0001, end);
  }

  let head = env; // node the oscillators feed into
  if (voice.filterMult) {
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = Math.min(freq * voice.filterMult, 12000);
    filter.connect(env);
    head = filter;
  }

  const oscs = [];
  if (voice.detune) {
    for (const cents of [-voice.detune / 2, voice.detune / 2]) {
      const osc = ctx.createOscillator();
      osc.type = voice.type;
      osc.frequency.value = freq;
      osc.detune.value = cents;
      const half = ctx.createGain();
      half.gain.value = 0.5;
      osc.connect(half);
      half.connect(head);
      oscs.push(osc);
    }
  } else {
    const osc = ctx.createOscillator();
    osc.type = voice.type;
    osc.frequency.value = freq;
    osc.connect(head);
    oscs.push(osc);
  }
  for (const { mult, amp } of voice.partials ?? []) {
    const partial = ctx.createOscillator();
    partial.type = "sine";
    partial.frequency.value = freq * mult;
    const partialGain = ctx.createGain();
    partialGain.gain.value = amp;
    partial.connect(partialGain);
    partialGain.connect(head);
    oscs.push(partial);
  }

  env.connect(trackBus(chain, channel));

  for (const osc of oscs) {
    osc.start(when);
    osc.stop(end + 0.05);
  }
}

// Karplus-Strong plucked string: a noise burst circulating through a tuned
// delay line with lowpass damping in the feedback loop.
function playKarplus(chain, { freq, when, velocity, durSteps, stepDur, gain, channel }) {
  const { ctx } = chain;

  const out = ctx.createGain();
  out.gain.value = 1.3 * velocity * gain;

  const delay = ctx.createDelay(0.1);
  delay.delayTime.value = 1 / freq;
  const damp = ctx.createBiquadFilter();
  damp.type = "lowpass";
  damp.frequency.value = Math.min(freq * 10, 9000);
  // For lowpass filters Q is resonance in DECIBELS; anything above 0 peaks
  // over unity near cutoff and the feedback loop diverges instead of
  // decaying. Keep it well negative.
  damp.Q.value = -12;
  const feedback = ctx.createGain();
  feedback.gain.value = 0.975;

  const burst = ctx.createBufferSource();
  burst.buffer = chain.noise;
  const burstEnv = ctx.createGain();
  burstEnv.gain.setValueAtTime(0.8, when);
  burstEnv.gain.linearRampToValueAtTime(0, when + Math.min(2 / freq, 0.02));

  burst.connect(burstEnv);
  burstEnv.connect(delay);
  delay.connect(damp);
  damp.connect(feedback);
  feedback.connect(delay);
  damp.connect(out);
  out.connect(trackBus(chain, channel));

  burst.start(when);
  burst.stop(when + 0.05);

  const end = when + Math.max(durSteps * stepDur, 1.4);
  out.gain.setValueAtTime(out.gain.value, end - 0.15);
  out.gain.exponentialRampToValueAtTime(0.0001, end);
  feedback.gain.setValueAtTime(0, end); // kill the loop so the string dies

  // Live contexts need the loop nodes disconnected once the note is done or
  // they keep processing forever; offline renders end on their own.
  if (typeof OfflineAudioContext === "undefined" || !(ctx instanceof OfflineAudioContext)) {
    setTimeout(() => {
      delay.disconnect();
      damp.disconnect();
      feedback.disconnect();
      out.disconnect();
    }, (end - ctx.currentTime) * 1000 + 500);
  }
}

function noiseSource(chain, when, dur, { type, freq, gain, q = 0, attack = 0 }) {
  const { ctx } = chain;
  const src = ctx.createBufferSource();
  src.buffer = chain.noise;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = q;
  const env = ctx.createGain();
  if (attack > 0) {
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(gain, when + attack);
  } else {
    env.gain.setValueAtTime(gain, when);
  }
  env.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  src.connect(filter);
  filter.connect(env);
  env.connect(chain.drumGain ?? chain.master);
  src.start(when);
  src.stop(when + dur + attack + 0.05);
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
      env.connect(chain.drumGain ?? chain.master);
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
      env.connect(chain.drumGain ?? chain.master);
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
    case "crash":
      // Bright, long, shimmering: a broad highpass wash plus a resonant
      // high band for the metallic edge.
      noiseSource(chain, when, 1.3, { type: "highpass", freq: 4000, gain: 0.24 * v });
      noiseSource(chain, when, 1.1, { type: "bandpass", freq: 9000, gain: 0.14 * v, q: 0.6 });
      break;
    case "tambourine":
      // Short metallic jingle: a resonant high band with a quick attack so it
      // "chinks" rather than clicks.
      noiseSource(chain, when, 0.16, {
        type: "bandpass", freq: 9500, gain: 0.5 * v, q: 1.4, attack: 0.002,
      });
      noiseSource(chain, when, 0.09, { type: "highpass", freq: 7000, gain: 0.18 * v });
      break;
    case "clap": {
      // Classic clap: three fast noise bursts a few ms apart, then a slightly
      // longer diffuse tail, all through a mid bandpass.
      for (const [offset, dur, g] of [[0, 0.02, 0.5], [0.009, 0.02, 0.5], [0.018, 0.02, 0.5], [0.027, 0.13, 0.42]]) {
        noiseSource(chain, when + offset, dur, { type: "bandpass", freq: 1100, gain: g * v, q: 0.7 });
      }
      break;
    }
  }
}
