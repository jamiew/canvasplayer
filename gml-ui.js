/*
 * gml-ui.js: player controls.
 *
 * transport() adds play/pause, a timeline with stroke ticks, a clock and speed.
 * switches() adds ink modes, effects, data layers and help text.
 * gml-ui.css styles the DOM with --ink, --paper, --mute and --rule from any
 * ancestor. Colors default to black on white.
 *
 * Public domain, Jamie Wilkinson & Free Art & Technology (F.A.T.) Lab.
 * No rights reserved.
 */

const RATES = [0.25, 0.5, 1, 2, 4];

const PLAY = '<svg class="play" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
  '<path d="M8 5.2v13.6L19 12z"/></svg>';
const PAUSE = '<svg class="pause" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
  '<path d="M7.6 5.2h3.4v13.6H7.6zM13 5.2h3.4v13.6H13z"/></svg>';

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html) node.innerHTML = html;
  return node;
}

function button(className, html) {
  const node = el('button', className, html);
  node.type = 'button';
  return node;
}

function pad(n) { return String(n).padStart(2, '0'); }
export function secs(t) {
  const hundredths = Math.round(t * 100);
  return pad(Math.floor(hundredths / 100)) + '.' + pad(hundredths % 100);
}

/* Play, timeline, clock, speed. Disabled until the player has a tag. */
export function transport(player, host) {
  const hadClass = host.classList.contains('gml-transport');
  host.classList.add('gml-transport');

  const play = button('play', PLAY + PAUSE);
  play.setAttribute('aria-label', 'Play');

  // Keep the native range input's keyboard behavior above the custom visuals.
  const timeline = el('div', 'timeline');
  const fill = el('div', 'fill');
  const ticks = el('div', 'ticks');
  const scrub = el('input');
  scrub.type = 'range';
  scrub.min = 0;
  scrub.max = 1000;
  scrub.step = 1;
  scrub.value = 0;
  scrub.setAttribute('aria-label', 'Playback position');
  timeline.append(el('div', 'rail'), fill, ticks, scrub);

  const clock = el('span', 'clock');
  const clockValue = el('span', '', '00.00 / 00.00');
  const clockSpace = el('span');
  clockSpace.setAttribute('aria-hidden', 'true');
  clock.append(clockValue, clockSpace);
  const rate = button('rate');
  const rateValue = el('span', '', '1&times;');
  rate.appendChild(rateValue);
  for (const value of RATES) {
    const space = el('span', '', value + '×');
    space.setAttribute('aria-hidden', 'true');
    rate.appendChild(space);
  }

  host.append(play, timeline, clock, rate);

  let scrubbing = false;

  const toggle = () => player.toggle();
  const input = () => {
    scrubbing = true;
    player.pause().seek((scrub.value / 1000) * Math.max(player.duration, 0));
  };
  const change = () => { scrubbing = false; };
  const speed = () => {
    const next = RATES[(RATES.indexOf(player.opts.speed) + 1) % RATES.length];
    player.setSpeed(next);
  };
  play.addEventListener('click', toggle);
  scrub.addEventListener('input', input);
  scrub.addEventListener('change', change);
  rate.addEventListener('click', speed);

  const frame = s => {
    const time = Math.max(0, Math.min(s.time, s.duration));
    const at = s.duration > 0 ? time / s.duration : 0;
    if (!scrubbing) scrub.value = Math.round(at * 1000);
    fill.style.width = (at * 100).toFixed(2) + '%';
    clockValue.textContent = secs(time) + ' / ' + secs(s.duration);
    scrub.setAttribute('aria-valuetext', time.toFixed(1) + ' of ' + s.duration.toFixed(1) + ' seconds');
  };
  const state = s => {
    play.toggleAttribute('data-playing', s.playing);
    play.setAttribute('aria-label', s.playing ? 'Pause' : 'Play');
  };
  const config = () => {
    rateValue.textContent = player.opts.speed + '×';
    rate.setAttribute('aria-label', 'Playback speed: ' + player.opts.speed + '×');
  };
  player.on('frame', frame);
  player.on('state', state);
  player.on('config', config);

  const load = tag => {
    // A tick per stroke, so the timeline shows the shape of the tag.
    ticks.innerHTML = '';
    tag.strokes.forEach((stroke, i) => {
      if (!i || tag.duration <= 0 || !stroke.points.length) return;
      const mark = el('i');
      mark.style.left = ((stroke.points[0][2] / tag.duration) * 100).toFixed(2) + '%';
      ticks.appendChild(mark);
    });
    play.disabled = rate.disabled = !tag.strokes.length;
    scrub.disabled = !tag.strokes.length || tag.duration <= 0;
    scrubbing = false;
    clockSpace.textContent = secs(tag.duration) + ' / ' + secs(tag.duration);
    frame({ time: player.time, duration: player.duration });
  };
  player.on('load', load);
  load(player.tag);
  state({ playing: player.playing });
  config();

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    player.off('frame', frame);
    player.off('state', state);
    player.off('config', config);
    player.off('load', load);
    play.removeEventListener('click', toggle);
    scrub.removeEventListener('input', input);
    scrub.removeEventListener('change', change);
    rate.removeEventListener('click', speed);
    play.remove();
    timeline.remove();
    clock.remove();
    rate.remove();
    if (!hadClass) host.classList.remove('gml-transport');
  };
}

/*
 * One row each for mode, effects and layers. Select one mode.
 * Toggle effects and layers independently.
 */
export function switches(player, host) {
  const hadClass = host.classList.contains('gml-switches');
  host.classList.add('gml-switches');

  /*
   * Read capabilities from the renderer so WebGL pages need not load the
   * 2D painter for its constants.
   */
  const can = player.capabilities || {};
  const ABOUT = can.about || {};

  /*
   * Describe the hovered or focused button. Otherwise describe the ink mode.
   */
  const about = el('p', 'about');
  const descriptions = new Map();
  const say = name => descriptions.forEach((description, key) => {
    description.setAttribute('aria-hidden', String(key !== name));
  });
  let describing = false;
  const rest = () => {
    describing = false;
    say(player.mode);
  };
  const syncs = [];
  const disposals = [];

  function row(label, names, setClass, isOn, toggle) {
    // Omit options this renderer does not support.
    if (!names || !names.length) return;
    const wrap = el('div', 'row');
    const set = el('div', setClass);
    set.setAttribute('role', 'group');
    set.setAttribute('aria-label', label);

    const handlers = [];
    const buttons = names.map(name => {
      if (ABOUT[name] && !descriptions.has(name)) {
        const description = el('span');
        description.textContent = ABOUT[name];
        description.setAttribute('aria-hidden', 'true');
        descriptions.set(name, description);
        about.appendChild(description);
      }
      const b = button('', name);
      const describe = () => {
        describing = true;
        say(name);
      };
      const click = () => {
        toggle(name);
        say(name);
      };
      b.addEventListener('pointerenter', describe);
      b.addEventListener('focus', describe);
      b.addEventListener('pointerleave', rest);
      b.addEventListener('blur', rest);
      b.addEventListener('click', click);
      handlers.push({ describe, click });
      set.appendChild(b);
      return b;
    });
    const sync = () => buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(!!isOn(names[i]))));
    syncs.push(sync);
    sync();

    wrap.append(el('span', 'label', label), set);
    host.appendChild(wrap);
    disposals.push(() => {
      buttons.forEach((b, i) => {
        b.removeEventListener('pointerenter', handlers[i].describe);
        b.removeEventListener('focus', handlers[i].describe);
        b.removeEventListener('pointerleave', rest);
        b.removeEventListener('blur', rest);
        b.removeEventListener('click', handlers[i].click);
      });
      wrap.remove();
    });
  }

  row('Ink mode', can.modes, 'set segmented', name => player.mode === name, name => player.setMode(name));
  row('Effects', can.effects, 'set', name => player.effects[name], name => player.setEffect(name, !player.effects[name]));
  row('Data', can.layers, 'set', name => player.layers[name], name => player.setLayer(name, !player.layers[name]));

  if (descriptions.size) host.appendChild(about);
  rest();
  const config = () => {
    syncs.forEach(sync => sync());
    if (!describing) rest();
  };
  player.on('config', config);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    player.off('config', config);
    disposals.forEach(dispose => dispose());
    about.remove();
    if (!hadClass) host.classList.remove('gml-switches');
  };
}
