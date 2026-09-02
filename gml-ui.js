/*
 * gml-ui.js -- controls for a GmlPlayer.
 *
 * transport() is play and pause, a timeline to scrub with a tick where each
 * stroke starts, a clock and a speed button. switches() is a row of buttons
 * each for the ink mode, the effects and the data layers. Plain DOM, styled
 * by gml-ui.css. Colors come from --ink, --paper, --mute and --rule on any
 * ancestor, or fall back to black on white.
 *
 * Public domain, Jamie Wilkinson & Free Art & Technology (F.A.T.) Lab.
 * No rights reserved.
 */

import { MODES, EFFECTS, LAYERS } from './gml-player.js';

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
export function secs(t) { return pad(Math.floor(t)) + '.' + pad(Math.round((t % 1) * 100)); }

/* Play, timeline, clock, speed. Disabled until the player has a tag. */
export function transport(player, host) {
  host.classList.add('gml-transport');

  const play = button('play', PLAY + PAUSE);
  play.setAttribute('aria-label', 'Play');

  // The range input stays the real control and keeps its keyboard
  // behavior; the visuals sit underneath.
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

  const clock = el('span', 'clock', '00.00 / 00.00');
  const rate = button('rate', '1&times;');

  host.append(play, timeline, clock, rate);

  let scrubbing = false;

  play.addEventListener('click', () => player.toggle());
  scrub.addEventListener('input', () => {
    scrubbing = true;
    player.pause().seek((scrub.value / 1000) * player.duration);
  });
  scrub.addEventListener('change', () => { scrubbing = false; });
  rate.addEventListener('click', () => {
    const next = RATES[(RATES.indexOf(player.opts.speed) + 1) % RATES.length];
    player.setSpeed(next);
    rate.innerHTML = next + '&times;';
  });

  player.on('frame', s => {
    const at = Math.min(s.time, s.duration) / s.duration;
    if (!scrubbing) scrub.value = Math.round(at * 1000);
    fill.style.width = (at * 100).toFixed(2) + '%';
    clock.textContent = secs(Math.min(s.time, s.duration)) + ' / ' + secs(s.duration);
  });
  player.on('state', s => {
    play.toggleAttribute('data-playing', s.playing);
    play.setAttribute('aria-label', s.playing ? 'Pause' : 'Play');
  });

  const load = tag => {
    // A tick per stroke, so the timeline shows the shape of the tag.
    ticks.innerHTML = '';
    tag.strokes.forEach((stroke, i) => {
      if (!i) return;
      const mark = el('i');
      mark.style.left = ((stroke.points[0][2] / tag.duration) * 100).toFixed(2) + '%';
      ticks.appendChild(mark);
    });
    play.disabled = rate.disabled = scrub.disabled = !tag.strokes.length;
  };
  player.on('load', load);
  load(player.tag);

  return host;
}

/*
 * One row each for mode, effects and layers. Mode is one-of-many, so it
 * joins into one control. Effects and layers are independent, so they stay
 * separate chips.
 */
export function switches(player, host) {
  host.classList.add('gml-switches');

  function row(label, names, setClass, isOn, toggle) {
    const wrap = el('div', 'row');
    const set = el('div', setClass);
    set.setAttribute('role', 'group');
    set.setAttribute('aria-label', label);

    const buttons = names.map(name => {
      const b = button('', name);
      set.appendChild(b);
      return b;
    });
    const sync = () => buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(!!isOn(names[i]))));
    buttons.forEach((b, i) => b.addEventListener('click', () => {
      toggle(names[i]);
      sync();
    }));
    sync();

    wrap.append(el('span', 'label', label), set);
    host.appendChild(wrap);
  }

  row('Ink mode', MODES, 'set segmented', name => player.mode === name, name => player.setMode(name));
  row('Effects', EFFECTS, 'set', name => player.effects[name], name => player.setEffect(name, !player.effects[name]));
  row('Data', LAYERS, 'set', name => player.layers[name], name => player.setLayer(name, !player.layers[name]));

  return host;
}
