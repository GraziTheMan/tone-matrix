import { ROWS, STEPS, ROOT_CHOICES, buildRowNotes } from "./scale.js";
import { AudioEngine } from "./audio.js";
import { gridToMidi, downloadMidi } from "./midi.js";

const STORAGE_KEY = "tone-matrix-state";

// ---- State ----------------------------------------------------------------

let grid = Array.from({ length: ROWS }, () => Array(STEPS).fill(false));
let bpm = 120;
let rootIndex = 0;
let rowNotes = buildRowNotes(ROOT_CHOICES[rootIndex].midi);

function saveState() {
  const cells = grid.map((row) => row.map((c) => (c ? 1 : 0)).join("")).join("|");
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ cells, bpm, rootIndex }));
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    const rows = (data.cells || "").split("|");
    if (rows.length === ROWS) {
      grid = rows.map((r) => r.split("").map((c) => c === "1"));
    }
    if (data.bpm >= 40 && data.bpm <= 240) bpm = data.bpm;
    if (data.rootIndex >= 0 && data.rootIndex < ROOT_CHOICES.length) {
      rootIndex = data.rootIndex;
    }
    rowNotes = buildRowNotes(ROOT_CHOICES[rootIndex].midi);
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

// ---- Grid UI --------------------------------------------------------------

const gridEl = document.getElementById("grid");
const cellEls = [];

for (let row = 0; row < ROWS; row++) {
  cellEls.push([]);
  for (let step = 0; step < STEPS; step++) {
    const cell = document.createElement("button");
    cell.className = "cell";
    cell.dataset.row = row;
    cell.dataset.step = step;
    cell.setAttribute("aria-label", `Row ${row + 1}, step ${step + 1}`);
    gridEl.appendChild(cell);
    cellEls[row].push(cell);
  }
}

function renderCell(row, step) {
  cellEls[row][step].classList.toggle("on", grid[row][step]);
}

function renderGrid() {
  for (let row = 0; row < ROWS; row++)
    for (let step = 0; step < STEPS; step++) renderCell(row, step);
}

// Paint interaction: tap toggles; dragging paints with the value set by the
// first cell touched, so a stroke doesn't flicker cells on and off.
let painting = false;
let paintValue = true;

function applyPaint(target) {
  if (!target?.classList?.contains("cell")) return;
  const row = +target.dataset.row;
  const step = +target.dataset.step;
  if (grid[row][step] === paintValue) return;
  grid[row][step] = paintValue;
  renderCell(row, step);
  if (paintValue) engine.preview(rowNotes[row]);
  saveState();
}

gridEl.addEventListener("pointerdown", (e) => {
  const cell = e.target.closest(".cell");
  if (!cell) return;
  painting = true;
  paintValue = !grid[+cell.dataset.row][+cell.dataset.step];
  applyPaint(cell);
  e.preventDefault();
});
window.addEventListener("pointermove", (e) => {
  if (!painting) return;
  applyPaint(document.elementFromPoint(e.clientX, e.clientY));
});
window.addEventListener("pointerup", () => (painting = false));
gridEl.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });

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
  for (let row = 0; row < ROWS; row++) {
    for (let s = 0; s < STEPS; s++) {
      const el = cellEls[row][s];
      const active = s === step;
      el.classList.toggle("playhead", active);
      if (active && grid[row][s]) {
        el.classList.remove("pulse");
        void el.offsetWidth; // restart the animation
        el.classList.add("pulse");
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

for (const [i, root] of ROOT_CHOICES.entries()) {
  const opt = document.createElement("option");
  opt.value = i;
  opt.textContent = `${root.label} pentatonic`;
  rootSelect.appendChild(opt);
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

rootSelect.addEventListener("change", () => {
  rootIndex = +rootSelect.value;
  rowNotes = buildRowNotes(ROOT_CHOICES[rootIndex].midi);
  saveState();
});

document.getElementById("clear").addEventListener("click", () => {
  grid = Array.from({ length: ROWS }, () => Array(STEPS).fill(false));
  renderGrid();
  saveState();
});

document.getElementById("export").addEventListener("click", () => {
  const bytes = gridToMidi(grid, rowNotes, STEPS, bpm);
  downloadMidi(bytes);
});

// ---- Init -----------------------------------------------------------------

loadState();
engine.bpm = bpm;
bpmInput.value = bpm;
bpmLabel.textContent = `${bpm} BPM`;
rootSelect.value = rootIndex;
renderGrid();
