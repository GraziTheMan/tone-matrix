import { midiToFreq } from "./scale.js";

// Audio engine: a lookahead scheduler (the "tale of two clocks" pattern).
// A coarse setInterval wakes up every LOOKAHEAD_MS and schedules any steps
// that fall within SCHEDULE_AHEAD seconds, using the sample-accurate
// AudioContext clock. This stays rock solid where a naive setInterval-driven
// playhead would drift and jitter.

const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.12; // seconds

export class AudioEngine {
  constructor({ steps, onStep }) {
    this.steps = steps;
    this.onStep = onStep; // (step, audioTime) => void, for UI sync
    this.bpm = 120;
    this.ctx = null;
    this.master = null;
    this.delay = null;
    this.timer = null;
    this.currentStep = 0;
    this.nextNoteTime = 0;
    this.playing = false;
    this.noiseBuffer = null;
    // Set by the app each tick: (step) => array of MIDI notes to play.
    this.getNotesForStep = () => [];
    // (step) => array of drum ids ("kick", "snare", ...) to play.
    this.getDrumsForStep = () => [];
  }

  ensureContext() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);

    // A gentle feedback delay gives the airy ToneMatrix ambience.
    this.delay = this.ctx.createDelay(1.0);
    this.delay.delayTime.value = 0.28;
    const feedback = this.ctx.createGain();
    feedback.gain.value = 0.3;
    const wet = this.ctx.createGain();
    wet.gain.value = 0.35;
    this.delay.connect(feedback);
    feedback.connect(this.delay);
    this.delay.connect(wet);
    wet.connect(this.master);
  }

  secondsPerStep() {
    // One step is a 16th note.
    return 60 / this.bpm / 4;
  }

  start() {
    this.ensureContext();
    if (this.ctx.state === "suspended") this.ctx.resume();
    if (this.playing) return;
    this.playing = true;
    this.currentStep = 0;
    this.nextNoteTime = this.ctx.currentTime + 0.06;
    this.timer = setInterval(() => this.schedule(), LOOKAHEAD_MS);
  }

  stop() {
    this.playing = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  schedule() {
    while (this.nextNoteTime < this.ctx.currentTime + SCHEDULE_AHEAD) {
      const step = this.currentStep;
      const when = this.nextNoteTime;
      for (const midi of this.getNotesForStep(step)) {
        this.playNote(midi, when);
      }
      for (const drum of this.getDrumsForStep(step)) {
        this.playDrum(drum, when);
      }
      this.onStep(step, when);
      this.nextNoteTime += this.secondsPerStep();
      this.currentStep = (this.currentStep + 1) % this.steps;
    }
  }

  // A bell-ish voice: sine fundamental + quiet octave partial, sharp attack,
  // exponential decay.
  playNote(midi, when, velocity = 1) {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);
    const dur = Math.max(0.35, this.secondsPerStep() * 3);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(0.28 * velocity, when + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, when + dur);

    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;

    const partial = ctx.createOscillator();
    partial.type = "sine";
    partial.frequency.value = freq * 2;
    const partialGain = ctx.createGain();
    partialGain.gain.value = 0.18;

    osc.connect(env);
    partial.connect(partialGain);
    partialGain.connect(env);
    env.connect(this.master);
    env.connect(this.delay);

    osc.start(when);
    partial.start(when);
    osc.stop(when + dur + 0.05);
    partial.stop(when + dur + 0.05);
  }

  // Immediate one-shot preview when the user paints a cell.
  preview(midi) {
    this.ensureContext();
    if (this.ctx.state === "suspended") this.ctx.resume();
    this.playNote(midi, this.ctx.currentTime, 0.8);
  }

  previewDrum(id) {
    this.ensureContext();
    if (this.ctx.state === "suspended") this.ctx.resume();
    this.playDrum(id, this.ctx.currentTime);
  }

  getNoiseBuffer() {
    if (!this.noiseBuffer) {
      const len = this.ctx.sampleRate; // 1 second of white noise
      this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    return this.noiseBuffer;
  }

  noiseSource(when, dur, { type, freq, gain }) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.getNoiseBuffer();
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    const env = ctx.createGain();
    env.gain.setValueAtTime(gain, when);
    env.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    src.connect(filter);
    filter.connect(env);
    env.connect(this.master);
    src.start(when);
    src.stop(when + dur + 0.05);
  }

  // Synthesized drum kit, kept dry (no delay send) so the groove stays tight.
  playDrum(id, when) {
    const ctx = this.ctx;
    switch (id) {
      case "kick": {
        const osc = ctx.createOscillator();
        osc.frequency.setValueAtTime(150, when);
        osc.frequency.exponentialRampToValueAtTime(45, when + 0.11);
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.85, when);
        env.gain.exponentialRampToValueAtTime(0.0001, when + 0.3);
        osc.connect(env);
        env.connect(this.master);
        osc.start(when);
        osc.stop(when + 0.35);
        break;
      }
      case "snare": {
        this.noiseSource(when, 0.18, { type: "bandpass", freq: 1800, gain: 0.5 });
        const body = ctx.createOscillator();
        body.type = "triangle";
        body.frequency.value = 185;
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.35, when);
        env.gain.exponentialRampToValueAtTime(0.0001, when + 0.12);
        body.connect(env);
        env.connect(this.master);
        body.start(when);
        body.stop(when + 0.15);
        break;
      }
      case "hatClosed":
        this.noiseSource(when, 0.05, { type: "highpass", freq: 7000, gain: 0.3 });
        break;
      case "hatOpen":
        this.noiseSource(when, 0.32, { type: "highpass", freq: 6500, gain: 0.26 });
        break;
    }
  }
}
