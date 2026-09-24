/* Mad River Brookies — map app. Plain JS, Leaflet 1.9. Works from file:// and GitHub Pages. */
(function () {
  'use strict';
  var SPOTS = window.SPOTS, OVR = window.OVERLAYS || {};
  var META = SPOTS.properties, INN = META.inn;
  var FEATS = SPOTS.features;
  var BY_ID = {};
  FEATS.forEach(function (f) { BY_ID[f.properties.id] = f; });
  var MAD_STREAMS = {};
  FEATS.forEach(function (f) { if (f.properties.watershed === 'Mad River') MAD_STREAMS[f.properties.name] = true; });
  var DESKTOP = function () { return window.matchMedia('(min-width: 900px)').matches; };
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  // ------------------------------------------------------------ state
  var state = {
    base: 'osm', scope: 'mad', tab: 'map', selected: null, me: null,
    layers: { b1: true, narrative: true, access: true, lines: true, watersheds: true, public: false, osm: false, temps: false },
    plan: { b1: false, bkt: false, fromHere: false },
    preset: 'basics'
  };
  var LAYER_DEFS = [
    ['b1', 'B1 wild trout waters', 'sw', '#2e7d32', 'Report survey points; solid dot + B1 badge'],
    ['narrative', 'Other tributaries (narrative only)', 'sw hollow', '#2e7d32', 'Named in the report text, no table row'],
    ['access', 'Access & parking', 'sw', '#039be5', 'Trailheads, lots, river access, state fishing access'],
    ['lines', 'Stream lines', 'sw line', '#2e7d32', 'VT Hydrography Dataset; coloured by species mix'],
    ['watersheds', 'Watershed outlines', 'sw dash', '#777', 'HUC10 boundaries (Mad, Dog, and neighbours)'],
    ['public', 'Public land', 'sw fill', '', 'VT Protected Lands Database: public or open-access parcels'],
    ['osm', 'Other OSM trails & parking', 'sw hollow', '#6d4c41', 'OpenStreetMap, unverified'],
    ['temps', 'Temperature sites', 'sw', '#fb8c00', 'Report tables 1–5, 13–16; colour = max 7-day avg']
  ];

  // ------------------------------------------------------------ utils
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function llOf(f) { var c = f.geometry.coordinates; return [c[1], c[0]]; }
  function fmtMin(m, src) { if (m == null) return '?'; return Math.round(m) + ' min' + (src === 'est.' ? ' est.' : ''); }
  function fmtWalk(m) { return m < 1000 ? m + ' m' : (m / 1000).toFixed(1) + ' km'; }
  function haversine(a, b) {
    var R = 6371000, p1 = a[0] * Math.PI / 180, p2 = b[0] * Math.PI / 180, dp = p2 - p1, dl = (b[1] - a[1]) * Math.PI / 180;
    var h = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  var originStr = function () { return (state.plan.fromHere && state.me) ? '' : INN.lat + ',' + INN.lng; };
  function gDir(lat, lng) { var o = originStr(); return 'https://www.google.com/maps/dir/?api=1' + (o ? '&origin=' + o : '') + '&destination=' + lat + ',' + lng + '&travelmode=driving'; }
  function aDir(lat, lng) { var o = originStr(); return 'https://maps.apple.com/?' + (o ? 'saddr=' + o + '&' : '') + 'daddr=' + lat + ',' + lng + '&dirflg=d'; }
  function gPin(lat, lng) { return 'https://www.google.com/maps/search/?api=1&query=' + lat + ',' + lng; }
  function aPin(lat, lng, name) { return 'https://maps.apple.com/?ll=' + lat + ',' + lng + '&q=' + encodeURIComponent(name); }
  var toastT;
  function toast(msg) { var t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(function () { t.hidden = true; }, 2200); }
  function copyText(txt) {
    var done = function () { toast('Copied: ' + txt.slice(0, 60)); };
    if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(txt).then(done, function () { fallback(); }); } else { fallback(); }
    function fallback() {
      var ta = document.createElement('textarea'); ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('Copy failed — long-press to select'); }
      document.body.removeChild(ta);
    }
  }
  var ICONS = {
    trailhead: '<svg viewBox="0 0 24 24"><circle cx="13.5" cy="4" r="2"/><path d="M12 7.5 8.5 9l-2 5 1.9.7 1.3-3.2 1.3 2.3-2.7 8.2h2.1l2.1-6.3 1.8 2.2V22h2v-5l-2.6-3.3.7-3.5 1.6 1.9 1.8-1.3-3.3-3.8z"/></svg>',
    parking: '<span>P</span>',
    river_access: '<svg viewBox="0 0 24 24"><path d="M2 9c2.3-2.2 4.4-2.2 6.7 0s4.4 2.2 6.7 0 4.4-2.2 6.6 0v2.6c-2.2-2.2-4.3-2.2-6.6 0s-4.4 2.2-6.7 0-4.4-2.2-6.7 0zm0 6c2.3-2.2 4.4-2.2 6.7 0s4.4 2.2 6.7 0 4.4-2.2 6.6 0v2.6c-2.2-2.2-4.3-2.2-6.6 0s-4.4 2.2-6.7 0-4.4-2.2-6.7 0z"/></svg>',
    landmark: '<svg viewBox="0 0 24 24"><path d="M6 2h2v20H6zm3 1h10l-2.5 4L19 11H9z"/></svg>',
    base: '<svg viewBox="0 0 24 24"><path d="M4 12 12 4l8 8v8h-5v-5h-6v5H4z"/></svg>',
    fly_shop: '<svg viewBox="0 0 24 24"><path d="M14 3a1 1 0 0 1 1 1v6.2c2 .5 3.5 2.2 3.5 4.3 0 2.5-2 4.5-4.5 4.5S9.5 17 9.5 14.5c0-1 .3-1.9.9-2.7L7 8.4V4a1 1 0 1 1 2 0v3.6l3 2.8V4a1 1 0 0 1 1-1zm0 9a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/></svg>',
    lake: '<svg viewBox="0 0 24 24"><path d="M3 12c3-4 7-6 11-4l3-3v4l2 3-2 3v4l-3-3c-4 2-8 0-11-4zm11-1a1 1 0 1 0 0 2 1 1 0 0 0 0-2z"/></svg>',
    osm_trailhead: '<svg viewBox="0 0 24 24"><path d="M6 2h2v20H6zm3 1h10l-2.5 4L19 11H9z"/></svg>',
    osm_parking: '<span>P</span>'
  };
  var TYPE_LABEL = { trailhead: 'Trailhead', parking: 'Parking', river_access: 'River access', landmark: 'Landmark', base: 'Home base', fly_shop: 'Fly shop', lake: 'Lake' };
  var STATE_BADGE = '<span class="badge b-state">VT</span>';

  // ------------------------------------------------------------ map
  var map = L.map('map', { zoomControl: false, attributionControl: true, worldCopyJump: false, tapHold: true });
  map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
  var bases = {
    osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }),
    topo: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, subdomains: 'abc', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>, SRTM | &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)' })
  };
  bases.osm.addTo(map);
  if (DESKTOP()) L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.control.scale({ imperial: true, metric: true, position: 'bottomleft' }).addTo(map);
  map.setView([44.15, -72.85], 12);

  var G = {}; // layer groups
  ['public', 'watersheds', 'context', 'trails', 'osmpts', 'lines', 'hit', 'halo', 'temps', 'access', 'narrative', 'b1', 'pois', 'me'].forEach(function (k) { G[k] = L.layerGroup().addTo(map); });
  var lineLayers = {}; // stream name -> {vis, hit}
  var markers = {};   // feature id -> marker

  function inScope(f) {
    var p = f.properties;
    if (state.scope === 'all') return true;
    var h = p.huc10 || '';
    if (state.scope === 'mad') {
      if (h === 'Mad River') return true;
      if (p.serves && p.serves.some(function (s) { return MAD_STREAMS[s] || s === 'Mad River'; })) return true;
      return p.watershed === 'Mad River';
    }
    if (state.scope === 'dog') return h.indexOf('Dog River') === 0 || p.watershed === 'Dog River';
    return true;
  }
  function inScopeOverlay(p) {
    if (state.scope === 'all') return true;
    var h = p.huc10 || '';
    return state.scope === 'mad' ? h === 'Mad River' : h.indexOf('Dog River') === 0;
  }

  function pinHtml(f) {
    var p = f.properties, cls = 'pin', inner = '';
    if (p.layer === 'b1_water' || p.layer === 'narrative_only') {
      if (p.layer === 'narrative_only') cls += ' hollow';
      if (p.confidence === 'low') cls += ' low';
      inner = '<div class="dot"></div>';
      if (p.b1) inner += '<span class="badge b-b1">B1</span>';
      if (p.spawning_trib) inner += '<span class="badge b-star">★</span>';
      if (p.private_flag) inner += '<span class="badge b-lock">🔒</span>';
      if (p.confidence === 'low') inner += '<span class="badge b-verify">verify</span>';
    } else if (p.layer === 'access') {
      if (p.confidence === 'low') cls += ' low';
      inner = '<div class="ico">' + ICONS[p.type] + '</div>' + (p.state_access ? STATE_BADGE : '') + (p.confidence === 'low' ? '<span class="badge b-verify">verify</span>' : '');
    } else if (p.layer === 'poi') {
      inner = '<div class="ico">' + (ICONS[p.category] || ICONS.landmark) + '</div>';
    } else if (p.layer === 'temperature') {
      cls += ' temp'; inner = '<div class="sq"></div>';
    }
    if (state.selected === p.id) cls += ' selected';
    return { cls: cls, html: inner };
  }
  function makeMarker(f) {
    var p = f.properties, h = pinHtml(f);
    var m = L.marker(llOf(f), {
      icon: L.divIcon({ className: h.cls, html: h.html, iconSize: [44, 44], iconAnchor: [22, 22] }),
      title: p.name, keyboard: false, riseOnHover: true,
      zIndexOffset: p.layer === 'b1_water' ? 300 : p.layer === 'access' ? 200 : p.layer === 'poi' ? 250 : 100
    });
    m.getElement && m.on('add', function () { var el = m.getElement(); if (el) el.style.setProperty('--c', p.color); });
    m.on('click', function () { select(p.id); });
    return m;
  }

  var built = { context: false, public: false, trails: false, osmpts: false, watersheds: false, contextScope: null, trailsScope: null, osmScope: null };
  function buildStatic() {
    if (!built.watersheds && OVR.watersheds) {
      L.geoJSON(OVR.watersheds, {
        style: function (f) { return { color: f.properties.core ? '#546e7a' : '#90a4ae', weight: f.properties.core ? 1.5 : 1, dashArray: '6 5', fill: false, interactive: false }; }
      }).addTo(G.watersheds);
      built.watersheds = true;
    }
    if (state.layers.public && !built.public && OVR.public_land) {
      L.geoJSON(OVR.public_land, {
        style: { color: '#43a047', weight: 1, opacity: .6, fillColor: '#a5d6a7', fillOpacity: .25 },
        onEachFeature: function (f, l) {
          var p = f.properties;
          l.bindPopup('<b>' + esc(p.name || 'Protected land') + '</b><br>' + esc(p.agency || '') + (p.type ? ' · ' + esc(p.type.replace('_', ' ').toLowerCase()) : '') + '<br>Public access: ' + esc(p.access || 'unknown') + ' · ' + esc(p.acres) + ' ac');
        }
      }).addTo(G.public);
      built.public = true;
    }
    if (state.layers.lines && built.contextScope !== state.scope && OVR.streams_all) {
      G.context.clearLayers();
      L.geoJSON(OVR.streams_all, {
        filter: function (f) { return inScopeOverlay(f.properties); },
        style: function (f) { return { color: '#90caf9', weight: f.properties.order >= 5 ? 2.5 : 1.5, opacity: .9, interactive: false }; }
      }).addTo(G.context);
      built.contextScope = state.scope;
    }
    if (state.layers.osm && built.trailsScope !== state.scope && OVR.osm_trails) {
      G.trails.clearLayers();
      L.geoJSON(OVR.osm_trails, {
        filter: function (f) { return inScopeOverlay(f.properties); },
        style: { color: '#6d4c41', weight: 1.5, dashArray: '4 4', opacity: .8 },
        onEachFeature: function (f, l) { l.bindPopup('<b>' + esc(f.properties.name) + '</b><br><small>OSM ' + esc(f.properties.highway) + ', unverified · <a target="_blank" rel="noopener" href="https://www.openstreetmap.org/' + esc(f.properties.osm_id) + '">osm.org</a></small>'); }
      }).addTo(G.trails);
      built.trailsScope = state.scope;
    }
    if (state.layers.osm && built.osmScope !== state.scope && OVR.osm_access) {
      G.osmpts.clearLayers();
      OVR.osm_access.features.forEach(function (f) {
        if (!inScopeOverlay(f.properties)) return;
        var p = f.properties;
        var m = L.marker(llOf(f), { icon: L.divIcon({ className: 'pin hollow osm', html: '<div class="ico">' + ICONS['osm_' + p.type] + '</div>', iconSize: [44, 44], iconAnchor: [22, 22] }), title: p.name || p.type, keyboard: false });
        m.on('add', function () { var el = m.getElement(); if (el) el.style.setProperty('--c', p.type === 'trailhead' ? '#6d4c41' : '#546e7a'); });
        m.on('click', function () { openOsmCard(f); });
        m.addTo(G.osmpts);
      });
      built.osmScope = state.scope;
    }
  }

  function render() {
    // toggle static groups
    var on = function (k, v) { if (v) { if (!map.hasLayer(G[k])) G[k].addTo(map); } else if (map.hasLayer(G[k])) map.removeLayer(G[k]); };
    buildStatic();
    on('watersheds', state.layers.watersheds); on('public', state.layers.public);
    on('context', state.layers.lines); on('trails', state.layers.osm); on('osmpts', state.layers.osm);
    // named lines
    G.lines.clearLayers(); G.hit.clearLayers(); lineLayers = {};
    if (state.layers.lines && OVR.streams_named) {
      OVR.streams_named.features.forEach(function (f) {
        var p = f.properties, rec = null;
        FEATS.some(function (s) { if (s.properties.name === p.stream) { rec = s; return true; } });
        if (rec && !inScope(rec)) return;
        if (!rec && !inScopeOverlay(p)) return;
        if (rec && rec.properties.layer === 'b1_water' && !state.layers.b1) return;
        if (rec && rec.properties.layer === 'narrative_only' && !state.layers.narrative) return;
        var color = p.role === 'matched' && rec ? rec.properties.color : '#1e88e5'; // plain mainstem: lighter blue than the 3-species mix
        var vis = L.geoJSON(f, { style: { color: color, weight: p.role === 'matched' ? 4 : 3, opacity: .95, lineCap: 'round', lineJoin: 'round', interactive: false } }).addTo(G.lines);
        if (rec) {
          var hit = L.geoJSON(f, { style: { color: '#000', weight: 22, opacity: 0.001, interactive: true } }).addTo(G.hit);
          hit.on('click', function (e) { L.DomEvent.stop(e); select(rec.properties.id); });
          lineLayers[rec.properties.id] = { vis: vis, hit: hit, feature: f, color: color };
        }
      });
    }
    // points
    ['temps', 'access', 'narrative', 'b1', 'pois'].forEach(function (k) { G[k].clearLayers(); });
    markers = {};
    FEATS.forEach(function (f) {
      var p = f.properties, g = null;
      if (p.layer === 'b1_water' && state.layers.b1) g = 'b1';
      else if (p.layer === 'narrative_only' && state.layers.narrative) g = 'narrative';
      else if (p.layer === 'access' && state.layers.access) g = 'access';
      else if (p.layer === 'temperature' && state.layers.temps) g = 'temps';
      else if (p.layer === 'poi') g = 'pois';
      if (!g) return;
      if (p.layer !== 'poi' && !inScope(f)) return;
      var m = makeMarker(f); m.addTo(G[g]); markers[p.id] = m;
    });
    renderHalo();
    $$('#layer-list input').forEach(function (i) { i.checked = !!state.layers[i.dataset.layer]; });
    $$('#scope-seg button, #plan-scope button').forEach(function (b) { b.classList.toggle('on', b.dataset.scope === state.scope); });
    $$('#presets .chip[data-preset]').forEach(function (b) { b.classList.toggle('on', b.dataset.preset === state.preset); });
  }
  function renderHalo() {
    G.halo.clearLayers();
    var sel = state.selected && lineLayers[state.selected];
    if (!sel) return;
    L.geoJSON(sel.feature, { style: { color: '#fff', weight: 11, opacity: .95, interactive: false, lineCap: 'round' } }).addTo(G.halo);
    L.geoJSON(sel.feature, { style: { color: sel.color, weight: 6, opacity: 1, interactive: false, lineCap: 'round' } }).addTo(G.halo);
  }

  // ------------------------------------------------------------ selection + cards
  function select(id, opts) {
    opts = opts || {};
    var f = BY_ID[id]; if (!f) return;
    var prev = state.selected; state.selected = id;
    [prev, id].forEach(function (k) { var m = k && markers[k]; if (m) { var el = m.getElement(); if (el) el.classList.toggle('selected', k === id); } });
    renderHalo();
    var p = f.properties;
    if (p.layer === 'b1_water' || p.layer === 'narrative_only') openSheet(streamCard(f));
    else if (p.layer === 'access') openSheet(accessCard(f));
    else if (p.layer === 'poi') openSheet(poiCard(f));
    else if (p.layer === 'temperature') openSheet(tempCard(f));
    if (!opts.noPan) focusOn(llOf(f), opts.zoom);
    showTab('map');
    try { history.replaceState(null, '', '#f=' + id); } catch (e) { }
  }
  function focusOn(ll, zoom) {
    var z = Math.max(map.getZoom(), zoom || 13);
    if (DESKTOP()) { map.setView(ll, z, { animate: true }); return; }
    var sheetH = $('#sheet').classList.contains('full') ? window.innerHeight * .88 : window.innerHeight * .46;
    var mapH = map.getSize().y;
    var target = map.project(ll, z).subtract([0, (mapH - sheetH) / 2 - mapH / 2]);
    map.setView(map.unproject(target, z), z, { animate: true });
  }
  function speciesTag(p) {
    var lbl = p.species_label || (p.species && p.species.length ? p.species.join(', ') : 'no data');
    return '<span class="tag species" style="--c:' + p.color + '"><i class="sw"></i>' + esc(lbl) + '</span>';
  }
  function driveTag(p) { return '<span class="tag">🚗 ' + fmtMin(p.drive_min, p.drive_src) + ' from inn</span>'; }
  function coordRow(f, name) {
    var ll = llOf(f), s = ll[0].toFixed(5) + ', ' + ll[1].toFixed(5);
    return '<div class="btnrow">' +
      '<button class="btn small" data-copy="' + s + '">📋 Copy lat/long</button>' +
      '<a class="btn small" target="_blank" rel="noopener" href="' + gPin(ll[0], ll[1]) + '">Google pin</a>' +
      '<a class="btn small" target="_blank" rel="noopener" href="' + aPin(ll[0], ll[1], name) + '">Apple pin</a>' +
      '</div><div class="muted small mono">' + s + '</div>';
  }
  function accessRow(a, showServes) {
    var t = a.type || 'parking', col = META.access_types[t];
    return '<div class="acc">' +
      '<div class="acc-head" data-open="' + a.id + '"><div class="ico" style="--c:' + col + '">' + ICONS[t] + '</div><div class="name">' + esc(a.name) + '</div><span class="muted">›</span></div>' +
      '<div class="acc-meta"><b>🚗 ' + fmtMin(a.drive_min, a.drive_src) + '</b> drive · <b>🚶 ' + fmtWalk(a.walk_m) + '</b> to the stream, as the crow flies' + (showServes && a.serves ? ' · <span class="tick">✓ serves this stream</span>' : '') + '</div>' +
      '<div class="btnrow"><a class="btn small blue" target="_blank" rel="noopener" href="' + gDir(a.lat, a.lng) + '">Google ▸</a><a class="btn small" target="_blank" rel="noopener" href="' + aDir(a.lat, a.lng) + '">Apple ▸</a></div>' +
      '</div>';
  }
  function streamCard(f) {
    var p = f.properties, h = '<div class="card">';
    h += '<h2>' + esc(p.name) + '</h2>';
    h += '<div class="sub">' + esc(p.watershed) + ' watershed' + (p.has_line ? '' : ' · <span class="tag warn">no line matched</span>') + '</div>';
    h += '<div class="tags">' + speciesTag(p) + (p.b1 ? '<span class="tag b1">B1</span>' : '<span class="tag">narrative only</span>') +
      (p.spawning_trib ? '<span class="tag">★ spawning trib</span>' : '') + (p.private_flag ? '<span class="tag danger">🔒 private?</span>' : '') +
      (p.confidence === 'low' ? '<span class="tag warn">verify location</span>' : '') + driveTag(p) + '</div>';
    if (/REPORT COORDINATE PROBLEM/.test(p.notes)) {
      h += '<div class="callout"><b>Report coordinate rejected.</b> Table 11 gives 44.175722, −72.661631, which lands in the Dog River valley about 10 miles east — almost certainly a transcription error. This pin is at Warren village instead; the coloured line upstream is the reach the report describes.</div>';
      var rest = p.notes.replace(/^REPORT COORDINATE PROBLEM:.*?Report: /, '');
      h += '<p class="notes">' + esc(rest.charAt(0).toUpperCase() + rest.slice(1)) + '</p>';
    } else {
      h += '<p class="notes">' + esc(p.notes) + '</p>';
    }
    if (/verify current regs|closed to fishing/i.test(p.notes)) h += '<div class="callout">Special regulations mentioned in the 2017 report — <a target="_blank" rel="noopener" href="https://www.vtfishandwildlife.com/updated-fishing-regulations-overview">check the current VT regs</a> before fishing.</div>';
    h += '<div class="getthere"><h3>Get there</h3>';
    if (p.nearest_access && p.nearest_access.length) p.nearest_access.forEach(function (a) { h += accessRow(a, true); });
    else h += '<p class="muted small">No researched access within 3 km. Use the pin links below and look for a pull-off.</p>';
    h += '</div>';
    h += coordRow(f, p.name);
    h += '<div class="src">Source: <a target="_blank" rel="noopener" href="' + esc(p.source_url) + '">' + esc(p.source_label) + '</a> (<a target="_blank" rel="noopener" href="' + esc(META.pdf_local) + '">local copy</a>)<br>Coordinate: ' + esc(p.coord_source) + ' · confidence ' + esc(p.confidence) + '</div>';
    return h + '</div>';
  }
  function accessCard(f) {
    var p = f.properties, ll = llOf(f), h = '<div class="card">';
    h += '<h2>' + esc(p.name) + '</h2>';
    h += '<div class="tags"><span class="tag" style="--c:' + p.color + '"><i class="sw"></i>' + esc(TYPE_LABEL[p.type] || p.type) + '</span>' + (p.state_access ? '<span class="tag state">VT F&amp;W access area</span>' : '') +
      (p.confidence === 'low' ? '<span class="tag warn">verify location</span>' : '') + driveTag(p) + '</div>';
    h += '<div class="btnrow"><a class="btn primary" target="_blank" rel="noopener" href="' + gDir(ll[0], ll[1]) + '">Google directions</a><a class="btn" target="_blank" rel="noopener" href="' + aDir(ll[0], ll[1]) + '">Apple directions</a></div>';
    if (p.parking_notes) h += '<p class="notes"><b>Parking:</b> ' + esc(p.parking_notes) + '</p>';
    if (p.notes) h += '<p class="notes">' + esc(p.notes) + '</p>';
    var served = FEATS.filter(function (s) { return (s.properties.nearest_access || []).some(function (a) { return a.id === p.id; }) || p.serves.indexOf(s.properties.name) >= 0; });
    if (p.serves.indexOf('Mad River') >= 0 || served.length) {
      h += '<h3>Serves</h3><ul class="linklist">';
      if (p.serves.indexOf('Mad River') >= 0) h += '<li><a href="#" data-open="s-mad-river-above-warren-village">Mad River</a><small>mainstem — stocked Warren→Moretown, wild above Warren village</small></li>';
      served.forEach(function (s) {
        var sp = s.properties;
        h += '<li><a href="#" data-open="' + sp.id + '">' + esc(sp.name) + '</a><small>' + esc(sp.species_label) + (sp.b1 ? ' · B1' : '') + '</small></li>';
      });
      h += '</ul>';
    }
    h += coordRow(f, p.name);
    h += '<div class="src">Source: ' + linkify(p.source_ref) + '<br>Coordinate: ' + esc(p.coord_source) + ' · confidence ' + esc(p.confidence) + '</div>';
    return h + '</div>';
  }
  function poiCard(f) {
    var p = f.properties, ll = llOf(f), h = '<div class="card"><h2>' + esc(p.name) + '</h2>';
    h += '<div class="tags"><span class="tag" style="--c:' + p.color + '"><i class="sw"></i>' + esc(TYPE_LABEL[p.category] || p.category) + '</span>' + (p.category !== 'base' ? driveTag(p) : '') + '</div>';
    h += '<p class="notes">' + esc(p.notes) + '</p>';
    if (p.category !== 'base') h += '<div class="btnrow"><a class="btn primary" target="_blank" rel="noopener" href="' + gDir(ll[0], ll[1]) + '">Google directions</a><a class="btn" target="_blank" rel="noopener" href="' + aDir(ll[0], ll[1]) + '">Apple directions</a></div>';
    h += coordRow(f, p.name);
    h += '<div class="src">Source: ' + linkify(p.source_ref) + '<br>Coordinate: ' + esc(p.coord_source) + ' · confidence ' + esc(p.confidence) + '</div>';
    return h + '</div>';
  }
  function tempCard(f) {
    var p = f.properties, h = '<div class="card"><h2>' + esc(p.river) + ' · ' + p.elev_ft + ' ft</h2>';
    h += '<div class="tags"><span class="tag" style="--c:' + p.color + '"><i class="sw"></i>' + esc(p.band) + '</span></div>';
    h += '<dl class="kv"><dt>Max temp</dt><dd><b>' + p.max_temp_F + ' °F</b></dd><dt>Max 7-day avg</dt><dd><b>' + p.max_7day_avg_F + ' °F</b></dd><dt>Years</dt><dd>' + esc(p.years) + '</dd></dl>';
    h += '<p class="muted small">Brook trout thrive below 68 °F and tolerate brief periods up to 72 °F; browns and rainbows handle the low 80s briefly. June–October data; highest value across the years listed.</p>';
    h += coordRow(f, p.name);
    h += '<div class="src">Source: <a target="_blank" rel="noopener" href="' + esc(p.source_url) + '">' + esc(p.source_label) + '</a></div>';
    return h + '</div>';
  }
  function openOsmCard(f) {
    var p = f.properties, ll = llOf(f), h = '<div class="card"><h2>' + esc(p.name || (p.type === 'trailhead' ? 'Trailhead' : 'Parking')) + '</h2>';
    h += '<div class="tags"><span class="tag warn">OSM, unverified</span><span class="tag">' + esc(p.type) + '</span>' + (p.fee ? '<span class="tag">fee: ' + esc(p.fee) + '</span>' : '') + (p.access ? '<span class="tag">access: ' + esc(p.access) + '</span>' : '') + '</div>';
    if (p.operator) h += '<p class="notes">Operator: ' + esc(p.operator) + '</p>';
    h += '<div class="btnrow"><a class="btn primary" target="_blank" rel="noopener" href="' + gDir(ll[0], ll[1]) + '">Google directions</a><a class="btn" target="_blank" rel="noopener" href="' + aDir(ll[0], ll[1]) + '">Apple directions</a></div>';
    h += coordRow(f, p.name || 'OSM ' + p.type);
    h += '<div class="src">Source: <a target="_blank" rel="noopener" href="https://www.openstreetmap.org/' + esc(p.osm_id) + '">OpenStreetMap ' + esc(p.osm_id) + '</a></div></div>';
    state.selected = null; renderHalo(); openSheet(h); focusOn(ll);
  }
  function linkify(s) {
    return esc(s).replace(/(https?:\/\/[^\s;]+)/g, function (u) { return '<a target="_blank" rel="noopener" href="' + u + '">' + u.replace(/^https?:\/\//, '').slice(0, 40) + '…</a>'; });
  }

  // ------------------------------------------------------------ sheet
  var sheet = $('#sheet'), sheetBody = $('#sheet-body');
  function openSheet(html, size) {
    sheetBody.innerHTML = html; sheetBody.scrollTop = 0;
    sheet.classList.remove('full', 'peek'); sheet.classList.add(size || 'peek');
    hidePanels();
  }
  function closeSheet() { sheet.classList.remove('full', 'peek'); state.selected = null; renderHalo(); Object.keys(markers).forEach(function (k) { var el = markers[k].getElement(); if (el) el.classList.remove('selected'); }); try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { } }
  $('#sheet-close').addEventListener('click', closeSheet);
  sheetBody.addEventListener('click', function (e) {
    var t = e.target.closest('[data-copy],[data-open],[data-act]'); if (!t) return;
    if (t.dataset.copy) { e.preventDefault(); copyText(t.dataset.copy); }
    else if (t.dataset.open) { e.preventDefault(); select(t.dataset.open); }
    else if (t.dataset.act) { e.preventDefault(); actions[t.dataset.act](t); }
  });
  (function drag() {
    var grip = $('#sheet-grip'), y0 = null, h0 = 0;
    grip.addEventListener('pointerdown', function (e) { y0 = e.clientY; h0 = sheet.getBoundingClientRect().height; sheet.classList.add('dragging'); grip.setPointerCapture(e.pointerId); });
    grip.addEventListener('pointermove', function (e) { if (y0 == null) return; var h = Math.max(120, Math.min(window.innerHeight * .9, h0 - (e.clientY - y0))); sheet.style.height = h + 'px'; });
    grip.addEventListener('pointerup', function (e) {
      if (y0 == null) return; var dy = e.clientY - y0; sheet.classList.remove('dragging'); sheet.style.height = '';
      if (dy < -60) sheet.classList.add('full'); else if (dy > 60) { if (sheet.classList.contains('full')) sheet.classList.remove('full'); else closeSheet(); }
      y0 = null;
    });
    grip.addEventListener('click', function () { sheet.classList.toggle('full'); });
  })();

  // ------------------------------------------------------------ tabs / panels
  function hidePanels() { $$('.panel').forEach(function (p) { p.hidden = true; }); }
  function showTab(tab) {
    state.tab = tab;
    $$('.tab').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === tab); });
    hidePanels();
    if (tab === 'plan') { renderPlan(); $('#panel-plan').hidden = false; }
    else if (tab === 'layers') { $('#panel-layers').hidden = false; }
    else if (tab === 'info') { $('#panel-info').hidden = false; }
    if (tab !== 'map' && !DESKTOP()) sheet.classList.remove('peek', 'full');
    if (tab === 'map') setTimeout(function () { map.invalidateSize(); }, 50);
  }
  $$('.tab').forEach(function (b) { b.addEventListener('click', function () { showTab(b.dataset.tab === state.tab && b.dataset.tab !== 'map' ? 'map' : b.dataset.tab); }); });
  $('#btn-menu').addEventListener('click', function () { showTab(state.tab === 'info' ? 'map' : 'info'); });
  $('#btn-layers').addEventListener('click', function () { showTab(state.tab === 'layers' ? 'map' : 'layers'); });

  // ------------------------------------------------------------ layers panel
  (function buildLayerList() {
    var ul = $('#layer-list');
    ul.innerHTML = LAYER_DEFS.map(function (d) {
      var sw = '<i class="' + d[2] + '" style="background:' + (d[2].indexOf('fill') >= 0 || d[2].indexOf('hollow') >= 0 || d[2].indexOf('dash') >= 0 ? '' : d[3]) + ';border-color:' + d[3] + '"></i>';
      return '<li><label>' + '<input type="checkbox" data-layer="' + d[0] + '">' + sw + '<span>' + d[1] + '<small>' + d[4] + '</small></span></label></li>';
    }).join('');
    ul.addEventListener('change', function (e) { var i = e.target; if (i.dataset.layer) { state.layers[i.dataset.layer] = i.checked; state.preset = null; render(); } });
  })();
  $$('#scope-seg button, #plan-scope button').forEach(function (b) { b.addEventListener('click', function () { setScope(b.dataset.scope); }); });
  function setScope(s) { state.scope = s; state.preset = null; render(); if (state.tab === 'plan') renderPlan(); }
  $$('#basemap-seg button').forEach(function (b) { b.addEventListener('click', function () { setBase(b.dataset.base); }); });
  function setBase(b) {
    state.base = b; Object.keys(bases).forEach(function (k) { if (map.hasLayer(bases[k])) map.removeLayer(bases[k]); }); bases[b].addTo(map);
    $$('#basemap-seg button').forEach(function (x) { x.classList.toggle('on', x.dataset.base === b); });
    $('#btn-basemap').classList.toggle('on', b === 'topo');
  }
  $('#btn-basemap').addEventListener('click', function () { setBase(state.base === 'osm' ? 'topo' : 'osm'); toast(state.base === 'osm' ? 'OpenStreetMap' : 'OpenTopoMap'); });
  $('#btn-home').addEventListener('click', function () { select('p-the-inn-at-the-round-barn-farm', { zoom: 13 }); });

  // ------------------------------------------------------------ presets
  var PRESETS = {
    basics: { layers: { b1: true, narrative: true, access: true, lines: true, watersheds: true, public: false, osm: false, temps: false }, scope: 'mad' },
    dog: { layers: { b1: true, narrative: true, access: true, lines: true, watersheds: true, public: false, osm: false, temps: true }, scope: 'dog' },
    all: { layers: { b1: true, narrative: true, access: true, lines: true, watersheds: true, public: true, osm: true, temps: true }, scope: 'all' }
  };
  function applyPreset(name, noFit) {
    var pr = PRESETS[name]; if (!pr) return;
    state.layers = Object.assign({}, pr.layers); state.scope = pr.scope; state.preset = name;
    render();
    if (noFit) return;
    var pts = FEATS.filter(function (f) { var l = f.properties.layer; return (l === 'b1_water' || l === 'narrative_only' || (l === 'access' && !f.properties.state_access)) && inScope(f); }).map(llOf);
    if (name === 'basics') pts = pts.filter(function (ll) { return ll[0] > 44.09 && ll[0] < 44.23; }); // Warren–Waitsfield
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 13 });
    if (state.tab === 'plan') renderPlan();
  }
  $$('#presets .chip[data-preset]').forEach(function (b) { b.addEventListener('click', function () { applyPreset(b.dataset.preset); showTab('map'); }); });

  // ------------------------------------------------------------ plan list
  function planRows() {
    var rows = FEATS.filter(function (f) {
      var p = f.properties;
      if (p.layer !== 'b1_water' && p.layer !== 'narrative_only') return false;
      if (!inScope(f)) return false;
      if (state.plan.b1 && !p.b1) return false;
      if (state.plan.bkt && p.species_key !== 'BKT') return false;
      return true;
    });
    var fromHere = state.plan.fromHere && state.me, km = {};
    rows.forEach(function (f) { km[f.properties.id] = fromHere ? haversine(state.me, llOf(f)) / 1000 : null; });
    rows.sort(function (a, b) { return fromHere ? km[a.properties.id] - km[b.properties.id] : (a.properties.drive_min - b.properties.drive_min) || a.properties.name.localeCompare(b.properties.name); });
    return rows.map(function (f) { return { f: f, km: km[f.properties.id] }; });
  }
  function renderPlan() {
    var ol = $('#plan-list'), rows = planRows(), fromHere = state.plan.fromHere && state.me;
    if (!rows.length) { ol.innerHTML = '<li class="plan-empty">Nothing matches these filters.</li>'; return; }
    ol.innerHTML = rows.map(function (r) {
      var f = r.f, p = f.properties, a = (p.nearest_access || [])[0];
      var drive = fromHere ? '<b>' + (r.km < 10 ? r.km.toFixed(1) : Math.round(r.km)) + '</b><small>km away</small>' :
        '<b>' + Math.round(p.drive_min) + '</b><small' + (p.drive_src === 'est.' ? ' class="est"' : '') + '>min' + (p.drive_src === 'est.' ? ' est.' : '') + '</small>';
      var go = a ? '<a class="g" target="_blank" rel="noopener" href="' + gDir(a.lat, a.lng) + '" title="Google directions to ' + esc(a.name) + '">Go</a><a class="apple" target="_blank" rel="noopener" href="' + aDir(a.lat, a.lng) + '" title="Apple directions">Apple</a>'
        : '<a class="g" target="_blank" rel="noopener" href="' + gDir(llOf(f)[0], llOf(f)[1]) + '">Go</a>';
      return '<li class="plan-row" data-id="' + p.id + '"><div class="drive">' + drive + '</div><div class="main"><div class="name">' + esc(p.name) + '</div>' +
        '<div class="tags">' + speciesTag(p) + (p.b1 ? '<span class="tag b1">B1</span>' : '') + (p.private_flag ? '<span class="tag danger">🔒</span>' : '') + (p.confidence === 'low' ? '<span class="tag warn">verify</span>' : '') + '</div>' +
        '<div class="lot">' + (a ? '🅿 ' + esc(a.name) + ' · ' + fmtWalk(a.walk_m) + ' walk' : 'no researched lot within 3 km') + '</div></div><div class="go">' + go + '</div></li>';
    }).join('');
  }
  $('#plan-list').addEventListener('click', function (e) {
    if (e.target.closest('a')) return;
    var li = e.target.closest('.plan-row'); if (li) select(li.dataset.id);
  });
  ['b1', 'bkt', 'fromhere'].forEach(function (k) {
    $('#plan-' + k).addEventListener('change', function (e) {
      var key = k === 'fromhere' ? 'fromHere' : k; state.plan[key] = e.target.checked;
      if (key === 'fromHere' && e.target.checked && !state.me) locate(function () { renderPlan(); });
      renderPlan();
    });
  });

  // ------------------------------------------------------------ search
  var searchIn = $('#search'), results = $('#search-results');
  function searchIndex() {
    return FEATS.filter(function (f) { return f.properties.layer !== 'temperature'; }).map(function (f) {
      var p = f.properties, sub = p.layer === 'access' ? (TYPE_LABEL[p.type] || p.type) + (p.state_access ? ' · state' : '') : p.layer === 'poi' ? (TYPE_LABEL[p.category] || p.category) : (p.species_label + (p.b1 ? ' · B1' : '') + ' · ' + p.watershed);
      return { id: p.id, name: p.name, sub: sub, color: p.color, hay: (p.name + ' ' + sub + ' ' + (p.notes || '')).toLowerCase() };
    });
  }
  var IDX = searchIndex(), activeIdx = -1;
  function doSearch() {
    var q = searchIn.value.trim().toLowerCase();
    if (!q) { results.hidden = true; return; }
    var hits = IDX.filter(function (r) { return r.name.toLowerCase().indexOf(q) >= 0; });
    if (hits.length < 8) IDX.forEach(function (r) { if (hits.indexOf(r) < 0 && r.hay.indexOf(q) >= 0) hits.push(r); });
    hits = hits.slice(0, 12); activeIdx = -1;
    results.innerHTML = hits.length ? hits.map(function (r) { return '<li data-id="' + r.id + '"><i class="sw" style="width:12px;height:12px;border-radius:50%;background:' + r.color + '"></i><span class="r-name">' + esc(r.name) + '</span><span class="r-sub">' + esc(r.sub) + '</span></li>'; }).join('') : '<li class="empty">No match</li>';
    results.hidden = false;
  }
  searchIn.addEventListener('input', doSearch);
  searchIn.addEventListener('focus', doSearch);
  searchIn.addEventListener('keydown', function (e) {
    var items = $$('li[data-id]', results);
    if (e.key === 'ArrowDown') { activeIdx = Math.min(items.length - 1, activeIdx + 1); } else if (e.key === 'ArrowUp') { activeIdx = Math.max(0, activeIdx - 1); }
    else if (e.key === 'Enter') { var it = items[activeIdx >= 0 ? activeIdx : 0]; if (it) pick(it.dataset.id); return; } else if (e.key === 'Escape') { results.hidden = true; searchIn.blur(); return; } else return;
    items.forEach(function (li, i) { li.classList.toggle('active', i === activeIdx); }); e.preventDefault();
  });
  results.addEventListener('click', function (e) { var li = e.target.closest('li[data-id]'); if (li) pick(li.dataset.id); });
  function pick(id) {
    results.hidden = true; searchIn.blur();
    var f = BY_ID[id];
    if (f && !inScope(f) && f.properties.layer !== 'poi') { state.scope = 'all'; state.preset = null; render(); toast('Filter widened to the whole report'); }
    if (f && ((f.properties.layer === 'b1_water' && !state.layers.b1) || (f.properties.layer === 'narrative_only' && !state.layers.narrative) || (f.properties.layer === 'access' && !state.layers.access))) {
      state.layers[f.properties.layer === 'access' ? 'access' : f.properties.layer === 'b1_water' ? 'b1' : 'narrative'] = true; render();
    }
    select(id, { zoom: 14 });
  }
  $('#search-clear').addEventListener('click', function () { searchIn.value = ''; results.hidden = true; });
  document.addEventListener('click', function (e) { if (!e.target.closest('.searchbar')) results.hidden = true; });

  // ------------------------------------------------------------ locate
  function locate(cb) {
    if (!navigator.geolocation) { toast('No geolocation on this device'); return; }
    toast('Finding you…');
    navigator.geolocation.getCurrentPosition(function (pos) {
      state.me = [pos.coords.latitude, pos.coords.longitude];
      G.me.clearLayers();
      L.circle(state.me, { radius: pos.coords.accuracy, color: '#1e88e5', weight: 1, fillOpacity: .08, interactive: false }).addTo(G.me);
      L.marker(state.me, { icon: L.divIcon({ className: 'pin me', html: '<div class="dot"></div>', iconSize: [44, 44], iconAnchor: [22, 22] }), interactive: false }).addTo(G.me);
      if (cb) cb(); else { map.setView(state.me, Math.max(map.getZoom(), 13)); toast('You are here (±' + Math.round(pos.coords.accuracy) + ' m)'); }
    }, function (err) { toast('Location unavailable: ' + err.message); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  }
  $('#btn-locate').addEventListener('click', function () { locate(); });

  // ------------------------------------------------------------ export
  function download(kind) {
    var text = window.Exporters[kind](SPOTS, OVR, { includeTemps: !!state.layers.temps });
    var blob = new Blob([text], { type: window.Exporters.mimes[kind] + ';charset=utf-8' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = window.Exporters.filenames[kind];
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast('Downloading ' + a.download);
  }
  $('#export-btns').addEventListener('click', function (e) { var b = e.target.closest('[data-export]'); if (b) download(b.dataset.export); });
  $('#btn-export').addEventListener('click', function () {
    openSheet('<div class="card"><h2>Export</h2><p class="muted small">Same serializer as the committed <code>exports/</code> files. Temperature sites are included only when that layer is on' + (state.layers.temps ? ' (on)' : ' (off)') + '.</p>' +
      '<div class="btnrow"><button class="btn primary" data-act="gpx">GPX</button><button class="btn primary" data-act="kml">KML</button><button class="btn" data-act="csv">CSV</button><button class="btn" data-act="geojson">GeoJSON</button></div>' +
      '<ul class="linklist"><li><b>GPX</b><small>Gaia GPS, onX, Garmin: waypoints + one track per matched stream</small></li><li><b>KML</b><small>Google My Maps → Create map → Import. One folder per layer</small></li><li><b>CSV</b><small>Spreadsheet, or My Maps import</small></li><li><b>GeoJSON</b><small>Everything incl. the overlays</small></li></ul>' +
      '<p class="muted small">Apple Maps has no bulk import — use "Apple pin" on a card, then Save.</p></div>');
  });
  var actions = { gpx: function () { download('gpx'); }, kml: function () { download('kml'); }, csv: function () { download('csv'); }, geojson: function () { download('geojson'); },
    'csv-row': function () { copyText($('#newrow').value); }, 'csv-gen': function () { genRow(); } };

  // ------------------------------------------------------------ long-press → CSV row
  var lp = null;
  map.on('contextmenu', function (e) {
    lp = e.latlng;
    var ll = e.latlng.lat.toFixed(6) + ', ' + e.latlng.lng.toFixed(6);
    openSheet('<div class="card"><h2>New point</h2><div class="muted small mono">' + ll + '</div>' +
      '<div class="segmented" id="np-kind"><button class="on" data-kind="stream">Stream</button><button data-kind="access">Access / parking</button></div>' +
      '<p><input id="np-name" placeholder="Name" style="width:100%;height:44px;font-size:16px;padding:0 10px;border:1px solid var(--line);border-radius:10px"></p>' +
      '<p><input id="np-notes" placeholder="Notes (optional)" style="width:100%;height:44px;font-size:16px;padding:0 10px;border:1px solid var(--line);border-radius:10px"></p>' +
      '<div class="btnrow"><button class="btn primary" data-act="csv-gen">Make CSV row</button></div>' +
      '<textarea id="newrow" class="mono small" style="width:100%;height:96px;border:1px solid var(--line);border-radius:10px;padding:8px" readonly placeholder="Row appears here"></textarea>' +
      '<div class="btnrow"><button class="btn" data-act="csv-row">📋 Copy row</button></div>' +
      '<p class="muted small">Paste into <code>data/streams.csv</code> or <code>data/access.csv</code>, then run <code>python3 scripts/build.py</code>.</p></div>');
    $$('#np-kind button').forEach(function (b) { b.addEventListener('click', function () { $$('#np-kind button').forEach(function (x) { x.classList.toggle('on', x === b); }); }); });
  });
  function genRow() {
    if (!lp) return;
    var kind = $('#np-kind .on').dataset.kind, name = ($('#np-name').value || 'New point').replace(/"/g, '""'), notes = ($('#np-notes').value || '').replace(/"/g, '""');
    var lat = lp.lat.toFixed(6), lng = lp.lng.toFixed(6), today = new Date().toISOString().slice(0, 10);
    var row = kind === 'stream'
      ? '"' + name + '",narrative_only,' + (state.scope === 'dog' ? 'Dog River' : 'Mad River') + ',BKT,no,no,no,' + lat + ',' + lng + ',"map long-press ' + today + '",low,"",' + '"' + notes + '"'
      : '"' + name + '",parking,' + lat + ',' + lng + ',"map long-press ' + today + '",low,"","",' + '"own observation ' + today + '","' + notes + '"';
    $('#newrow').value = row;
  }

  // ------------------------------------------------------------ info panel
  function infoHtml() {
    var c = META.counts, ov = META.overlay_sources || {};
    var legendRow = function (sw, txt) { return '<div class="row">' + sw + '<span>' + txt + '</span></div>'; };
    var h = '';
    h += '<h3>Legend</h3><div class="legend">';
    Object.keys(META.species).forEach(function (k) { h += legendRow('<i class="sw" style="background:' + META.species[k].color + '"></i>', esc(META.species[k].label) + ' <span class="muted">(' + esc(k) + ')</span>'); });
    h += legendRow('<i class="sw hollow" style="--c:#2e7d32"></i>', 'hollow = narrative-only tributary (no table row)');
    h += legendRow('<span class="tag b1" style="height:20px">B1</span>', 'B1 water: abundant wild trout, ≥1,000/mile or ≥200/mile over 6″; ★ spawning tributary; 🔒 private/ask first; <span class="tag warn" style="height:20px">verify</span> geocoded, unconfirmed');
    h += legendRow('<i class="sw" style="background:#6d4c41;border-radius:5px"></i>', 'trailhead') + legendRow('<i class="sw" style="background:#546e7a;border-radius:5px"></i>', 'parking') + legendRow('<i class="sw" style="background:#039be5;border-radius:5px"></i>', 'river access (VT badge = state fishing access area)') + legendRow('<i class="sw" style="background:#ef6c00;border-radius:5px"></i>', 'landmark');
    h += legendRow('<i class="sw sq" style="background:#1e88e5"></i>', '≤68 °F') + legendRow('<i class="sw sq" style="background:#26a69a"></i>', '68–72') + legendRow('<i class="sw sq" style="background:#fdd835"></i>', '72–75') + legendRow('<i class="sw sq" style="background:#fb8c00"></i>', '75–80') + legendRow('<i class="sw sq" style="background:#e53935"></i>', '>80 °F max 7-day average');
    h += '</div>';
    h += '<p class="small">Each stream point is the report\'s survey location or the downstream end of the proposed B1 reach — a point on the stream, not the whole stream. The coloured lines are the same streams from the VT Hydrography Dataset; thin light-blue lines are every other perennial stream (order ≥ 2) for context; the Mad below Warren and the Winooski are drawn in a plain lighter blue as mainstems.</p>';
    h += '<h3>Source</h3><p class="small">' + esc(META.report) + ' <a target="_blank" rel="noopener" href="' + esc(META.pdf_local) + '">Local copy</a> · <a target="_blank" rel="noopener" href="' + esc(META.pdf_url) + '">State URL</a>. Data as of 2017; populations swing year to year. Nearly all tributaries are managed as wild trout waters (not stocked). The Mad River is stocked from Warren to Moretown; above Warren Village it is managed for wild trout.</p>';
    h += '<p class="small">Brook trout thrive below 68 °F and tolerate brief periods up to 72 °F; browns and rainbows handle the low 80s briefly. Warm water is the main limit on brook trout. The report has no Mad River temperature sites; the coldest sites in the dataset are the upper Dog River in Roxbury (1,340 ft, never above 68.1 °F in four summers), about 25 min from Warren over Roxbury Gap.</p>';
    h += '<h3>Season &amp; regs</h3><p class="small">Vermont\'s harvest season on streams runs from the 2nd Saturday in April through Oct 31; most streams stay open the rest of the year for catch-and-release with artificial flies/lures only (<a target="_blank" rel="noopener" href="https://www.vtfishandwildlife.com/fish/fishing-opportunities/year-round-trout-fishing">year-round trout fishing</a>). <a target="_blank" rel="noopener" href="https://www.vtfishandwildlife.com/updated-fishing-regulations-overview">Regulation changes</a>. A Vermont fishing license is required.</p>';
    h += '<p class="small"><b>Special regs noted in the report:</b> Chase Brook (Dog River) closed until June 1; reduced harvest on 4.3 miles of the Dog River in Berlin <i>(verify current regs)</i>.</p>';
    h += '<p class="small"><b>Fall:</b> brook trout spawn in autumn — stay off clean, freshly turned gravel in the small brooks.</p>';
    h += '<h3>Land &amp; access</h3><p class="small">Vermont tradition/law is that unposted private land is open to fishing, but posted land is not — respect signs, ask when in doubt <i>(verify current law)</i>. Several trailheads here cross private land by permission (Hedgehog Brook, Millbrook Trailhead) — park only where signed.</p>';
    h += '<p class="small"><b>Cell service:</b> none at Lincoln Gap, App Gap, Big Basin Rd or in Granville Gulf — export to your phone app before you go (Layers → Export). This page caches itself for offline use when served over https.</p>';
    h += '<h3>Flows &amp; weather</h3><p class="small" id="info-live">USGS gauge 04288000, Mad River near Moretown — <a target="_blank" rel="noopener" href="https://waterdata.usgs.gov/monitoring-location/04288000/">waterdata.usgs.gov</a> <i>(verify ID)</i>.</p>';
    h += '<h3>Local</h3><ul class="linklist">' +
      '<li><a target="_blank" rel="noopener" href="https://thesilvertrout.com/fly-fishing-shop">The Silver Trout</a><small>Fly shop, 40 Bridge St Waitsfield — flies and current local advice</small></li>' +
      '<li><a target="_blank" rel="noopener" href="https://www.friendsofthemadriver.org">Friends of the Mad River</a><small>(verify)</small></li>' +
      '<li><a target="_blank" rel="noopener" href="https://madriverpath.org">Mad River Path Association</a><small>Trail maps, parking rules</small></li>' +
      '<li><a target="_blank" rel="noopener" href="https://www.madriverriders.org">Mad River Riders</a><small>Blueberry Lake trails</small></li>' +
      '<li><a target="_blank" rel="noopener" href="https://www.google.com/search?q=Trout+Unlimited+Mad+Dog+chapter+Vermont">Trout Unlimited "Mad Dog" chapter</a><small>(verify name/url)</small></li>' +
      '<li><a target="_blank" rel="noopener" href="https://newengland.com/travel/vermont/fall-in-mad-river-valley-vermont-turn-up-the-color/">Stream and Brook Fly Fishing (Middlebury)</a><small>Guides the Mad near Warren</small></li>' +
      '<li><a target="_blank" rel="noopener" href="https://vermontriverconservancy.org/sites/dog-river-jacuzzi-natural-area">Vermont River Conservancy — Dog River Jacuzzi</a><small>Berlin access</small></li></ul>';
    h += '<h3>Data &amp; provenance</h3><p class="small">Coordinates: <b>high</b> = straight from the report or a verified listing; <b>medium</b> = Google Places point for a natural feature (roughly on the stream); <b>low</b> = geocoded, estimated or flagged — shown dashed with a <i>verify</i> badge. Mad River (above Warren Village): the report\'s Table 11 coordinate (44.175722, −72.661631) lands in the Dog River valley and was rejected; the pin sits at Warren village.</p>';
    h += '<p class="small">Stream lines: ' + esc(ov.streams_named || '') + '.<br>Watersheds: ' + esc(ov.watersheds || '') + '.<br>Public land: ' + esc(ov.public_land || '') + '.<br>State fishing access: ' + esc(ov.fishing_access || '') + '.<br>OSM trails/parking: ' + esc(ov.osm_access || '') + '.<br>Drive times: ' + esc(META.drive_source) + ' (' + esc(META.drive_fetched || '') + '); "est." = straight-line × 1.35 at 30 mph.</p>';
    h += '<p class="small muted">Built ' + esc(META.generated) + ': ' + c.b1_water + ' B1 waters, ' + c.narrative_only + ' narrative-only tributaries, ' + c.access_curated + ' researched access points + ' + c.access_state + ' state access areas, ' + c.pois + ' POIs, ' + c.temperature_sites + ' temperature sites; ' + c.streams_with_line + '/' + (c.b1_water + c.narrative_only) + ' streams matched to a line' + (META.unmatched_streams.length ? ' (unmatched: ' + esc(META.unmatched_streams.map(function (u) { return u.stream; }).join(', ')) + ')' : '') + '. <a target="_blank" rel="noopener" href="https://github.com/TheKeeks/mad-river-brookies">Source code &amp; CSVs</a> · <a href="cheatsheet.html">printable cheat sheet</a>.</p>';
    return h;
  }
  $('#info-body').innerHTML = infoHtml();

  // ------------------------------------------------------------ live: USGS flow + NWS weather (fail silently)
  var live = { flow: null, stage: null, when: null, median: null, temp: null, sky: null };
  function liveLine() {
    var parts = [];
    if (live.flow != null) {
      var rel = '';
      if (live.median) { var r = live.flow / live.median; rel = r < .6 ? ' low' : r > 1.8 ? ' high' : ' ~normal'; }
      parts.push('Mad R @ Moretown <b>' + live.flow + ' cfs</b>' + rel + (live.stage != null ? ' · ' + live.stage + ' ft' : ''));
    }
    if (live.temp != null) parts.push(live.temp + '°F ' + esc(live.sky || ''));
    if (!parts.length) return;
    $('#live-line').innerHTML = '<a href="https://waterdata.usgs.gov/monitoring-location/04288000/" target="_blank" rel="noopener">' + parts.join(' · ') + '</a>';
    var il = $('#info-live');
    if (il) il.innerHTML = 'USGS 04288000, Mad River near Moretown: <b>' + (live.flow != null ? live.flow + ' cfs' : '?') + '</b>' + (live.stage != null ? ', gage ' + live.stage + ' ft' : '') + (live.median ? ' (long-term median for today ≈ ' + live.median + ' cfs)' : '') + (live.when ? ', as of ' + esc(live.when) : '') + ' — <a target="_blank" rel="noopener" href="https://waterdata.usgs.gov/monitoring-location/04288000/">waterdata.usgs.gov</a>. ' + (live.temp != null ? 'Now at the inn: ' + live.temp + ' °F, ' + esc(live.sky) + ' (<a target="_blank" rel="noopener" href="https://forecast.weather.gov/MapClick.php?lat=44.1677&lon=-72.8112">NWS forecast</a>).' : '');
  }
  function fetchLive() {
    if (!window.fetch) return;
    fetch('https://waterservices.usgs.gov/nwis/iv/?format=json&sites=04288000&parameterCd=00060,00065&siteStatus=all').then(function (r) { return r.json(); }).then(function (j) {
      (j.value.timeSeries || []).forEach(function (ts) {
        var code = ts.variable.variableCode[0].value, vals = ts.values[0].value; if (!vals.length) return;
        var v = vals[vals.length - 1];
        if (code === '00060') { live.flow = Math.round(parseFloat(v.value)); live.when = v.dateTime.replace('T', ' ').slice(0, 16); }
        if (code === '00065') live.stage = parseFloat(v.value).toFixed(2);
      });
      liveLine();
    }).catch(function () { });
    fetch('https://waterservices.usgs.gov/nwis/stat/?format=rdb&sites=04288000&statReportType=daily&statTypeCd=p50&parameterCd=00060').then(function (r) { return r.text(); }).then(function (t) {
      var d = new Date(), mm = d.getMonth() + 1, dd = d.getDate(), hdr = null;
      t.split('\n').forEach(function (line) {
        if (line.charAt(0) === '#') return; var c = line.split('\t');
        if (!hdr) { hdr = c; return; }
        if (c.length < hdr.length || /^\d+[sn]/.test(c[0])) return;
        var m = parseInt(c[hdr.indexOf('month_nu')], 10), day = parseInt(c[hdr.indexOf('day_nu')], 10);
        if (m === mm && day === dd) live.median = Math.round(parseFloat(c[hdr.indexOf('p50_va')]));
      });
      liveLine();
    }).catch(function () { });
    fetch('https://api.weather.gov/gridpoints/BTV/104,44/forecast/hourly', { headers: { 'Accept': 'application/geo+json' } }).then(function (r) { return r.json(); }).then(function (j) {
      var p = j.properties.periods[0]; live.temp = p.temperature; live.sky = p.shortForecast; liveLine();
    }).catch(function () { });
  }

  // ------------------------------------------------------------ service worker (https only; file:// and http localhost skip)
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(function () { });
  }

  // ------------------------------------------------------------ boot
  function boot() {
    var h = location.hash.replace(/^#/, ''), params = {};
    h.split('&').forEach(function (kv) { var p = kv.split('='); if (p[0]) params[p[0]] = decodeURIComponent(p[1] || ''); });
    var preset = PRESETS[params.p] ? params.p : 'basics';
    applyPreset(preset, !!params.f);
    if (params.f && BY_ID[params.f]) {
      var f = BY_ID[params.f];
      if (!inScope(f) && f.properties.layer !== 'poi') { state.scope = 'all'; state.preset = null; render(); }
      select(params.f, { zoom: 14 });
    }
    if (DESKTOP()) { L.control.zoom({ position: 'bottomright' }); }
    setTimeout(function () { map.invalidateSize(); }, 100);
    fetchLive();
  }
  window.addEventListener('resize', function () { map.invalidateSize(); });
  boot();
  window.MRB = { state: state, map: map, select: select, applyPreset: applyPreset, render: render, download: download, feats: FEATS };
})();
