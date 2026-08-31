// Run with: node gml-source.test.js
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const sandbox = { window: {}, document: { createElement: () => ({}), body: {} } };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'gml-source.js'), 'utf8'), sandbox);
const { parse, isLandscape } = sandbox.GmlSource;

function assert(cond, msg) {
  if (!cond) { console.error('FAIL ' + msg); process.exitCode = 1; }
  else console.log('  ok  ' + msg);
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
{
  const d = parse({ tag: {
    environment: { screenBounds: { x: '480', y: '320' } },
    drawing: { stroke: { pt: pt(0, 0, 0) } }
  } }, 5);
  assert(d.screen.x === 480 && d.screen.y === 320, 'screen bounds are read');
}

console.log('orientation');
{
  // From tag ~200 onward GML says which way was up.
  assert(isLandscape({ up: { x: '1', y: '0', z: '0' } }, 'Graffiti Analysis 2.0: DustTag') === true,
    'up along +x means the device was sideways');
  assert(isLandscape({ up: { x: '0', y: '1', z: '0' } }, 'Fat Tag - Katsu Edition') === false,
    'up along +y is already upright');
  assert(isLandscape({ up: { x: '0', y: '1', z: '0' } }, 'Graffiti Analysis 2.0: DustTag') === false,
    'the vector wins over the client name, which the same app contradicts either way');
}
{
  // Before that the element is missing entirely, so the name is all there is.
  assert(isLandscape({}, 'DustTag: Graffiti Analysis 2.0') === true,
    'no vector falls back to the name, for the oldest DustTag captures');
  assert(isLandscape(null, 'Fat Tag - Katsu Edition') === true,
    'no environment at all still falls back to the name');
  assert(isLandscape({}, 'Graffiti Analysis 2.0') === false,
    'desktop Graffiti Analysis was upright and must not be caught by the fallback');
  assert(isLandscape({}, 'Webmarker.me') === false, 'desktop clients are left alone');
  assert(isLandscape({ up: { x: '0', y: '0', z: '0' } }, 'Coding With Attitude GML Drawer') === false,
    'an all-zero vector is treated as absent, and the name does not match');
}
{
  const d = parse({ tag: {
    header: { client: { name: 'DustTag: Graffiti Analysis 2.0' } },
    drawing: { stroke: { pt: pt(0, 0, 0) } }
  } }, 147);
  assert(d.rotate === true, 'tag 147, which has an empty <environment>, still rotates');
  assert(d.app === 'DustTag: Graffiti Analysis 2.0', 'the client name is carried through');
}
