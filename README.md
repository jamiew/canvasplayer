![GML drawing with drips and diagnostic overlays](header.jpg)

# canvasplayer

Plays [Graffiti Markup Language](https://fffff.at/gml-week-graffiti-markup-language/)
(GML) on `<canvas>`. Repairs timing, turns sideways captures upright and draws
at the speed of the hand. No dependencies or build step.

[2D demo](https://jamiew.github.io/canvasplayer/?renderer=canvas) ·
[WebGL demo](https://jamiew.github.io/canvasplayer/?renderer=webgl) ·
[Embed options](https://jamiew.github.io/canvasplayer/embeds/) ·
[AI guide](https://jamiew.github.io/canvasplayer/llms.txt)

## Install and use

    npm install canvasplayer

Or copy the modules into your site. The examples below use npm imports;
without an import map or bundler, use relative file paths instead.

```html
<div class="stage" style="max-width:560px;height:360px"><canvas></canvas></div>
<script type="module">
  import { parse, GmlPlayer } from 'canvasplayer';

  const json = await (await fetch('./tag.json')).json();
  const tag = parse(json.gml, json.id);
  const player = new GmlPlayer(document.querySelector('canvas'), tag);
  player.setEffect('smooth', true).play();
</script>
```

Use the bundled [tag.json](embeds/tag.json) to try it. The canvas fills its
parent, so give that element a size. Serve files over HTTP, not `file://`.
The #000000book API has no CORS header; the demo and embeds share a site-only
[JSONP loader](load-tag.js) to load tags across origins.

### Optional controls

Add empty `#transport` and `#switches` elements and link `gml-ui.css`.
Then, in the same module script:

```js
import { transport, switches } from 'canvasplayer/ui';

const disposeTransport = transport(player, document.querySelector('#transport'));
const disposeSwitches = switches(player, document.querySelector('#switches'));

// Call when removing the player.
function unmount() {
  disposeTransport();
  disposeSwitches();
  player.destroy();
}
```

Controls follow the player's setters. Colors come from `--ink`, `--paper`,
`--mute` and `--rule`. Both helpers return disposal functions.
Repeated disposal is safe and leaves unrelated host content alone.

### Optional WebGL

Install `three` separately and pass your copy to the renderer:

```js
import * as THREE from 'three';
import { ThreePlayer } from 'canvasplayer/three';

const player = new ThreePlayer(THREE, canvas, tag);
player.play();
```

WebGL adds smoothed ribbons, time as depth, and flying dust trails with gravity,
based on [Evan Roth's 3D fork](https://github.com/evanroth/canvasplayer/tree/ga4-3d-player).
Drag to orbit; scroll to zoom. Tested with three.js r160. Use a fresh canvas
when changing renderers. A canvas cannot switch context types.

WebGL keeps the fork's ribbons, timestamps, framing, and dust rules at a fixed
60 Hz. Capture orientation is still corrected, including #147 and #842.
Unlike 2D, it does not repair timestamps or shorten pauses.

The shared controls offer `dust` and `auto-rotate`, both on by default.
Use `player.setEffect(name, on)`. Dust off clears and stops simulation; on follows
new marks. Auto-rotate off holds the angle without disabling drag or zoom.

## Drawing options

| | Choices |
|---|---|
| Ink modes | `marker`, `chisel`, `outline`, `dyna`, `hairline`, `skeleton` |
| Effects | `ghost`, `smooth`, `bleed`, `jitter`, `fade` |
| Data layers | `ink`, `drips`, `vectors`, `points`, `bounds`, `graph` |

The demo and player embed start in marker with ghost, smooth and drips on.
Use the buttons or `setMode(name)`, `setEffect(name, on)` and
`setLayer(name, on)` to change them.

**Smooth** curves marker and outline through recorded samples. Turn it off
for straight segments with `player.setEffect('smooth', false)`. `GmlPlayer`
leaves it off unless enabled. For `paint()`, pass `effects: { smooth: true }`.
Dyna has its own spring motion. Both keep earlier ink fixed as playback advances.

Fullscreen fills the window without the browser fullscreen API. Link with
`?fullscreen=1`; Escape exits. Controls start hidden. The controls button shows
or hides playback controls and right-hand drawing settings on any screen size.
Fullscreen uses dark colors; leaving it restores your selected page theme.

## API

| Module | Core exports |
|---|---|
| `canvasplayer` | `parse(json, id)`, `prepare(tag, options)`, `GmlPlayer(canvas, tag, options)`, `paint(ctx, tag, frame)`, `fit(bounds, w, h, pad)`, `MODES`, `EFFECTS`, `LAYERS`, `ABOUT`, `DEFAULTS` |
| `canvasplayer/gml` | Data preparation only: `parse`, `prepare`, `progress(strokes, time)`, `isLandscape(environment, strokes)` |
| `canvasplayer/ui` | `transport(player, host)`, `switches(player, host)`, `secs(time)` |
| `canvasplayer/three` | `ThreePlayer(THREE, canvas, tag, options)`, `DEFAULTS` |

Players take a parsed tag: `{ id, app, rotate, strokes: [{ points: [[x, y, time], ...] }] }`.
Coordinates are capture units, usually 0–1; time is seconds. `prepare()` repairs
timing, measures widths and plans drips. It has no DOM or canvas dependency.

For a static drawing, call `paint(ctx, prepare(tag), { w, h, time })`.
Use the prepared tag's duration for the finished image. Treat prepared tags
as immutable: the painter caches by tag identity. See options in
[gml.js](gml.js), [gml-player.js](gml-player.js) and [gml-three.js](gml-three.js).

Both players provide `load`, `play`, `pause`, `toggle`, `seek`, `setSpeed`,
`destroy`, `on`, `off`, and the properties `time`, `duration`, `playing`.

- `load(tag)` resets time and draws without changing playback state.
- `seek(seconds)` clamps and draws immediately; pause first to stay there.
  WebGL seeking clears the simulated dust.
- 2D supports `{ loop: false }`; playing a completed tag restarts it.
  WebGL loops through writing, hold and fade.
- Players follow parent size and pixel density. `destroy()` stops playback
  and releases listeners, observers and renderer resources.

| Event | Payload |
|---|---|
| `load` | prepared tag |
| `frame` | `{ time, duration }` |
| `state` | `{ playing }` |
| `config` | none; read the changed settings |

Subscribe with `on(name, callback)`; `off(name, callback)` removes all matching
registrations. Both return the player.

## Embeds

Choose an [animation](https://jamiew.github.io/canvasplayer/embeds/animation.html?id=161),
[full player](https://jamiew.github.io/canvasplayer/embeds/player.html?id=161) or
[static drawing](https://jamiew.github.io/canvasplayer/embeds/drawing.html?id=161).
The [gallery](https://jamiew.github.io/canvasplayer/embeds/) shows all three.
These paste-ready snippets use public GitHub Pages URLs. Local changes may
not be deployed there yet.

```html
<iframe src="https://jamiew.github.io/canvasplayer/embeds/animation.html?id=161"
        title="Animated graffiti drawing" loading="lazy"
        style="width:100%;aspect-ratio:1;border:0"></iframe>

<iframe src="https://jamiew.github.io/canvasplayer/embeds/player.html?id=161"
        title="Graffiti player" loading="lazy"
        style="width:100%;height:800px;border:0"></iframe>

<iframe src="https://jamiew.github.io/canvasplayer/embeds/drawing.html?id=161"
        title="Static graffiti drawing" loading="lazy"
        style="width:100%;height:800px;border:0"></iframe>
```

All three accept a numeric `?id`, such as `?id=147`. Without it, or with
`?id=161`, they load bundled Katsu #161 without an external API request.
Other IDs load from 000000book through JSONP. Invalid IDs and failed loads
show an error rather than falling back to a different drawing.

For local development, open `/embeds/` on your static server. Its preview
frames use relative URLs so content sizing works on the same origin.
For example, test http://localhost:8420/embeds/player.html?id=147.
The gallery's Open links and copied snippets still point to the public site.

The embeds and shared loader are site-only and excluded from npm. If
self-hosting, keep the directory layout, `load-tag.js`, root `site.css` and
`theme.js`, and required library files.

- Framing needs no CORS. JSONP executes scripts from 000000book; allow only
  trusted script sources in your content security policy.
- Keep scrolling available with fixed heights. The gallery shows same-origin
  content sizing with `ResizeObserver`; it cannot measure cross-origin frames.
- The host's `frame-src` and the player's `frame-ancestors` and
  `X-Frame-Options` policies must allow the embed.
- A sandbox is optional. These embeds need `allow-scripts allow-same-origin`
  if sandboxed; that combination does not isolate untrusted same-origin code.
- There is no cross-origin `postMessage` control API. Use the framed controls.

## Run locally

    python3 -m http.server 8420

Open http://localhost:8420/?id=161. Other choices: `?latest`, `?random`,
`?renderer=webgl`. Run `npm test` for the browser-free, network-free tests.

Started in 2009 for GML Week at F.A.T. Lab. Dyna follows Paul Haeberli's
DynaDraw (1989).

Public domain, Jamie Wilkinson & Free Art & Technology (F.A.T.) Lab.
No rights reserved.
