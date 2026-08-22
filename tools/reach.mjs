/**
 * What fraction of the walkable map can actually REACH the player?
 *
 * chase.mjs measures real agents, but the mode spawns them at random points and
 * there is no seed, so two runs are not comparable and a change looks better or
 * worse by luck. This is deterministic: it flood-fills the nav graph using the
 * SAME neighbour rule A* uses, from the player's spawn cell, and reports how
 * much of the walkable world is connected to it.
 *
 * A cell that is walkable but not connected is a place an enemy can stand,
 * cannot leave, and will appear to "sit still" in exactly the way reported.
 */
import { chromium } from 'playwright';

const MAPS = (process.argv[2] ?? 'outpost,miami,zone,strike,holdout').split(',');
const BASE = process.argv[3] ?? 'http://127.0.0.1:5181/';

const b = await chromium.launch({ headless: true, args: ['--mute-audio'] });
const p = await b.newPage({ viewport: { width: 900, height: 560 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));

console.log('\nmap        walkable  reachable  isolated   %reached  islands');
let worst = 1;
for (const map of MAPS) {
  await p.goto(`${BASE}?map=${map}&menu=0`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction('!!window.__ENGINE__', null, { timeout: 300000 });
  await p.waitForTimeout(800);
  const r = await p.evaluate(() => {
    const e = window.__ENGINE__;
    const g = e.ctx.peek('ai').grid;
    const pl = e.ctx.peek('player');
    const L = g.layers ?? 1;
    const N = g.n ?? g.nx * g.nz;
    const total = N * L;
    const DX = [1, -1, 0, 0, 1, 1, -1, -1];
    const DZ = [0, 0, 1, -1, 1, -1, 1, -1];
    const ixOf = (i) => (g.ixOf ? g.ixOf(i) : i % g.nx);
    const izOf = (i) => (g.izOf ? g.izOf(i) : (i / g.nx) | 0);
    const near = (ix, iz, y) => {
      if (g.layerNear) return g.layerNear(ix, iz, y);
      if (!g.walkable(ix, iz)) return -1;
      const i = g.index(ix, iz);
      return Math.abs(g.floor[i] - y) <= g.maxStep ? i : -1;
    };

    let walkable = 0;
    for (let i = 0; i < total; i++) if (g.flags[i] !== 0) walkable++;

    const start = g.nearest(pl.position.x, pl.position.z, pl.position.y);
    if (start < 0) return { walkable, reachable: 0, islands: 0, noStart: true };

    const seen = new Uint8Array(total);
    const stack = [start];
    seen[start] = 1;
    let reached = 0;
    while (stack.length) {
      const cur = stack.pop();
      reached++;
      const cx = ixOf(cur), cz = izOf(cur), cy = g.floor[cur];
      for (let d = 0; d < 8; d++) {
        const ni = near(cx + DX[d], cz + DZ[d], cy);
        if (ni < 0 || seen[ni]) continue;
        seen[ni] = 1;
        stack.push(ni);
      }
    }

    // How many separate walkable islands exist at all, and how big?
    const sizes = [];
    let islands = 0;
    const seen2 = new Uint8Array(total);
    for (let s = 0; s < total; s++) {
      if (g.flags[s] === 0 || seen2[s]) continue;
      islands++;
      let size = 0;
      const st = [s];
      seen2[s] = 1;
      while (st.length) {
        size++;
        const cur = st.pop();
        const cx = ixOf(cur), cz = izOf(cur), cy = g.floor[cur];
        for (let d = 0; d < 8; d++) {
          const ni = near(cx + DX[d], cz + DZ[d], cy);
          if (ni < 0 || seen2[ni]) continue;
          seen2[ni] = 1;
          st.push(ni);
        }
      }
      sizes.push(size);
    }
    sizes.sort((a, c) => c - a);
    return { walkable, reachable: reached, islands, top: sizes.slice(0, 6) };
  });
  const pct = r.walkable ? (r.reachable / r.walkable) * 100 : 0;
  worst = Math.min(worst, pct / 100);
  console.log(
    `${map.padEnd(10)}${String(r.walkable).padStart(9)}${String(r.reachable).padStart(11)}` +
    `${String(r.walkable - r.reachable).padStart(10)}${(pct.toFixed(1) + '%').padStart(11)}${String(r.islands).padStart(9)}   top: ${(r.top ?? []).join(', ')}`
  );
}
await b.close();
