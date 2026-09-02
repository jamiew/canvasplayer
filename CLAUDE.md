# canvasplayer

GML playback on canvas. 3 ES modules, no build, no dependencies.

- `gml.js`: parse and prepare. Pure. No DOM, no canvas.
- `gml-player.js`: `paint()` and `GmlPlayer`.
- `gml-ui.js` and `gml-ui.css`: controls.
- `index.html`: the demo on GitHub Pages. Its script is the JSONP loader and
  page glue. Nothing else lives there.
- `test.js`: `node --test`. No browser, no network.

## Rules

- Keep the 3-module split. `gml.js` must stay free of DOM and canvas.
- No dependencies, no bundler, no TypeScript.
- Keep the "why" comments. They record real bugs in real tags.
- Run `npm test` before a commit.
- Check the demo with a static server: `python3 -m http.server 8420`.
  Modules do not load from `file://`.
- The public API is the named exports and the class names in `gml-ui.css`.
  Changing either is a breaking change.
- Write in plain English. Short sentences. GOV.UK style. Keep the F.A.T. Lab
  sign-off.

See `PLAN.md` for what is next.
