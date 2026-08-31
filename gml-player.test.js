// Run with: node gml-player.test.js
// Exercise the player's timing repair and stroke measurement headlessly, so
// the numbers can be checked without a browser.
const fs = require('fs');
const vm = require('vm');

const sandbox = {
  window: {}, ResizeObserver: null, devicePixelRatio: 1,
  addEventListener() {}, removeEventListener() {},
  requestAnimationFrame() { return 0; }, cancelAnimationFrame() {}
};
sandbox.window = sandbox;
vm.createContext(sandbox);
const SRC = require('path').join(__dirname, 'gml-player.js');
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox);
const GmlPlayer = sandbox.GmlPlayer;

// Minimal canvas stub: the player only touches width/height/style and a 2d ctx.
function stubCanvas() {
  const noop = () => {};
  const ctx = new Proxy({}, { get: () => noop });
  return {
    getContext: () => ctx,
    style: {},
    clientWidth: 800, clientHeight: 600,
    parentNode: { clientWidth: 800, clientHeight: 600 }
  };
}

function build(data) {
  return new GmlPlayer(stubCanvas(), data);
}

function assert(cond, msg) {
  if (!cond) { console.error('FAIL ' + msg); process.exitCode = 1; }
  else console.log('  ok  ' + msg);
}

console.log('timing repair');
{
  // Three points 0.1s apart, a 73s pause, then three more 0.1s apart.
  const a = [[0, 0, 0], [0.1, 0, 0.1], [0.2, 0, 0.2]];
  const b = [[0.3, 0, 73.2], [0.4, 0, 73.3], [0.5, 0, 73.4]];
  const p = build({ strokes: [{ points: a }, { points: b }] });
  assert(p.timing.gapsClosed === 1, 'closes exactly the one long pause (got ' + p.timing.gapsClosed + ')');
  assert(Math.abs(p.duration - 0.8) < 1e-6, 'duration is 0.8s, not 73.4s (got ' + p.duration.toFixed(3) + ')');
}
{
  const p = build({ strokes: [{ points: [[0, 0, 0], [0.1, 0, 5], [0.2, 0, 3], [0.3, 0, 6]] }] });
  assert(p.timing.reordered === 1, 'counts the out-of-order sample');
  assert(p.duration > 0, 'still produces a usable duration');
}
{
  const p = build({ strokes: [{ points: [[0, 0, 0], [0.1, 0, 0], [0.2, 0, 0]] }] });
  assert(p.timing.synthesized === true, 'flags all-zero timing as synthesized');
  assert(Math.abs(p.duration - 2 / 60) < 1e-6, 'synthesizes 60Hz spacing');
}
{
  // Unix-epoch stamps in milliseconds.
  const base = 1362000000000;
  const p = build({ strokes: [{ points: [[0, 0, base], [0.1, 0, base + 100], [0.2, 0, base + 200]] }] });
  assert(Math.abs(p.duration - 0.2) < 1e-6, 'rebases absolute ms timestamps (got ' + p.duration + ')');
}

console.log('pauses between strokes are kept, in miniature');
{
  // Two strokes half a second apart: short enough to be the writer's rhythm.
  const p = build({ strokes: [
    { points: [[0, 0, 0], [0.1, 0, 0.1]] },
    { points: [[0.2, 0, 0.6], [0.3, 0, 0.7]] }
  ] });
  assert(p.timing.gapsClosed === 0, 'a 0.5s pause is not treated as a stall');
  assert(Math.abs(p.duration - 0.7) < 1e-6, 'real pause preserved (got ' + p.duration.toFixed(3) + ')');
}

console.log('velocity uses both axes');
{
  // Pure vertical movement. The old sqrt(pow(dx,2), pow(dy,2)) bug discarded
  // dy, so this stroke measured zero speed and drew at full width throughout.
  const p = build({ strokes: [{ points: [[0.5, 0, 0], [0.5, 0.4, 0.1], [0.5, 0.8, 0.2]] }] });
  assert(p.peakSpeed > 1, 'vertical stroke registers speed (got ' + p.peakSpeed.toFixed(2) + ')');
  const flat = p.strokes[0].width;
  // Held at one speed the line should hold one width. It used to open with a
  // blob, because the first sample had nothing to measure against and so read
  // as a dead stop.
  assert(Math.abs(flat[0] - flat[2]) < 1e-9, 'constant speed gives constant width');
}
{
  // Starts slow, ends fast.
  const p = build({ strokes: [{ points: [
    [0.5, 0.00, 0], [0.5, 0.02, 0.1], [0.5, 0.06, 0.2], [0.5, 0.30, 0.3], [0.5, 0.72, 0.4]
  ] }] });
  const w = p.strokes[0].width;
  assert(w[4] < w[1], 'accelerating stroke tapers thinner (' + w[1].toFixed(4) + ' -> ' + w[4].toFixed(4) + ')');
}

console.log('retuning');
{
  const p = build({ strokes: [{ points: [[0, 0, 0], [0.2, 0.2, 0.1], [0.5, 0.4, 0.2]] }] });
  const before = p.strokes[0].width[1];
  p.retune({ maxWidth: 0.2, minWidth: 0.15 });
  assert(p.strokes[0].width[1] > before, 'retune re-derives widths');
  p.retune(p.defaults());
  assert(Math.abs(p.strokes[0].width[1] - before) < 1e-9, 'reset restores the original brush');
}

console.log('bounds fit the drawing, not the capture screen');
{
  const p = build({ strokes: [{ points: [[0.8, 0.8, 0], [0.9, 0.9, 0.1]] }] });
  assert(Math.abs(p.bounds.x0 - 0.8) < 1e-6 && Math.abs(p.bounds.x1 - 0.9) < 1e-6, 'bbox tracks the strokes');
}

console.log('rotation');
{
  const p = build({ rotate: true, strokes: [{ points: [[0.25, 0.5, 0], [0.25, 0.5, 0.1]] }] });
  const q = p.strokes[0].points[0];
  assert(Math.abs(q[0] - 0.5) < 1e-6 && Math.abs(q[1] - 0.75) < 1e-6,
    'quarter turn maps (x,y) -> (y, 1-x) (got ' + q[0] + ',' + q[1] + ')');
}

console.log('progress lookup');
{
  // Kept inside one stroke and under MAX_STROKE_GAP, so these times survive.
  const p = build({ strokes: [{ points: [[0, 0, 0], [0.1, 0, 1], [0.2, 0, 2], [0.3, 0, 3]] }] });
  assert(Math.abs(p.duration - 3) < 1e-6, 'within-stroke rhythm is left alone');
  assert(p.progress(0)[0].count === 1, 'one point at t=0');
  assert(p.progress(1.5)[0].count === 2, 'two points at t=1.5');
  assert(Math.abs(p.progress(1.5)[0].partial - 0.5) < 1e-6, 'halfway between samples');
  assert(p.progress(99)[0].count === 4, 'all points past the end');
}
