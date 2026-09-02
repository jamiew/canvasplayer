# Plan

## Where we are

canvasplayer v6 is split into 3 modules and set up as an npm package. It is
not published yet.

- `gml.js` parses and prepares. Pure, no DOM.
- `gml-player.js` paints and plays.
- `gml-ui.js` and `gml-ui.css` build the controls.
- `index.html` is the demo. It loads tags over JSONP and uses all 3 modules.
- `test.js` runs under `node --test`. 36 tests pass.
- The demo was checked in a browser on desktop and mobile. No console errors.

## Decisions to confirm

- Version is 6.0.0. v5 was the last version noted in index.html.
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

## Done, 1 September 2026

- Split `gml-player.js` and `gml-source.js` into `gml.js`, `gml-player.js`
  and `gml-ui.js` as ES modules.
- Drips planned once in `prepare`, each with a birth time. No reset on seek.
- Fixed a crash when a stroke has one point and drips are on.
- `package.json` with `exports` for the 3 modules and the stylesheet.
- README in Markdown with a header image made with Glif.
- Pages workflow runs `npm test`.
