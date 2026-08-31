/*
 * Loading GML from #000000book, and turning it into what GmlPlayer wants.
 *
 * Tries fetch() first and falls back to JSONP. #000000book sends no CORS
 * headers today, so cross-origin fetch fails and the JSONP path is what
 * actually runs -- but the moment the API starts sending them, the fetch path
 * takes over on its own and the callback shim stops being used. A real HTTP
 * error, a 404 for a tag that does not exist, is reported rather than retried.
 *
 * Public domain, Jamie Wilkinson & Free Art & Technology (F.A.T.) Lab.
 */

(function (global) {
  'use strict';

  var API = 'https://000000book.com/data/';

  // Anything the XML-to-JSON conversion may hand back as a lone object rather
  // than a one-element array.
  function list(value) {
    if (value === null || value === undefined) return [];
    return Array.isArray(value) ? value : [value];
  }

  function num(value) {
    var n = parseFloat(value);
    return isFinite(n) ? n : null;
  }

  /*
   * Which way was up when the tag was captured.
   *
   * GML records this in <environment><up>: an up vector along +x means the
   * device was held sideways and the points were written out unrotated. That
   * covers the archive from roughly tag 200 onwards.
   *
   * Before that the element is simply absent, which is what the old sketch
   * here was working around when it matched on the client's name. So the name
   * check survives, but only as the fallback it always should have been. It
   * deliberately does not match plain "Graffiti Analysis 2.0", which is the
   * desktop app and was already upright.
   */
  var LANDSCAPE_CLIENTS = /DustTag|Dust Tag|Katsu|Fat Tag/i;

  function isLandscape(environment, clientName) {
    var up = (environment && environment.up) || null;
    var x = up ? num(up.x) : null;
    var y = up ? num(up.y) : null;

    if (x !== null && y !== null && (x !== 0 || y !== 0)) return Math.abs(x) > Math.abs(y);
    return LANDSCAPE_CLIENTS.test(clientName || '');
  }

  /*
   * Flatten the GML tree into the flat [x, y, time] triples the player reads.
   * Timing is passed through untouched, gaps and all: the player repairs it
   * and reports what it had to do, so a bad capture stays visible.
   */
  function parse(gml, id) {
    var tag = (gml && (gml.tag || gml.GML)) || {};
    var header = tag.header || {};
    var environment = tag.environment || {};
    var client = header.client || {};
    var bounds = environment.screenBounds || {};

    var strokes = list((tag.drawing || {}).stroke).map(function (stroke) {
      var points = list(stroke && stroke.pt).map(function (pt) {
        var x = num(pt && pt.x);
        var y = num(pt && pt.y);
        if (x === null || y === null) return null;
        return [x, y, num(pt.time) || 0];
      }).filter(Boolean);

      return points.length ? {
        color: stroke.color || null,
        brush: num(stroke.brush || stroke.stroke_size),
        drips: stroke.dripping === 'true' || stroke.dripping === true,
        points: points
      } : null;
    }).filter(Boolean);

    return {
      id: id,
      app: client.name || null,
      client: client.name || null,
      screen: { x: num(bounds.x), y: num(bounds.y) },
      rotate: isLandscape(environment, client.name),
      strokes: strokes
    };
  }

  /*
   * Fetch a tag by id, or the strings "latest" or "random", which the API
   * also answers to.
   */
  var pending = 0;

  function deliver(data, id, onReady, onError) {
    if (!data || !data.gml) {
      if (onError) onError(new Error('No GML in the response for ' + id));
      return;
    }
    onReady(parse(data.gml, data.id || id), data);
  }

  function load(id, onReady, onError) {
    var url = API + encodeURIComponent(id) + '.json';

    if (global.fetch) {
      global.fetch(url, { mode: 'cors' })
        .then(function (response) {
          if (!response.ok) throw Object.assign(new Error('HTTP ' + response.status), { http: true });
          return response.json();
        })
        .then(function (data) { deliver(data, id, onReady, onError); })
        .catch(function (err) {
          // An HTTP status is the server answering; anything else is the
          // request never getting there, which is where JSONP still helps.
          if (err && err.http) {
            if (onError) onError(err);
            return;
          }
          jsonp(id, onReady, onError);
        });
      return;
    }

    jsonp(id, onReady, onError);
  }

  function jsonp(id, onReady, onError) {
    var name = '__gmlLoad' + (pending++);
    var script = document.createElement('script');
    var done = false;

    var cleanup = function () {
      delete global[name];
      if (script.parentNode) script.parentNode.removeChild(script);
    };

    global[name] = function (data) {
      done = true;
      cleanup();
      deliver(data, id, onReady, onError);
    };

    script.onerror = function () {
      if (done) return;
      cleanup();
      // A script tag reports one undifferentiated error, so this cannot tell
      // a missing tag from a network failure. The fetch path can, and says so.
      if (onError) onError(new Error('Could not load tag ' + id + ' -- it may not exist'));
    };

    script.src = API + encodeURIComponent(id) + '.json?callback=' + name;
    document.body.appendChild(script);
  }

  global.GmlSource = { load: load, jsonp: jsonp, parse: parse, isLandscape: isLandscape, API: API };
}(window));
