# canvasplayer

GML playback on canvas. No build or dependencies.

- `gml.js`: parse and prepare. Pure. No DOM, no canvas.
- `gml-player.js`: `paint()` and `GmlPlayer`. The 2D canvas renderer.
- `gml-ui.js` and `gml-ui.css`: controls. They import neither renderer.
- `gml-three.js`: optional WebGL renderer. Shares preparation code but takes
  `THREE` as a constructor argument. The demo vendors r160; npm excludes it.
- `index.html`: demo, JSONP loader and page setup.
- `test.js`: `node --test`. No browser, no network.

## Rules

- Keep the module split. `gml.js` must stay free of DOM and canvas, and
  `gml-three.js` must never `import` three.
- No dependencies, bundler or TypeScript. three.js is an optional peer.
- Keep the "why" comments. They record real bugs in real tags.
- Run `npm test` before a commit.
- Check the demo with a static server: `python3 -m http.server 8420`.
  Modules do not load from `file://`.
- The public API is the named exports and the class names in `gml-ui.css`.
  Changing either is a breaking change.
- Use plain English, American spelling and short, active sentences.
  Keep the F.A.T. Lab sign-off.
