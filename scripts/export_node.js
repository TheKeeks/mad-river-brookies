#!/usr/bin/env node
// Writes exports/* using the same serializer the browser uses (exporters.js).
// Called by scripts/build.py; can also be run directly: node scripts/export_node.js exports
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const outDir = path.resolve(process.argv[2] || path.join(root, 'exports'));
const ctx = { window: {} };
ctx.window.window = ctx.window;
vm.createContext(ctx);
for (const f of ['data/spots.js', 'data/overlays.js', 'exporters.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });
}
const w = ctx.window;
fs.mkdirSync(outDir, { recursive: true });
for (const k of ['gpx', 'kml', 'csv', 'geojson']) {
  const text = w.Exporters[k](w.SPOTS, w.OVERLAYS, { includeTemps: false });
  fs.writeFileSync(path.join(outDir, w.Exporters.filenames[k]), text);
  console.log(`  exports/${w.Exporters.filenames[k]}: ${(Buffer.byteLength(text) / 1024).toFixed(0)} kB`);
}
