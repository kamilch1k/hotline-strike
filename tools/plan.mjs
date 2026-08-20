/**
 * Draw an arena as a top-down floorplan, from its own row data and the LIVE nav
 * grid, as SVG.
 *
 *   node tools/plan.mjs miami            -> plan-miami.svg
 *   node tools/plan.mjs zone plan.svg
 *
 * WHY THIS EXISTS. A map is 130 rows of `[x, z, w, d, h, rot, mat, y]` and no
 * amount of reading them tells you whether the thing they describe is a place.
 * An in-game screenshot does not answer it either: there is a viewmodel across a
 * third of the frame, and a render cannot show what the PATHFINDER believes the
 * floor is. So the nav cells are the bottom layer here and the geometry is drawn
 * over them — a surface that renders but is not walkable shows up as a hole, and
 * a doorway something is quietly blocking shows up as a wall.
 *
 * It found exactly that on its first run: a decorative glass panel 8 m wide
 * across a face whose doors were cut at x = +/-2.8..5.2, sealing both of the
 * penthouse's front entrances. Everything still pathed — around the flanks — so
 * it read as a long walk in play and was invisible in the numbers.
 *
 * LEVEL SPACE vs WORLD SPACE, which is the trap this tool exists to avoid.
 * Rows in arenas.js are authored in LEVEL space. The whole arena is then rotated
 * into the scene by LEVEL_YAW (0.5877 rad) and translated — so the nav grid,
 * physics and every agent position are in WORLD space, where level (-22, 27) is
 * world (-2.4, 36.0). Probing the grid with authoring coordinates reads a
 * different part of the map entirely and reports confident nonsense. The cells
 * are converted back through `world.worldToLevel` before they are drawn.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const MAP = process.argv[2] ?? 'miami';
const OUT = process.argv[3] ?? `plan-${MAP}.svg`;
const BASE = process.argv[4] ?? 'http://127.0.0.1:5181/';

const browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${BASE}?map=${MAP}&menu=0`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('!!window.__ENGINE__', null, { timeout: 300000 });
await page.waitForTimeout(1200);

const d = await page.evaluate(async (MAP) => {
  const mod = await import('/src/world/arenas.js');
  const spec = mod.ARENAS[MAP];
  if (!spec) return { error: `unknown map "${MAP}"`, available: Object.keys(mod.ARENAS) };
  const ctx = window.__ENGINE__.ctx;
  const g = ctx.peek('ai').grid;
  const world = ctx.peek('world');
  const half = [spec.floor[0] / 2 + 2, spec.floor[1] / 2 + 2];
  const cells = [];
  for (let iz = 0; iz < g.nz; iz++) {
    for (let ix = 0; ix < g.nx; ix++) {
      const lv = world.worldToLevel(g.worldX(ix), 0, g.worldZ(iz));
      if (Math.abs(lv.x) > half[0] || Math.abs(lv.z) > half[1]) continue;
      const i = g.index(ix, iz);
      const fl = g.floor[i];
      if (!g.flags[i] && !(fl > -900)) continue;
      cells.push([+lv.x.toFixed(2), +lv.z.toFixed(2), g.flags[i], Number.isFinite(fl) ? +fl.toFixed(2) : null]);
    }
  }
  return { floor: spec.floor, cell: g.cell, rows: spec.walls, cells, spawns: spec.spawns };
}, MAP);
await browser.close();

if (d.error) {
  console.error(d.error, d.available ? `— have: ${d.available.join(', ')}` : '');
  process.exit(1);
}

const M = 46;
const S = 11; // px per metre
const W = d.floor[0], H = d.floor[1];
const PX = W * S + M * 2, PY = H * S + M * 2;
// +z is NORTH and is drawn UP, so z flips.
const sx = (x) => M + (x + W / 2) * S;
const sy = (z) => M + (H / 2 - z) * S;

const o = [];
o.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${PX}" height="${PY}" viewBox="0 0 ${PX} ${PY}" font-family="ui-monospace,Menlo,monospace">`);
o.push(`<rect width="${PX}" height="${PY}" fill="#0d1117"/>`);

/**
 * One band per ELEVATION the map actually uses, not per arbitrary slice. A
 * single ">1.4" bucket painted the 1.4 wings, the 2.8 deck and the 4.2 antenna
 * the same green and made a four-level map look like one plateau — which is the
 * exact mistake the render exists to catch.
 */
const byHeight = (h) =>
  h === null ? '#3a1d24'
  : h < 0.35 ? '#16202c'  // yard / canyon floor
  : h < 1.2 ? '#1f4d63'   // 0.8 terrace
  : h < 1.85 ? '#2f7d78'  // 1.6 terrace
  : h < 2.25 ? '#3f9b6b'  // 2.0 dock
  : h < 2.9 ? '#6cb85e'   // 2.4 court
  : h < 3.6 ? '#a8cc5c'   // 3.2 station
  : '#e8d46a';            // anything above

const c = d.cell * S;
o.push('<g shape-rendering="crispEdges">');
for (const [x, z, flag, fl] of d.cells) {
  // flag 0 = the grid found a surface and refuses to walk it. Red on purpose.
  o.push(`<rect x="${(sx(x) - c / 2).toFixed(1)}" y="${(sy(z) - c / 2).toFixed(1)}" width="${c.toFixed(1)}" height="${c.toFixed(1)}" fill="${flag === 0 ? '#5c1f2b' : byHeight(fl)}"/>`);
}
o.push('</g>');

// Geometry, stroked by how tall it stands: full wall, tall prop, chest cover,
// vaultable, or a surface decal you cannot interact with at all.
const stroke = (h, y) => {
  const top = h + (y || 0);
  return top >= 2.4 ? '#f2f5f7' : top >= 1.5 ? '#9fd0e6' : top >= 0.9 ? '#ffb26b' : top >= 0.4 ? '#ffe27a' : '#7c8b99';
};
o.push('<g fill="none" stroke-width="1.2">');
for (const row of d.rows) {
  // Object rows are slopes and roofs (see arenas.js). They are drawn
  // differently on purpose: a roof is the one thing on the plan that is NOT
  // underfoot, and a slope needs to be told apart from a flat pad at a glance.
  if (!Array.isArray(row)) {
    if (row.slope) {
      const w = row.dir === 'x' ? row.len : row.w;
      const dd = row.dir === 'x' ? row.w : row.len;
      const sg = row.sign ?? 1;
      const cx = sx(row.x + (row.dir === 'x' ? (sg * row.len) / 2 : 0));
      const cy = sy(row.z + (row.dir === 'z' ? (sg * row.len) / 2 : 0));
      o.push(`<rect x="${(cx - w * S / 2).toFixed(1)}" y="${(cy - dd * S / 2).toFixed(1)}" width="${(w * S).toFixed(1)}" height="${(dd * S).toFixed(1)}" stroke="#c07be0" stroke-dasharray="5 3"/>`);
      o.push(`<text x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" font-size="9" fill="#c07be0" text-anchor="middle">ramp ${row.rise}m</text>`);
    } else if (row.roof) {
      const cx = sx(row.x), cy = sy(row.z);
      o.push(`<rect x="${(cx - row.w * S / 2).toFixed(1)}" y="${(cy - row.d * S / 2).toFixed(1)}" width="${(row.w * S).toFixed(1)}" height="${(row.d * S).toFixed(1)}" stroke="#7de0c0" stroke-dasharray="2 4" opacity="0.85"/>`);
      o.push(`<text x="${cx.toFixed(1)}" y="${(cy - row.d * S / 2 + 11).toFixed(1)}" font-size="9" fill="#7de0c0" text-anchor="middle">roof ${row.y}m</text>`);
    }
    continue;
  }
  const [x, z, w, dd, h, ry, , y] = row;
  const cx = sx(x), cy = sy(z);
  const rot = ry ? ` transform="rotate(${(-ry * 180 / Math.PI).toFixed(2)} ${cx.toFixed(1)} ${cy.toFixed(1)})"` : '';
  o.push(`<rect x="${(cx - w * S / 2).toFixed(1)}" y="${(cy - dd * S / 2).toFixed(1)}" width="${(w * S).toFixed(1)}" height="${(dd * S).toFixed(1)}"${rot} stroke="${stroke(h, y)}" opacity="${(h + (y || 0)) < 0.4 ? 0.45 : 0.95}"/>`);
}
o.push('</g>');

o.push('<g>');
for (const [x, z, , name] of d.spawns ?? []) {
  o.push(`<circle cx="${sx(x).toFixed(1)}" cy="${sy(z).toFixed(1)}" r="4.5" fill="#ffd166" stroke="#0d1117" stroke-width="1.5"/>`);
  o.push(`<text x="${(sx(x) + 7).toFixed(1)}" y="${(sy(z) + 3.5).toFixed(1)}" font-size="9" fill="#ffd166">${name ?? ''}</text>`);
}
o.push('</g>');

o.push('<g stroke="#2a3441" stroke-width="0.6" opacity="0.7">');
for (let v = -Math.floor(W / 2 / 10) * 10; v <= W / 2; v += 10) {
  o.push(`<line x1="${sx(v)}" y1="${M}" x2="${sx(v)}" y2="${PY - M}"/>`);
  o.push(`<line x1="${M}" y1="${sy(v)}" x2="${PX - M}" y2="${sy(v)}"/>`);
}
o.push('</g><g font-size="9" fill="#5b6b7c">');
for (let v = -Math.floor(W / 2 / 10) * 10; v <= W / 2; v += 10) {
  o.push(`<text x="${sx(v) + 2}" y="${PY - M + 12}">${v}</text>`);
  o.push(`<text x="${M - 22}" y="${sy(v) + 3}">${v}</text>`);
}
o.push('</g>');

o.push(`<g font-size="10"><text x="${M}" y="20" font-size="13" fill="#e6edf3">${MAP.toUpperCase()} — floorplan over nav grid (north up, level space)</text>`);
[['#5c1f2b', 'NOT walkable'], ['#16202c', '0 yard'], ['#1f4d63', '0.8'], ['#2f7d78', '1.6'],
 ['#3f9b6b', '2.0'], ['#6cb85e', '2.4'], ['#a8cc5c', '3.2'], ['#e8d46a', 'higher']]
  .forEach(([col, label], i) => {
    const lx = M + i * 98;
    o.push(`<rect x="${lx}" y="26" width="10" height="10" fill="${col}"/><text x="${lx + 14}" y="34" fill="#8b98a5">${label}</text>`);
  });
o.push('</g></svg>');

writeFileSync(OUT, o.join('\n'));
console.log(`${MAP}: ${d.rows.length} rows, ${d.cells.length} nav cells -> ${OUT}`);
