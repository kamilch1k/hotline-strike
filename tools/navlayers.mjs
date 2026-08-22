/**
 * How much walkable ground does the single-layer nav grid throw away?
 *
 * NavGrid.build() fires ONE ray down from above and takes the first surface as
 * "the floor". Under any solid overhang — a terrace, a catwalk, a roofed room —
 * that first surface is the overhang, so the real ground beneath it is never
 * registered and agents standing there have no cell to path from.
 *
 * This re-samples every cell, walking the ray DOWN through every surface, and
 * reports how many cells have walkable ground hidden underneath whatever the
 * grid picked. That number is the size of the hole in the AI's world.
 */
import { chromium } from 'playwright';

const MAPS = (process.argv[2] ?? 'outpost,miami,zone,strike,holdout').split(',');
const BASE = process.argv[3] ?? 'http://127.0.0.1:5181/';

const b = await chromium.launch({ headless: true, args: ['--mute-audio'] });
const p = await b.newPage({ viewport: { width: 900, height: 560 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));

console.log('\nmap        cells  grid-walkable  hidden-below  worst-drop  example');
for (const map of MAPS) {
  await p.goto(`${BASE}?map=${map}&menu=0`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction('!!window.__ENGINE__', null, { timeout: 300000 });
  await p.waitForTimeout(800);
  const r = await p.evaluate(() => {
    const e = window.__ENGINE__;
    const ai = e.ctx.peek('ai');
    const phys = e.ctx.peek('physics');
    const g = ai.grid;
    const MASK = phys.MASK.WORLD;
    let hidden = 0, worst = 0, example = null;
    for (let iz = 0; iz < g.nz; iz += 1) {
      for (let ix = 0; ix < g.nx; ix += 1) {
        const x = g.worldX(ix), z = g.worldZ(iz);
        const top = g.floor[g.index(ix, iz, 0)];
        if (!Number.isFinite(top)) continue;
        // Surfaces the grid ALREADY holds on some storey are not hidden.
        const known = [];
        for (let l = 0; l < (g.layers ?? 1); l++) {
          const f = g.floor[g.index(ix, iz, l)];
          if (Number.isFinite(f)) known.push(f);
        }
        // Walk down from just under the recorded floor looking for more surfaces.
        let y = top - 0.05;
        for (let guard = 0; guard < 6; guard++) {
          const hit = phys.raycast(x, y, z, 0, -1, 0, y - (-30), MASK);
          if (!hit.hit) break;
          const fy = hit.point.y;
          if (fy > y - 1e-3) { y = fy - 0.05; continue; }
          // is THIS surface stand-able?
          if (hit.normal.y >= g.maxSlope) {
            const up = phys.raycast(x, fy + 0.25, z, 0, 1, 0, g.height - 0.2, MASK);
            const clear = !up.hit || up.distance > g.crouchHeight - 0.25;
            if (clear) {
              if (known.some((k) => Math.abs(k - fy) < 0.2)) break;
              hidden++;
              const drop = top - fy;
              if (drop > worst) { worst = drop; example = { x: +x.toFixed(1), z: +z.toFixed(1), grid: +top.toFixed(2), real: +fy.toFixed(2) }; }
              break;
            }
          }
          y = fy - 0.05;
        }
      }
    }
    return { nx: g.nx, nz: g.nz, walkable: g.walkableCount, hidden, worst: +worst.toFixed(2), example };
  });
  console.log(
    `${map.padEnd(10)}${String(r.nx * r.nz).padStart(6)}${String(r.walkable).padStart(15)}` +
    `${String(r.hidden).padStart(14)}${String(r.worst + 'm').padStart(12)}  ` +
    (r.example ? `cell(${r.example.x},${r.example.z}) grid says ${r.example.grid}m, ground is ${r.example.real}m` : '-')
  );
}
await b.close();
