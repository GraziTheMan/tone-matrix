import {
  ROWS,
  VIEW_COLS,
  MAX_STEPS,
  PATTERN_LENGTHS,
  SCALES,
  ROOT_CHOICES,
  buildRowNotes,
  midiNoteName,
} from "./scale.js";
import { DRUMS, DRUM_ROWS, defaultDrumMap } from "./drums.js";
import { AudioEngine } from "./audio.js";
import { INSTRUMENTS } from "./synth.js";
import { songToMidi } from "./midi.js";
import { downloadFile } from "./download.js";
import { renderSongToWav } from "./render.js";
import { MidiOut } from "./midiout.js";
import { isTmx, tmxToProject } from "./tmx.js";

const STORAGE_KEY = "tone-matrix-state";
const HOLD_MS = 400; // press-and-hold duration for accent / solo gestures
const PATTERN_COUNT = 12;
const PATTERN_NAMES = "ABCDEFGHIJKL";
const TRACK_COUNT = 3;
const OCTAVE_RANGE = 2; // per-track shift of ±2 octaves

// Cell values: 0 = off, 1 = on, 2 = accented. Accent loudness is a user
// setting (percent extra on top of the normal velocity).
let accentBoost = 60;
const velFor = (value) => (value === 2 ? 0.7 * (1 + accentBoost / 100) : 0.7);
const midiVelFor = (value) =>
  value === 2 ? Math.min(127, Math.round(88 * (1 + accentBoost / 100))) : 88;

// ---- State ----------------------------------------------------------------

const emptyGrid = (rows, fill = 0) =>
  Array.from({ length: rows }, () => Array(MAX_STEPS).fill(fill));

const emptyTrack = () => ({
  grid: emptyGrid(ROWS),
  tieGrid: emptyGrid(ROWS, false),
});

const emptyPattern = () => ({
  tracks: Array.from({ length: TRACK_COUNT }, emptyTrack),
  drumGrid: emptyGrid(DRUM_ROWS),
  length: 16,
});

const defaultTrackSettings = () =>
  Array.from({ length: TRACK_COUNT }, () => ({ instrument: "bell", octave: 0, muted: false }));

let patterns = Array.from({ length: PATTERN_COUNT }, emptyPattern);
let selectedPattern = 0;
let activeTrack = 0;
let trackSettings = defaultTrackSettings();
let drumsMuted = false;
let songChain = []; // pattern indices played in order when song mode is on
let songMode = false;
let bpm = 120;
let swing = 50; // percent, 50 = straight … 75 = heavy
let rootIndex = 0;
let scaleIndex = 0; // index into SCALES, or the string "custom"
let customScale = buildRowNotes(48, SCALES[0].intervals); // one MIDI note per row, top first
let customScaleSet = false; // becomes true once the user shapes it
let drumMap = defaultDrumMap();
let remapOnScaleChange = false;
let mute = { melody: Array(ROWS).fill(false), drum: Array(DRUM_ROWS).fill(false) };
let solo = { melody: Array(ROWS).fill(false), drum: Array(DRUM_ROWS).fill(false) };
let midiOutId = ""; // "" = built-in synth
// Mixer: per-track volume percent (0-150), drum volume percent, delay percent.
let trackVolumes = [100, 100, 100];
let drumVolume = 100;
let delayLevel = 50;

function applyMix() {
  engine.setMix({
    trackVolumes: trackVolumes.map((v) => v / 100),
    drumVolume: drumVolume / 100,
    delayLevel: delayLevel / 100,
  });
}

function currentScaleNotes() {
  return scaleIndex === "custom"
    ? [...customScale]
    : buildRowNotes(ROOT_CHOICES[rootIndex].midi, SCALES[scaleIndex].intervals);
}

let rowNotes = currentScaleNotes();

let viewPage = 0;
let playingPage = 0;
let follow = true;
let tool = "draw"; // "draw" | "tie"

// Scheduler-side song position (runs ahead of what you hear) and the
// UI-side positions applied when the audio actually reaches them.
let schedChainPos = 0;
let uiPlayingPattern = 0;
let uiChainPos = -1;

const current = () => patterns[selectedPattern];
const pageCount = () => current().length / VIEW_COLS;
const stepOf = (col) => viewPage * VIEW_COLS + col;

const playingPatternIndex = () =>
  songMode && songChain.length
    ? songChain[schedChainPos % songChain.length]
    : selectedPattern;

function patternIsEmpty(pat) {
  return (
    pat.tracks.every((t) => t.grid.every((row) => row.every((v) => !v))) &&
    pat.drumGrid.every((row) => row.every((v) => !v))
  );
}

// The MIDI note a row plays on a given track (scale note + octave shift).
function trackNote(t, row) {
  return Math.min(127, Math.max(0, rowNotes[row] + trackSettings[t].octave * 12));
}

function trackNoteArrays() {
  return trackSettings.map((_, t) => rowNotes.map((_, row) => trackNote(t, row)));
}

// ---- Persistence ----------------------------------------------------------

const packGrid = (g) => g.map((row) => row.map((c) => +c).join("")).join("|");
const unpackGrid = (s, rows) => {
  const parsed = (s || "").split("|");
  if (parsed.length !== rows) return null;
  return parsed.map((r) => {
    const out = Array(MAX_STEPS).fill(0);
    for (let i = 0; i < Math.min(r.length, MAX_STEPS); i++) {
      out[i] = Math.min(2, Math.max(0, +r[i] || 0));
    }
    return out;
  });
};
const unpackBoolGrid = (s, rows) => {
  const g = unpackGrid(s, rows);
  return g ? g.map((row) => row.map((v) => v === 1)) : null;
};

function buildStateObject() {
  return {
    patterns: patterns.map((p) => ({
      tracks: p.tracks.map((t) => ({ cells: packGrid(t.grid), ties: packGrid(t.tieGrid) })),
      drums: packGrid(p.drumGrid),
      length: p.length,
    })),
    trackSettings,
    drumsMuted,
    accentBoost,
    trackVolumes,
    drumVolume,
    delayLevel,
    selectedPattern,
    songChain,
    songMode,
    bpm,
    swing,
    rootIndex,
    scaleIndex,
    customScale,
    customScaleSet,
    drumMap,
    remapOnScaleChange,
    muteMelody: mute.melody,
    muteDrum: mute.drum,
    soloMelody: solo.melody,
    soloDrum: solo.drum,
    midiOutId,
  };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(buildStateObject()));
}

function loadPattern(saved) {
  const pat = emptyPattern();
  if (Array.isArray(saved.tracks)) {
    for (let t = 0; t < Math.min(saved.tracks.length, TRACK_COUNT); t++) {
      pat.tracks[t].grid = unpackGrid(saved.tracks[t].cells, ROWS) ?? pat.tracks[t].grid;
      pat.tracks[t].tieGrid = unpackBoolGrid(saved.tracks[t].ties, ROWS) ?? pat.tracks[t].tieGrid;
    }
  } else {
    // Single-track format: the old melody grid becomes track 1.
    pat.tracks[0].grid = unpackGrid(saved.cells, ROWS) ?? pat.tracks[0].grid;
    pat.tracks[0].tieGrid = unpackBoolGrid(saved.ties, ROWS) ?? pat.tracks[0].tieGrid;
  }
  // Drums: current saves have DRUM_ROWS rows. Older saves had 4 rows
  // (open hat, closed hat, snare, kick) before crash/tambourine/clap were
  // added — remap those onto the new lane order by name.
  const drums = unpackGrid(saved.drums, DRUM_ROWS);
  if (drums) {
    pat.drumGrid = drums;
  } else {
    const legacy = unpackGrid(saved.drums, 4);
    if (legacy) {
      const legacyIds = ["hatOpen", "hatClosed", "snare", "kick"];
      for (let i = 0; i < 4; i++) {
        const dest = DRUMS.findIndex((d) => d.id === legacyIds[i]);
        if (dest >= 0) pat.drumGrid[dest] = legacy[i];
      }
    }
  }
  if (PATTERN_LENGTHS.includes(saved.length)) pat.length = saved.length;
  return pat;
}

const boolArray = (v, len) =>
  Array.isArray(v) && v.length === len && v.every((x) => typeof x === "boolean")
    ? v
    : null;

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    applyStateData(JSON.parse(raw));
  } catch {
    // Corrupt state: start fresh.
  }
}

// Parse a saved state object (current or older formats) into the globals.
function applyStateData(data) {
  {
    if (Array.isArray(data.patterns)) {
      for (let i = 0; i < Math.min(data.patterns.length, PATTERN_COUNT); i++) {
        patterns[i] = loadPattern(data.patterns[i]);
      }
      if (data.selectedPattern >= 0 && data.selectedPattern < PATTERN_COUNT) {
        selectedPattern = data.selectedPattern;
      }
      if (
        Array.isArray(data.songChain) &&
        data.songChain.every((i) => Number.isInteger(i) && i >= 0 && i < PATTERN_COUNT)
      ) {
        songChain = data.songChain;
      }
      songMode = data.songMode === true;
      mute.melody = boolArray(data.muteMelody, ROWS) ?? mute.melody;
      mute.drum = boolArray(data.muteDrum, DRUM_ROWS) ?? mute.drum;
      solo.melody = boolArray(data.soloMelody, ROWS) ?? solo.melody;
      solo.drum = boolArray(data.soloDrum, DRUM_ROWS) ?? solo.drum;
      remapOnScaleChange = data.remapOnScaleChange === true;
      if (typeof data.midiOutId === "string") midiOutId = data.midiOutId;
      if (Array.isArray(data.trackSettings) && data.trackSettings.length === TRACK_COUNT) {
        trackSettings = data.trackSettings.map((t) => ({
          instrument: Object.keys(INSTRUMENTS).includes(t?.instrument) ? t.instrument : "bell",
          octave:
            Number.isInteger(t?.octave) && Math.abs(t.octave) <= OCTAVE_RANGE ? t.octave : 0,
          muted: t?.muted === true,
        }));
      } else {
        trackSettings = defaultTrackSettings();
      }
      drumsMuted = data.drumsMuted === true;
      if (Number.isInteger(data.accentBoost) && data.accentBoost >= 10 && data.accentBoost <= 100) {
        accentBoost = data.accentBoost;
      }
      const vol = (x) => Number.isFinite(x) && x >= 0 && x <= 150;
      trackVolumes =
        Array.isArray(data.trackVolumes) && data.trackVolumes.length === TRACK_COUNT && data.trackVolumes.every(vol)
          ? data.trackVolumes
          : [100, 100, 100];
      drumVolume = vol(data.drumVolume) ? data.drumVolume : 100;
      delayLevel =
        Number.isFinite(data.delayLevel) && data.delayLevel >= 0 && data.delayLevel <= 100
          ? data.delayLevel
          : 50;
    } else if (data.cells) {
      // Older single-pattern format: migrate into slot A.
      patterns[0] = loadPattern({
        cells: data.cells,
        ties: data.ties,
        drums: data.drums,
        length: data.patternLength,
      });
    }

    if (data.bpm >= 40 && data.bpm <= 240) bpm = data.bpm;
    if (data.swing >= 50 && data.swing <= 75) swing = data.swing;
    if (data.rootIndex >= 0 && data.rootIndex < ROOT_CHOICES.length) {
      rootIndex = data.rootIndex;
    }
    if (data.scaleIndex === "custom") {
      scaleIndex = "custom";
    } else if (data.scaleIndex >= 0 && data.scaleIndex < SCALES.length) {
      scaleIndex = data.scaleIndex;
    }
    if (
      Array.isArray(data.customScale) &&
      data.customScale.length === ROWS &&
      data.customScale.every((n) => Number.isInteger(n) && n >= 0 && n <= 127)
    ) {
      customScale = data.customScale;
      customScaleSet = data.customScaleSet === true;
    }
    if (
      Array.isArray(data.drumMap) &&
      data.drumMap.length === DRUM_ROWS &&
      data.drumMap.every((n) => Number.isInteger(n) && n >= 0 && n <= 127)
    ) {
      drumMap = data.drumMap;
    }
    rowNotes = currentScaleNotes();
  }
}

// ---- Mute / solo ----------------------------------------------------------

function soloActive() {
  return solo.melody.some(Boolean) || solo.drum.some(Boolean);
}

function rowAudible(kind, row) {
  if (soloActive()) return solo[kind][row];
  return !mute[kind][row];
}

// ---- Audio ----------------------------------------------------------------

const engine = new AudioEngine({
  onStep: (step, when) =>
    stepQueue.push({
      step,
      when,
      pattern: playingPatternIndex(),
      chainPos: songMode && songChain.length ? schedChainPos % songChain.length : -1,
    }),
});
engine.getPatternLength = () => patterns[playingPatternIndex()].length;
engine.onLoop = () => {
  if (songMode && songChain.length) {
    schedChainPos = (schedChainPos + 1) % songChain.length;
  }
};

// Length of the note starting at `step` in 16ths (1 when untied).
function noteLength(pat, t, row, step) {
  const { grid, tieGrid } = pat.tracks[t];
  let end = step;
  while (end < pat.length - 1 && tieGrid[row][end] && grid[row][end + 1]) end++;
  return end - step + 1;
}

// A step is a note START unless it continues a tie from the previous step.
function isNoteStart(pat, t, row, step) {
  const { grid, tieGrid } = pat.tracks[t];
  return (
    grid[row][step] > 0 &&
    !(step > 0 && tieGrid[row][step - 1] && grid[row][step - 1] > 0)
  );
}

engine.getNotesForStep = (step) => {
  const pat = patterns[playingPatternIndex()];
  const notes = [];
  for (let t = 0; t < TRACK_COUNT; t++) {
    if (trackSettings[t].muted) continue;
    const grid = pat.tracks[t].grid;
    for (let row = 0; row < ROWS; row++) {
      if (rowAudible("melody", row) && isNoteStart(pat, t, row, step)) {
        const value = grid[row][step];
        notes.push({
          midi: trackNote(t, row),
          velocity: velFor(value),
          midiVelocity: midiVelFor(value),
          durSteps: noteLength(pat, t, row, step),
          instrument: trackSettings[t].instrument,
          channel: t,
        });
      }
    }
  }
  return notes;
};
engine.getDrumsForStep = (step) => {
  if (drumsMuted) return [];
  const pat = patterns[playingPatternIndex()];
  const hits = [];
  for (let row = 0; row < DRUM_ROWS; row++) {
    if (rowAudible("drum", row) && pat.drumGrid[row][step]) {
      const value = pat.drumGrid[row][step];
      hits.push({
        id: DRUMS[row].id,
        note: drumMap[row],
        velocity: velFor(value),
        midiVelocity: midiVelFor(value),
      });
    }
  }
  return hits;
};

// ---- Grid UI --------------------------------------------------------------

function buildGridUI(el, rows, kind, labelFor) {
  const cells = [];
  const heads = [];
  for (let row = 0; row < rows; row++) {
    const head = document.createElement("button");
    head.className = "row-head";
    head.dataset.kind = kind;
    head.dataset.row = row;
    head.title = `${labelFor(row)} — tap to mute, hold to solo`;
    head.setAttribute("aria-label", `Mute or solo ${labelFor(row)}`);
    attachRowHeadGestures(head, kind, row);
    el.appendChild(head);
    heads.push(head);

    cells.push([]);
    for (let col = 0; col < VIEW_COLS; col++) {
      const cell = document.createElement("button");
      cell.className = kind === "drum" ? "cell drum" : "cell";
      cell.dataset.kind = kind;
      cell.dataset.row = row;
      cell.dataset.col = col;
      cell.title = labelFor(row);
      cell.setAttribute("aria-label", `${labelFor(row)}, column ${col + 1}`);
      el.appendChild(cell);
      cells[row].push(cell);
    }
  }
  return { cells, heads };
}

function attachRowHeadGestures(head, kind, row) {
  head.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    let held = false;
    const timer = setTimeout(() => {
      held = true;
      solo[kind][row] = !solo[kind][row];
      renderRowHeads();
      renderView();
      saveState();
    }, HOLD_MS);
    window.addEventListener(
      "pointerup",
      () => {
        clearTimeout(timer);
        if (!held) {
          mute[kind][row] = !mute[kind][row];
          renderRowHeads();
          renderView();
          saveState();
        }
      },
      { once: true }
    );
  });
}

const melodyUI = buildGridUI(
  document.getElementById("grid"),
  ROWS,
  "melody",
  (row) => midiNoteName(rowNotes[row])
);
const drumUI = buildGridUI(
  document.getElementById("drum-grid"),
  DRUM_ROWS,
  "drum",
  (row) => DRUMS[row].label
);

const cellEls = melodyUI.cells;
const drumCellEls = drumUI.cells;

const gridDataFor = (kind) =>
  kind === "drum" ? current().drumGrid : current().tracks[activeTrack].grid;
const cellsFor = (kind) => (kind === "drum" ? drumCellEls : cellEls);
const headsFor = (kind) => (kind === "drum" ? drumUI.heads : melodyUI.heads);

function renderRowHeads() {
  for (const kind of ["melody", "drum"]) {
    const heads = headsFor(kind);
    for (let row = 0; row < heads.length; row++) {
      heads[row].classList.toggle("muted", mute[kind][row]);
      heads[row].classList.toggle("solo", solo[kind][row]);
    }
  }
}

// Re-render every visible cell for the current page (cheap: ~320 nodes).
function renderView() {
  const pat = current();
  for (const kind of ["melody", "drum"]) {
    const g = gridDataFor(kind);
    const cells = cellsFor(kind);
    for (let row = 0; row < cells.length; row++) {
      const dim = !rowAudible(kind, row);
      for (let col = 0; col < VIEW_COLS; col++) {
        const step = stepOf(col);
        const el = cells[row][col];
        const value = g[row][step];
        el.classList.toggle("on", value > 0);
        el.classList.toggle("accent", value === 2);
        el.classList.toggle("row-muted", dim);
        if (kind === "melody") {
          const tieGrid = pat.tracks[activeTrack].tieGrid;
          const tiedRight =
            value > 0 && tieGrid[row][step] && step + 1 < pat.length && g[row][step + 1] > 0;
          const tiedLeft =
            value > 0 && step > 0 && tieGrid[row][step - 1] && g[row][step - 1] > 0;
          el.classList.toggle("tie-right", tiedRight);
          el.classList.toggle("tie-left", tiedLeft);
          // Ghost dot: another track has a note here (helps line layers up).
          let ghost = -1;
          for (let t = 0; t < TRACK_COUNT && ghost < 0; t++) {
            if (t !== activeTrack && pat.tracks[t].grid[row][step] > 0) ghost = t;
          }
          for (let t = 0; t < TRACK_COUNT; t++) {
            el.classList.toggle(`ghost-${t}`, ghost === t && value === 0);
          }
        }
      }
    }
  }
}

function refreshMelodyTooltips() {
  for (let row = 0; row < ROWS; row++) {
    const name = midiNoteName(trackNote(activeTrack, row));
    for (const cell of cellEls[row]) cell.title = name;
    melodyUI.heads[row].title = `${name} — tap to mute, hold to solo`;
  }
}

function previewCell(kind, row, step) {
  const pat = current();
  if (kind === "drum") {
    const value = pat.drumGrid[row][step];
    engine.previewDrum({
      id: DRUMS[row].id,
      note: drumMap[row],
      velocity: velFor(value),
      midiVelocity: midiVelFor(value),
    });
  } else {
    const value = pat.tracks[activeTrack].grid[row][step];
    engine.preview({
      midi: trackNote(activeTrack, row),
      velocity: velFor(value),
      midiVelocity: midiVelFor(value),
      durSteps: noteLength(pat, activeTrack, row, step),
      instrument: trackSettings[activeTrack].instrument,
      channel: activeTrack,
    });
  }
}

// ---- Paint interaction ----------------------------------------------------
//
// Draw tool: tap toggles a cell; press-and-hold accents it (hold an accented
// cell to un-accent). Toggling OFF is deferred to pointerup so holding an
// active cell accents instead of erasing. Dragging paints with the value
// implied by the first cell touched.
//
// Tie tool (melody only): tap or drag across a note to join/split it with
// its right-hand neighbour.

let painting = false;
let paintMode = null; // "draw" | "erase" | "tie" | "untie"
let holdTimer = null;
let pendingOff = null; // cell awaiting toggle-off on pointerup
let downKey = null; // "kind:row:step" of the initial cell

const cellInfo = (target) => {
  if (!target?.classList?.contains("cell")) return null;
  return {
    kind: target.dataset.kind,
    row: +target.dataset.row,
    step: stepOf(+target.dataset.col),
  };
};

function cancelHold() {
  if (holdTimer) clearTimeout(holdTimer);
  holdTimer = null;
}

function applyTie(row, step, wantTie) {
  const pat = current();
  const { grid, tieGrid } = pat.tracks[activeTrack];
  if (step >= pat.length - 1) return;
  if (wantTie && !(grid[row][step] && grid[row][step + 1])) return;
  if (tieGrid[row][step] === wantTie) return;
  tieGrid[row][step] = wantTie;
  renderView();
  if (wantTie) previewCell("melody", row, step);
  saveState();
}

function applyDraw(info, value) {
  const g = gridDataFor(info.kind);
  if (!!g[info.row][info.step] === !!value) return;
  g[info.row][info.step] = value;
  renderView();
  renderPatternSlots();
  if (value) previewCell(info.kind, info.row, info.step);
  saveState();
}

function onPointerDown(e) {
  const info = cellInfo(e.target.closest(".cell"));
  if (!info) return;
  e.preventDefault();
  painting = true;
  downKey = `${info.kind}:${info.row}:${info.step}`;

  if (tool === "tie") {
    if (info.kind !== "melody") return;
    paintMode = current().tracks[activeTrack].tieGrid[info.row][info.step] ? "untie" : "tie";
    applyTie(info.row, info.step, paintMode === "tie");
    return;
  }

  const g = gridDataFor(info.kind);
  const value = g[info.row][info.step];
  if (value > 0) {
    // Defer the toggle-off; a hold accents instead.
    paintMode = "erase";
    pendingOff = info;
    holdTimer = setTimeout(() => {
      holdTimer = null;
      pendingOff = null;
      painting = false;
      g[info.row][info.step] = value === 2 ? 1 : 2;
      renderView();
      previewCell(info.kind, info.row, info.step);
      saveState();
    }, HOLD_MS);
  } else {
    paintMode = "draw";
    applyDraw(info, 1);
    holdTimer = setTimeout(() => {
      holdTimer = null;
      painting = false;
      g[info.row][info.step] = 2;
      renderView();
      previewCell(info.kind, info.row, info.step);
      saveState();
    }, HOLD_MS);
  }
}

function onPointerMove(e) {
  if (!painting) return;
  const info = cellInfo(document.elementFromPoint(e.clientX, e.clientY));
  if (!info || `${info.kind}:${info.row}:${info.step}` === downKey) return;
  // Leaving the initial cell turns this into a drag: no accent, and a
  // pending toggle-off commits as the start of an erase stroke.
  cancelHold();
  if (pendingOff) {
    applyDraw(pendingOff, 0);
    pendingOff = null;
  }
  if (paintMode === "tie" || paintMode === "untie") {
    if (info.kind === "melody") applyTie(info.row, info.step, paintMode === "tie");
  } else {
    applyDraw(info, paintMode === "draw" ? 1 : 0);
  }
}

function onPointerUp() {
  cancelHold();
  if (pendingOff) {
    applyDraw(pendingOff, 0);
    pendingOff = null;
  }
  painting = false;
  downKey = null;
}

for (const el of [document.getElementById("grid"), document.getElementById("drum-grid")]) {
  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });
}
window.addEventListener("pointermove", onPointerMove);
window.addEventListener("pointerup", onPointerUp);

// ---- Playhead sync --------------------------------------------------------

// The scheduler runs ahead of real time, so UI updates are queued with their
// audio timestamps and drawn by rAF when each moment actually arrives.
const stepQueue = [];
let drawnStep = -1;

function draw() {
  if (engine.ctx) {
    const now = engine.ctx.currentTime;
    let next = null;
    while (stepQueue.length && stepQueue[0].when <= now) {
      next = stepQueue.shift();
    }
    if (next) {
      drawnStep = next.step;
      uiPlayingPattern = next.pattern;
      if (next.chainPos !== uiChainPos) {
        uiChainPos = next.chainPos;
        renderSongChain();
      }
      const page = Math.floor(next.step / VIEW_COLS);
      if (page !== playingPage) {
        playingPage = page;
        updatePageTabs();
      }
      if (follow && engine.playing) {
        if (uiPlayingPattern !== selectedPattern) {
          selectPattern(uiPlayingPattern, { keepFollow: true });
        }
        if (viewPage !== page && page < pageCount()) {
          setViewPage(page, { keepFollow: true });
        }
      }
      renderPatternSlots();
      setPlayheadColumn(engine.playing ? next.step : -1);
    }
  }
  requestAnimationFrame(draw);
}

function setPlayheadColumn(step) {
  // Playhead only shows when you're looking at the playing pattern.
  const visible = step >= 0 && uiPlayingPattern === selectedPattern;
  const col = visible ? step - viewPage * VIEW_COLS : -1;
  for (const kind of ["melody", "drum"]) {
    const cells = cellsFor(kind);
    const g = gridDataFor(kind);
    for (let row = 0; row < cells.length; row++) {
      for (let c = 0; c < VIEW_COLS; c++) {
        const el = cells[row][c];
        const active = c === col && col >= 0 && col < VIEW_COLS;
        el.classList.toggle("playhead", active);
        if (active && g[row][stepOf(c)]) {
          el.classList.remove("pulse");
          void el.offsetWidth; // restart the animation
          el.classList.add("pulse");
        }
      }
    }
  }
}

requestAnimationFrame(draw);

// ---- Patterns and song chain ----------------------------------------------

const patternSlotsEl = document.getElementById("pattern-slots");
const songChainEl = document.getElementById("song-chain");
const songModeBtn = document.getElementById("song-mode");

for (let i = 0; i < PATTERN_COUNT; i++) {
  const slot = document.createElement("button");
  slot.className = "slot";
  slot.textContent = PATTERN_NAMES[i];
  slot.addEventListener("click", () => selectPattern(i));
  patternSlotsEl.appendChild(slot);
}

function renderPatternSlots() {
  const slots = patternSlotsEl.children;
  for (let i = 0; i < slots.length; i++) {
    slots[i].classList.toggle("active", i === selectedPattern);
    slots[i].classList.toggle("playing", engine.playing && i === uiPlayingPattern);
    slots[i].classList.toggle("filled", !patternIsEmpty(patterns[i]));
  }
}

function selectPattern(i, { keepFollow = false } = {}) {
  if (i === selectedPattern) return;
  selectedPattern = i;
  if (!keepFollow && songMode) setFollow(false);
  viewPage = 0;
  lengthSelect.value = current().length;
  rebuildPageTabs();
  renderView();
  renderPatternSlots();
  setPlayheadColumn(engine.playing ? drawnStep : -1);
  saveState();
}

function renderSongChain() {
  songChainEl.replaceChildren();
  for (const [pos, patIdx] of songChain.entries()) {
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.textContent = PATTERN_NAMES[patIdx];
    chip.title = "Remove from song";
    if (engine.playing && songMode && pos === uiChainPos) chip.classList.add("playing");
    chip.addEventListener("click", () => {
      songChain.splice(pos, 1);
      renderSongChain();
      saveState();
    });
    songChainEl.appendChild(chip);
  }
  if (!songChain.length) {
    const empty = document.createElement("span");
    empty.className = "chain-empty";
    empty.textContent = "tap + to build a song from the selected pattern";
    songChainEl.appendChild(empty);
  }
}

document.getElementById("song-add").addEventListener("click", () => {
  songChain.push(selectedPattern);
  renderSongChain();
  saveState();
});

function setSongMode(value) {
  songMode = value;
  songModeBtn.classList.toggle("active", songMode);
  songModeBtn.setAttribute("aria-pressed", String(songMode));
  schedChainPos = 0;
  saveState();
}

songModeBtn.addEventListener("click", () => setSongMode(!songMode));

document.getElementById("duplicate").addEventListener("click", () => {
  const target = patterns.findIndex((p) => patternIsEmpty(p));
  if (target === -1) return;
  const src = current();
  patterns[target] = {
    tracks: src.tracks.map((t) => ({
      grid: t.grid.map((r) => [...r]),
      tieGrid: t.tieGrid.map((r) => [...r]),
    })),
    drumGrid: src.drumGrid.map((r) => [...r]),
    length: src.length,
  };
  selectPattern(target);
});

// ---- Track mixer panel -----------------------------------------------------

const mixerEl = document.getElementById("mixer");
const delayInput = document.getElementById("delay");
const delayLabel = document.getElementById("delay-label");
const TRACK_COLORS = ["var(--on)", "#9ccc65", "#f06292"];
const volInputs = [];

function addVolumeRow(name, color, get, set) {
  const row = document.createElement("label");
  row.className = "slider mixer-row";
  const label = document.createElement("span");
  label.className = "mixer-name";
  label.textContent = name;
  if (color) label.style.color = color;
  const input = document.createElement("input");
  input.type = "range";
  input.min = 0;
  input.max = 150;
  input.step = 5;
  const value = document.createElement("span");
  value.className = "mixer-val";
  const render = () => {
    input.value = get();
    value.textContent = `${get()}%`;
  };
  input.addEventListener("input", () => {
    set(+input.value);
    value.textContent = `${+input.value}%`;
    applyMix();
    saveState();
  });
  row.append(label, input, value);
  mixerEl.appendChild(row);
  return render;
}

for (let t = 0; t < TRACK_COUNT; t++) {
  volInputs.push(
    addVolumeRow(`Track ${t + 1}`, TRACK_COLORS[t], () => trackVolumes[t], (v) => (trackVolumes[t] = v))
  );
}
volInputs.push(
  addVolumeRow("Drums", "var(--accent)", () => drumVolume, (v) => (drumVolume = v))
);

delayInput.addEventListener("input", () => {
  delayLevel = +delayInput.value;
  delayLabel.textContent = `Delay ${delayLevel}%`;
  applyMix();
  saveState();
});

function renderMixer() {
  for (const r of volInputs) r();
  delayInput.value = delayLevel;
  delayLabel.textContent = `Delay ${delayLevel}%`;
}

// ---- Track bar -------------------------------------------------------------

const trackTabsEl = document.getElementById("track-tabs");
const instrumentSelect = document.getElementById("instrument");
const octLabel = document.getElementById("oct-label");

for (const [id, voice] of Object.entries(INSTRUMENTS)) {
  const opt = document.createElement("option");
  opt.value = id;
  opt.textContent = voice.label;
  instrumentSelect.appendChild(opt);
}

for (let t = 0; t < TRACK_COUNT; t++) {
  const tab = document.createElement("button");
  tab.className = `track-tab tab-${t}`;
  tab.textContent = t + 1;
  tab.title = "Tap to select, hold to mute";
  tab.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    let held = false;
    const timer = setTimeout(() => {
      held = true;
      trackSettings[t].muted = !trackSettings[t].muted;
      renderTrackBar();
      saveState();
    }, HOLD_MS);
    window.addEventListener(
      "pointerup",
      () => {
        clearTimeout(timer);
        if (!held) setActiveTrack(t);
      },
      { once: true }
    );
  });
  trackTabsEl.appendChild(tab);
}

const drumMuteBtn = document.createElement("button");
drumMuteBtn.className = "track-tab tab-drums";
drumMuteBtn.textContent = "Drums";
drumMuteBtn.title = "Tap to mute or unmute the drum track";
drumMuteBtn.addEventListener("click", () => {
  drumsMuted = !drumsMuted;
  renderTrackBar();
  saveState();
});
trackTabsEl.appendChild(drumMuteBtn);

function setActiveTrack(t) {
  activeTrack = t;
  renderTrackBar();
  refreshMelodyTooltips();
  renderView();
}

function renderTrackBar() {
  const tabs = trackTabsEl.children;
  for (let t = 0; t < TRACK_COUNT; t++) {
    tabs[t].classList.toggle("active", t === activeTrack);
    tabs[t].classList.toggle("muted", trackSettings[t].muted);
  }
  drumMuteBtn.classList.toggle("muted", drumsMuted);
  document.getElementById("drum-grid").classList.toggle("drums-muted", drumsMuted);
  instrumentSelect.value = trackSettings[activeTrack].instrument;
  octLabel.textContent = `Oct ${trackSettings[activeTrack].octave > 0 ? "+" : ""}${trackSettings[activeTrack].octave}`;
  const gridEl = document.getElementById("grid");
  for (let t = 0; t < TRACK_COUNT; t++) {
    gridEl.classList.toggle(`track-${t}`, t === activeTrack);
  }
}

instrumentSelect.addEventListener("change", () => {
  trackSettings[activeTrack].instrument = instrumentSelect.value;
  engine.preview({
    midi: trackNote(activeTrack, ROWS - 4),
    velocity: velFor(1),
    midiVelocity: midiVelFor(1),
    instrument: instrumentSelect.value,
    channel: activeTrack,
  });
  saveState();
});

function shiftOctave(delta) {
  const s = trackSettings[activeTrack];
  const next = Math.min(OCTAVE_RANGE, Math.max(-OCTAVE_RANGE, s.octave + delta));
  if (next === s.octave) return;
  s.octave = next;
  renderTrackBar();
  refreshMelodyTooltips();
  engine.preview({
    midi: trackNote(activeTrack, ROWS - 4),
    velocity: velFor(1),
    midiVelocity: midiVelFor(1),
    instrument: s.instrument,
    channel: activeTrack,
  });
  saveState();
}

document.getElementById("oct-down").addEventListener("click", () => shiftOctave(-1));
document.getElementById("oct-up").addEventListener("click", () => shiftOctave(1));

// ---- Pages ----------------------------------------------------------------

const pagesEl = document.getElementById("pages");
const pageTabsEl = document.getElementById("page-tabs");
const followBtn = document.getElementById("follow");

function setViewPage(page, { keepFollow = false } = {}) {
  viewPage = page;
  if (!keepFollow) setFollow(false);
  updatePageTabs();
  renderView();
  setPlayheadColumn(engine.playing ? drawnStep : -1);
}

function setFollow(value) {
  follow = value;
  followBtn.classList.toggle("active", follow);
  followBtn.setAttribute("aria-pressed", String(follow));
}

function updatePageTabs() {
  const tabs = pageTabsEl.children;
  for (let i = 0; i < tabs.length; i++) {
    tabs[i].classList.toggle("active", i === viewPage);
    tabs[i].classList.toggle(
      "playing",
      engine.playing && i === playingPage && uiPlayingPattern === selectedPattern
    );
  }
}

function rebuildPageTabs() {
  pageTabsEl.replaceChildren();
  const pages = pageCount();
  pagesEl.hidden = pages <= 1;
  for (let i = 0; i < pages; i++) {
    const tab = document.createElement("button");
    tab.className = "tab";
    tab.textContent = i + 1;
    tab.addEventListener("click", () => setViewPage(i));
    pageTabsEl.appendChild(tab);
  }
  updatePageTabs();
}

followBtn.addEventListener("click", () => setFollow(!follow));

// ---- Controls -------------------------------------------------------------

const playBtn = document.getElementById("play");
const bpmInput = document.getElementById("bpm");
const bpmLabel = document.getElementById("bpm-label");
const swingInput = document.getElementById("swing");
const swingLabel = document.getElementById("swing-label");
const rootSelect = document.getElementById("root");
const scaleSelect = document.getElementById("scale");
const lengthSelect = document.getElementById("length");
const toolDrawBtn = document.getElementById("tool-draw");
const toolTieBtn = document.getElementById("tool-tie");
const remapToggle = document.getElementById("remap-toggle");
const accentInput = document.getElementById("accent");
const accentLabel = document.getElementById("accent-label");

accentInput.addEventListener("input", () => {
  accentBoost = +accentInput.value;
  accentLabel.textContent = `Accent +${accentBoost}%`;
  saveState();
});

for (const [i, root] of ROOT_CHOICES.entries()) {
  const opt = document.createElement("option");
  opt.value = i;
  opt.textContent = root.label;
  rootSelect.appendChild(opt);
}
for (const [i, scale] of SCALES.entries()) {
  const opt = document.createElement("option");
  opt.value = i;
  opt.textContent = scale.label;
  scaleSelect.appendChild(opt);
}
{
  const opt = document.createElement("option");
  opt.value = "custom";
  opt.textContent = "Custom";
  scaleSelect.appendChild(opt);
}

function stopPlayback() {
  if (!engine.playing) return;
  engine.stop();
  stepQueue.length = 0;
  drawnStep = -1;
  uiChainPos = -1;
  setPlayheadColumn(-1);
  updatePageTabs();
  renderPatternSlots();
  renderSongChain();
  playBtn.textContent = "Play";
  playBtn.setAttribute("aria-pressed", "false");
}

playBtn.addEventListener("click", () => {
  if (engine.playing) {
    stopPlayback();
  } else {
    schedChainPos = 0;
    engine.start();
    playBtn.textContent = "Stop";
    playBtn.setAttribute("aria-pressed", "true");
  }
});

bpmInput.addEventListener("input", () => {
  bpm = +bpmInput.value;
  engine.bpm = bpm;
  bpmLabel.textContent = `${bpm} BPM`;
  saveState();
});

swingInput.addEventListener("input", () => {
  swing = +swingInput.value;
  engine.swing = swing / 100;
  swingLabel.textContent = `Swing ${swing}%`;
  saveState();
});

// Move every note in every pattern to the row whose new pitch is nearest its
// old pitch, so melodies keep their sound (not just their shape) across
// scale and root changes.
function remapPatterns(oldNotes, newNotes) {
  const nearestRow = (pitch) => {
    let best = 0;
    for (let r = 1; r < newNotes.length; r++) {
      if (Math.abs(newNotes[r] - pitch) < Math.abs(newNotes[best] - pitch)) best = r;
    }
    return best;
  };
  const rowMap = oldNotes.map((pitch) => nearestRow(pitch));
  for (const pat of patterns) {
    for (const track of pat.tracks) {
      const newGrid = emptyGrid(ROWS);
      const newTies = emptyGrid(ROWS, false);
      for (let row = 0; row < ROWS; row++) {
        const nr = rowMap[row];
        for (let step = 0; step < MAX_STEPS; step++) {
          if (track.grid[row][step]) {
            newGrid[nr][step] = Math.max(newGrid[nr][step], track.grid[row][step]);
          }
          if (track.tieGrid[row][step]) newTies[nr][step] = true;
        }
      }
      track.grid = newGrid;
      track.tieGrid = newTies;
    }
  }
}

function applyScaleChange() {
  const oldNotes = rowNotes;
  rowNotes = currentScaleNotes();
  rootSelect.disabled = scaleIndex === "custom";
  if (remapOnScaleChange) {
    remapPatterns(oldNotes, rowNotes);
    renderView();
    renderPatternSlots();
  }
  refreshMelodyTooltips();
  saveState();
}

rootSelect.addEventListener("change", () => {
  rootIndex = +rootSelect.value;
  applyScaleChange();
});

scaleSelect.addEventListener("change", () => {
  scaleIndex = scaleSelect.value === "custom" ? "custom" : +scaleSelect.value;
  // First visit to Custom: start from whatever scale was playing so it
  // sounds identical until the user shapes it.
  if (scaleIndex === "custom" && !customScaleSet) {
    customScale = [...rowNotes];
    customScaleSet = true;
    renderCustomScale();
  }
  applyScaleChange();
});

remapToggle.addEventListener("change", () => {
  remapOnScaleChange = remapToggle.checked;
  saveState();
});

lengthSelect.addEventListener("change", () => {
  current().length = +lengthSelect.value;
  if (viewPage >= pageCount()) viewPage = 0;
  rebuildPageTabs();
  renderView();
  saveState();
});

function setTool(next) {
  tool = next;
  toolDrawBtn.classList.toggle("active", tool === "draw");
  toolDrawBtn.setAttribute("aria-pressed", String(tool === "draw"));
  toolTieBtn.classList.toggle("active", tool === "tie");
  toolTieBtn.setAttribute("aria-pressed", String(tool === "tie"));
  document.getElementById("grid").classList.toggle("tie-mode", tool === "tie");
}

toolDrawBtn.addEventListener("click", () => setTool("draw"));
toolTieBtn.addEventListener("click", () => setTool("tie"));

// ---- Clear menu ------------------------------------------------------------

const clearBtn = document.getElementById("clear");
const clearMenu = document.getElementById("clear-menu");

function resetProjectState() {
  patterns = Array.from({ length: PATTERN_COUNT }, emptyPattern);
  selectedPattern = 0;
  songChain = [];
  songMode = false;
  bpm = 120;
  swing = 50;
  rootIndex = 0;
  scaleIndex = 0;
  trackSettings = defaultTrackSettings();
  drumsMuted = false;
  trackVolumes = [100, 100, 100];
  drumVolume = 100;
  delayLevel = 50;
  mute = { melody: Array(ROWS).fill(false), drum: Array(DRUM_ROWS).fill(false) };
  solo = { melody: Array(ROWS).fill(false), drum: Array(DRUM_ROWS).fill(false) };
  rowNotes = currentScaleNotes();
}

function afterClear() {
  renderView();
  renderPatternSlots();
  renderSongChain();
  saveState();
}

const CLEAR_OPTIONS = [
  {
    label: () => `Track ${activeTrack + 1} on pattern ${PATTERN_NAMES[selectedPattern]}`,
    confirmText: () =>
      `Clear track ${activeTrack + 1} on pattern ${PATTERN_NAMES[selectedPattern]}?`,
    run: () => {
      current().tracks[activeTrack] = emptyTrack();
      afterClear();
    },
  },
  {
    label: () => `Drums on pattern ${PATTERN_NAMES[selectedPattern]}`,
    confirmText: () => `Clear the drums on pattern ${PATTERN_NAMES[selectedPattern]}?`,
    run: () => {
      current().drumGrid = emptyGrid(DRUM_ROWS);
      afterClear();
    },
  },
  {
    label: () => `Whole pattern ${PATTERN_NAMES[selectedPattern]}`,
    confirmText: () =>
      `Clear pattern ${PATTERN_NAMES[selectedPattern]}? All its tracks, ties, and drums will be removed.`,
    run: () => {
      const pat = current();
      pat.tracks = Array.from({ length: TRACK_COUNT }, emptyTrack);
      pat.drumGrid = emptyGrid(DRUM_ROWS);
      afterClear();
    },
  },
  {
    label: () => "Song chain",
    confirmText: () => "Clear the song chain? The patterns themselves are kept.",
    run: () => {
      songChain = [];
      afterClear();
    },
  },
  {
    label: () => "Entire project",
    confirmText: () =>
      "Clear the ENTIRE project — all patterns, the song chain, and settings? Saved projects are kept.",
    run: () => {
      stopPlayback();
      resetProjectState();
      saveState();
      syncUI();
    },
  },
];

function hideClearMenu() {
  clearMenu.hidden = true;
  clearBtn.setAttribute("aria-expanded", "false");
}

clearBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (!clearMenu.hidden) {
    hideClearMenu();
    return;
  }
  clearMenu.replaceChildren();
  for (const opt of CLEAR_OPTIONS) {
    const item = document.createElement("button");
    item.className = "clear-item";
    item.textContent = opt.label();
    item.addEventListener("click", (ev) => {
      ev.stopPropagation();
      hideClearMenu();
      if (confirm(opt.confirmText())) opt.run();
    });
    clearMenu.appendChild(item);
  }
  clearMenu.hidden = false;
  clearBtn.setAttribute("aria-expanded", "true");
});

window.addEventListener("pointerdown", (e) => {
  if (!clearMenu.hidden && !clearMenu.contains(e.target) && e.target !== clearBtn) {
    hideClearMenu();
  }
});

function exportArgs() {
  const chain =
    songMode && songChain.length ? songChain.map((i) => patterns[i]) : [current()];
  return {
    segments: chain.map((p) => ({
      tracks: p.tracks,
      drumGrid: p.drumGrid,
      steps: p.length,
    })),
    trackNotes: trackNoteArrays(),
    trackInstruments: trackSettings.map((t) => t.instrument),
    trackAudible: trackSettings.map((t) => !t.muted),
    bpm,
    swing: swing / 100,
    accentVelocity: midiVelFor(2),
    accentAudio: velFor(2),
    mix: {
      trackVolumes: trackVolumes.map((v) => v / 100),
      drumVolume: drumVolume / 100,
      delayLevel: delayLevel / 100,
    },
    melodyAudible: Array.from({ length: ROWS }, (_, r) => rowAudible("melody", r)),
    drumAudible: Array.from({ length: DRUM_ROWS }, (_, r) => !drumsMuted && rowAudible("drum", r)),
  };
}

document.getElementById("export").addEventListener("click", () => {
  downloadFile(songToMidi({ ...exportArgs(), drumNotes: drumMap }), "sonic-squares.mid", "audio/midi");
});

const exportWavBtn = document.getElementById("export-wav");
exportWavBtn.addEventListener("click", async () => {
  exportWavBtn.disabled = true;
  exportWavBtn.textContent = "Rendering…";
  try {
    const bytes = await renderSongToWav(exportArgs());
    await downloadFile(bytes, "sonic-squares.wav", "audio/wav");
  } finally {
    exportWavBtn.disabled = false;
    exportWavBtn.textContent = "Export WAV";
  }
});

// ---- Custom scale editor ---------------------------------------------------

const customScaleEl = document.getElementById("custom-scale");
const customScaleInputs = [];

for (let row = 0; row < ROWS; row++) {
  const rowEl = document.createElement("label");
  rowEl.className = "drum-map-row";

  const name = document.createElement("span");
  name.className = "drum-map-name";
  name.textContent = row === 0 ? "Row 1 (top)" : row === ROWS - 1 ? `Row ${ROWS} (bottom)` : `Row ${row + 1}`;

  const input = document.createElement("input");
  input.type = "number";
  input.min = 0;
  input.max = 127;
  input.inputMode = "numeric";

  const noteName = document.createElement("span");
  noteName.className = "drum-map-note";

  input.addEventListener("change", () => {
    const value = Math.min(127, Math.max(0, Math.round(+input.value || 0)));
    input.value = value;
    customScale[row] = value;
    customScaleSet = true;
    noteName.textContent = midiNoteName(value);
    if (scaleIndex === "custom") {
      rowNotes = [...customScale];
      refreshMelodyTooltips();
    }
    engine.preview({ midi: value, velocity: velFor(1), midiVelocity: midiVelFor(1) });
    saveState();
  });

  rowEl.append(name, input, noteName);
  customScaleEl.appendChild(rowEl);
  customScaleInputs.push({ input, noteName });
}

function renderCustomScale() {
  for (const [row, { input, noteName }] of customScaleInputs.entries()) {
    input.value = customScale[row];
    noteName.textContent = midiNoteName(customScale[row]);
  }
}

document.getElementById("custom-scale-copy").addEventListener("click", () => {
  customScale = [...rowNotes];
  customScaleSet = true;
  renderCustomScale();
  if (scaleIndex !== "custom") {
    scaleIndex = "custom";
    scaleSelect.value = "custom";
    applyScaleChange();
  } else {
    saveState();
  }
});

// ---- Projects ---------------------------------------------------------------
//
// Named projects live in localStorage for instant save/load; export/import
// moves them as .json files through the share sheet (native) or downloads
// (browser), so they can be kept in any folder, synced, or shared.

const PROJECTS_KEY = "tone-matrix-projects";
const projectListEl = document.getElementById("project-list");
const projectNameInput = document.getElementById("project-name");
const projectFileInput = document.getElementById("project-file");

function readProjects() {
  try {
    const data = JSON.parse(localStorage.getItem(PROJECTS_KEY));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function writeProjects(projects) {
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
  renderProjectList();
}

function loadProjectState(data) {
  stopPlayback();
  applyStateData(data);
  saveState();
  syncUI();
}

function renderProjectList() {
  const projects = readProjects();
  projectListEl.replaceChildren();
  const names = Object.keys(projects).sort();
  if (!names.length) {
    const empty = document.createElement("span");
    empty.className = "chain-empty";
    empty.textContent = "no saved projects yet";
    projectListEl.appendChild(empty);
    return;
  }
  for (const name of names) {
    const row = document.createElement("div");
    row.className = "project-row";
    const label = document.createElement("span");
    label.className = "project-name";
    label.textContent = name;
    const loadBtn = document.createElement("button");
    loadBtn.className = "btn btn-small";
    loadBtn.textContent = "Load";
    loadBtn.addEventListener("click", () => {
      loadProjectState(projects[name]);
      projectNameInput.value = name;
    });
    const exportBtn = document.createElement("button");
    exportBtn.className = "btn btn-small";
    exportBtn.textContent = "Export";
    exportBtn.title = "Save as a file you can keep anywhere or share";
    exportBtn.addEventListener("click", () => {
      const bytes = new TextEncoder().encode(JSON.stringify(projects[name], null, 2));
      const safe = name.replace(/[^\w\- ]+/g, "").trim() || "project";
      downloadFile(bytes, `${safe}.sonicsquares.json`, "application/json");
    });
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "btn btn-small";
    deleteBtn.textContent = "✕";
    deleteBtn.title = "Delete";
    deleteBtn.addEventListener("click", () => {
      if (!confirm(`Delete project "${name}"? This can't be undone.`)) return;
      const next = readProjects();
      delete next[name];
      writeProjects(next);
    });
    row.append(label, loadBtn, exportBtn, deleteBtn);
    projectListEl.appendChild(row);
  }
}

document.getElementById("project-new").addEventListener("click", () => {
  const hasContent = patterns.some((p) => !patternIsEmpty(p)) || songChain.length;
  if (
    hasContent &&
    !confirm("Start a new project? Unsaved changes to the current one will be lost.")
  ) {
    return;
  }
  stopPlayback();
  resetProjectState();
  projectNameInput.value = "";
  saveState();
  syncUI();
});

document.getElementById("project-save").addEventListener("click", () => {
  const name =
    projectNameInput.value.trim() ||
    `Project ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  projectNameInput.value = name;
  const projects = readProjects();
  if (
    projects[name] &&
    !confirm(`A project called "${name}" already exists. Overwrite it with the current state?`)
  ) {
    return;
  }
  projects[name] = buildStateObject();
  writeProjects(projects);
});

document.getElementById("project-import").addEventListener("click", () => projectFileInput.click());

projectFileInput.addEventListener("change", async () => {
  const file = projectFileInput.files?.[0];
  projectFileInput.value = "";
  if (!file) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let data;
    if (isTmx(bytes)) {
      // RollingTones song: convert on the fly.
      data = tmxToProject(bytes);
    } else {
      data = JSON.parse(new TextDecoder().decode(bytes));
      if (!Array.isArray(data.patterns) && !data.cells) throw new Error("not a project");
    }
    loadProjectState(data);
    const name = file.name.replace(/\.sonicsquares\.json$|\.tonematrix\.json$|\.json$|\.tmx$/i, "");
    projectNameInput.value = name;
  } catch {
    alert("That file doesn't look like a Sonic Squares project or RollingTones song.");
  }
});

// ---- MIDI output ----------------------------------------------------------

const midiOut = new MidiOut();
engine.midiOut = midiOut;
const midiOutSelect = document.getElementById("midi-out");
const midiStatusEl = document.getElementById("midi-status");

function renderMidiOutputs() {
  const outputs = midiOut.outputs();
  midiOutSelect.replaceChildren();
  const off = document.createElement("option");
  off.value = "";
  off.textContent = "Built-in synth";
  midiOutSelect.appendChild(off);
  for (const { id, name } of outputs) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = name;
    midiOutSelect.appendChild(opt);
  }
  // Keep the saved selection if that device is still connected.
  if (midiOutId && outputs.some((o) => o.id === midiOutId)) {
    midiOutSelect.value = midiOutId;
    midiOut.select(midiOutId);
  } else {
    midiOutSelect.value = "";
    midiOut.select(null);
  }
  midiStatusEl.textContent = outputs.length
    ? "Live playback goes to the selected device (drums on channel 10, using the mapping below)."
    : "No MIDI devices found — connect one and it will appear here. The built-in synth plays meanwhile.";
}

async function initMidiOut() {
  if (!(await midiOut.init())) {
    midiStatusEl.textContent =
      "Web MIDI isn't supported in this browser, so playback uses the built-in synth. Chrome and Edge support it.";
    midiOutSelect.disabled = true;
    return;
  }
  midiOut.onchange = renderMidiOutputs;
  renderMidiOutputs();
}

midiOutSelect.addEventListener("change", () => {
  midiOutId = midiOutSelect.value;
  midiOut.select(midiOutId || null);
  saveState();
});

// ---- Percussion MIDI mapping panel ----------------------------------------

const drumMapEl = document.getElementById("drum-map");
const drumMapInputs = [];

for (const [row, drum] of DRUMS.entries()) {
  const rowEl = document.createElement("label");
  rowEl.className = "drum-map-row";

  const name = document.createElement("span");
  name.className = "drum-map-name";
  name.textContent = drum.label;

  const input = document.createElement("input");
  input.type = "number";
  input.min = 0;
  input.max = 127;
  input.inputMode = "numeric";

  const noteName = document.createElement("span");
  noteName.className = "drum-map-note";

  input.addEventListener("change", () => {
    const value = Math.min(127, Math.max(0, Math.round(+input.value || 0)));
    input.value = value;
    drumMap[row] = value;
    noteName.textContent = midiNoteName(value);
    saveState();
  });

  rowEl.append(name, input, noteName);
  drumMapEl.appendChild(rowEl);
  drumMapInputs.push({ input, noteName });
}

function renderDrumMap() {
  for (const [row, { input, noteName }] of drumMapInputs.entries()) {
    input.value = drumMap[row];
    noteName.textContent = midiNoteName(drumMap[row]);
  }
}

document.getElementById("drum-map-reset").addEventListener("click", () => {
  drumMap = defaultDrumMap();
  renderDrumMap();
  saveState();
});

// ---- Init -----------------------------------------------------------------

// Sync every control and view from the current state. Runs at startup and
// again whenever a project is loaded or imported.
function syncUI() {
  viewPage = 0;
  activeTrack = 0;
  engine.bpm = bpm;
  engine.swing = swing / 100;
  bpmInput.value = bpm;
  bpmLabel.textContent = `${bpm} BPM`;
  swingInput.value = swing;
  swingLabel.textContent = `Swing ${swing}%`;
  rootSelect.value = rootIndex;
  rootSelect.disabled = scaleIndex === "custom";
  scaleSelect.value = scaleIndex;
  lengthSelect.value = current().length;
  remapToggle.checked = remapOnScaleChange;
  accentInput.value = accentBoost;
  accentLabel.textContent = `Accent +${accentBoost}%`;
  songModeBtn.classList.toggle("active", songMode);
  songModeBtn.setAttribute("aria-pressed", String(songMode));
  renderTrackBar();
  refreshMelodyTooltips();
  rebuildPageTabs();
  renderView();
  renderRowHeads();
  renderPatternSlots();
  renderSongChain();
  renderDrumMap();
  renderCustomScale();
  renderProjectList();
  renderMixer();
  applyMix();
}

loadState();
setTool("draw");
setFollow(true);
syncUI();
initMidiOut();
