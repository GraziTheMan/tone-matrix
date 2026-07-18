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
import { gridToMidi, downloadMidi } from "./midi.js";

const STORAGE_KEY = "tone-matrix-state";
const HOLD_MS = 400; // press-and-hold this long to accent a cell

// Cell values: 0 = off, 1 = on, 2 = accented. Audio velocities per value:
const VEL = { 1: 0.7, 2: 1.0 };

// ---- State ----------------------------------------------------------------

const emptyGrid = (rows, fill = 0) =>
  Array.from({ length: rows }, () => Array(MAX_STEPS).fill(fill));

let grid = emptyGrid(ROWS);
let drumGrid = emptyGrid(DRUM_ROWS);
// tieGrid[row][step] = true joins the melody note at `step` to `step + 1`.
let tieGrid = emptyGrid(ROWS, false);
let bpm = 120;
let swing = 50; // percent, 50 = straight … 75 = heavy
let rootIndex = 0;
let scaleIndex = 0;
let patternLength = 16;
let drumMap = defaultDrumMap();
let rowNotes = buildRowNotes(ROOT_CHOICES[rootIndex].midi, SCALES[scaleIndex].intervals);

let viewPage = 0;
let playingPage = 0;
let follow = true;
let tool = "draw"; // "draw" | "tie"

const pageCount = () => patternLength / VIEW_COLS;
const stepOf = (col) => viewPage * VIEW_COLS + col;

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

function saveState() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      cells: packGrid(grid),
      ties: packGrid(tieGrid),
      drums: packGrid(drumGrid),
      bpm,
      swing,
      rootIndex,
      scaleIndex,
      patternLength,
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
    const ties = unpackGrid(data.ties, ROWS);
    if (ties) tieGrid = ties.map((row) => row.map((v) => v === 1));
    if (data.bpm >= 40 && data.bpm <= 240) bpm = data.bpm;
    if (data.swing >= 50 && data.swing <= 75) swing = data.swing;
    if (data.rootIndex >= 0 && data.rootIndex < ROOT_CHOICES.length) {
      rootIndex = data.rootIndex;
    }
    if (data.scaleIndex >= 0 && data.scaleIndex < SCALES.length) {
      scaleIndex = data.scaleIndex;
    }
    if (PATTERN_LENGTHS.includes(data.patternLength)) {
      patternLength = data.patternLength;
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
  onStep: (step, when) => stepQueue.push({ step, when }),
});

// Length of the note starting at `step` in 16ths (1 when untied).
function noteLength(row, step) {
  let end = step;
  while (end < patternLength - 1 && tieGrid[row][end] && grid[row][end + 1]) end++;
  return end - step + 1;
}

// A step is a note START unless it continues a tie from the previous step.
function isNoteStart(row, step) {
  return (
    grid[row][step] > 0 &&
    !(step > 0 && tieGrid[row][step - 1] && grid[row][step - 1] > 0)
  );
}

engine.getNotesForStep = (step) => {
  const notes = [];
  for (let row = 0; row < ROWS; row++) {
    if (isNoteStart(row, step)) {
      notes.push({
        midi: rowNotes[row],
        velocity: VEL[grid[row][step]],
        durSteps: noteLength(row, step),
      });
    }
  }
  return notes;
};
engine.getDrumsForStep = (step) => {
  const hits = [];
  for (let row = 0; row < DRUM_ROWS; row++) {
    if (drumGrid[row][step]) {
      hits.push({ id: DRUMS[row].id, velocity: VEL[drumGrid[row][step]] });
    }
  }
  return hits;
};

// ---- Grid UI --------------------------------------------------------------

function buildGridUI(el, rows, kind, labelFor) {
  const cells = [];
  for (let row = 0; row < rows; row++) {
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

// Re-render every visible cell for the current page (cheap: ~320 nodes).
function renderView() {
  for (const kind of ["melody", "drum"]) {
    const g = gridFor(kind);
    const cells = cellsFor(kind);
    for (let row = 0; row < cells.length; row++) {
      for (let col = 0; col < VIEW_COLS; col++) {
        const step = stepOf(col);
        const el = cells[row][col];
        const value = g[row][step];
        el.classList.toggle("on", value > 0);
        el.classList.toggle("accent", value === 2);
        if (kind === "melody") {
          const tiedRight =
            value > 0 &&
            tieGrid[row][step] &&
            step + 1 < patternLength &&
            g[row][step + 1] > 0;
          const tiedLeft =
            value > 0 && step > 0 && tieGrid[row][step - 1] && g[row][step - 1] > 0;
          el.classList.toggle("tie-right", tiedRight);
          el.classList.toggle("tie-left", tiedLeft);
        }
      }
    }
  }
}

function refreshMelodyTooltips() {
  for (let row = 0; row < ROWS; row++) {
    for (const cell of cellEls[row]) cell.title = midiNoteName(rowNotes[row]);
  }
}

function previewCell(kind, row, step) {
  if (kind === "drum") {
    engine.previewDrum(DRUMS[row].id, VEL[drumGrid[row][step]]);
  } else {
    engine.preview(rowNotes[row], VEL[grid[row][step]], noteLength(row, step));
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
  if (step >= patternLength - 1) return;
  if (wantTie && !(grid[row][step] && grid[row][step + 1])) return;
  if (tieGrid[row][step] === wantTie) return;
  tieGrid[row][step] = wantTie;
  renderView();
  if (wantTie) previewCell("melody", row, step);
  saveState();
}

function applyDraw(info, value) {
  const g = gridFor(info.kind);
  if (!!g[info.row][info.step] === !!value) return;
  g[info.row][info.step] = value;
  renderView();
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
    paintMode = tieGrid[info.row][info.step] ? "untie" : "tie";
    applyTie(info.row, info.step, paintMode === "tie");
    return;
  }

  const g = gridFor(info.kind);
  const current = g[info.row][info.step];
  if (current > 0) {
    // Defer the toggle-off; a hold accents instead.
    paintMode = "erase";
    pendingOff = info;
    holdTimer = setTimeout(() => {
      holdTimer = null;
      pendingOff = null;
      painting = false;
      g[info.row][info.step] = current === 2 ? 1 : 2;
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
    if (next && next.step !== drawnStep) {
      drawnStep = next.step;
      const page = Math.floor(next.step / VIEW_COLS);
      if (page !== playingPage) {
        playingPage = page;
        updatePageTabs();
        if (follow && viewPage !== page) setViewPage(page, { keepFollow: true });
      }
      setPlayheadColumn(engine.playing ? next.step : -1);
    }
  }
  requestAnimationFrame(draw);
}

function setPlayheadColumn(step) {
  const col = step >= 0 ? step - viewPage * VIEW_COLS : -1;
  for (const kind of ["melody", "drum"]) {
    const cells = cellsFor(kind);
    const g = gridFor(kind);
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
    tabs[i].classList.toggle("playing", engine.playing && i === playingPage);
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
    drawnStep = -1;
    setPlayheadColumn(-1);
    updatePageTabs();
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

swingInput.addEventListener("input", () => {
  swing = +swingInput.value;
  engine.swing = swing / 100;
  swingLabel.textContent = `Swing ${swing}%`;
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

lengthSelect.addEventListener("change", () => {
  patternLength = +lengthSelect.value;
  engine.patternLength = patternLength;
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

document.getElementById("clear").addEventListener("click", () => {
  grid = emptyGrid(ROWS);
  drumGrid = emptyGrid(DRUM_ROWS);
  tieGrid = emptyGrid(ROWS, false);
  renderView();
  saveState();
});

document.getElementById("export").addEventListener("click", () => {
  const bytes = gridToMidi({
    melodyGrid: grid,
    tieGrid,
    rowNotes,
    drumGrid,
    drumNotes: drumMap,
    steps: patternLength,
    bpm,
    swing: swing / 100,
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
engine.swing = swing / 100;
engine.patternLength = patternLength;
bpmInput.value = bpm;
bpmLabel.textContent = `${bpm} BPM`;
swingInput.value = swing;
swingLabel.textContent = `Swing ${swing}%`;
rootSelect.value = rootIndex;
scaleSelect.value = scaleIndex;
lengthSelect.value = patternLength;
setTool("draw");
setFollow(true);
refreshMelodyTooltips();
rebuildPageTabs();
renderView();
renderDrumMap();
