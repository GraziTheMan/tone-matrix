import {
  ROWS,
  STEPS,
  SCALES,
  ROOT_CHOICES,
  buildRowNotes,
  midiNoteName,
} from "./scale.js";
import { DRUMS, DRUM_ROWS, defaultDrumMap } from "./drums.js";
import { AudioEngine } from "./audio.js";
import { gridToMidi, downloadMidi } from "./midi.js";

const STORAGE_KEY = "tone-matrix-state";

// ---- State ----------------------------------------------------------------

const emptyGrid = (rows) => Array.from({ length: rows }, () => Array(STEPS).fill(false));

let grid = emptyGrid(ROWS);
let drumGrid = emptyGrid(DRUM_ROWS);
let bpm = 120;
let rootIndex = 0;
let scaleIndex = 0;
let drumMap = defaultDrumMap();
let rowNotes = buildRowNotes(ROOT_CHOICES[rootIndex].midi, SCALES[scaleIndex].intervals);

const packGrid = (g) => g.map((row) => row.map((c) => (c ? 1 : 0)).join("")).join("|");
const unpackGrid = (s, rows) => {
  const parsed = (s || "").split("|");
  if (parsed.length !== rows) return null;
  return parsed.map((r) => r.split("").map((c) => c === "1"));
};

function saveState() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      cells: packGrid(grid),
      drums: packGrid(drumGrid),
      bpm,
      rootIndex,
      scaleIndex,
      drumMap,
    })
  );
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    grid = unpackGrid(data.cells, ROWS) ?? grid;
    drumGrid = unpackGrid(data.drums, DRUM_ROWS) ?? drumGrid;
    if (data.bpm >= 40 && data.bpm <= 240) bpm = data.bpm;
    if (data.rootIndex >= 0 && data.rootIndex < ROOT_CHOICES.length) {
      rootIndex = data.rootIndex;
    }
    if (data.scaleIndex >= 0 && data.scaleIndex < SCALES.length) {
      scaleIndex = data.scaleIndex;
    }
    if (
      Array.isArray(data.drumMap) &&
      data.drumMap.length === DRUM_ROWS &&
      data.drumMap.every((n) => Number.isInteger(n) && n >= 0 && n <= 127)
    ) {
      drumMap = data.drumMap;
    }
    rowNotes = buildRowNotes(ROOT_CHOICES[rootIndex].midi, SCALES[scaleIndex].intervals);
  } catch {
    // Corrupt state: start fresh.
  }
}

// ---- Audio ----------------------------------------------------------------

const engine = new AudioEngine({
  steps: STEPS,
  onStep: (step, when) => stepQueue.push({ step, when }),
});
engine.getNotesForStep = (step) => {
  const notes = [];
  for (let row = 0; row < ROWS; row++) {
    if (grid[row][step]) notes.push(rowNotes[row]);
  }
  return notes;
};
engine.getDrumsForStep = (step) => {
  const ids = [];
  for (let row = 0; row < DRUM_ROWS; row++) {
    if (drumGrid[row][step]) ids.push(DRUMS[row].id);
  }
  return ids;
};

// ---- Grid UI --------------------------------------------------------------

function buildGridUI(el, rows, kind, labelFor) {
  const cells = [];
  for (let row = 0; row < rows; row++) {
    cells.push([]);
    for (let step = 0; step < STEPS; step++) {
      const cell = document.createElement("button");
      cell.className = kind === "drum" ? "cell drum" : "cell";
      cell.dataset.kind = kind;
      cell.dataset.row = row;
      cell.dataset.step = step;
      cell.title = labelFor(row);
      cell.setAttribute("aria-label", `${labelFor(row)}, step ${step + 1}`);
      el.appendChild(cell);
      cells[row].push(cell);
    }
  }
  return cells;
}

const cellEls = buildGridUI(
  document.getElementById("grid"),
  ROWS,
  "melody",
  (row) => midiNoteName(rowNotes[row])
);
const drumCellEls = buildGridUI(
  document.getElementById("drum-grid"),
  DRUM_ROWS,
  "drum",
  (row) => DRUMS[row].label
);

const gridFor = (kind) => (kind === "drum" ? drumGrid : grid);
const cellsFor = (kind) => (kind === "drum" ? drumCellEls : cellEls);

function renderCell(kind, row, step) {
  cellsFor(kind)[row][step].classList.toggle("on", gridFor(kind)[row][step]);
}

function renderGrids() {
  for (let row = 0; row < ROWS; row++)
    for (let step = 0; step < STEPS; step++) renderCell("melody", row, step);
  for (let row = 0; row < DRUM_ROWS; row++)
    for (let step = 0; step < STEPS; step++) renderCell("drum", row, step);
}

function refreshMelodyTooltips() {
  for (let row = 0; row < ROWS; row++) {
    for (const cell of cellEls[row]) cell.title = midiNoteName(rowNotes[row]);
  }
}

// Paint interaction: tap toggles; dragging paints with the value set by the
// first cell touched, so a stroke doesn't flicker cells on and off.
let painting = false;
let paintValue = true;

function applyPaint(target) {
  if (!target?.classList?.contains("cell")) return;
  const kind = target.dataset.kind;
  const row = +target.dataset.row;
  const step = +target.dataset.step;
  const g = gridFor(kind);
  if (g[row][step] === paintValue) return;
  g[row][step] = paintValue;
  renderCell(kind, row, step);
  if (paintValue) {
    if (kind === "drum") engine.previewDrum(DRUMS[row].id);
    else engine.preview(rowNotes[row]);
  }
  saveState();
}

for (const el of [document.getElementById("grid"), document.getElementById("drum-grid")]) {
  el.addEventListener("pointerdown", (e) => {
    const cell = e.target.closest(".cell");
    if (!cell) return;
    painting = true;
    paintValue = !gridFor(cell.dataset.kind)[+cell.dataset.row][+cell.dataset.step];
    applyPaint(cell);
    e.preventDefault();
  });
  el.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });
}
window.addEventListener("pointermove", (e) => {
  if (!painting) return;
  applyPaint(document.elementFromPoint(e.clientX, e.clientY));
});
window.addEventListener("pointerup", () => (painting = false));

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
    if (next && next.step !== drawnStep) {
      setPlayheadColumn(engine.playing ? next.step : -1);
      drawnStep = next.step;
    }
  }
  requestAnimationFrame(draw);
}

function setPlayheadColumn(step) {
  for (const kind of ["melody", "drum"]) {
    const cells = cellsFor(kind);
    const g = gridFor(kind);
    for (let row = 0; row < cells.length; row++) {
      for (let s = 0; s < STEPS; s++) {
        const el = cells[row][s];
        const active = s === step;
        el.classList.toggle("playhead", active);
        if (active && g[row][s]) {
          el.classList.remove("pulse");
          void el.offsetWidth; // restart the animation
          el.classList.add("pulse");
        }
      }
    }
  }
}

requestAnimationFrame(draw);

// ---- Controls -------------------------------------------------------------

const playBtn = document.getElementById("play");
const bpmInput = document.getElementById("bpm");
const bpmLabel = document.getElementById("bpm-label");
const rootSelect = document.getElementById("root");
const scaleSelect = document.getElementById("scale");

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

playBtn.addEventListener("click", () => {
  if (engine.playing) {
    engine.stop();
    stepQueue.length = 0;
    setPlayheadColumn(-1);
    playBtn.textContent = "Play";
    playBtn.setAttribute("aria-pressed", "false");
  } else {
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

function applyScaleChange() {
  rowNotes = buildRowNotes(ROOT_CHOICES[rootIndex].midi, SCALES[scaleIndex].intervals);
  refreshMelodyTooltips();
  saveState();
}

rootSelect.addEventListener("change", () => {
  rootIndex = +rootSelect.value;
  applyScaleChange();
});

scaleSelect.addEventListener("change", () => {
  scaleIndex = +scaleSelect.value;
  applyScaleChange();
});

document.getElementById("clear").addEventListener("click", () => {
  grid = emptyGrid(ROWS);
  drumGrid = emptyGrid(DRUM_ROWS);
  renderGrids();
  saveState();
});

document.getElementById("export").addEventListener("click", () => {
  const bytes = gridToMidi({
    melodyGrid: grid,
    rowNotes,
    drumGrid,
    drumNotes: drumMap,
    steps: STEPS,
    bpm,
  });
  downloadMidi(bytes);
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

loadState();
engine.bpm = bpm;
bpmInput.value = bpm;
bpmLabel.textContent = `${bpm} BPM`;
rootSelect.value = rootIndex;
scaleSelect.value = scaleIndex;
refreshMelodyTooltips();
renderGrids();
renderDrumMap();
