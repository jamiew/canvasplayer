# canvasplayer v6: on npm, in pieces

canvasplayer plays graffiti tags in the browser. The tags are GML files from
#000000book, the open database we started at F.A.T. Lab in 2009. Each tag is
a list of points with times. The player draws them back at the speed the hand
moved.

The first version was a Processing.js sketch. This year I dropped
Processing.js and rewrote it on plain canvas. It got drips, 4 ink modes, 4
effects and 6 debug layers. It was still one 1,000-line file bolted to a demo
page.

## What changed

Version 6 splits it into 3 modules.

- `gml.js` reads a tag and gets it ready. It fixes bad timing, measures speed
  and width, and plans the drips. It has no DOM and no canvas. Use it to draw
  GML with anything: SVG, WebGL, a plotter.
- `gml-player.js` draws. `paint()` draws one frame on any 2D context.
  `GmlPlayer` wraps that in a canvas with a clock.
- `gml-ui.js` builds controls: play, scrub, speed, and switches for the
  modes, effects and layers.

The split made the code simpler. Drips are now planned once, up front, each
with a birth time. The painter asks which ones exist yet. Seeking backwards
no longer throws anything away. A stroke with one point used to crash the
drip planner. It does not now.

It ships on npm as `canvasplayer`. No build step. Copy the 4 files if you
would rather not use npm.

## Use it

    import { parse } from 'canvasplayer/gml';
    import { GmlPlayer } from 'canvasplayer';

    const json = await (await fetch('./147.json')).json();
    new GmlPlayer(canvas, parse(json.gml, json.id)).play();

The canvas fills its parent. Size that element.

## Next

- Add CORS headers to 000000book, so pages on other sites can fetch tags
  without JSONP.
- Put this player on 000000book itself. It still runs the 2009 one.

Demo: https://jamiew.github.io/canvasplayer
Code: https://github.com/jamiew/canvasplayer

Public domain, no rights reserved.
