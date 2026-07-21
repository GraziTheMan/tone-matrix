import { createChain, playNote, playDrum } from "./synth.js";

// Audio engine: a lookahead scheduler (the "tale of two clocks" pattern).
// A coarse setInterval wakes up every LOOKAHEAD_MS and schedules any steps
// that fall within SCHEDULE_AHEAD seconds, using the sample-accurate
// AudioContext clock. This stays rock solid where a naive setInterval-driven
// playhead would drift and jitter.
//
// When a Web MIDI output is selected (this.midiOut.active), notes are sent
// to the external device with matching timestamps instead of the built-in
// synth.

const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.12; // seconds

export class AudioEngine {
  constructor({ onStep }) {
    this.onStep = onStep; // (step, audioTime) => void, for UI sync
    this.bpm = 120;
    // Length of the pattern currently playing — a callback so the app can
    // swap patterns (and lengths) mid-playback for song chaining.
    this.getPatternLength = () => 16;
    // Called after the playhead wraps to step 0; the app advances the song
    // chain here.
    this.onLoop = null;
    // Swing ratio: 0.5 = straight, up to 0.75 = heavy triplet swing. Offbeat
    // 16ths are delayed; the grid/playhead itself stays straight.
    this.swing = 0.5;
    this.midiOut = null; // MidiOut instance, optional
    // Mixer: per-track volume (0..1.5), drum volume, and delay level (0..1).
    this.mix = { trackVolumes: [1, 1, 1], drumVolume: 1, delayLevel: 0.5 };
    this.ctx = null;
    this.chain = null;
    this.timer = null;
    this.currentStep = 0;
    this.nextNoteTime = 0;
    this.playing = false;
    // Set by the app: (step) => [{ midi, velocity, midiVelocity, durSteps }]
    // note STARTS only — tied continuations must not appear here.
    this.getNotesForStep = () => [];
    // (step) => [{ id, note, velocity, midiVelocity }] where `id` drives the
    // built-in kit and `note` is the mapped channel-10 MIDI note.
    this.getDrumsForStep = () => [];
  }

  ensureContext() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.chain = createChain(this.ctx);
    this.applyMix();
  }

  // Set the mixer and apply it live if the context exists.
  setMix(mix) {
    this.mix = mix;
    this.applyMix();
  }

  applyMix() {
    if (!this.chain) return;
    this.mix.trackVolumes.forEach((v, t) => {
      if (this.chain.trackGains[t]) this.chain.trackGains[t].gain.value = v;
    });
    this.chain.drumGain.gain.value = this.mix.drumVolume;
    // Delay level 0..1 maps to a wet gain up to 0.7 (0.5 ≈ the old default).
    this.chain.wet.gain.value = this.mix.delayLevel * 0.7;
  }

  secondsPerStep() {
    // One step is a 16th note.
    return 60 / this.bpm / 4;
  }

  swingDelay() {
    return (this.swing - 0.5) * 2 * this.secondsPerStep();
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
    this.midiOut?.allOff();
  }

  schedule() {
    while (this.nextNoteTime < this.ctx.currentTime + SCHEDULE_AHEAD) {
      const step = this.currentStep;
      const when = this.nextNoteTime + (step % 2 ? this.swingDelay() : 0);
      const stepDur = this.secondsPerStep();
      const external = this.midiOut?.active;
      for (const n of this.getNotesForStep(step)) {
        if (external) {
          this.midiOut.note(n.channel ?? 0, n.midi, n.midiVelocity, when, n.durSteps * stepDur, this.ctx);
        } else {
          playNote(this.chain, { ...n, when, stepDur });
        }
      }
      for (const d of this.getDrumsForStep(step)) {
        if (external) {
          this.midiOut.note(9, d.note, d.midiVelocity, when, stepDur, this.ctx);
        } else {
          playDrum(this.chain, { id: d.id, when, velocity: d.velocity });
        }
      }
      this.onStep(step, this.nextNoteTime);
      this.nextNoteTime += this.secondsPerStep();
      this.currentStep += 1;
      if (this.currentStep >= this.getPatternLength()) {
        this.currentStep = 0;
        this.onLoop?.();
      }
    }
  }

  // Immediate one-shot preview when the user paints a cell.
  preview({ midi, velocity, midiVelocity, durSteps = 1, instrument, channel = 0 }) {
    this.ensureContext();
    if (this.ctx.state === "suspended") this.ctx.resume();
    const stepDur = this.secondsPerStep();
    if (this.midiOut?.active) {
      this.midiOut.note(channel, midi, midiVelocity, this.ctx.currentTime, durSteps * stepDur, this.ctx);
    } else {
      playNote(this.chain, { midi, velocity, durSteps, instrument, channel, when: this.ctx.currentTime, stepDur });
    }
  }

  previewDrum({ id, note, velocity, midiVelocity }) {
    this.ensureContext();
    if (this.ctx.state === "suspended") this.ctx.resume();
    if (this.midiOut?.active) {
      this.midiOut.note(9, note, midiVelocity, this.ctx.currentTime, this.secondsPerStep(), this.ctx);
    } else {
      playDrum(this.chain, { id, when: this.ctx.currentTime, velocity });
    }
  }
}
