// Run with node --test. No browser or network required.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { progress, isLandscape } from './gml.js';
import { parse, prepare, fit, paint, GmlPlayer, EFFECTS, LAYERS } from './gml-player.js';
import { ThreePlayer } from './gml-three.js';
import { secs } from './gml-ui.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// The painter only touches methods and a few numeric properties.
function stubContext() {
  const noop = () => {};
  const state = { globalAlpha: 1, fillStyle: '#000', strokeStyle: '#000', lineWidth: 1 };
  const stack = [];
  state.save = () => stack.push({ ...state });
  state.restore = () => Object.assign(state, stack.pop());
  return new Proxy(state, {
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
    // sqrt(pow(dx,2), pow(dy,2)) ignored dy, making vertical strokes full-width.
    const p = prepare({ strokes: [{ points: [[0.5, 0, 0], [0.5, 0.4, 0.1], [0.5, 0.8, 0.2]] }] });
    assert.ok(p.peakSpeed > 1, 'vertical stroke registers speed (got ' + p.peakSpeed + ')');
    // Reuse the first segment's speed so constant motion starts at constant width.
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
    // A collapsed axis would reduce the scale and all stroke widths to zero.
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
    // Tag 161 stores its title in client.name. Treating "katsu-4" as the
    // iPhone app name wrongly rotated it.
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

// Injected THREE lets these tests exercise WebGL scene construction without a GPU.
function stubThree() {
  const vec = (x = 0, y = 0, z = 0) => ({ x, y, z, set(a, b, c) { this.x = a; this.y = b; this.z = c; return this; } });
  class BufferAttribute {
    constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; this.needsUpdate = false; }
    addUpdateRange() {}
    clearUpdateRanges() {}
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
    dispose() { this.disposed = true; }
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
  return Object.assign(new EventTarget(), {
    style: {}, clientWidth: 400, clientHeight: 300, parentNode: null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 })
  });
}

describe('ThreePlayer', () => {
  const tag = {
    strokes: [
      { points: Array.from({ length: 40 }, (_, i) => [0.2 + i / 80, 0.5 + Math.sin(i / 5) * 0.15, i * 0.05]) },
      { points: [[0.3, 0.2, 2.2], [0.7, 0.4, 2.6]] }
    ]
  };
  const build = () => new ThreePlayer(stubThree(), stubGlCanvas(), tag);

  test('keeps ribbon vertices finite at the one-sample taper boundary', () => {
    const p = new ThreePlayer(stubThree(), stubGlCanvas(), tag, { taper: 1 });
    for (const time of [0, 0.3, p.duration, 0.1]) {
      p.seek(time);
      p.meshes.forEach(m => {
        assert.ok(m.mesh.geometry.attributes.position.array.every(Number.isFinite), 'no NaN in the ribbon');
      });
    }
    p.destroy();
  });

  test('renders dabs and stationary strokes without invalid geometry or dust', () => {
    const p = new ThreePlayer(stubThree(), stubGlCanvas(), { strokes: [
      { points: [[0.5, 0.5, 0]] },
      { points: [[0.5, 0.5, 0.1], [0.5, 0.5, 0.2], [0.5, 0.5, 0.3], [0.5, 0.5, 0.4]] }
    ] });
    for (let i = 0; i < 60; i++) p.step(1 / 120);
    p.render();
    const dab = p.meshes[0].mesh.geometry;
    assert.equal(dab.drawRange.count, 6, 'a lone sample remains visible');
    const a = dab.attributes.position.array;
    assert.ok(Math.abs((a[3] - a[0]) * (a[7] - a[1])) > 0, 'the dab has area');
    for (const m of p.meshes) {
      assert.ok(m.mesh.geometry.attributes.position.array.every(Number.isFinite));
    }
    assert.equal(p.dotGeo.drawRange.count, 0, 'a stationary pen cannot stir the field');
    p.destroy();
  });

  test('keeps raw capture time and corrects orientation without changing the input', () => {
    const input = { id: 147, app: 'DustTag', rotate: true, strokes: [{
      points: [[0, 0.125, 4], [0.25, 0.375, 5], [0.5, 0.625, 5], [0.75, 0.875, 24]]
    }] };
    const original = structuredClone(input);
    const p = new ThreePlayer(stubThree(), stubGlCanvas(), input);
    // The repeated timestamp and long pause remain part of the capture.
    // Rotate (x, y) to (y, 1 - x), then sample all three coordinates.
    assert.deepEqual(p.meshes[0].pts, [
      [0.375, 0.75, 5], [0.4375, 0.6875, 4.625], [0.5, 0.625, 3.875],
      [0.5625, 0.5625, 3.6875], [0.875, 0.25, 24]
    ]);
    assert.equal(p.duration, 24, 'capture pauses are not shortened');
    assert.deepEqual(input, original, 'loading does not rotate or retime the caller’s data');
    p.destroy();
  });

  test('reveals a completed sample prefix even when cubic timestamps run backward', () => {
    const p = new ThreePlayer(stubThree(), stubGlCanvas(), { strokes: [{
      points: [[0, 0, 0], [1, 0, 1], [1, 1, 1], [0, 1, 20]]
    }] });
    // Cubic sample times are 1, 0.625, -0.125, -0.3125, 20.
    // Later low timestamps must not bypass the first, still-hidden sample.
    const geo = p.meshes[0].mesh.geometry;
    for (const [time, count] of [[0.8, 0], [1, 18], [19, 18], [20, 24], [0.8, 0]]) {
      p.seek(time);
      assert.equal(geo.drawRange.count, count, 'completed triangles at ' + time);
    }
    p.destroy();
  });

  test('shapes ribbon width from spatial motion rather than capture timestamps', () => {
    const p = new ThreePlayer(stubThree(), stubGlCanvas(), { strokes: [{
      points: [[0, 0, 0], [0.01, 0, 0.001], [1, 0, 1]]
    }] }, { taper: 1 });
    p.seek(p.duration);
    const width = i => {
      const a = p.meshes[0].mesh.geometry.attributes.position.array;
      return Math.hypot(a[i * 6] - a[i * 6 + 3], a[i * 6 + 1] - a[i * 6 + 4]);
    };
    assert.ok(width(1) > width(2) * 10, 'short steps stay thick even when their timestamps are close');
    p.destroy();
  });

  test('draws no dust until the field has been stepped', () => {
    // A fresh BufferGeometry draws its whole buffer, so an unstepped field
    // used to put every particle on screen at the origin.
    const p = build();
    assert.equal(p.dotGeo.drawRange.count, 0);
    assert.equal(p.trailGeo.drawRange.count, 0);
    p.destroy();
  });

  test('seeking back to the start clears the dust it had drawn', () => {
    const p = build();
    // The first injection records the head; later movement stirs the field.
    for (let i = 0; i < 40; i++) p.step(1 / 60);
    assert.ok(p.dotGeo.drawRange.count > 0, 'the field woke while playing');
    p.seek(0);
    assert.equal(p.dotGeo.drawRange.count, 0, 'and is empty again after a seek');
    p.destroy();
  });

  test('re-enabling dust follows the current head without replaying hidden loops', () => {
    const p = build().step(0.4).render();
    const clock = build().step(0.4);
    p.setEffect('dust', false);
    assert.equal(p.dots.visible, false);
    assert.equal(p.trails.visible, false);
    assert.equal(p.dotGeo.drawRange.count, 0);
    const hidden = p.duration + p.opts.holdSec + p.opts.fadeSec + 0.6;
    p.step(hidden).render();
    clock.step(hidden);
    assert.equal(p.time, clock.time, 'turning dust off does not change the loop clock');

    const fresh = build().seek(p.time);
    p.setEffect('dust', true);
    for (let i = 0; i < 20; i++) {
      p.step(1 / 60);
      fresh.step(1 / 60);
    }
    p.render();
    fresh.render();
    assert.equal(p.dots.visible, true);
    assert.equal(p.trails.visible, true);
    assert.equal(p.trailGeo.drawRange.count, fresh.trailGeo.drawRange.count);
    const count = fresh.trailGeo.drawRange.count * 3;
    assert.ok(count > 0, 'new head movement wakes dust after re-enabling');
    assert.deepEqual(p.trailPos.slice(0, count), fresh.trailPos.slice(0, count));
    p.destroy();
    fresh.destroy();
    clock.destroy();
  });

  test('publishes the new frame when a paused player loads another tag', () => {
    const p = build().step(0.6).render();
    assert.ok(p.dotGeo.drawRange.count > 0, 'the old tag has visible dust');
    p.step(1 / 120);
    const frames = [];
    p.on('frame', frame => frames.push(frame));
    p.load({ strokes: [{ points: [[0, 0, 0], [1, 1, 2]] }] });
    assert.deepEqual(frames, [{ time: 0, duration: 2 }]);
    assert.equal(p.dotGeo.drawRange.count, 0, 'loading removes the old tag’s dust');
    p.step(1 / 120);
    assert.equal(p.time, 0, 'loading discards a partial tick from the old tag');
    p.destroy();
  });

  test('a sampled moving stroke produces the same dust across display refresh rates', () => {
    const simulate = hz => {
      const p = new ThreePlayer(stubThree(), stubGlCanvas(), {
        strokes: [{ points: Array.from({ length: 41 }, (_, i) => [0.1 + i / 50, 0.1 + i / 50, i / 40]) }]
      }, { cols: 12, rows: 10 });
      for (let i = 0; i < hz; i++) p.step(1 / hz);
      const result = p.dotPos.slice(0, p.dotGeo.drawRange.count * 3);
      p.destroy();
      return result;
    };
    const expected = simulate(120);
    assert.ok(expected.length > 0, 'the moving head must wake particles');
    for (const hz of [30, 60, 144]) {
      const actual = simulate(hz);
      assert.equal(actual.length, expected.length, 'the same particles wake');
      assert.ok(actual.every((v, i) => near(v, expected[i], 1e-5)), 'the same elapsed time gives the same dust');
    }
  });

  test('moving dust leaves long origin trails that fall with the particles', () => {
    const p = new ThreePlayer(stubThree(), stubGlCanvas(), {
      strokes: [{ points: Array.from({ length: 41 }, (_, i) => [i / 40, i / 40, i / 40]) }]
    });
    for (let i = 0; i < 180; i++) p.step(1 / 120);
    const kicked = p.trailPos.slice(0, p.trailGeo.drawRange.count * 3);
    assert.ok(kicked.every(Number.isFinite));
    let farthest = 0;
    for (let i = 0; i < kicked.length; i += 6) {
      const distance = Math.hypot(kicked[i] - kicked[i + 3], kicked[i + 1] - kicked[i + 4]);
      if (distance > Math.hypot(kicked[farthest] - kicked[farthest + 3],
        kicked[farthest + 1] - kicked[farthest + 4])) farthest = i;
      assert.equal(kicked[i + 2], kicked[i + 5], 'the trail stays at its wake depth');
    }
    assert.ok(Math.hypot(kicked[farthest] - kicked[farthest + 3],
      kicked[farthest + 1] - kicked[farthest + 4]) > 0.1,
    'dust flies away from the ribbon instead of staying as dots on it');
    for (let i = 0; i < 180; i++) p.step(1 / 120);
    const falling = p.trailPos.slice(0, p.trailGeo.drawRange.count * 3);
    let sameParticle = -1;
    for (let i = 0; i < falling.length; i += 6) {
      if (falling[i + 3] === kicked[farthest + 3]
        && falling[i + 4] === kicked[farthest + 4]
        && falling[i + 5] === kicked[farthest + 5]) {
        sameParticle = i;
        break;
      }
    }
    assert.ok(sameParticle >= 0, 'the trail origin never follows the particle');
    assert.ok(falling[sameParticle + 1] < kicked[farthest + 1], 'awake particles fall in world space');
    p.destroy();
  });

  test('revealing and seeking preserve the already drawn ribbon surface', () => {
    const p = new ThreePlayer(stubThree(), stubGlCanvas(), { strokes: [{
      points: [[0, 0, 0], [1, 0, 1], [1, 1, 2], [0, 1, 3], [0, 0, 4]]
    }] }, { taper: 1 });
    const triangles = time => {
      p.seek(time);
      const geo = p.meshes[0].mesh.geometry;
      const positions = geo.attributes.position.array;
      const result = [];
      for (let i = 0; i < geo.drawRange.count; i += 3) {
        result.push(geo.index.slice(i, i + 3).map(j => Array.from(positions.slice(j * 3, j * 3 + 3))));
      }
      return result;
    };
    const before = triangles(1.3);
    assert.equal(before.length, 2, 'the first completed segment has two triangles');
    const [a, b, c] = before[0];
    assert.ok(Math.abs((b[0] - a[0]) * (c[1] - a[1])
      - (b[1] - a[1]) * (c[0] - a[0])) > 1e-8, 'the completed ink has area');
    assert.deepEqual(triangles(1.4), before, 'there is no interpolated leading triangle');
    for (const time of [1.6, 2.2, p.duration]) {
      const after = triangles(time);
      assert.deepEqual(after.slice(0, before.length), before,
        'completed triangles stay fixed at ' + time);
    }
    assert.deepEqual(triangles(1.3), before, 'a backward seek restores the same completed surface');
    p.destroy();
  });

  test('dust toggles preserve partial ticks while seeking discards them', () => {
    const p = build().step(1 / 120);
    p.setEffect('dust', false).step(1 / 120);
    assert.ok(near(p.time, 1 / 60), 'disabling dust does not lose half a tick');
    p.step(1 / 120).setEffect('dust', true).step(1 / 120);
    assert.ok(near(p.time, 2 / 60), 'enabling dust does not lose half a tick');
    p.step(1 / 120).seek(0.5).step(1 / 120);
    assert.equal(p.time, 0.5, 'a seek starts with a fresh tick');
    p.step(1 / 120);
    assert.ok(near(p.time, 0.5 + 1 / 60));
    p.destroy();
  });

  test('loops only past the end and discards loop overshoot, not a partial tick', () => {
    for (const duration of [1 / 60, 1.5 / 60]) {
      const p = new ThreePlayer(stubThree(), stubGlCanvas(), {
        strokes: [{ points: [[0, 0, 0], [1, 1, duration]] }]
      }, { holdSec: 0, fadeSec: 0 });
      p.step(1 / 60);
      assert.equal(p.time, 1 / 60, 'reaching the exact end does not loop yet');
      p.step(1.5 / 60);
      assert.equal(p.time, 0, 'the crossing tick resets to zero without carrying overshoot');
      p.step(0.5 / 60);
      assert.equal(p.time, 1 / 60, 'the unconsumed half tick survives the loop');
      p.destroy();
    }
  });

  test('resizing to portrait keeps the native camera distance and user zoom', () => {
    const canvas = stubGlCanvas();
    const p = new ThreePlayer(stubThree(), canvas, tag);
    const distance = () => Math.hypot(p.camera.position.x, p.camera.position.y, p.camera.position.z);
    canvas.clientWidth = 200;
    canvas.clientHeight = 600;
    p.resize();
    assert.ok(near(distance(), 2.7), 'portrait does not add a fitting multiplier');
    const wheel = Object.assign(new Event('wheel', { cancelable: true }), { deltaY: 100 });
    canvas.dispatchEvent(wheel);
    const zoomed = distance();
    assert.ok(zoomed > 2.7, 'wheel input changes the camera distance');
    canvas.clientWidth = 800;
    p.resize();
    assert.ok(near(distance(), zoomed), 'resizing does not change the chosen zoom');
    p.destroy();
  });

  test('a frame after a long gap advances by a capped step, not the gap', () => {
    const frames = [];
    const raf = globalThis.requestAnimationFrame;
    const caf = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = fn => frames.push(fn);
    globalThis.cancelAnimationFrame = () => {};
    try {
      const p = build().play();
      frames.shift()(1000);
      assert.ok(near(p.time, 1 / 60), 'the first frame advances by one native tick');
      frames.shift()(1016);
      const before = p.time;
      // A tab left in the background for a minute.
      frames.shift()(61016);
      assert.ok(near(p.time - before, 0.05), 'the clock advances by the capped three ticks');
      p.destroy();
    } finally {
      globalThis.requestAnimationFrame = raf;
      globalThis.cancelAnimationFrame = caf;
    }
  });

  test('a destroyed player cannot intercept input on its reused canvas', () => {
    const canvas = stubGlCanvas();
    canvas.style.touchAction = 'pan-y';
    const p = new ThreePlayer(stubThree(), canvas, tag);
    p.destroy();
    p.destroy();
    assert.equal(canvas.style.touchAction, 'pan-y');
    const frames = p.renderer.frames;
    const yaw = p.camera3.yaw;
    const wheel = new Event('wheel', { cancelable: true });
    wheel.deltaY = 10;
    canvas.dispatchEvent(wheel);
    assert.equal(wheel.defaultPrevented, false, 'destroyed input must not prevent page scrolling');
    const next = new ThreePlayer(stubThree(), canvas, tag);
    canvas.dispatchEvent(Object.assign(new Event('pointerdown'), { clientX: 0, clientY: 0 }));
    canvas.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 20, clientY: 0 }));
    canvas.dispatchEvent(new Event('pointerup'));
    assert.equal(p.camera3.yaw, yaw, 'the old camera does not move');
    assert.equal(p.renderer.frames, frames, 'the old renderer does not run');
    assert.ok(next.camera3.yaw > 0, 'the replacement still receives input');
    next.destroy();
  });

});

describe('fade slicing', () => {
  // Fade slice boundaries move as the stroke grows. Absolute sample indices
  // keep old ink fixed. This crosses a slice-size change from 6 to 7 samples.
  const tag = prepare({ strokes: [{ points: Array.from({ length: 210 },
    (_, i) => [0.2 + 0.6 * (i / 209), 0.5 + 0.18 * Math.sin(i / 9), i * 0.02]) }] });

  function geometry(mode, time) {
    const drawn = [];
    const ctx = new Proxy({ globalAlpha: 1, getTransform: () => ({ a: 1, d: 1 }) }, {
      get: (t, k) => (k in t ? t[k] : (...a) => {
        // Compare fixed edges, not caps at moving slice boundaries.
        if (k === 'moveTo' || k === 'lineTo') {
          drawn.push(a.map(v => v.toFixed(3)).join(','));
        }
      }),
      set: (t, k, v) => { t[k] = v; return true; }
    });
    paint(ctx, tag, { time, w: 400, h: 300, mode, effects: { ghost: false, fade: true }, layers: { ink: true } });
    return drawn;
  }

  test('dyna keeps written edges when fade slice boundaries move', () => {
    const before = geometry('dyna', 3.34);
    const after = new Set(geometry('dyna', 3.36));
    assert.ok(before.every(point => after.has(point)), 'all previously written edges remain fixed');
  });
});

describe('ribbon geometry', () => {
  // Like tag 100: a closed shape recorded as five widely separated corners.
  const tag = prepare({ strokes: [{ points: [
    [0, 0, 0], [1, 0, 1], [1, 1, 2], [0, 1, 3], [0, 0, 4]
  ] }] }, { minWidth: 0.02, maxWidth: 0.02 });
  const view = fit(tag.bounds, 400, 400);

  function draw(time, smooth, mode = 'marker') {
    const vertices = [];
    const caps = [];
    const ctx = stubContext();
    ctx.moveTo = ctx.lineTo = (x, y) => vertices.push([x, y]);
    ctx.arc = (x, y, r) => caps.push([x, y, r]);
    paint(ctx, tag, { time, w: 400, h: 400, mode, effects: { smooth }, layers: { ink: true } });
    return { vertices, caps };
  }

  test('only curves sparse marker and outline corners when smoothing is enabled', () => {
    for (const mode of ['marker', 'outline']) {
      const straight = draw(tag.duration, false, mode).vertices;
      const curved = draw(tag.duration, true, mode).vertices;
      const margin = view.unit * 0.02 / 2;
      assert.ok(straight.every(([x, y]) => x >= view.x(0) - margin && y >= view.y(0) - margin),
        mode + ' keeps the recorded straight sides');
      assert.ok(curved.some(([, y]) => y < view.y(0) - margin - 1),
        mode + ' can explicitly bow the path between corners');
    }
    const tip = draw(0.5, false).caps.at(-1);
    assert.ok(near(tip[0], view.x(0.5)) && near(tip[1], view.y(0)),
      'without smoothing the moving tip interpolates the recorded segment');
  });

  test('keeps written ribbon edges fixed as the head moves and crosses a sample', () => {
    for (const smooth of [false, true]) {
      const before = draw(0.75, smooth);
      const head = before.caps.at(-1);
      const written = before.vertices.filter(([x, y]) => Math.hypot(x - head[0], y - head[1]) > 20);
      for (const time of [0.9, 1, 1.25]) {
        const after = draw(time, smooth).vertices;
        assert.ok(written.every(([x, y]) => after.some(([ax, ay]) => near(x, ax) && near(y, ay))),
          'already written edges stay put with smooth=' + smooth + ' at ' + time);
      }
    }
  });

  test('Dyna reveals a fixed spring trajectory across sparse samples', () => {
    const before = draw(0.75, false, 'dyna');
    const written = [before.vertices[0], before.vertices.at(-1)];
    for (const time of [0.9, 1, 1.25]) {
      const after = draw(time, false, 'dyna').vertices;
      assert.ok(written.every(([x, y]) => after.some(([ax, ay]) => near(x, ax) && near(y, ay))),
        'the beginning of the ribbon stays fixed at ' + time);
    }
    assert.deepEqual(draw(0.75, false, 'dyna'), before, 'backwards seeking restores the same ink');
  });
});

describe('paint', () => {
  const tag = prepare({ strokes: [
    { points: Array.from({ length: 30 }, (_, i) => [0.1 + i / 40, 0.5 + Math.sin(i / 3) * 0.2, i * 0.03]) },
    { points: [[0.2, 0.2, 1.2], [0.6, 0.3, 1.5]] }
  ] });
  const all = names => Object.fromEntries(names.map(n => [n, true]));

  test('preserves the caller context state across effects and layers', () => {
    const ctx = stubContext();
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = '#123456';
    ctx.strokeStyle = '#abcdef';
    ctx.lineWidth = 7;
    paint(ctx, tag, { time: 0.5, w: 400, h: 300, effects: all(EFFECTS), layers: all(LAYERS) });
    assert.deepEqual(
      [ctx.globalAlpha, ctx.fillStyle, ctx.strokeStyle, ctx.lineWidth],
      [0.35, '#123456', '#abcdef', 7]
    );
  });

  // Supply a canvas layer to check that ghost opacity is applied once.
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

  // Playback does not change the full-tag ghost; redrawing it wasted frame time.
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

  test('resumes paused playback but restarts a completed non-looping tag', () => {
    const request = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
    const cancel = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame');
    let next;
    globalThis.requestAnimationFrame = fn => { next = fn; return 1; };
    globalThis.cancelAnimationFrame = () => { next = null; };
    const p = new GmlPlayer(stubCanvas(), {
      strokes: [{ points: [[0, 0, 0], [1, 1, 1]] }]
    }, { loop: false, loopDelay: 0 });
    try {
      p.seek(0.4).play();
      next(0);
      assert.equal(p.time, 0.4, 'a paused drawing resumes in place');
      p.pause().seek(p.duration).play();
      next(0);
      assert.equal(p.time, 0, 'a completed drawing starts again');
      next(50);
      assert.ok(near(p.time, 0.05));
    } finally {
      p.destroy();
      if (request) Object.defineProperty(globalThis, 'requestAnimationFrame', request);
      else delete globalThis.requestAnimationFrame;
      if (cancel) Object.defineProperty(globalThis, 'cancelAnimationFrame', cancel);
      else delete globalThis.cancelAnimationFrame;
    }
  });
});

describe('clock formatting', () => {
  test('carries rounded hundredths into the next second', () => {
    assert.equal(secs(0.994), '00.99');
    assert.equal(secs(0.995), '01.00');
    assert.equal(secs(1.999), '02.00');
    assert.equal(secs(99.999), '100.00');
  });
});
