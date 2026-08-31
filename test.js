// Run with: node test.js
// Exercise the player's timing repair and stroke measurement, and the source's
// parser, headlessly, so the numbers can be checked without a browser.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const sandbox = {
  window: {}, ResizeObserver: null, devicePixelRatio: 1,
  addEventListener() {}, removeEventListener() {},
  requestAnimationFrame() { return 0; }, cancelAnimationFrame() {},
  document: { createElement: () => ({}), body: {} }
};
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const file of ['gml-player.js', 'gml-source.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), sandbox);
}
const GmlPlayer = sandbox.GmlPlayer;
const { parse, isLandscape } = sandbox.GmlSource;

function assert(cond, msg) {
  if (!cond) { console.error('FAIL ' + msg); process.exitCode = 1; }
  else console.log('  ok  ' + msg);
}

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

console.log('timing repair');
{
  // Three strokes: a half-second pause the writer meant, then a 72s stall.
  const p = build({ strokes: [
    { points: [[0, 0, 0], [0.1, 0, 0.1]] },
    { points: [[0.2, 0, 0.6], [0.3, 0, 0.7]] },
    { points: [[0.4, 0, 73.2], [0.5, 0, 73.3]] }
  ] });
  assert(p.timing.gapsClosed === 1, 'closes the stall and keeps the pause (got ' + p.timing.gapsClosed + ')');
  assert(Math.abs(p.duration - 1.2) < 1e-6, 'duration is 1.2s, not 73.3s (got ' + p.duration.toFixed(3) + ')');
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

console.log('bounds fit the drawing, not the capture screen');
{
  // A dead straight line collapses one axis, which would take the scale, and
  // every width derived from it, to zero.
  const p = build({ strokes: [{ points: [[0.5, 0.2, 0], [0.5, 0.8, 0.1]] }] });
  assert(Math.abs((p.bounds.x1 - p.bounds.x0) - 0.1) < 1e-6, 'a collapsed axis is padded open');
  assert(p.unit > 0, 'so the brush still has a size to scale against');
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

const pt = (x, y, t) => ({ x: String(x), y: String(y), time: String(t) });

console.log('shape');
{
  // One stroke with one point arrives as bare objects, not arrays.
  const d = parse({ tag: { drawing: { stroke: { pt: pt(0.5, 0.25, 0) } } } }, 1);
  assert(d.strokes.length === 1, 'a lone stroke becomes a one-element list');
  assert(d.strokes[0].points.length === 1, 'a lone point becomes a one-element list');
  assert(d.strokes[0].points[0][0] === 0.5, 'coordinates are parsed to numbers');
}
{
  const d = parse({ tag: { drawing: { stroke: [
    { pt: [pt(0, 0, 0), pt(1, 1, 1)] },
    { pt: [pt(0, 1, 2)] }
  ] } } }, 2);
  assert(d.strokes.length === 2, 'multiple strokes survive');
  assert(d.strokes[0].points.length === 2, 'multiple points survive');
}
{
  const d = parse({ tag: { drawing: { stroke: { pt: [pt(0.1, 0.1, 0), { x: 'nope', y: '0.2' }] } } } }, 3);
  assert(d.strokes[0].points.length === 1, 'unreadable coordinates are dropped');
}
{
  const d = parse({ tag: { drawing: {} } }, 4);
  assert(d.strokes.length === 0, 'a drawing with no strokes is empty, not a crash');
}

console.log('orientation');
{
  // From tag ~170 onward GML says which way was up.
  assert(isLandscape({ up: { x: '1', y: '0', z: '0' } }, []) === true,
    'up along +x means the device was sideways');
  assert(isLandscape({ up: { x: '0', y: '1', z: '0' } }, []) === false,
    'up along +y is already upright');
  assert(isLandscape({ up: { x: '0', y: '0', z: '0' } }, []) === false,
    'an all-zero vector is treated as absent');
}
{
  // Before that the element is missing, and the geometry has to answer it.
  // Both axes are normalized against the same edge, so y > 1 is the long edge
  // of a sideways screen measured in units of the short one.
  const sideways = [{ points: [[0.5, 0.4, 0], [0.5, 1.34, 1]] }];
  const upright = [{ points: [[0.5, 0.4, 0], [0.5, 0.63, 1]] }];
  assert(isLandscape({}, sideways) === true, 'y past 1 means the capture was sideways');
  assert(isLandscape({}, upright) === false, 'y inside 0..1 is upright');
  assert(isLandscape(null, upright) === false, 'no environment at all is upright');
  assert(isLandscape({ up: { x: '0', y: '1' } }, sideways) === false,
    'the vector wins over the geometry when it is there');
}
{
  // Tag 161 calls itself "katsu-4" because Graffiti Analysis 1.0 wrote the
  // tag's name into <client><name>, not the app's. Matching that name against
  // the Fat Tag Katsu iPhone app is what used to lay this tag on its side.
  const d = parse({ tag: {
    header: { client: { name: 'katsu-4' } },
    environment: { rotation: { x: '20', y: '6', z: '0' } },
    drawing: { stroke: { pt: [pt(0.203, 0.141, 0), pt(0.658, 0.631, 1)] } }
  } }, 161);
  assert(d.rotate === false, 'tag 161 stays upright despite being called katsu-4');
  assert(d.app === 'katsu-4', 'the client name is carried through');
}
{
  // Tag 147 is the other half of the same story: an empty <environment>, and
  // only the geometry to say it was captured sideways.
  const d = parse({ tag: {
    header: { client: { name: 'DustTag: Graffiti Analysis 2.0' } },
    drawing: { stroke: { pt: [pt(0.099, 0.16, 0), pt(0.997, 1.326, 1)] } }
  } }, 147);
  assert(d.rotate === true, 'tag 147, which has an empty <environment>, still rotates');
}

console.log('shapes the tree arrives in');
{
  // Tag 100 ships five <drawing> elements rather than one.
  const d = parse({ tag: { drawing: [
    { stroke: { pt: [pt(0, 0, 0), pt(1, 1, 1)] } },
    { stroke: { pt: [pt(0, 1, 2), pt(1, 0, 3)] } }
  ] } }, 100);
  assert(d.strokes.length === 2, 'strokes from every <drawing> are collected');
}
{
  const d = parse({ tag: [{ drawing: { stroke: { pt: pt(0.5, 0.5, 0) } } }] }, 7);
  assert(d.strokes.length === 1, 'a <tag> wrapped in an array still parses');
}
