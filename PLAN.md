# Plan

## Where we are

One parser, two renderers, four modules. `gml.js` is shared and pure.

- `gml.js` parses and prepares. Pure, no DOM, no canvas.
- `gml-player.js` paints and plays on a 2D canvas: 8 ink modes, 4 effects,
  6 data layers. This is what 000000book imports.
- `gml-ui.js` and `gml-ui.css` build the controls.
- `gml-three.js` is the optional WebGL dust renderer, after Evan Roth's 3D
  fork. It imports shared preparation code, but you supply `THREE`.
- `index.html` is the demo. It loads tags over JSONP and switches renderer
  with `?renderer=`.
- `test.js` runs under `node --test`.

## Merging the branches back, September 2026

Three long-lived branches were three copies of the same shared code, and
they drifted. The audit found the same bug in all three copies more than
once. So: one branch, one package, renderers as modules.

`native-3d` is retired, tagged `v6.1-native-3d`. It put time on the z axis
in pure 2D canvas, so all 8 ink modes worked in depth for 711 lines and no
dependency. The WebGL renderer looks and performs better, and the reasons to
keep both were about putting depth on a 000000book browse page, which is not
what 3D is for here. One look we like beats eight we do not.

Done. The steps, each one commit:

1. Bring `gml-3d.js` over as `gml-three.js`. `THREE` becomes the first
   constructor argument rather than a top-level import, so the module pulls
   in no three.js code on its own and an npm consumer supplies their own copy.
2. Fix its two live bugs: `uploadDust()` never runs on `load()` or `seek()`,
   so the GPU draws stale buffers; and a browser with no WebGL hangs on
   LOADING forever, because the constructor throws and nothing catches it.
3. Load three lazily in the demo with `await import()`, so a visitor who
   never picks WebGL pays none of its 167 KB. Keep it vendored at r160
   rather than fetched from a CDN: repo bytes cost nothing at runtime, and a
   CDN is a third-party request on every visit.
4. Decouple `gml-ui.js` from `gml-player.js`. It imports 5 constant arrays
   and drags the whole 2D painter into a WebGL page to get them. The
   renderer should advertise what it supports instead.
5. Fix the slice re-roll: `fade` cuts a stroke into slices and reruns the
   brush per slice, so spray, sketch and dyna re-roll their noise and ink
   already on screen changes shape. Seed off the absolute sample index.
6. `role="status"` on the loading overlay, and an error style that drops the
   caps and letter-spacing so a full sentence is readable.
7. Package metadata for importers: `main`, `sideEffects`, export
   `package.json`, three as an optional peer, vendor out of `files`.
8. One `index.html` with a renderer switch, replacing three near-identical
   copies. Redirect stubs keep the old sub-URLs alive.
9. One README with an API section written for someone importing rather than
   reading the demo. CLAUDE.md promises 3 modules; make it 3 plus 1
   optional. Fix the counts.
10. Pages workflow back to a single branch.

## Decisions to confirm

- Version is 7.0.0. `VIEWS` is gone, which is a named export removed, so by
  this project's own rule that is a major. `transport()` and `switches()`
  now return disposal functions rather than their host elements.
- The license field says Unlicense. The code says public domain, no rights
  reserved. Change it if you want CC0 instead.
- The name `canvasplayer` is free on npm.

## Next

1. `npm publish`. Needs your npm login. `prepublishOnly` runs the tests.
2. Add `Access-Control-Allow-Origin: *` to the JSON routes on 000000book.
   Then swap the demo's JSONP loader for `fetch`.
3. Replace the 2009 player in blackbook's `public/canvasplayer/` with these
   files. Drop `processing.min.js`, the `load_gml` callback and
   `iphone_rotate=1`. `isLandscape` makes that call on the client now.
   Fetch JSON from the same origin. Size the stage and dispose its controls
   and player on removal. Use one-shot `paint()` calls for browse thumbnails.
4. Maybe later: parse raw `.gml` XML in the browser with DOMParser. An SVG
   painter, if anyone needs one.

## Review fixes, 10 September 2026

- WebGL frames are capped at 0.1 s like the 2D player. Fed a whole
  background-tab gap, the field took every stroke crossed in that time at
  once and blew the dust off the tag on return. The skipped-backlog branch
  went with it.
- Dust uploads stop at the last woken particle instead of sending both full
  buffers every step. The ribbon's bent edge pair is restored only when the
  head moves to another pair.
- The spray cache keeps its prefix through a backwards seek or a shrinking
  fade slice and draws that frame plain, rather than being rebuilt. With
  fade on it was thrown away every few frames as the slice boundaries moved.
- Checked in headless Chromium against the committed renderer on tag 147 at
  the same clock: the same particles wake and travel the same distance.

## Review fixes, 9 September 2026

- Controls initialize from the current player, follow external setter changes
  and return idempotent disposal functions. Both players provide `off` and
  changed-only `config` events. Rounded clocks carry into the next second.
- Transparent 2D frames clear old ink. Every brush and WebGL now draws
  single-point tags. Completed non-looping 2D playback restarts; the graph
  playhead stays at the endpoint during the hold.
- Both players observe pixel density separately from parent layout.
  WebGL sets CSS dimensions independently of its backing buffer, renders
  paused loads immediately and removes input handlers on destruction.
- WebGL interpolates the ribbon and dust head through sparse samples,
  includes final segments and never injects pen-up jumps. Fixed simulation
  steps and time-based decay keep 30, 60, 120 and 144 Hz results consistent.
  Taper values of zero and one remain finite.
- Tag links preserve renderer and layout parameters, including when opened
  in a new tab. Package metadata keeps the stylesheet side-effectful.
- Spray caches native path prefixes without changing overlap opacity.
  Particle uploads no longer allocate coordinate arrays per particle, and
  ribbon updates upload only changed vertex pairs.
- Measured spray in headless Chromium at 560 by 560, with ghost and drips:
  median of three 20-frame batches. Tag 147 went from 2.27 to 0.26 ms per
  completed frame, and 1.69 to 0.70 ms while writing. A 10,000-point synthetic
  stroke went from 24.21 to 2.72 ms completed, and 17.11 to 11.65 ms writing.
  These are local draw-batch timings, not mobile frame-rate guarantees.
- All 24 pixel comparisons against uncached spray were identical across
  forward playback, seeks, bleed, jitter and fade. Focused regressions cover
  the rendering boundaries, simulation and disposal behavior.
- Added standalone examples for drawing a frame, mounting a player with
  disposable controls, and iframe embedding. They share bundled tag #100.
  Checked playback, seeking, removal and mobile layout in Chromium, plus
  cross-origin framing with and without a sandbox. README covers hosting
  policies and the absence of a cross-origin control API.

## Done, September 2026

- 4 more ink modes, each taken from something that already existed rather
  than invented: `spray` (the Gaussian that airbrush simulation has used
  since the 1980s), `outline` (how a writer blocks a piece out before
  filling it), `sketch` (Wood et al.'s sketchy rendering, by way of Handy
  and Rough.js), `dyna` (Haeberli's DynaDraw, 1989).
- The ghost is cached instead of redrawn every frame. It is the same picture
  all the way through a tag and cost more than the ink that was moving:
  2.8x fewer drawing calls, 2.5ms to 1.7ms on a default frame in a browser.
- Fixed the speed graph's label running off a wide frame, `pause()`
  announcing a state it was already in, and the demo hanging forever on a
  response that loads but never calls back.
- Split the 3D work onto its own branches, so this one has a single job
  again: `gml-player.js` is 1,033 lines rather than 1,662.

## Done, 1 September 2026

- Split `gml-player.js` and `gml-source.js` into `gml.js`, `gml-player.js`
  and `gml-ui.js` as ES modules.
- Drips planned once in `prepare`, each with a birth time. No reset on seek.
- Fixed a crash when a stroke has one point and drips are on.
- `package.json` with `exports` for the 3 modules and the stylesheet.
- README in Markdown with a header image made with Glif.
- Pages workflow runs `npm test`.
