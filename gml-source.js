/*
 * Loads GML from #000000book and flattens it into what GmlPlayer wants.
 *
 * Tries fetch, falls back to JSONP. The API sends no CORS headers, so JSONP
 * is the path that runs today. An HTTP status is reported, not retried.
 *
 * Public domain, Jamie Wilkinson & Free Art & Technology (F.A.T.) Lab.
 */

(function (global) {
  'use strict';

  var API = 'https://000000book.com/data/';

  // The XML-to-JSON conversion drops one-element arrays down to bare objects.
  function list(value) {
    if (value === null || value === undefined) return [];
    return Array.isArray(value) ? value : [value];
  }

  // And the other way round. Tag 100 ships five <drawing> elements.
  function first(value) { return Array.isArray(value) ? (value[0] || {}) : (value || {}); }

  function num(value) {
    var n = parseFloat(value);
    return isFinite(n) ? n : null;
  }

  /*
   * Which way was up when the tag was captured.
   *
   * <environment><up> along +x means the device was sideways. Tags before
   * about #170 have no <environment>, so the geometry has to answer it: both
   * axes are normalized against the same edge, so y can only pass 1 on a
   * sideways capture.
   *
   * Do not guess from the client's name. Graffiti Analysis 1.0 wrote the
   * tag's name there, not the app's, so #161 is "katsu-4" and the old
   * /Katsu/ match laid it on its side.
   */
  function isLandscape(environment, strokes) {
    var up = (environment && environment.up) || null;
    var x = up ? num(up.x) : null;
    var y = up ? num(up.y) : null;

    if (x !== null && y !== null && (x !== 0 || y !== 0)) return Math.abs(x) > Math.abs(y);

    return (strokes || []).some(function (stroke) {
      return stroke.points.some(function (p) { return p[1] > 1; });
    });
  }

  /*
   * Flatten the tree into the [x, y, time] triples the player reads. Timing
   * passes through untouched: the player repairs it and says so.
   */
  function parse(gml, id) {
    var tag = first((gml && (gml.tag || gml.GML)) || {});
    var header = first(tag.header);
    var environment = first(tag.environment);
    var client = first(header.client);

    var raw = list(tag.drawing).reduce(function (all, drawing) {
      return all.concat(list(first(drawing).stroke));
    }, []);

    var strokes = raw.map(function (stroke) {
      var points = list(stroke && stroke.pt).map(function (pt) {
        var x = num(pt && pt.x);
        var y = num(pt && pt.y);
        if (x === null || y === null) return null;
        return [x, y, num(pt.time) || 0];
      }).filter(Boolean);

      return points.length ? { points: points } : null;
    }).filter(Boolean);

    return {
      id: id,
      app: client.name || null,
      rotate: isLandscape(environment, strokes),
      strokes: strokes
    };
  }

  // Fetch by id, or "latest" or "random", which the API also answers to.
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
          // A status means the server answered. Anything else never arrived,
          // which is where JSONP still helps.
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
      // A script tag reports one undifferentiated error, so a missing tag and
      // a dead network look the same here. The fetch path can tell them apart.
      if (onError) onError(new Error('Could not load tag ' + id + ' -- it may not exist'));
    };

    script.src = API + encodeURIComponent(id) + '.json?callback=' + name;
    document.body.appendChild(script);
  }

  global.GmlSource = { load: load, jsonp: jsonp, parse: parse, isLandscape: isLandscape, API: API };
}(window));
