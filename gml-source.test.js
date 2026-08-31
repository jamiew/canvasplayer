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

