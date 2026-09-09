# Plan

## Where we are

Three renderers, one parser, one branch each. `gml.js` is shared and pure.

| branch | renderer |
|---|---|
| `main` | flat 2D canvas: 8 ink modes, 4 effects, 6 data layers |
| `native-3d` | 2D canvas with time as depth, particle dust, extrude, anaglyph |
| `threejs-renderer` | WebGL, after Evan Roth's 3D fork |

Pages publishes all three from one workflow: main at the root, the others in
subfolders. No merging needed.

- `gml.js` parses and prepares. Pure, no DOM.
- `gml-player.js` paints and plays.
- `gml-ui.js` and `gml-ui.css` build the controls.
- `index.html` is the demo. It loads tags over JSONP and uses all 3 modules.
- `test.js` runs under `node --test`. 42 tests pass.

## Decisions to confirm

- Version is 6.1.0. Modes were only added to, so the API grew without
  breaking.
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
