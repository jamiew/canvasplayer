![A tag drawn as a tapered ribbon with drips, under the bounds, points, vectors and speed graph overlays](header.jpg)

# canvasplayer

Plays Graffiti Markup Language (GML) tags on `<canvas>`. It reads a tag from
[#000000book](https://000000book.com), fixes the timing and plays it back at
the speed the hand moved. No dependencies. No build step.

Demo: https://jamiew.github.io/canvasplayer

## Install

    npm install canvasplayer

Or copy the 4 files next to your page and import them by path. On Rails with
Propshaft, put them in `public/`. Propshaft does not rewrite imports.

## Use

    <div class="stage"><canvas></canvas></div>
    <script type="module">
      import { parse } from 'canvasplayer/gml';
      import { GmlPlayer } from 'canvasplayer';

      const json = await (await fetch('./147.json')).json();
      const tag = parse(json.gml, json.id);
      new GmlPlayer(document.querySelector('canvas'), tag).play();
    </script>

The canvas fills its parent. Size that element.

`147.json` is what https://000000book.com/data/147.json returns. The API sends
no CORS header yet. A page on another site must load it with JSONP. The demo
page shows how.

Add controls if you want them:

    import { transport, switches } from 'canvasplayer/ui';

    transport(player, document.querySelector('#transport'));
    switches(player, document.querySelector('#switches'));

Link `gml-ui.css` too. It takes colors from `--ink`, `--paper`, `--mute` and
`--rule`, so the controls match your page.

## What you get

`canvasplayer/gml` reads GML. It has no DOM and no canvas, so you can draw
the result with anything.

- `parse(json, id)` turns the #000000book tree into strokes
- `prepare(tag, options)` fixes timing, measures speed and width, finds the
  bounds and plans the drips
- `progress(strokes, t)` says how far each stroke has got at time t
- `isLandscape(environment, strokes)` says if the capture was sideways

`canvasplayer` draws.

- `paint(ctx, tag, frame)` draws one frame on any 2D context. It works with
  OffscreenCanvas and Node canvas libraries.
- `fit(bounds, w, h, pad)` says where the drawing lands in a frame
- `orbit(view, duration, camera, opts)` turns a fit into a camera that reads
  time as depth
- `Dust(tag, options)` is the particle field. `step(dt, t)` moves it on,
  `reset()` puts it back
- `GmlPlayer(canvas, tag, options)` runs a canvas: sizing, clock and events
- `MODES`, `EFFECTS`, `VIEWS`, `LAYERS` and `DEFAULTS`

`canvasplayer/ui` builds controls: `transport` and `switches`.

A tag looks like this. Make one from anything.

    { id, app, rotate, strokes: [ { points: [[x, y, time], ...] } ] }

x and y run from 0 to 1. time is in seconds.

## How it draws

Capture apps write bad times: zeroes, unix epochs, samples out of order and
minute-long stalls. The timeline is fixed first. What changed is counted on
`tag.timing`.

Line width follows the hand. Slow is wide. Fast is thin. Ink runs from where
the line is widest.

8 modes. `marker` is a spline through the samples, wide where the hand was
slow. `chisel` is a flat nib at a fixed angle, so width comes from direction.
`spray` scatters ink on a Gaussian, the way a can does, so density follows
how long the hand lingered. `outline` draws the silhouette only, which is the
shape a writer lays down before filling it. `sketch` draws the line twice,
each pass bowed off the true path. `dyna` tows a brush with mass along the
path on a spring and draws where the brush went, after Paul Haeberli's
DynaDraw. `hairline` and `skeleton` are diagrams.

3 view options, on top of depth. `cue` dims what is far off, so depth reads
in a still frame and not only while the camera moves. `strata` gives each
stroke one flat plane at the moment it began, instead of every sample
carrying its own depth, so a tag built up in passes comes apart into those
passes. `ortho` drops perspective for a parallel projection: a technical
drawing rather than a photograph.

7 effects. `ghost` shows the whole tag faint underneath. `bleed` soaks the
ink outwards. `jitter` nudges every sample by noise. `fade` dims old ink.
`depth` puts each sample at the moment it was drawn, so the tag has real
thickness. Drag to turn it, scroll to move in and out. `extrude` sweeps the
drawing backwards into a solid body, along the time axis when depth is on.
`stereo` draws it from two eyes in red and cyan, for a pair of anaglyph
glasses; it needs depth. `dust` puts 15,000 particles on a vector field the
drawing pushes around, each trailing a line back to where it started. Every
one of them works with every mode and with the drips.

`dust` is a simulation, not a function of the clock, so it cannot live inside
`paint()`. The player owns a `Dust`, steps it, and passes it in. Seeking or
looping starts it over, because a field like that has no reverse.

6 data layers, for checking a tag. `ink` and `drips` are the drawing.
`vectors` are arrows for direction and speed. `points` marks every sample.
`bounds` draws the screen, the box and a grid. `graph` plots speed over time.

It opens in marker with ghost and drips on.

Sideways captures get a quarter turn. The up vector decides. If there is
none, y past 1 means sideways.

## Run it

Any static server works. Modules do not load from `file://`.

    python3 -m http.server 8420

Open http://localhost:8420/?id=161. `?latest` and `?random` work too.

    npm test

Tests need no browser and no network.

## History

Started in 2009 for GML Week at F.A.T. Lab as a Processing.js sketch. v4
dropped Processing.js and fixed the maths. v6 split it into modules and put
it on npm.

Time as depth comes from Evan Roth's Graffiti Analysis, by way of his 3D fork
of this player. That fork reached for WebGL. It does not need to: a tag is a
few thousand points, so the projection is 40 lines of arithmetic and every
mode and effect keeps working.

The drawing modes are borrowed too. `dyna` is Paul Haeberli's DynaDraw (1989),
which filtered a mouse through a mass on a spring and drew the mass. `sketch`
follows Jo Wood and colleagues' sketchy rendering, the method behind Handy and
Rough.js. `spray` uses the Gaussian that airbrush simulations have used since
the 1980s. `dust` is Evan Roth's, numbers and all, moved from WebGL onto the
2D canvas.

Public domain, Jamie Wilkinson & Free Art & Technology (F.A.T.) Lab.
No rights reserved.
