/*
 * canvasplayer -- Graffiti Markup Language playback on a 2D canvas.
 *
 * by Jamie Wilkinson <https://jamiedubs.com> <https://github.com/jamiew>
 * Public domain, Free Art & Technology (F.A.T.) Lab. No rights reserved.
 *
 * Plays a tag back in real time, from the timestamps the capture app recorded.
 * No dependencies. Feed it the payload GmlSource builds, or the same shape
 * from anywhere else.
 *
 * This replaces the Processing.js sketch this repo carried from 2009, which:
 *
 * - advanced at most one point per frame, so a dense tag silently fell behind
 *   its own timeline. That is what the downsampling hack was working around
 * - derived stroke weight from `sqrt(pow(dimx,2), pow(dimy,2))`, and sqrt
 *   takes one argument, so the vertical component was discarded and width
 *   only ever tracked horizontal speed
 * - rotated landscape captures by `rotate(80)`, which Processing reads as 80
 *   radians rather than 80 degrees
 * - drew onto a fixed 800x580 canvas, so taller tags were cropped
 * - mapped normalized x and y straight onto canvas width and height. GML
 *   normalizes the two axes independently, so the capture screen's aspect has
 *   to be reapplied or every tag comes out squashed
 */

(function (global) {
  'use strict';

  // Diagnostic overlays, each independently switchable.
  var LAYERS = ['ink', 'drips', 'vectors', 'points', 'bounds', 'graph'];

  // How the ink itself is drawn. One at a time.
  var MODES = ['marker', 'hairline', 'outline', 'dots', 'spray', 'skeleton'];

  // Combinable treatments applied on top of whichever mode is active.
  var EFFECTS = ['glow', 'ghost', 'chromatic', 'jitter', 'fade'];

  var DEFAULTS = {
    // Stroke width, as a fraction of the artwork's on-screen size. A marker
    // lays down more ink the slower it travels, so speed maps to width
    // inversely.
    maxWidth: 0.052,
    minWidth: 0.014,
    // Fraction of this tag's peak speed that maps to the thinnest line.
    speedBias: 0.55,
    // How hard the width follows speed. Higher smooths out capture jitter.
    smoothing: 0.72,

    // Below this speed the pen counts as dwelling, and ink starts to pool.
    dwellSpeed: 0.14,
    dripLength: 1,

    hairline: 1.5,
    dotScale: 1,
    sprayDensity: 6,
    sprayScatter: 1.1,

    glow: 14,
    jitter: 0.9,
    chromatic: 3,
    fadeWindow: 1.6,
    ghostAlpha: 0.14,

    color: '#ffffff',
    background: '#000000',

    loop: true,
    loopDelay: 1400,
    speed: 1
  };

  // Longest pause kept as recorded, and what an over-long one is replaced with.
  // Samples inside a stroke land 10-40ms apart, so anything approaching these
  // is the capture stalling rather than the hand moving.
  var MAX_STROKE_GAP = 2.5;
  var MAX_STROKE_GAP_FILL = 0.4;
  var MAX_PAUSE = 1.2;
  var MAX_PAUSE_FILL = 0.4;

  var TAU = Math.PI * 2;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  /*
   * Stable pseudo-random in [0,1) from two integers. Spray and jitter need to
   * scatter, but a tag has to look the same every time it is played and every
   * time the panel repaints it, so this stands in for Math.random.
   */
  function noise(a, b) {
    var h = (a * 374761393 + b * 668265263) | 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  /*
   * Capture apps are inconsistent about time: some write zeroes, some write
   * unix epochs, some pause mid-tag and leave a minute-long gap, and a few
   * emit points out of order. Rather than silently smoothing that over we
   * repair it and record what was repaired, so debug mode can show it.
   */
  function repairTiming(strokes) {
    var report = { synthesized: false, reordered: 0, gapsClosed: 0, origin: 0 };
    var flat = [];
    strokes.forEach(function (s) { s.points.forEach(function (p) { flat.push(p); }); });
    if (!flat.length) return report;

    var times = flat.map(function (p) { return p[2]; });
    var first = times[0];
    var span = Math.max.apply(null, times) - Math.min.apply(null, times);

    // Some apps wrote wall-clock time instead of an offset from the first
    // sample. Tell seconds from milliseconds by magnitude, not by span: a short
    // tag has a small span either way.
    if (first > 1e6) {
      report.origin = first;
      var ms = first > 1e11;
      flat.forEach(function (p) {
        p[2] -= first;
        if (ms) p[2] /= 1000;
      });
      span = ms ? span / 1000 : span;
    }

    // No usable timing at all -- fall back to an even 60Hz so the tag still
    // draws, and say so rather than pretending the pacing is real.
    if (span <= 0) {
      report.synthesized = true;
      flat.forEach(function (p, i) { p[2] = i / 60; });
      return report;
    }

    // Rebuild the timeline from the gaps between samples rather than editing
    // timestamps in place: once a gap is closed the repaired clock no longer
    // lines up with the recorded one, so every later comparison has to be made
    // against the raw previous time, not the corrected one.
    //
    // Within a stroke the intervals are the gesture itself and are kept as
    // recorded. Between strokes they are the writer pausing, which is worth
    // keeping in miniature but not worth waiting through.
    var clock = 0;
    var prevEnd = null;
    strokes.forEach(function (stroke) {
      var pts = stroke.points;
      if (prevEnd !== null) {
        var pause = pts[0][2] - prevEnd;
        if (pause < 0) { pause = MAX_PAUSE_FILL; report.reordered++; }
        if (pause > MAX_PAUSE) { pause = MAX_PAUSE_FILL; report.gapsClosed++; }
        clock += pause;
      }
      var raw = pts[0][2];
      prevEnd = pts[pts.length - 1][2];
      for (var i = 0; i < pts.length; i++) {
        var dt = pts[i][2] - raw;
        raw = pts[i][2];
        if (i === 0) { pts[i][2] = clock; continue; }
        if (dt < 0) { dt = 0; report.reordered++; }
        if (dt > MAX_STROKE_GAP) { dt = MAX_STROKE_GAP_FILL; report.gapsClosed++; }
        clock += dt;
        pts[i][2] = clock;
      }
    });
    return report;
  }

  /*
   * Per-point speed and width, computed once up front.
   *
   * Width is scaled against this tag's own range rather than a fixed speed:
   * a big slow piece and a quick throw-up both want to read as marker work,
   * and what counts as "fast" is only meaningful relative to the rest of the
   * same hand.
   */
  function measure(strokes, opts) {
    var peak = 0;
    var i;

    strokes.forEach(function (stroke) {
      var pts = stroke.points;
      var smoothed = 0;
      stroke.speed = new Array(pts.length);
      for (var j = 1; j < pts.length; j++) {
        var dx = pts[j][0] - pts[j - 1][0];
        var dy = pts[j][1] - pts[j - 1][1];
        var dt = Math.max(pts[j][2] - pts[j - 1][2], 1 / 240);
        // The bug the old player had: both axes belong in here. It called
        // sqrt(pow(dx,2), pow(dy,2)), and sqrt takes one argument, so every
        // vertical stroke measured as motionless and drew at full width.
        var speed = Math.sqrt(dx * dx + dy * dy) / dt;
        smoothed = j === 1 ? speed : lerp(speed, smoothed, opts.smoothing);
        stroke.speed[j] = smoothed;
        if (smoothed > peak) peak = smoothed;
      }
      // The first sample has nothing to measure against. Reading that as a
      // dead stop made every stroke open with a full-width blob, so it
      // inherits the speed it was already travelling at.
      stroke.speed[0] = stroke.speed.length > 1 ? stroke.speed[1] : 0;
    });

    // Most of a stroke sits well under the peak, so mapping against the peak
    // alone would leave everything at full width. Bias to the busy part.
    var ceiling = Math.max(peak * opts.speedBias, 1e-4);
    strokes.forEach(function (stroke) {
      stroke.width = new Array(stroke.speed.length);
      for (i = 0; i < stroke.speed.length; i++) {
        var t = clamp(stroke.speed[i] / ceiling, 0, 1);
        stroke.width[i] = lerp(opts.maxWidth, opts.minWidth, Math.pow(t, 0.7));
      }
    });
    return peak;
  }

  function bounds(strokes) {
    var b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    strokes.forEach(function (s) {
      s.points.forEach(function (p) {
        if (p[0] < b.x0) b.x0 = p[0];
        if (p[1] < b.y0) b.y0 = p[1];
        if (p[0] > b.x1) b.x1 = p[0];
        if (p[1] > b.y1) b.y1 = p[1];
      });
    });
    if (!isFinite(b.x0)) return { x0: 0, y0: 0, x1: 1, y1: 1 };
    // Guard against a perfectly straight line collapsing an axis to zero.
    if (b.x1 - b.x0 < 1e-4) { b.x0 -= 0.05; b.x1 += 0.05; }
    if (b.y1 - b.y0 < 1e-4) { b.y0 -= 0.05; b.y1 += 0.05; }
    return b;
  }

  function GmlPlayer(canvas, data, options) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = Object.assign({}, DEFAULTS, options || {});
    this.layers = { ink: true, drips: true, vectors: false, points: false, bounds: false, graph: false };
    this.effects = { glow: false, ghost: false, chromatic: false, jitter: false, fade: false };
    this.mode = 'marker';
    this.playing = false;
    this.time = 0;
    this.drips = [];
    this.seeded = {};
    this.listeners = {};
    this.load(data);

    this.onResize = this.resize.bind(this);
    if (global.ResizeObserver) {
      this.observer = new ResizeObserver(this.onResize);
      this.observer.observe(canvas.parentNode || canvas);
    } else {
      global.addEventListener('resize', this.onResize);
    }
    this.resize();
  }

  GmlPlayer.prototype.on = function (name, fn) {
    (this.listeners[name] = this.listeners[name] || []).push(fn);
    return this;
  };

  GmlPlayer.prototype.emit = function (name, payload) {
    (this.listeners[name] || []).forEach(function (fn) { fn(payload); });
  };

  GmlPlayer.prototype.load = function (data) {
    this.data = data;
    this.strokes = (data.strokes || []).map(function (s) {
      return {
        color: s.color || null,
        drips: !!s.drips,
        points: s.points.map(function (p) { return [p[0], p[1], p[2]]; })
      };
    });

    if (data.rotate) {
      // Quarter turn for landscape captures: (x, y) -> (y, 1 - x).
      this.strokes.forEach(function (s) {
        s.points.forEach(function (p) {
          var x = p[0];
          p[0] = p[1];
          p[1] = 1 - x;
        });
      });
    }

    // GML normalizes x against the capture screen's width and y against its
    // height, independently. On a 480x320 phone that means one unit across is
    // 1.5x one unit down, so the screen ratio has to be put back or every tag
    // comes out squashed along one axis.
    var screen = data.screen || {};
    this.aspect = (screen.x > 0 && screen.y > 0) ? (screen.x / screen.y) : 1.5;
    if (data.rotate) this.aspect = 1 / this.aspect;

    this.timing = repairTiming(this.strokes);
    this.peakSpeed = measure(this.strokes, this.opts) || 1;
    this.bounds = bounds(this.strokes);
    this.pointCount = this.strokes.reduce(function (n, s) { return n + s.points.length; }, 0);

    var last = this.strokes[this.strokes.length - 1];
    this.duration = last ? last.points[last.points.length - 1][2] : 0;
    // A tag with no usable duration still needs a timeline to scrub.
    if (!(this.duration > 0)) this.duration = Math.max(this.pointCount / 60, 0.5);
    this.time = 0;
    this.drips = [];
    this.seeded = {};

    // Let the frame take the shape of the tag instead of boxing a wide throw-up
    // and a tall piece into the same rectangle. Clamped so one stray point
    // cannot stretch the page.
    var host = this.canvas.parentNode;
    if (host && host.style) {
      var shape = ((this.bounds.x1 - this.bounds.x0) * this.aspect) / (this.bounds.y1 - this.bounds.y0);
      host.style.aspectRatio = clamp(shape, 0.8, 2.4).toFixed(3);
    }
  };

  GmlPlayer.prototype.resize = function () {
    var host = this.canvas.parentNode || this.canvas;
    var w = Math.max(host.clientWidth || this.canvas.clientWidth, 1);
    var h = Math.max(host.clientHeight || this.canvas.clientHeight, 1);
    var dpr = Math.min(global.devicePixelRatio || 1, 2);

    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.w = w;
    this.h = h;
    this.dpr = dpr;

    // Fit the drawing's own bounds rather than the full 0..1 space, so tags
    // that only use a corner of the capture screen still fill the frame.
    var pad = 0.07;
    var bw = (this.bounds.x1 - this.bounds.x0) * this.aspect;
    var bh = this.bounds.y1 - this.bounds.y0;
    var scale = Math.min(w * (1 - pad * 2) / bw, h * (1 - pad * 2) / bh);

    this.sx = scale * this.aspect;
    this.sy = scale;
    this.scale = scale;
    this.ox = (w - bw * scale) / 2 - this.bounds.x0 * this.sx;
    this.oy = (h - bh * scale) / 2 - this.bounds.y0 * this.sy;

    // Stroke widths follow the size of the artwork on screen, not the size of
    // the viewport, so a tag looks the same in the grid and on its own page.
    this.unit = Math.sqrt(bw * scale * bh * scale);

    this.render();
  };

  GmlPlayer.prototype.px = function (x) { return this.ox + x * this.sx; };
  GmlPlayer.prototype.py = function (y) { return this.oy + y * this.sy; };

  /* How far through each stroke playback has reached, at time t. */
  GmlPlayer.prototype.progress = function (t) {
    return this.strokes.map(function (stroke) {
      var pts = stroke.points;
      if (t < pts[0][2]) return { count: 0, partial: 0 };
      if (t >= pts[pts.length - 1][2]) return { count: pts.length, partial: 0 };
      var lo = 0;
      var hi = pts.length - 1;
      while (lo < hi) {
        var mid = (lo + hi + 1) >> 1;
        if (pts[mid][2] <= t) lo = mid; else hi = mid - 1;
      }
      var span = pts[lo + 1][2] - pts[lo][2];
      return { count: lo + 1, partial: span > 0 ? (t - pts[lo][2]) / span : 0 };
    });
  };

  /*
   * Screen-space points for a slice of a stroke, as [x, y, width] triples.
   * `to` is exclusive. The leading edge is interpolated when playback is
   * partway between two samples, so the line grows smoothly rather than
   * jumping a whole sample at a time.
   */
  GmlPlayer.prototype.path = function (stroke, si, from, to, partial) {
    var pts = stroke.points;
    var out = [];
    var jitter = this.effects.jitter ? this.opts.jitter * this.unit * 0.012 : 0;

    for (var i = from; i < to; i++) {
      var jx = jitter ? (noise(si * 91 + i, 7) - 0.5) * jitter : 0;
      var jy = jitter ? (noise(si * 91 + i, 13) - 0.5) * jitter : 0;
      out.push([this.px(pts[i][0]) + jx, this.py(pts[i][1]) + jy, stroke.width[i] * this.unit]);
    }
    if (partial > 0 && to < pts.length && to > from) {
      var a = pts[to - 1];
      var b = pts[to];
      out.push([
        this.px(lerp(a[0], b[0], partial)),
        this.py(lerp(a[1], b[1], partial)),
        lerp(stroke.width[to - 1], stroke.width[to], partial) * this.unit
      ]);
    }
    return out;
  };

  /*
   * Fill the outline of a stroke as a ribbon: walk the centreline offsetting
   * by half the width along the normal, then walk back down the other side.
   * Filling that polygon gives a continuously tapering line, which stroking
   * with a per-segment lineWidth cannot.
   */
  GmlPlayer.prototype.ribbon = function (ctx, path, fill) {
    if (!path.length) return;

    if (path.length === 1) {
      ctx.beginPath();
      ctx.arc(path[0][0], path[0][1], path[0][2] / 2, 0, TAU);
      if (fill) ctx.fill(); else ctx.stroke();
      return;
    }

    var left = [];
    var right = [];
    var i;
    for (i = 0; i < path.length; i++) {
      var prev = path[Math.max(i - 1, 0)];
      var next = path[Math.min(i + 1, path.length - 1)];
      var tx = next[0] - prev[0];
      var ty = next[1] - prev[1];
      var len = Math.hypot(tx, ty) || 1;
      var r = path[i][2] / 2;
      left.push([path[i][0] + (-ty / len) * r, path[i][1] + (tx / len) * r]);
      right.push([path[i][0] - (-ty / len) * r, path[i][1] - (tx / len) * r]);
    }

    ctx.beginPath();
    ctx.moveTo(left[0][0], left[0][1]);
    for (i = 1; i < left.length; i++) ctx.lineTo(left[i][0], left[i][1]);
    for (i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i][0], right[i][1]);
    ctx.closePath();
    if (fill) ctx.fill(); else ctx.stroke();

    // Caps as their own discs rather than arcs spliced into the outline: an
    // arc between two computed angles picks its sweep direction from the sign
    // of the difference, and at a stroke's ends that is as likely to take the
    // long way round, which is what put a notch on every stroke.
    if (!fill) return;
    var ends = [path[0], path[path.length - 1]];
    for (i = 0; i < ends.length; i++) {
      ctx.beginPath();
      ctx.arc(ends[i][0], ends[i][1], ends[i][2] / 2, 0, TAU);
      ctx.fill();
    }
  };

  GmlPlayer.prototype.polyline = function (ctx, path, width) {
    if (path.length < 2) return;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(path[0][0], path[0][1]);
    for (var i = 1; i < path.length; i++) ctx.lineTo(path[i][0], path[i][1]);
    ctx.stroke();
  };

  GmlPlayer.prototype.dots = function (ctx, path) {
    for (var i = 0; i < path.length; i++) {
      ctx.beginPath();
      ctx.arc(path[i][0], path[i][1], Math.max(path[i][2] / 2 * this.opts.dotScale, 0.5), 0, TAU);
      ctx.fill();
    }
  };

  /* Particles scattered across the width of the line, thickest where slowest. */
  GmlPlayer.prototype.spray = function (ctx, path, si) {
    var density = Math.max(1, Math.round(this.opts.sprayDensity));
    for (var i = 1; i < path.length; i++) {
      var ax = path[i - 1][0];
      var ay = path[i - 1][1];
      var dx = path[i][0] - ax;
      var dy = path[i][1] - ay;
      var len = Math.hypot(dx, dy) || 1;
      var nx = -dy / len;
      var ny = dx / len;
      var r = path[i][2] / 2 * this.opts.sprayScatter;

      for (var k = 0; k < density; k++) {
        var along = noise(si * 131 + i, k * 3 + 1);
        // Bias toward the centre so the line still reads as a line.
        var across = (noise(si * 131 + i, k * 3 + 2) + noise(si * 131 + i, k * 3 + 5) - 1) * r;
        var size = 0.4 + noise(si * 131 + i, k * 3 + 7) * 1.4;
        // Squares, not circles: at two pixels across nobody can tell, and a
        // busy tag draws tens of thousands of these every frame.
        ctx.fillRect(ax + dx * along + nx * across - size, ay + dy * along + ny * across - size,
          size * 2, size * 2);
      }
    }
  };

  /* Centreline plus width ticks: the ribbon drawn as a technical diagram. */
  GmlPlayer.prototype.skeleton = function (ctx, path) {
    ctx.lineWidth = 1;
    this.polyline(ctx, path, 1);
    for (var i = 0; i < path.length; i += 2) {
      var prev = path[Math.max(i - 1, 0)];
      var next = path[Math.min(i + 1, path.length - 1)];
      var tx = next[0] - prev[0];
      var ty = next[1] - prev[1];
      var len = Math.hypot(tx, ty) || 1;
      var r = path[i][2] / 2;
      ctx.beginPath();
      ctx.moveTo(path[i][0] + (-ty / len) * r, path[i][1] + (tx / len) * r);
      ctx.lineTo(path[i][0] - (-ty / len) * r, path[i][1] - (tx / len) * r);
      ctx.stroke();
    }
  };

  GmlPlayer.prototype.drawStroke = function (ctx, stroke, si, from, to, partial) {
    var path = this.path(stroke, si, from, to, partial);
    if (!path.length) return;

    switch (this.mode) {
      case 'hairline':
        this.polyline(ctx, path, this.opts.hairline);
        break;
      case 'outline':
        ctx.lineWidth = 1;
        this.ribbon(ctx, path, false);
        break;
      case 'dots':
        this.dots(ctx, path);
        break;
      case 'spray':
        this.spray(ctx, path, si);
        break;
      case 'skeleton':
        this.skeleton(ctx, path);
        break;
      default:
        this.ribbon(ctx, path, true);
    }
  };

  /*
   * Ink for one frame. With the fade effect on, each stroke is drawn in slices
   * whose opacity falls off with age, so playback leaves a comet tail instead
   * of a finished drawing.
   */
  GmlPlayer.prototype.drawInk = function (ctx, t, progress) {
    var self = this;
    var stroked = this.mode === 'hairline' || this.mode === 'outline' || this.mode === 'skeleton';

    this.strokes.forEach(function (stroke, si) {
      var p = progress[si];
      if (!p.count) return;

      var paint = stroke.color || self.opts.color;
      ctx.fillStyle = paint;
      ctx.strokeStyle = paint;

      if (!self.effects.fade) {
        self.drawStroke(ctx, stroke, si, 0, p.count, p.partial);
        return;
      }

      // Slices overlap by one sample so the joins do not show as gaps.
      var pts = stroke.points;
      var slices = Math.max(1, Math.min(28, Math.ceil(p.count / 6)));
      var step = Math.ceil(p.count / slices);
      for (var from = 0; from < p.count; from += step) {
        var to = Math.min(from + step + 1, p.count);
        var age = t - pts[Math.min(to, pts.length) - 1][2];
        var alpha = clamp(1 - age / self.opts.fadeWindow, 0.04, 1);
        ctx.globalAlpha = alpha;
        self.drawStroke(ctx, stroke, si, from, to, to === p.count ? p.partial : 0);
      }
      ctx.globalAlpha = 1;
    });
    if (stroked) ctx.lineWidth = 1;
  };

  /*
   * Ink runs from two places: where the pen slowed enough to pool, and where a
   * stroke was lifted while still laying down a heavy line. Both are read out
   * of the capture data, so the same tag always drips in the same places.
   */
  GmlPlayer.prototype.seedDrips = function (t) {
    var self = this;
    var heavy = (this.opts.maxWidth + this.opts.minWidth) / 2;

    this.strokes.forEach(function (stroke, si) {
      var pts = stroke.points;
      var last = pts.length - 1;

      for (var i = 1; i < pts.length; i++) {
        if (pts[i][2] > t) break;
        var key = si + ':' + i;
        if (self.seeded[key]) continue;

        var dwelling = stroke.speed[i] < self.opts.dwellSpeed;
        var lifted = i === last && stroke.width[i] > heavy;
        if (!dwelling && !lifted) continue;
        self.seeded[key] = true;

        var pooled = lifted ? 1 : 1 - (stroke.speed[i] / self.opts.dwellSpeed);
        var dwell = pts[i][2] - pts[i - 1][2];
        self.drips.push({
          x: pts[i][0],
          y: pts[i][1],
          width: stroke.width[i] * 0.4,
          length: clamp(0.015 + dwell * 1.2 + pooled * 0.075, 0.015, 0.24),
          born: pts[i][2],
          // Staggered off the point index so neighbouring runs do not fall in
          // lockstep, but stably: the same tag drips the same way every time.
          fall: 0.8 + (i % 7) * 0.16
        });
      }
    });
  };

  GmlPlayer.prototype.drawDrips = function (ctx, t) {
    var self = this;
    ctx.fillStyle = this.opts.color;
    this.drips.forEach(function (d) {
      var age = t - d.born;
      if (age <= 0) return;
      // Ease out: a drip accelerates away from the pool then slows as it thins.
      var p = 1 - Math.pow(1 - clamp(age / d.fall, 0, 1), 2.2);
      var len = d.length * self.opts.dripLength * p;
      if (len <= 0) return;

      var x = self.px(d.x);
      var y0 = self.py(d.y);
      var y1 = self.py(d.y + len);
      var w = d.width * self.unit;

      ctx.beginPath();
      ctx.moveTo(x - w / 2, y0);
      ctx.quadraticCurveTo(x - w / 2, lerp(y0, y1, 0.72), x, y1);
      ctx.quadraticCurveTo(x + w / 2, lerp(y0, y1, 0.72), x + w / 2, y0);
      ctx.closePath();
      ctx.fill();

      // The bead of ink at the head of the run.
      ctx.beginPath();
      ctx.arc(x, y1, w * 0.5 * (1 - p * 0.35), 0, TAU);
      ctx.fill();
    });
  };

  /* --- debug layers ------------------------------------------------------ */

  GmlPlayer.prototype.drawBounds = function () {
    var ctx = this.ctx;
    var i;
    ctx.save();
    ctx.lineWidth = 1;

    // Normalized capture space, ticked every 0.1.
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.beginPath();
    for (i = 0; i <= 10; i++) {
      var g = i / 10;
      ctx.moveTo(this.px(g), this.py(0));
      ctx.lineTo(this.px(g), this.py(1));
      ctx.moveTo(this.px(0), this.py(g));
      ctx.lineTo(this.px(1), this.py(g));
    }
    ctx.stroke();

    // The capture screen itself.
    ctx.strokeStyle = 'rgba(255,255,255,0.24)';
    ctx.setLineDash([2, 3]);
    ctx.strokeRect(this.px(0), this.py(0), this.sx, this.sy);
    ctx.setLineDash([]);

    // What the tag actually occupies.
    var b = this.bounds;
    ctx.strokeStyle = '#f5ff00';
    ctx.strokeRect(this.px(b.x0), this.py(b.y0), (b.x1 - b.x0) * this.sx, (b.y1 - b.y0) * this.sy);

    // Pinned to the frame rather than to the box: anchored to the box it
    // landed either on the tag or on the speed graph, depending on the shape.
    ctx.fillStyle = '#f5ff00';
    ctx.font = '500 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(
      'BBOX ' + b.x0.toFixed(3) + ',' + b.y0.toFixed(3) + ' → ' + b.x1.toFixed(3) + ',' + b.y1.toFixed(3),
      8, 14
    );

    // Origin crosshair.
    ctx.strokeStyle = 'rgba(245,255,0,0.55)';
    ctx.beginPath();
    ctx.moveTo(this.px(0) - 7, this.py(0));
    ctx.lineTo(this.px(0) + 7, this.py(0));
    ctx.moveTo(this.px(0), this.py(0) - 7);
    ctx.lineTo(this.px(0), this.py(0) + 7);
    ctx.stroke();
    ctx.restore();
  };

  GmlPlayer.prototype.drawPoints = function (progress) {
    var ctx = this.ctx;
    var self = this;
    ctx.save();
    ctx.font = '500 9px ui-monospace, SFMono-Regular, Menlo, monospace';

    this.strokes.forEach(function (stroke, si) {
      var count = progress[si].count;
      if (!count) return;
      var pts = stroke.points;

      ctx.fillStyle = 'rgba(245,255,0,0.85)';
      for (var i = 0; i < count; i++) {
        ctx.fillRect(self.px(pts[i][0]) - 1, self.py(pts[i][1]) - 1, 2, 2);
      }

      // Where each stroke begins, numbered in capture order.
      ctx.fillStyle = '#f5ff00';
      ctx.beginPath();
      ctx.arc(self.px(pts[0][0]), self.py(pts[0][1]), 3, 0, TAU);
      ctx.fill();
      ctx.fillText('S' + String(si + 1).padStart(2, '0'), self.px(pts[0][0]) + 6, self.py(pts[0][1]) - 5);
    });
    ctx.restore();
  };

  GmlPlayer.prototype.drawVectors = function (progress) {
    var ctx = this.ctx;
    var self = this;
    ctx.save();
    ctx.lineWidth = 1;

    this.strokes.forEach(function (stroke, si) {
      var count = progress[si].count;
      if (count < 2) return;
      var pts = stroke.points;
      // Every 4th sample, or the overlay becomes a solid mat of arrows.
      for (var i = 1; i < count; i += 4) {
        var dx = pts[i][0] - pts[i - 1][0];
        var dy = pts[i][1] - pts[i - 1][1];
        var len = Math.hypot(dx, dy) || 1;
        var mag = clamp(stroke.speed[i] / self.peakSpeed, 0, 1);
        var reach = 6 + mag * 22;
        var x = self.px(pts[i][0]);
        var y = self.py(pts[i][1]);
        ctx.strokeStyle = 'rgba(245,255,0,' + (0.18 + mag * 0.5).toFixed(3) + ')';
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + (dx / len) * reach, y + (dy / len) * reach);
        ctx.stroke();
      }
    });
    ctx.restore();
  };

  /* Speed over the whole tag, with a playhead. Drawn along the bottom edge. */
  GmlPlayer.prototype.drawSpeedGraph = function (t) {
    var ctx = this.ctx;
    var h = 34;
    var y = this.h - h - 8;
    var self = this;

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(8, y + h);
    ctx.lineTo(this.w - 8, y + h);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(245,255,0,0.75)';
    ctx.beginPath();
    var started = false;
    this.strokes.forEach(function (stroke) {
      stroke.points.forEach(function (p, i) {
        var gx = 8 + (p[2] / self.duration) * (self.w - 16);
        var gy = y + h - clamp(stroke.speed[i] / self.peakSpeed, 0, 1) * h;
        if (!started) { ctx.moveTo(gx, gy); started = true; } else ctx.lineTo(gx, gy);
      });
    });
    ctx.stroke();

    var px = 8 + (t / this.duration) * (this.w - 16);
    ctx.strokeStyle = '#f5ff00';
    ctx.beginPath();
    ctx.moveTo(px, y - 4);
    ctx.lineTo(px, y + h);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '500 9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText('SPEED', 8, y - 6);
    ctx.fillText(this.peakSpeed.toFixed(2) + ' u/s PEAK', this.w - 88, y - 6);
    ctx.restore();
  };

  /* --- compositing -------------------------------------------------------- */

  /*
   * Glow and chromatic split are applied to the finished ink as a whole rather
   * than to each stroke as it is drawn. Setting shadowBlur on the context
   * makes every fill pay for a blur, so spray mode -- which is thousands of
   * small arcs -- ground to a halt, and overlapping strokes stacked their
   * halos on top of each other. Rendering to an offscreen layer and
   * compositing once is both faster and more correct.
   */
  GmlPlayer.prototype.scratch = function (name, scale) {
    if (typeof document === 'undefined') return null;
    var key = '_' + name;
    var w = Math.max(Math.round(this.canvas.width * (scale || 1)), 1);
    var h = Math.max(Math.round(this.canvas.height * (scale || 1)), 1);
    var canvas = this[key] || (this[key] = document.createElement('canvas'));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return canvas;
  };

  GmlPlayer.prototype.layerContext = function () {
    var canvas = this.scratch('inkLayer');
    if (!canvas) return null;
    var g = canvas.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    return g;
  };

  /*
   * Recolour an already-drawn layer by filling through its own alpha.
   * 'copy' replaces the destination outright, so no separate clear is needed.
   */
  GmlPlayer.prototype.tinted = function (source, color) {
    var canvas = this.scratch('tintLayer');
    if (!canvas) return source;
    var g = canvas.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'copy';
    g.drawImage(source, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = color;
    g.fillRect(0, 0, canvas.width, canvas.height);
    return canvas;
  };

  /*
   * Put the finished ink on the canvas, through whichever of the two
   * whole-image effects are on.
   *
   * The split is resolved into its own layer before the glow is applied, so
   * the blur is paid for once. Drawing each of the three channels through
   * shadowBlur separately cost three full-canvas blurs a frame -- about 14ms
   * whatever the tag, which is most of a frame's budget spent on compositing.
   */
  GmlPlayer.prototype.compose = function (source) {
    var ctx = this.ctx;
    var self = this;
    var layer = source;

    if (this.effects.chromatic) {
      var canvas = this.scratch('fxLayer');
      if (canvas) {
        var g = canvas.getContext('2d');
        var off = this.opts.chromatic * this.dpr;
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.globalCompositeOperation = 'copy';
        g.clearRect(0, 0, canvas.width, canvas.height);
        g.globalCompositeOperation = 'lighter';
        [['#ff0040', -off], ['#00ff88', 0], ['#0080ff', off]].forEach(function (pass) {
          g.drawImage(self.tinted(source, pass[0]), pass[1], 0);
        });
        layer = canvas;
      }
    }

    ctx.save();
    // Composite in device pixels: the layer is already at that scale.
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    if (this.effects.glow) {
      // The halo is blurred at half resolution and scaled back up. A blur
      // costs in proportion to the pixels it covers, and nobody can see the
      // difference in something this soft -- at full size on a retina display
      // it was comfortably the most expensive thing in the frame. The crisp
      // layer then goes on top, so only the halo is ever approximate.
      var halo = this.scratch('glowLayer', 0.5);
      if (halo) {
        var hg = halo.getContext('2d');
        hg.setTransform(1, 0, 0, 1, 0, 0);
        hg.globalCompositeOperation = 'copy';
        hg.clearRect(0, 0, halo.width, halo.height);
        hg.globalCompositeOperation = 'source-over';
        hg.shadowColor = this.opts.color;
        hg.shadowBlur = this.opts.glow * this.dpr * 0.5;
        hg.drawImage(layer, 0, 0, halo.width, halo.height);
        hg.shadowBlur = 0;
        ctx.drawImage(halo, 0, 0, this.canvas.width, this.canvas.height);
      }
    }

    ctx.drawImage(layer, 0, 0);
    ctx.restore();
  };

  /* --- frame ------------------------------------------------------------- */

  GmlPlayer.prototype.render = function () {
    if (!this.strokes) return;
    var ctx = this.ctx;
    var t = this.time;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = this.opts.background;
    ctx.fillRect(0, 0, this.w, this.h);

    if (this.layers.bounds) this.drawBounds();

    var progress = this.progress(t);

    // Where the tag is going, held faintly under where it has got to. Drawn
    // straight to the canvas so the glow does not pick it up.
    if (this.layers.ink && this.effects.ghost) {
      var whole = this.strokes.map(function (s) { return { count: s.points.length, partial: 0 }; });
      ctx.save();
      ctx.globalAlpha = this.opts.ghostAlpha;
      this.drawInk(ctx, this.duration, whole);
      ctx.restore();
    }

    if (this.layers.drips) this.seedDrips(t);

    if (this.layers.ink || this.layers.drips) {
      var buffered = (this.effects.glow || this.effects.chromatic) && this.layerContext();
      var target = buffered || ctx;

      target.save();
      if (this.layers.ink) this.drawInk(target, t, progress);
      if (this.layers.drips) this.drawDrips(target, t);
      target.restore();

      if (buffered) this.compose(buffered.canvas);
    }

    if (this.layers.vectors) this.drawVectors(progress);
    if (this.layers.graph) this.drawSpeedGraph(t);
    if (this.layers.points) this.drawPoints(progress);

    this.emit('frame', this.stats(t, progress));
  };

  GmlPlayer.prototype.stats = function (t, progress) {
    var drawn = 0;
    var active = -1;
    var speed = 0;
    for (var i = 0; i < progress.length; i++) {
      drawn += progress[i].count;
      if (progress[i].count > 0 && progress[i].count < this.strokes[i].points.length) {
        active = i;
        speed = this.strokes[i].speed[progress[i].count - 1];
      }
    }
    var head = null;
    if (active >= 0) head = this.strokes[active].points[progress[active].count - 1];
    return {
      time: t,
      duration: this.duration,
      points: drawn,
      totalPoints: this.pointCount,
      stroke: active >= 0 ? active + 1 : this.strokes.length,
      strokes: this.strokes.length,
      speed: speed,
      peakSpeed: this.peakSpeed,
      head: head,
      drips: this.drips.length,
      timing: this.timing
    };
  };

  /* --- transport --------------------------------------------------------- */

  GmlPlayer.prototype.play = function () {
    if (this.playing) return this;
    this.playing = true;
    this.last = null;
    var self = this;

    var step = function (now) {
      if (!self.playing) return;
      if (self.last === null) self.last = now;
      var dt = Math.min((now - self.last) / 1000, 0.1) * self.opts.speed;
      self.last = now;
      self.time += dt;

      // Hold on the finished tag for a beat before starting over, so you get
      // to look at it.
      if (self.time >= self.duration + self.opts.loopDelay / 1000) {
        if (self.opts.loop) self.seek(0);
        else { self.time = self.duration; self.pause(); self.render(); return; }
      }
      self.render();
      self.raf = global.requestAnimationFrame(step);
    };
    this.raf = global.requestAnimationFrame(step);
    this.emit('state', { playing: true });
    return this;
  };

  GmlPlayer.prototype.pause = function () {
    this.playing = false;
    if (this.raf) global.cancelAnimationFrame(this.raf);
    this.emit('state', { playing: false });
    return this;
  };

  GmlPlayer.prototype.toggle = function () { return this.playing ? this.pause() : this.play(); };

  GmlPlayer.prototype.seek = function (t) {
    var next = clamp(t, 0, this.duration);
    // Drips are seeded as playback passes each dwell, so scrubbing backwards
    // has to throw away everything seeded after the new position.
    if (next < this.time) { this.drips = []; this.seeded = {}; }
    this.time = next;
    this.render();
    return this;
  };

  GmlPlayer.prototype.setLayer = function (name, on) {
    if (LAYERS.indexOf(name) === -1) return this;
    this.layers[name] = !!on;
    this.render();
    return this;
  };

  GmlPlayer.prototype.setEffect = function (name, on) {
    if (EFFECTS.indexOf(name) === -1) return this;
    this.effects[name] = !!on;
    this.render();
    return this;
  };

  GmlPlayer.prototype.setMode = function (name) {
    if (MODES.indexOf(name) === -1) return this;
    this.mode = name;
    this.render();
    return this;
  };

  GmlPlayer.prototype.setSpeed = function (rate) {
    this.opts.speed = rate;
    this.emit('speed', rate);
    return this;
  };

  /*
   * Change how the brush behaves and re-derive the stroke widths. Drips are
   * dropped rather than kept, because where ink pools depends on the dwell
   * threshold that may have just moved.
   */
  GmlPlayer.prototype.retune = function (changes) {
    Object.assign(this.opts, changes);
    this.peakSpeed = measure(this.strokes, this.opts) || 1;
    this.drips = [];
    this.seeded = {};
    this.render();
    this.emit('tune', this.opts);
    return this;
  };

  GmlPlayer.prototype.defaults = function () { return Object.assign({}, DEFAULTS); };

  GmlPlayer.prototype.destroy = function () {
    this.pause();
    if (this.observer) this.observer.disconnect();
    else global.removeEventListener('resize', this.onResize);
  };

  GmlPlayer.LAYERS = LAYERS;
  GmlPlayer.MODES = MODES;
  GmlPlayer.EFFECTS = EFFECTS;
  GmlPlayer.DEFAULTS = DEFAULTS;
  global.GmlPlayer = GmlPlayer;
}(window));
