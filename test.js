// Run with: node --test
// Exercises the parser, the timing repair and the measurements headlessly,
// and runs the painter against a stub context, so nothing here needs a
// browser or the network.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, prepare, progress, isLandscape } from './gml.js';
import { fit, paint, GmlPlayer, MODES, EFFECTS, LAYERS } from './gml-player.js';
import { ThreePlayer } from './gml-three.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// The painter only touches methods and a few numeric properties.
function stubContext() {
  const noop = () => {};
  return new Proxy({ globalAlpha: 1 }, {
    get: (t, k) => (k in t ? t[k] : noop),
    set: (t, k, v) => { t[k] = v; return true; }
  });
}

// A context that logs each drawing call with the alpha it was made at.
function loggingContext(log) {
  return new Proxy({ globalAlpha: 1, getTransform: () => ({ a: 2, d: 2 }) }, {
    get: (t, k) => (k in t ? t[k] : () => log.push([k, t.globalAlpha])),
    set: (t, k, v) => { t[k] = v; return true; }
  });
}

function stubCanvas() {
  const ctx = stubContext();
  return {
    getContext: () => ctx,
    style: {},
    clientWidth: 800, clientHeight: 600,
    parentNode: { clientWidth: 800, clientHeight: 600 }
  };
}

describe('prepare', () => {
  test('closes a stall between strokes and keeps a pause', () => {
    // Three strokes: a half-second pause the writer meant, then a 72s stall.
    const p = prepare({ strokes: [
      { points: [[0, 0, 0], [0.1, 0, 0.1]] },
      { points: [[0.2, 0, 0.6], [0.3, 0, 0.7]] },
      { points: [[0.4, 0, 73.2], [0.5, 0, 73.3]] }
    ] });
    assert.equal(p.timing.gapsClosed, 1);
    assert.ok(near(p.duration, 1.2), 'duration is 1.2s, not 73.3s (got ' + p.duration + ')');
  });

  test('counts out-of-order samples', () => {
    const p = prepare({ strokes: [{ points: [[0, 0, 0], [0.1, 0, 5], [0.2, 0, 3], [0.3, 0, 6]] }] });
    assert.equal(p.timing.reordered, 1);
    assert.ok(p.duration > 0);
  });

  test('synthesizes 60Hz spacing when every timestamp is zero', () => {
    const p = prepare({ strokes: [{ points: [[0, 0, 0], [0.1, 0, 0], [0.2, 0, 0]] }] });
    assert.equal(p.timing.synthesized, true);
    assert.ok(near(p.duration, 2 / 60));
  });

  test('rebases absolute millisecond timestamps', () => {
    const base = 1362000000000;
    const p = prepare({ strokes: [{ points: [[0, 0, base], [0.1, 0, base + 100], [0.2, 0, base + 200]] }] });
    assert.ok(near(p.duration, 0.2), 'got ' + p.duration);
  });

  test('measures speed on both axes', () => {
    // Pure vertical movement. The old sqrt(pow(dx,2), pow(dy,2)) bug discarded
    // dy, so this stroke measured zero speed and drew at full width throughout.
    const p = prepare({ strokes: [{ points: [[0.5, 0, 0], [0.5, 0.4, 0.1], [0.5, 0.8, 0.2]] }] });
    assert.ok(p.peakSpeed > 1, 'vertical stroke registers speed (got ' + p.peakSpeed + ')');
    // Held at one speed the line should hold one width. It used to open with
    // a blob, because the first sample had nothing to measure against.
    const w = p.strokes[0].width;
    assert.ok(near(w[0], w[2], 1e-9), 'constant speed gives constant width');
  });

  test('tapers thinner as the hand accelerates', () => {
    const p = prepare({ strokes: [{ points: [
      [0.5, 0.00, 0], [0.5, 0.02, 0.1], [0.5, 0.06, 0.2], [0.5, 0.30, 0.3], [0.5, 0.72, 0.4]
    ] }] });
    const w = p.strokes[0].width;
    assert.ok(w[4] < w[1], w[1] + ' -> ' + w[4]);
  });

  test('pads a collapsed axis open', () => {
    // A dead straight line collapses one axis, which would take the scale,
    // and every width derived from it, to zero.
    const p = prepare({ strokes: [{ points: [[0.5, 0.2, 0], [0.5, 0.8, 0.1]] }] });
    assert.ok(near(p.bounds.x1 - p.bounds.x0, 0.1));
  });

  test('gives a landscape capture a quarter turn', () => {
    const p = prepare({ rotate: true, strokes: [{ points: [[0.25, 0.5, 0], [0.25, 0.5, 0.1]] }] });
    const q = p.strokes[0].points[0];
    assert.ok(near(q[0], 0.5) && near(q[1], 0.75), '(x,y) -> (y, 1-x), got ' + q[0] + ',' + q[1]);
  });

  test('leaves the input alone', () => {
    const tag = { rotate: true, strokes: [{ points: [[0.25, 0.5, 5], [0.3, 0.5, 6]] }] };
    prepare(tag);
    assert.deepEqual(tag.strokes[0].points[0], [0.25, 0.5, 5]);
  });

  test('plans the same drips every time, each with a birth time', () => {
    const tag = { strokes: [{ points: Array.from({ length: 40 }, (_, i) => [i / 40, 0.5, i * 0.03]) }] };
    const a = prepare(tag);
    const b = prepare(tag);
    assert.ok(a.drips.length > 0, 'a 40-sample stroke runs somewhere');
    assert.deepEqual(a.drips, b.drips);
    a.drips.forEach(d => assert.ok(d.born >= 0 && d.born <= a.duration));
  });

  test('does not run from a lone point', () => {
    // A single sample has no dwell to measure. This used to throw.
    const p = prepare({ strokes: [{ points: [[0.5, 0.5, 0]] }] });
    assert.equal(p.drips.length, 0);
  });

  test('copes with no strokes at all', () => {
    const p = prepare({ strokes: [] });
    assert.equal(p.pointCount, 0);
    assert.ok(p.duration > 0, 'still has a timeline to scrub');
  });

  test('drops an empty stroke', () => {
    // The parser never makes one, but prepare() is public.
    const p = prepare({ strokes: [{ points: [] }, { points: [[0.5, 0.5, 0]] }] });
    assert.equal(p.strokes.length, 1);
    assert.equal(p.pointCount, 1);
  });

  test('survives a capture too long to spread', () => {
    // Math.max(...times) overflowed the stack on a tag this size.
    const points = Array.from({ length: 200000 }, (_, i) => [0.5, 0.5, i / 1000]);
    const p = prepare({ strokes: [{ points }] });
    assert.ok(near(p.duration, 199.999, 1e-3), 'timed from the last sample');
  });
});

describe('progress', () => {
  // Kept inside one stroke and under the stall limit, so these times survive.
  const p = prepare({ strokes: [{ points: [[0, 0, 0], [0.1, 0, 1], [0.2, 0, 2], [0.3, 0, 3]] }] });
  const at = t => progress(p.strokes, t)[0];

  test('within-stroke rhythm is left alone', () => assert.ok(near(p.duration, 3)));
  test('one point at t=0', () => assert.equal(at(0).count, 1));
  test('two points at t=1.5, halfway to the next', () => {
    assert.equal(at(1.5).count, 2);
    assert.ok(near(at(1.5).partial, 0.5));
  });
  test('all points past the end', () => assert.equal(at(99).count, 4));
});

describe('fit', () => {
  test('a collapsed axis still gives the brush a size', () => {
    const p = prepare({ strokes: [{ points: [[0.5, 0.2, 0], [0.5, 0.8, 0.1]] }] });
    assert.ok(fit(p.bounds, 800, 600).unit > 0);
  });

  test('centers the drawing and keeps one scale for both axes', () => {
    const v = fit({ x0: 0, y0: 0, x1: 1, y1: 0.5 }, 200, 200, 0);
    assert.ok(near(v.scale, 200));
    assert.ok(near(v.x(0.5), 100));
    assert.ok(near(v.y(0.25), 100));
  });
});

const pt = (x, y, t) => ({ x: String(x), y: String(y), time: String(t) });

describe('parse', () => {
  test('a lone stroke and a lone point arrive as bare objects', () => {
    const d = parse({ tag: { drawing: { stroke: { pt: pt(0.5, 0.25, 0) } } } }, 1);
    assert.equal(d.strokes.length, 1);
    assert.equal(d.strokes[0].points.length, 1);
    assert.equal(d.strokes[0].points[0][0], 0.5, 'coordinates are parsed to numbers');
  });

  test('multiple strokes and points survive', () => {
    const d = parse({ tag: { drawing: { stroke: [
      { pt: [pt(0, 0, 0), pt(1, 1, 1)] },
      { pt: [pt(0, 1, 2)] }
    ] } } }, 2);
    assert.equal(d.strokes.length, 2);
    assert.equal(d.strokes[0].points.length, 2);
  });

  test('unreadable coordinates are dropped', () => {
    const d = parse({ tag: { drawing: { stroke: { pt: [pt(0.1, 0.1, 0), { x: 'nope', y: '0.2' }] } } } }, 3);
    assert.equal(d.strokes[0].points.length, 1);
  });

  test('a drawing with no strokes is empty, not a crash', () => {
    assert.equal(parse({ tag: { drawing: {} } }, 4).strokes.length, 0);
  });

  test('strokes from every <drawing> are collected', () => {
    // Tag 100 ships five <drawing> elements rather than one.
    const d = parse({ tag: { drawing: [
      { stroke: { pt: [pt(0, 0, 0), pt(1, 1, 1)] } },
      { stroke: { pt: [pt(0, 1, 2), pt(1, 0, 3)] } }
    ] } }, 100);
    assert.equal(d.strokes.length, 2);
  });

  test('a <tag> wrapped in an array still parses', () => {
    assert.equal(parse({ tag: [{ drawing: { stroke: { pt: pt(0.5, 0.5, 0) } } }] }, 7).strokes.length, 1);
  });

  test('tag 161 stays upright despite being called katsu-4', () => {
    // Graffiti Analysis 1.0 wrote the tag's name into <client><name>, not
    // the app's. Matching that name against the Fat Tag Katsu iPhone app is
    // what used to lay this tag on its side.
    const d = parse({ tag: {
      header: { client: { name: 'katsu-4' } },
      environment: { rotation: { x: '20', y: '6', z: '0' } },
      drawing: { stroke: { pt: [pt(0.203, 0.141, 0), pt(0.658, 0.631, 1)] } }
    } }, 161);
    assert.equal(d.rotate, false);
    assert.equal(d.app, 'katsu-4', 'the client name is carried through');
  });

  test('tag 147, with an empty <environment>, still rotates', () => {
    const d = parse({ tag: {
      header: { client: { name: 'DustTag: Graffiti Analysis 2.0' } },
      drawing: { stroke: { pt: [pt(0.099, 0.16, 0), pt(0.997, 1.326, 1)] } }
    } }, 147);
    assert.equal(d.rotate, true);
  });
});

describe('isLandscape', () => {
  test('reads the up vector when there is one', () => {
    // From tag ~170 onward GML says which way was up.
    assert.equal(isLandscape({ up: { x: '1', y: '0', z: '0' } }, []), true, 'up along +x means sideways');
    assert.equal(isLandscape({ up: { x: '0', y: '1', z: '0' } }, []), false, 'up along +y is upright');
    assert.equal(isLandscape({ up: { x: '0', y: '0', z: '0' } }, []), false, 'all-zero is treated as absent');
  });

  test('falls back to the geometry', () => {
    // Both axes are normalized against the same edge, so y > 1 is the long
    // edge of a sideways screen measured in units of the short one.
    const sideways = [{ points: [[0.5, 0.4, 0], [0.5, 1.34, 1]] }];
    const upright = [{ points: [[0.5, 0.4, 0], [0.5, 0.63, 1]] }];
    assert.equal(isLandscape({}, sideways), true);
    assert.equal(isLandscape({}, upright), false);
    assert.equal(isLandscape(null, upright), false);
    assert.equal(isLandscape({ up: { x: '0', y: '1' } }, sideways), false, 'the vector wins over the geometry');
  });
});

/*
 * A stand-in for three.js, enough for gml-three.js to build its scene and
 * draw a frame. It is here at all because ThreePlayer takes THREE as an
 * argument rather than importing it, which is the only reason a WebGL
 * renderer can be tested with no browser and no GPU.
 */
function stubThree() {
  const vec = (x = 0, y = 0, z = 0) => ({ x, y, z, set(a, b, c) { this.x = a; this.y = b; this.z = c; return this; } });
  class BufferAttribute {
    constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; this.needsUpdate = false; }
  }
  class BufferGeometry {
    constructor() { this.attributes = {}; this.drawRange = { start: 0, count: Infinity }; }
    setAttribute(name, attr) { this.attributes[name] = attr; return this; }
    setIndex(index) { this.index = index; return this; }
    setDrawRange(start, count) { this.drawRange = { start, count }; return this; }
    dispose() { this.disposed = true; }
  }
  class Material {
    constructor(o = {}) { Object.assign(this, o); }
    dispose() { this.disposed = true; }
  }
  class Object3D {
    constructor(geometry, material) { this.geometry = geometry; this.material = material; }
  }
  class PerspectiveCamera {
    constructor(fov, aspect, near, far) {
      Object.assign(this, { fov, aspect, near, far });
      this.position = vec(); this.up = vec(0, 1, 0);
    }
    lookAt(x, y, z) { this.looked = [x, y, z]; }
    updateProjectionMatrix() {}
  }
  class WebGLRenderer {
    constructor(o) { this.canvas = o.canvas; this.frames = 0; }
    setClearColor() {} setPixelRatio(r) { this.pixelRatio = r; } setSize(w, h) { this.size = [w, h]; }
    render() { this.frames++; }
  }
  return {
    BufferAttribute, BufferGeometry, PerspectiveCamera, WebGLRenderer,
    Scene: class { constructor() { this.children = []; } add(o) { this.children.push(o); } remove(o) { this.children = this.children.filter(c => c !== o); } },
    Mesh: Object3D, Points: Object3D, LineSegments: Object3D,
    MeshBasicMaterial: Material, PointsMaterial: Material, LineBasicMaterial: Material,
    DoubleSide: 'double', AdditiveBlending: 'additive'
  };
}

function stubGlCanvas() {
  return {
    style: {}, clientWidth: 400, clientHeight: 300, parentNode: null,
    addEventListener() {}, removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 })
  };
}

describe('ThreePlayer', () => {
  const tag = {
    strokes: [
      { points: Array.from({ length: 40 }, (_, i) => [0.2 + i / 80, 0.5 + Math.sin(i / 5) * 0.15, i * 0.05]) },
      { points: [[0.3, 0.2, 2.2], [0.7, 0.4, 2.6]] }
    ]
  };
  const build = () => new ThreePlayer(stubThree(), stubGlCanvas(), tag);

  test('takes THREE as an argument and imports none of it', () => {
    const src = readFileSync(new URL('./gml-three.js', import.meta.url), 'utf8');
    assert.ok(!/^\s*import\s.*three/m.test(src), 'no import of three');
  });

  test('builds a scene and draws a frame', () => {
    const p = build();
    assert.ok(p.meshes.length > 0, 'a mesh per stroke');
    assert.ok(p.duration > 0);
    assert.equal(p.renderer.frames > 0, true);
  });

  test('every vertex it builds is a finite number', () => {
    const p = build();
    p.meshes.forEach(m => {
      const a = m.mesh.geometry.attributes.position.array;
      assert.ok(a.every(Number.isFinite), 'no NaN in the ribbon');
    });
  });

  test('draws no dust until the field has been stepped', () => {
    // A fresh BufferGeometry draws its whole buffer, so an unstepped field
    // used to put every particle on screen at the origin.
    const p = build();
    assert.equal(p.dotGeo.drawRange.count, 0);
    assert.equal(p.trailGeo.drawRange.count, 0);
  });

  test('seeking back to the start clears the dust it had drawn', () => {
    const p = build();
    // A few frames, not one: the first injection only records where the head
    // is, so nothing moves until it has somewhere to move from.
    for (let i = 0; i < 40; i++) p.step(1 / 60);
    assert.ok(p.dotGeo.drawRange.count > 0, 'the field woke while playing');
    p.seek(0);
    assert.equal(p.dotGeo.drawRange.count, 0, 'and is empty again after a seek');
  });

  test('offers the controls no modes it cannot draw', () => {
    const p = build();
    assert.deepEqual(p.capabilities.modes, []);
    assert.deepEqual(p.capabilities.layers, []);
  });
});

describe('fade slicing', () => {
  // fade cuts a stroke into slices to shade them, and the slice boundaries
  // move as the stroke grows. The brushes that read a sample index must read
  // the absolute one, or ink already on screen redraws itself differently.
  // 168 samples slice by 6, 169 by 7, so these two frames straddle a shift.
  const tag = prepare({ strokes: [{ points: Array.from({ length: 210 },
    (_, i) => [0.2 + 0.6 * (i / 209), 0.5 + 0.18 * Math.sin(i / 9), i * 0.02]) }] });

  function geometry(mode, time) {
    const drawn = [];
    const ctx = new Proxy({ globalAlpha: 1, getTransform: () => ({ a: 1, d: 1 }) }, {
      get: (t, k) => (k in t ? t[k] : (...a) => {
        // Rounded to a thousandth of a pixel: the claim is that drawn ink
        // does not visibly move, not that a filter reproduces bit for bit.
        if (k === 'moveTo' || k === 'lineTo' || k === 'arc') {
          drawn.push(k + a.map(v => typeof v === 'number' ? v.toFixed(3) : v).join(','));
        }
      }),
      set: (t, k, v) => { t[k] = v; return true; }
    });
    paint(ctx, tag, { time, w: 400, h: 300, mode, effects: { ghost: false, fade: true }, layers: { ink: true } });
    return drawn;
  }

  test('spray does not rescatter its grit when a slice boundary moves', () => {
    const before = geometry('spray', 3.34);
    const after = new Set(geometry('spray', 3.36));
    const kept = before.filter(g => after.has(g)).length;
    // Was 19% when the noise was seeded off the index within the slice.
    assert.equal(kept, before.length, 'every dot already sprayed stays put');
  });

  test('sketch and dyna mostly hold their shape across the same shift', () => {
    for (const mode of ['sketch', 'dyna']) {
      const before = geometry(mode, 3.34);
      const after = new Set(geometry(mode, 3.36));
      const kept = before.filter(g => after.has(g)).length / before.length;
      // Not 1: both read their neighbors, so the samples at a slice edge
      // still move. Was 0.12 and 0.11 before the absolute seed and the
      // dyna warm-up.
      assert.ok(kept > 0.5, mode + ' held ' + kept.toFixed(2));
    }
  });
});

describe('paint', () => {
  const tag = prepare({ strokes: [
    { points: Array.from({ length: 30 }, (_, i) => [0.1 + i / 40, 0.5 + Math.sin(i / 3) * 0.2, i * 0.03]) },
    { points: [[0.2, 0.2, 1.2], [0.6, 0.3, 1.5]] }
  ] });
  const all = names => Object.fromEntries(names.map(n => [n, true]));

  for (const mode of MODES) {
    test('draws ' + mode + ' with every effect and layer on', () => {
      const ctx = stubContext();
      for (const time of [0, 0.5, tag.duration, tag.duration + 5]) {
        paint(ctx, tag, { time, w: 400, h: 300, mode, effects: all(EFFECTS), layers: all(LAYERS) });
      }
      assert.equal(ctx.globalAlpha, 1, 'leaves the context as it found it');
    });
  }

  test('draws an empty tag', () => {
    paint(stubContext(), prepare({ strokes: [] }), { w: 100, h: 100 });
  });

  // Node has no canvas, so the tests above take the fallback. This stands a
  // layer in to check the ghost goes down once, at one alpha.
  test('lays the ghost down once, not as translucent fills that stack', () => {
    const layers = [];
    const onLayer = [];
    globalThis.OffscreenCanvas = class {
      constructor() { this.ctx = loggingContext(onLayer); this.ctx.canvas = this; layers.push(this); }
      getContext() { return this.ctx; }
    };
    try {
      const onFrame = [];
      const ctx = loggingContext(onFrame);
      const frame = { w: 400, h: 300, effects: { ghost: true }, layers: { ink: true }, opts: { ghostAlpha: 0.2 } };
      paint(ctx, tag, frame);

      const drawn = onFrame.filter(([k]) => k === 'fill' || k === 'stroke' || k === 'drawImage');
      assert.deepEqual(drawn.filter(([k]) => k === 'drawImage').map(([, a]) => a), [0.2], 'one image at ghostAlpha');
      assert.ok(drawn.every(([k, a]) => k === 'drawImage' || a === 1), 'the ink itself at full alpha');
      assert.ok(onLayer.some(([k]) => k === 'fill'), 'the ghost was drawn on the layer');
      assert.deepEqual([layers[0].width, layers[0].height], [800, 600], 'sized to the frame at its scale');

      paint(ctx, tag, frame);
      assert.equal(layers.length, 1, 'one layer per context, kept between frames');
    } finally {
      delete globalThis.OffscreenCanvas;
    }
  });

  // The ghost is the whole tag at full length, so playing does not change
  // it. Redrawing it every frame cost more than the ink that was moving.
  test('draws the ghost once, then keeps it until the picture changes', () => {
    const onLayer = [];
    globalThis.OffscreenCanvas = class {
      constructor() { this.ctx = loggingContext(onLayer); this.ctx.canvas = this; }
      getContext() { return this.ctx; }
    };
    try {
      const ctx = loggingContext([]);
      const frame = { w: 400, h: 300, effects: { ghost: true }, layers: { ink: true } };
      const fills = () => onLayer.filter(([k]) => k === 'fill').length;

      paint(ctx, tag, { ...frame, time: 0 });
      const once = fills();
      assert.ok(once > 0, 'drawn on the first frame');

      for (let i = 1; i <= 20; i++) paint(ctx, tag, { ...frame, time: i * 0.1 });
      assert.equal(fills(), once, 'and not again while only the time moves');

      paint(ctx, tag, { ...frame, time: 0, mode: 'chisel' });
      assert.ok(fills() > once, 'a change of mode is a new picture');
    } finally {
      delete globalThis.OffscreenCanvas;
    }
  });
});

describe('GmlPlayer', () => {
  test('starts empty and takes a tag later', () => {
    const player = new GmlPlayer(stubCanvas());
    assert.equal(player.tag.pointCount, 0);
    const loaded = [];
    player.on('load', t => loaded.push(t.pointCount));
    player.load({ strokes: [{ points: [[0, 0, 0], [0.5, 0.5, 1]] }] });
    assert.deepEqual(loaded, [2]);
    assert.ok(near(player.duration, 1));
  });

  test('clamps seek to the tag', () => {
    const player = new GmlPlayer(stubCanvas(), { strokes: [{ points: [[0, 0, 0], [0.5, 0.5, 2]] }] });
    assert.equal(player.seek(99).time, 2);
    assert.equal(player.seek(-1).time, 0);
  });

  test('ignores a mode, effect or layer it does not know', () => {
    const player = new GmlPlayer(stubCanvas());
    player.setMode('crayon').setEffect('glow', true).setLayer('grid', true);
    assert.equal(player.mode, 'marker');
    assert.equal(player.effects.glow, undefined);
    assert.equal(player.layers.grid, undefined);
  });
});
