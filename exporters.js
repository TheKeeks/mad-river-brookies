/* Shared export serializer: runs in the browser (Export buttons) and in Node
 * (scripts/export_node.js, called by scripts/build.py).  Output is
 * deterministic so the two are byte-identical.  Plain ES5-ish; no deps. */
(function (root) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fix(n, d) { return Number(n).toFixed(d === undefined ? 6 : d); }
  function pointFeatures(spots, opts) {
    return spots.features.filter(function (f) {
      return f.geometry.type === 'Point' && (opts.includeTemps || f.properties.layer !== 'temperature');
    });
  }
  function matchedLines(overlays) {
    return (overlays.streams_named ? overlays.streams_named.features : []).filter(function (f) {
      return f.properties.role === 'matched';
    });
  }
  function lineParts(geom) {
    return geom.type === 'LineString' ? [geom.coordinates] : geom.coordinates;
  }
  function speciesText(p) {
    if (p.layer === 'b1_water' || p.layer === 'narrative_only') {
      return (p.species && p.species.length ? p.species.join(', ') : 'no data') + (p.b1 ? ' | B1' : '');
    }
    return '';
  }
  function nearestText(p) {
    return (p.nearest_access || []).map(function (a) {
      return a.name + ' (' + a.walk_m + ' m, ' + a.drive_min + ' min)';
    }).join('; ');
  }
  function descText(p) {
    var parts = [];
    var s = speciesText(p); if (s) parts.push(s);
    if (p.type) parts.push(p.type.replace('_', ' '));
    if (p.category) parts.push(p.category.replace('_', ' '));
    if (p.watershed) parts.push(p.watershed + ' watershed');
    if (p.parking_notes) parts.push('Parking: ' + p.parking_notes);
    if (p.notes) parts.push(p.notes);
    var n = nearestText(p); if (n) parts.push('Nearest access: ' + n);
    if (p.source_label) parts.push('Source: ' + p.source_label + (p.source_url ? ' ' + p.source_url : ''));
    else if (p.source_ref) parts.push('Source: ' + p.source_ref);
    if (p.confidence) parts.push('Confidence: ' + p.confidence + (p.coord_source ? ' (' + p.coord_source + ')' : ''));
    if (p.drive_min != null) parts.push('Drive from inn: ' + p.drive_min + ' min' + (p.drive_src === 'est.' ? ' (est.)' : ''));
    return parts.join(' | ');
  }
  function sym(p) {
    if (p.layer === 'b1_water') return 'Fishing Area';
    if (p.layer === 'narrative_only') return 'Fishing Hot Spot Facility';
    if (p.layer === 'access') return p.type === 'parking' ? 'Parking Area' : p.type === 'trailhead' ? 'Trail Head' : p.type === 'river_access' ? 'Boat Ramp' : 'Scenic Area';
    if (p.layer === 'poi') return p.category === 'base' ? 'Residence' : p.category === 'fly_shop' ? 'Shopping Center' : p.category === 'lake' ? 'Fishing Area' : 'Scenic Area';
    if (p.layer === 'temperature') return 'Flag, Blue';
    return 'Waypoint';
  }

  // ------------------------------------------------------------------ GPX
  function gpx(spots, overlays, opts) {
    opts = opts || {};
    var out = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="mad-river-brookies (github.com/TheKeeks/mad-river-brookies)" xmlns="http://www.topografix.com/GPX/1/1">',
      '  <metadata><name>Upper Winooski / Mad River brook trout waters</name><desc>' + esc(spots.properties.report) + ' Built ' + esc(spots.properties.generated) + '.</desc></metadata>'];
    pointFeatures(spots, opts).forEach(function (f) {
      var p = f.properties, c = f.geometry.coordinates;
      out.push('  <wpt lat="' + fix(c[1]) + '" lon="' + fix(c[0]) + '">');
      out.push('    <name>' + esc(p.name) + '</name>');
      out.push('    <desc>' + esc(descText(p)) + '</desc>');
      if (p.source_url) out.push('    <link href="' + esc(p.source_url) + '"><text>' + esc(p.source_label || 'source') + '</text></link>');
      out.push('    <sym>' + esc(sym(p)) + '</sym>');
      out.push('    <type>' + esc(p.layer) + '</type>');
      out.push('  </wpt>');
    });
    var byId = {};
    spots.features.forEach(function (f) { byId[f.properties.name] = f.properties; });
    matchedLines(overlays).forEach(function (f) {
      var p = byId[f.properties.stream] || {};
      out.push('  <trk>');
      out.push('    <name>' + esc(f.properties.stream) + '</name>');
      out.push('    <desc>' + esc(speciesText(p) || 'stream line') + '</desc>');
      out.push('    <type>stream</type>');
      lineParts(f.geometry).forEach(function (part) {
        out.push('    <trkseg>');
        part.forEach(function (c) { out.push('      <trkpt lat="' + fix(c[1], 5) + '" lon="' + fix(c[0], 5) + '"/>'); });
        out.push('    </trkseg>');
      });
      out.push('  </trk>');
    });
    out.push('</gpx>');
    return out.join('\n') + '\n';
  }

  // ------------------------------------------------------------------ KML
  var LAYER_FOLDERS = [
    ['b1_water', 'B1 wild trout waters'], ['narrative_only', 'Other tributaries (narrative only)'],
    ['access', 'Access and parking'], ['poi', 'Points of interest'], ['temperature', 'Temperature sites']
  ];
  function kmlColor(hex, alpha) { // #rrggbb -> aabbggrr
    var r = hex.substr(1, 2), g = hex.substr(3, 2), b = hex.substr(5, 2);
    return (alpha || 'ff') + b + g + r;
  }
  function descHtml(p) {
    var h = [];
    if (p.species) h.push('<b>Species:</b> ' + esc(p.species.length ? p.species.join(', ') : 'no data') + (p.b1 ? ' &mdash; <b>B1</b>' : ''));
    if (p.type) h.push('<b>Type:</b> ' + esc(p.type.replace('_', ' ')));
    if (p.category) h.push('<b>Category:</b> ' + esc(p.category.replace('_', ' ')));
    if (p.watershed) h.push('<b>Watershed:</b> ' + esc(p.watershed));
    if (p.parking_notes) h.push('<b>Parking:</b> ' + esc(p.parking_notes));
    if (p.notes) h.push(esc(p.notes));
    if (p.nearest_access && p.nearest_access.length) {
      h.push('<b>Nearest access:</b><ul>' + p.nearest_access.map(function (a) {
        return '<li>' + esc(a.name) + ' &mdash; ' + a.walk_m + ' m as the crow flies, ' + a.drive_min + ' min drive</li>';
      }).join('') + '</ul>');
    }
    if (p.drive_min != null) h.push('<b>Drive from inn:</b> ' + p.drive_min + ' min' + (p.drive_src === 'est.' ? ' (est.)' : ''));
    if (p.max_temp_F != null) h.push('<b>Max temp:</b> ' + p.max_temp_F + ' &deg;F; <b>max 7-day avg:</b> ' + p.max_7day_avg_F + ' &deg;F (' + esc(p.years) + ')');
    if (p.source_url) h.push('<b>Source:</b> <a href="' + esc(p.source_url) + '">' + esc(p.source_label || p.source_ref) + '</a>');
    else if (p.source_ref) h.push('<b>Source:</b> ' + esc(p.source_ref));
    if (p.confidence) h.push('<b>Confidence:</b> ' + esc(p.confidence) + (p.coord_source ? ' (' + esc(p.coord_source) + ')' : ''));
    return h.join('<br/>');
  }
  function extData(p) {
    var keys = Object.keys(p).filter(function (k) { return k !== 'nearest_access'; }).sort();
    var out = ['      <ExtendedData>'];
    keys.forEach(function (k) {
      var v = p[k];
      if (Array.isArray(v)) v = v.join('; ');
      if (v === null || v === undefined) v = '';
      out.push('        <Data name="' + esc(k) + '"><value>' + esc(v) + '</value></Data>');
    });
    if (p.nearest_access) out.push('        <Data name="nearest_access"><value>' + esc(nearestText(p)) + '</value></Data>');
    out.push('      </ExtendedData>');
    return out.join('\n');
  }
  function kml(spots, overlays, opts) {
    opts = opts || {};
    var pts = pointFeatures(spots, opts);
    var styles = {};
    function styleId(p, kind) {
      var color = p.color || '#9e9e9e';
      var id = kind + '-' + color.substr(1);
      if (kind === 'pt') {
        var hollow = p.layer === 'narrative_only' || (p.layer === 'access' && false);
        id += hollow ? '-hollow' : '';
        styles[id] = '  <Style id="' + id + '"><IconStyle><color>' + kmlColor(color) + '</color><scale>' + (hollow ? '0.9' : '1.1') + '</scale>' +
          '<Icon><href>' + (hollow ? 'http://maps.google.com/mapfiles/kml/shapes/open-diamond.png' : 'http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png') + '</href></Icon></IconStyle>' +
          '<LabelStyle><scale>0.8</scale></LabelStyle></Style>';
      } else {
        styles[id] = '  <Style id="' + id + '"><LineStyle><color>' + kmlColor(color, 'e6') + '</color><width>4</width></LineStyle></Style>';
      }
      return id;
    }
    var folders = {};
    LAYER_FOLDERS.forEach(function (lf) { folders[lf[0]] = []; });
    pts.forEach(function (f) {
      var p = f.properties, c = f.geometry.coordinates;
      var sid = styleId(p, 'pt');
      folders[p.layer].push([
        '    <Placemark>',
        '      <name>' + esc(p.name) + '</name>',
        '      <description><![CDATA[' + descHtml(p) + ']]></description>',
        '      <styleUrl>#' + sid + '</styleUrl>',
        extData(p),
        '      <Point><coordinates>' + fix(c[0]) + ',' + fix(c[1]) + ',0</coordinates></Point>',
        '    </Placemark>'].join('\n'));
    });
    var byName = {};
    spots.features.forEach(function (f) { byName[f.properties.name] = f.properties; });
    var lines = matchedLines(overlays).map(function (f) {
      var p = byName[f.properties.stream] || { color: '#1565c0' };
      var sid = styleId(p, 'ln');
      var parts = lineParts(f.geometry).map(function (part) {
        return '        <LineString><tessellate>1</tessellate><coordinates>' + part.map(function (c) { return fix(c[0], 5) + ',' + fix(c[1], 5) + ',0'; }).join(' ') + '</coordinates></LineString>';
      });
      return ['    <Placemark>',
        '      <name>' + esc(f.properties.stream) + '</name>',
        '      <description><![CDATA[' + (speciesText(p) || 'stream') + '<br/>' + esc(overlays.streams_named.properties.source || '') + ']]></description>',
        '      <styleUrl>#' + sid + '</styleUrl>',
        '      <MultiGeometry>', parts.join('\n'), '      </MultiGeometry>',
        '    </Placemark>'].join('\n');
    });
    var out = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<kml xmlns="http://www.opengis.net/kml/2.2">', '<Document>',
      '  <name>Upper Winooski / Mad River brook trout waters</name>',
      '  <description><![CDATA[' + esc(spots.properties.report) + ' Built ' + esc(spots.properties.generated) + '. Stream lines: ' + esc(overlays.streams_named ? overlays.streams_named.properties.source : '') + ']]></description>'];
    Object.keys(styles).sort().forEach(function (k) { out.push(styles[k]); });
    LAYER_FOLDERS.forEach(function (lf) {
      if (!folders[lf[0]].length) return;
      out.push('  <Folder>', '    <name>' + esc(lf[1]) + '</name>');
      out.push(folders[lf[0]].join('\n'));
      out.push('  </Folder>');
    });
    if (lines.length) {
      out.push('  <Folder>', '    <name>Streams</name>');
      out.push(lines.join('\n'));
      out.push('  </Folder>');
    }
    out.push('</Document>', '</kml>');
    return out.join('\n') + '\n';
  }

  // ------------------------------------------------------------------ CSV
  var CSV_COLS = ['layer', 'name', 'lat', 'lng', 'type', 'category', 'watershed', 'species', 'b1', 'spawning_trib', 'private_flag',
    'serves', 'parking_notes', 'coord_source', 'confidence', 'source_ref', 'source_url', 'notes', 'drive_min_from_inn', 'drive_src',
    'nearest_access', 'river', 'elev_ft', 'years', 'max_temp_F', 'max_7day_avg_F'];
  function csvCell(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    if (Array.isArray(v)) v = v.join('; ');
    v = String(v);
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function csv(spots, overlays, opts) {
    opts = opts || {};
    var rows = [CSV_COLS.join(',')];
    pointFeatures(spots, opts).forEach(function (f) {
      var p = f.properties, c = f.geometry.coordinates;
      var r = {};
      CSV_COLS.forEach(function (k) { r[k] = p[k]; });
      r.lat = fix(c[1]); r.lng = fix(c[0]);
      r.drive_min_from_inn = p.drive_min;
      r.species = p.species ? (p.species.length ? p.species.join(', ') : 'no data') : '';
      r.nearest_access = nearestText(p);
      rows.push(CSV_COLS.map(function (k) { return csvCell(r[k]); }).join(','));
    });
    return rows.join('\n') + '\n';
  }

  // -------------------------------------------------------------- GeoJSON
  function geojson(spots, overlays, opts) {
    opts = opts || {};
    var fc = { type: 'FeatureCollection', properties: spots.properties, features: pointFeatures(spots, opts),
      overlays: {} };
    Object.keys(overlays).forEach(function (k) { fc.overlays[k] = overlays[k]; });
    return JSON.stringify(fc) + '\n';
  }

  root.Exporters = { gpx: gpx, kml: kml, csv: csv, geojson: geojson,
    filenames: { gpx: 'spots.gpx', kml: 'spots.kml', csv: 'spots.csv', geojson: 'spots.geojson' },
    mimes: { gpx: 'application/gpx+xml', kml: 'application/vnd.google-earth.kml+xml', csv: 'text/csv', geojson: 'application/geo+json' } };
})(typeof window !== 'undefined' ? window : (typeof module !== 'undefined' ? module.exports : this));
