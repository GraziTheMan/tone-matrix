// Shared note extraction for the MIDI and WAV exporters: flattens a list of
// pattern segments (played back to back) into note events on a global step
// timeline, merging tied melody runs and skipping muted rows and tracks.

// segments: [{ tracks: [{ grid, tieGrid }], drumGrid, steps }]
// Returns { melody: [{ track, step, durSteps, row, value }],
//           drums:  [{ step, row, value }], totalSteps }
export function collectSong(segments, { melodyAudible, drumAudible, trackAudible }) {
  const melody = [];
  const drums = [];
  let offset = 0;
  for (const seg of segments) {
    const { tracks, drumGrid, steps } = seg;
    for (let t = 0; t < tracks.length; t++) {
      if (trackAudible && !trackAudible[t]) continue;
      const { grid, tieGrid } = tracks[t];
      for (let row = 0; row < grid.length; row++) {
        if (!melodyAudible[row]) continue;
        let step = 0;
        while (step < steps) {
          if (!grid[row][step]) {
            step++;
            continue;
          }
          let end = step;
          while (end < steps - 1 && tieGrid[row][end] && grid[row][end + 1]) end++;
          melody.push({
            track: t,
            step: offset + step,
            durSteps: end - step + 1,
            row,
            value: grid[row][step],
          });
          step = end + 1;
        }
      }
    }
    for (let row = 0; row < drumGrid.length; row++) {
      if (!drumAudible[row]) continue;
      for (let step = 0; step < steps; step++) {
        if (drumGrid[row][step]) drums.push({ step: offset + step, row, value: drumGrid[row][step] });
      }
    }
    offset += steps;
  }
  return { melody, drums, totalSteps: offset };
}
