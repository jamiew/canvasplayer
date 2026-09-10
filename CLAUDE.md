# canvasplayer

GML playback on canvas. 4 ES modules, no build, no dependencies.

- `gml.js`: parse and prepare. Pure. No DOM, no canvas.
- `gml-player.js`: `paint()` and `GmlPlayer`. The 2D canvas renderer.
- `gml-ui.js` and `gml-ui.css`: controls. They import neither renderer.
- `gml-three.js`: `ThreePlayer`, the optional WebGL renderer. It imports
  nothing: `THREE` is the first constructor argument, so a consumer brings
  their own. `three.module.min.js` is vendored at r160 for the demo only and
  is not published.
- `index.html`: the demo on GitHub Pages. Its script is the JSONP loader and
  page glue. Nothing else lives there.
- `test.js`: `node --test`. No browser, no network.

## Rules

- Keep the module split. `gml.js` must stay free of DOM and canvas, and
  `gml-three.js` must never `import` three.
- No dependencies, no bundler, no TypeScript. three.js is an optional peer,
  which is not the same as a dependency.
- Keep the "why" comments. They record real bugs in real tags.
- Run `npm test` before a commit.
- Check the demo with a static server: `python3 -m http.server 8420`.
  Modules do not load from `file://`.
- The public API is the named exports and the class names in `gml-ui.css`.
  Changing either is a breaking change.
- Write in plain English. Short sentences. GOV.UK style. Keep the F.A.T. Lab
  sign-off.

See `PLAN.md` for what is next.
