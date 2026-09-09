# Plan -- native-3d branch

This branch is the 2D canvas renderer with time as depth. `main` is the flat
renderer; `threejs-renderer` is the WebGL one. All three share `gml.js`.

## Where we are

canvasplayer on this branch is 3 ES modules and an npm package.

- `gml.js` parses and prepares. Pure, no DOM.
- `gml-player.js` paints and plays. 8 ink modes, 8 effects, 3 view options,
  6 data layers.
- `gml-ui.js` and `gml-ui.css` build the controls.
- `index.html` is the demo. It loads tags over JSONP and uses all 3 modules.
- `test.js` runs under `node --test`. 48 tests pass.
- The demo was checked in a browser on desktop and mobile. No console errors.

## Decisions to confirm

- Version is 6.1.0-native-3d, to say which renderer it is rather than to
  claim a release.
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
4. Maybe later: parse raw `.gml` XML in the browser with DOMParser. An SVG
   painter, if anyone needs one.

## Still different from the fork

The fork does not turn sideways captures upright, so it draws #147 on its
side. We do, which is most of what is left of the difference between the two.

Its trails shade from bright to nothing along their length. Canvas has no
per-vertex colour, so ours is 3 batched passes instead. Close, not the same.

## Done, 7 September 2026

- `depth` effect: each sample sits at z = when it was drawn, projected by
  hand. No dependency. Works with every mode, effect, drip and data layer.
  Drag to orbit, scroll to zoom, and it turns while it plays.
- 4 more ink modes, each taken from something that already existed rather
  than invented: `spray` (the Gaussian that airbrush simulation has used
  since the 1980s), `outline` (how a writer blocks a piece out before
  filling it), `sketch` (Wood et al.'s sketchy rendering, by way of Handy
  and Rough.js), `dyna` (Haeberli's DynaDraw, 1989).
- 2 more effects: `extrude` sweeps the drawing into a solid body, along the
  time axis when depth is on. `stereo` is a red and cyan anaglyph.
- `dust`: the fork's particle field, ported to the 2D canvas with its numbers
  intact. 15,552 particles on a 144x108 grid, trails and all, at 3.2ms and a
  locked 60fps. It needed no WebGL. State lives on the player, not in
  `paint()`, which stays a pure function of the clock.
- Measured in a browser at 1280x600, median time in the draw call:
  marker 1.7ms, spray 3.0ms, dust 3.2ms, stereo 3.3ms, extrude+depth 5.6ms.
  All hold 60fps. The fork, for the same dust, is 2.0ms and 742KB to our 61KB.
- Every mode and effect that existed before draws byte-identically. Checked
  by recording each coordinate the painter emits, old build against new,
  across 96 frames.
- The ghost is cached instead of redrawn every frame. It is the same picture
  all the way through a tag and cost more than the ink that was moving:
  2.8x fewer drawing calls on a default frame.
- Fixed drips losing their jitter offset, the speed graph's label running off
  a wide frame, `pause()` announcing a state it was already in, and the demo
  hanging forever on a response that loads but never calls back.

## Done, 1 September 2026

- Split `gml-player.js` and `gml-source.js` into `gml.js`, `gml-player.js`
  and `gml-ui.js` as ES modules.
- Drips planned once in `prepare`, each with a birth time. No reset on seek.
- Fixed a crash when a stroke has one point and drips are on.
- `package.json` with `exports` for the 3 modules and the stylesheet.
- README in Markdown with a header image made with Glif.
- Pages workflow runs `npm test`.
