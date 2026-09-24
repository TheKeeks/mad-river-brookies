#!/usr/bin/env node
// Browser acceptance test. Needs Playwright (npm i -D playwright) and a local server:
//   python3 -m http.server 8765 &  node scripts/test_browser.js [http://127.0.0.1:8765/index.html]
'use strict';
const path = require('path');
const fs = require('fs');
let pw;
try { pw = require('playwright'); } catch (e) { console.error('playwright not installed: npm i -D playwright'); process.exit(2); }
const ROOT = path.resolve(__dirname, '..');
const URL = process.argv[2] || 'http://127.0.0.1:8765/index.html';
let failed = 0;
const check = (name, ok, extra) => { console.log((ok ? 'ok   ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!ok) failed++; };

(async () => {
  const browser = await pw.chromium.launch();
  for (const url of [URL, 'file://' + path.join(ROOT, 'index.html')]) {
    const ctx = await browser.newContext({ ...pw.devices['iPhone 13'], viewport: { width: 375, height: 812 }, ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    console.log('\n== ' + url);
    const s = await page.evaluate(() => ({ preset: window.MRB.state.preset, scope: window.MRB.state.scope, pins: document.querySelectorAll('.pin').length, hscroll: document.documentElement.scrollWidth > 375, center: window.MRB.map.getCenter() }));
    check('Brookie basics preset at load, Mad River scope', s.preset === 'basics' && s.scope === 'mad');
    check('centered on Warren/Waitsfield', s.center.lat > 44.1 && s.center.lat < 44.22 && s.center.lng > -72.92 && s.center.lng < -72.78, JSON.stringify(s.center));
    check('no horizontal scroll at 375px', !s.hscroll);
    check('markers rendered', s.pins > 30, s.pins);
    await page.evaluate(() => window.MRB.select('s-clay-brook'));
    await page.waitForTimeout(500);
    const card = await page.evaluate(() => ({ h2: document.querySelector('#sheet h2').textContent, accs: document.querySelectorAll('#sheet .acc').length, dir: document.querySelector('#sheet .acc a.btn').href, sheet: document.getElementById('sheet').className, sheetTop: document.getElementById('sheet').getBoundingClientRect().top }));
    check('stream card opens as a bottom sheet with nearest access', card.h2 === 'Clay Brook' && card.accs >= 1 && card.sheet.indexOf('peek') >= 0);
    check('sheet does not cover the whole map', card.sheetTop > 300, card.sheetTop);
    check('directions link to the lot', /google\.com\/maps\/dir/.test(card.dir));
    await page.evaluate(() => window.MRB.select('s-mad-river-above-warren-village'));
    await page.waitForTimeout(300);
    check('Mad River card explains the rejected coordinate', await page.evaluate(() => /rejected/i.test(document.querySelector('#sheet .callout').textContent)));
    // tap a stream line
    await page.evaluate(() => { document.getElementById('sheet-close').click(); window.MRB.map.setView([44.137, -72.90], 14); });
    await page.waitForTimeout(700);
    const pt = await page.evaluate(() => {
      const m = window.MRB.map, sz = m.getSize(), mr = document.getElementById('map').getBoundingClientRect();
      const f = window.OVERLAYS.streams_named.features.find(x => x.properties.stream === 'Clay Brook');
      let best = null; f.geometry.coordinates.forEach(part => part.forEach(c => { const p = m.latLngToContainerPoint([c[1], c[0]]); const d = Math.hypot(p.x - sz.x / 2, p.y - sz.y / 2); if (p.x > 30 && p.y > 30 && p.x < sz.x - 30 && p.y < sz.y - 30 && (!best || d < best.d)) best = { p, d }; }));
      return { x: mr.x + best.p.x, y: mr.y + best.p.y };
    });
    await page.touchscreen.tap(pt.x, pt.y);
    await page.waitForTimeout(500);
    check('tapping a stream line selects and highlights it', await page.evaluate(() => window.MRB.state.selected === 's-clay-brook' && document.querySelectorAll('.leaflet-overlay-pane path[stroke="#fff"]').length > 0));
    // plan, search, presets, layers
    await page.click('.tab[data-tab=plan]'); await page.waitForTimeout(300);
    check('Plan list sorted by drive time', await page.evaluate(() => { const v = [...document.querySelectorAll('.plan-row .drive b')].map(b => +b.textContent); return v.length > 10 && v.every((x, i) => i === 0 || x >= v[i - 1]); }));
    await page.click('.tab[data-tab=map]');
    await page.fill('#search', 'hedgehog'); await page.waitForTimeout(200);
    await page.click('#search-results li'); await page.waitForTimeout(400);
    check('search opens an access card', await page.evaluate(() => /Hedgehog/.test(document.querySelector('#sheet h2').textContent)));
    await page.click('.chip[data-preset=dog]'); await page.waitForTimeout(500);
    check('Dog River preset filters', await page.evaluate(() => window.MRB.state.scope === 'dog' && document.querySelectorAll('.pin').length < 40));
    await page.click('.chip[data-preset=all]'); await page.waitForTimeout(1200);
    check('Everything preset shows all layers', await page.evaluate(() => window.MRB.state.layers.temps && window.MRB.state.layers.public && document.querySelectorAll('.pin').length > 100));
    await page.click('.tab[data-tab=layers]');
    await page.click('#layer-list input[data-layer=temps]'); await page.waitForTimeout(200);
    check('layer toggle off removes temperature sites', await page.evaluate(() => !window.MRB.state.layers.temps && document.querySelectorAll('.pin.temp').length === 0));
    // exports byte-identical
    const out = await page.evaluate(() => { const o = {}; ['gpx', 'kml', 'csv', 'geojson'].forEach(k => { o[k] = window.Exporters[k](window.SPOTS, window.OVERLAYS, { includeTemps: false }); }); return o; });
    for (const k of Object.keys(out)) check('browser ' + k + ' export identical to exports/', fs.readFileSync(path.join(ROOT, 'exports', 'spots.' + k), 'utf8') === out[k]);
    check('no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
  await browser.close();
  console.log(failed ? '\n' + failed + ' check(s) failed' : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
