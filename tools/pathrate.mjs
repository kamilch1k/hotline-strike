/**
 * What fraction of walkable pairs can A* actually connect?
 *
 * The prune guarantees one component under `edge()`, and A* walks `edge()`, so
 * this should be 100%. Anything less is A* failing on a graph it is supposed to
 * own - which is exactly what a silently-dropping heap looked like.
 */
import { chromium } from 'playwright';
const MAPS = (process.argv[2] ?? 'outpost,miami,holdout,zone,strike').split(',');
const N = Number(process.argv[3] ?? 200);
const b = await chromium.launch({ headless: true, args: ['--mute-audio'] });
const p = await b.newPage({ viewport: { width: 900, height: 560 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
console.log('\nmap        pairs  failed  worstNodes  medMs');
for (const m of MAPS) {
  await p.goto(`http://127.0.0.1:5181/?map=${m}&mode=horde&menu=0`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction('!!window.__ENGINE__', null, { timeout: 300000 });
  await p.waitForTimeout(1200);
  const r = await p.evaluate((N) => {
    const g = window.__ENGINE__.ctx.peek('ai').grid;
    const walk = [];
    for (let i = 0; i < g.n * g.layers; i++) if (g.flags[i] !== 0) walk.push(i);
    let fail = 0; const times = []; const detail = [];
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let k = 0; k < N; k++) {
      const a = walk[(rnd() * walk.length) | 0], c = walk[(rnd() * walk.length) | 0];
      const pa = { x: g.worldX(g.ixOf(a)), y: g.floor[a], z: g.worldZ(g.izOf(a)) };
      const pc = { x: g.worldX(g.ixOf(c)), y: g.floor[c], z: g.worldZ(g.izOf(c)) };
      const t = performance.now();
      if (g.findPath(pa, pc, []) === 0) {
        fail++;
        if (detail.length < 6) {
          const sa = g.nearest(pa.x, pa.z, pa.y), sc = g.nearest(pc.x, pc.z, pc.y);
          // Does a flood fill using the SAME edge() connect them?
          const seen = new Uint8Array(g.n * g.layers);
          const st = [sa]; seen[sa] = 1; let ok = false;
          while (st.length) {
            const cur = st.pop();
            if (cur === sc) { ok = true; break; }
            for (let d = 0; d < 8; d++) {
              const ni = g.edge(cur, d);
              if (ni < 0 || seen[ni]) continue;
              seen[ni] = 1; st.push(ni);
            }
          }
          detail.push({
            aNode: a, snapA: sa, snapALayer: sa >= 0 ? g.layerOf(sa) : null, aFlag: g.flags[a],
            cNode: c, snapC: sc, snapCLayer: sc >= 0 ? g.layerOf(sc) : null, cFlag: g.flags[c],
            snapMatchA: sa === a, snapMatchC: sc === c,
            floodConnects: ok,
            dist: +Math.hypot(pa.x - pc.x, pa.z - pc.z).toFixed(1),
          });
        }
      }
      times.push(performance.now() - t);
    }
    times.sort((x, y) => x - y);
    return { fail, med: +times[times.length >> 1].toFixed(2), walkable: walk.length, detail };
  }, N);
  console.log(`${m.padEnd(11)}${String(N).padStart(5)}${String(r.fail).padStart(8)}${String(r.walkable).padStart(12)}${String(r.med + 'ms').padStart(8)}`);
  if (r.detail?.length) for (const d of r.detail) console.log('    ' + JSON.stringify(d));
}
await b.close();
