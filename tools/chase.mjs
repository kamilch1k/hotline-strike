/**
 * IF I STAND STILL, DOES THE GAME COME TO ME?
 *
 * tools/aicheck.mjs says the AI is perfect. The player says enemies sit still.
 * aicheck is the one that is wrong: it calls `ai.populate()` itself, which drops
 * agents near a parked player with clean line of sight, and then congratulates
 * them for walking downhill. That is not the failure mode being reported.
 *
 * This changes nothing and spawns nothing. It boots a NORMAL match, parks the
 * player, and watches whoever the mode's own spawner produces — the enemies the
 * player actually meets, at the distances the map actually creates. Then it asks
 * the only question that matters:
 *
 *   how many of them ever reach me?
 *
 * Per agent: closest approach, net closing, path length, and where it gave up.
 */
import { chromium } from 'playwright';

const MAP = process.argv[2] ?? 'outpost';
const MODE = process.argv[3] ?? 'horde';
const SECONDS = Number(process.argv[4] ?? 45);
const BASE = process.argv[5] ?? 'http://127.0.0.1:5181/';

const b = await chromium.launch({ headless: !process.env.HEADED, args: ['--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1000, height: 620 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto(`${BASE}?map=${MAP}&mode=${MODE}&menu=0`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction('!!window.__ENGINE__', null, { timeout: 300000 });
await p.waitForTimeout(2000);

const r = await p.evaluate(
  (secs) =>
    new Promise((done) => {
      const e = window.__ENGINE__;
      const ai = e.ctx.peek('ai');
      const pl = e.ctx.peek('player');
      const phys = e.ctx.peek('physics');
      e.ctx.get('render').renderer.render = () => {};

      /**
       * PIN THE PLAYER. There is no seed parameter, so the spawn point moves
       * between runs and two measurements of the same build differ by more than
       * the change being measured. Teleport takes an EYE position and a yaw
       * NUMBER; the cell is chosen deterministically from the grid.
       */
      const gi = ai.grid.nearest(0, 0, 0, 24);
      if (gi >= 0) {
        const px = ai.grid.worldX(ai.grid.ixOf ? ai.grid.ixOf(gi) : gi % ai.grid.nx);
        const pz = ai.grid.worldZ(ai.grid.izOf ? ai.grid.izOf(gi) : (gi / ai.grid.nx) | 0);
        pl.teleport({ x: px, y: ai.grid.floor[gi] + 1.66, z: pz }, 0);
      }

      // Track every agent the MODE spawns, by identity, for its whole life.
      const track = new Map();
      const t0 = performance.now();
      let tPrev = t0;

      const tick = () => {
        const now = performance.now();
        const t = now - t0;
        tPrev = now;

        for (const a of ai.agents) {
          if (!a.alive) continue;
          let s = track.get(a);
          const d = a.position.distanceTo(pl.position);
          if (!s) {
            s = { first: d, min: d, last: d, path: 0, prev: a.position.clone(),
                  variant: a.variantName ?? '?', states: new Set(), bornAt: t, sunk: 0 };
            track.set(a, s);
          }
          s.path += a.position.distanceTo(s.prev);
          s.prev.copy(a.position);
          s.min = Math.min(s.min, d);
          s.last = d;
          s.states.add(a.state);
          const gy = phys?.groundHeight?.(a.position.x, a.position.z, a.position.y + 8);
          if (Number.isFinite(gy)) s.sunk = Math.max(s.sunk, gy - a.position.y);
        }

        if (t > secs * 1000) {
          const rows = [...track.values()].map((s) => ({
            variant: s.variant,
            first: +s.first.toFixed(1),
            min: +s.min.toFixed(1),
            last: +s.last.toFixed(1),
            path: +s.path.toFixed(1),
            sunk: +s.sunk.toFixed(2),
            states: [...s.states].join('/'),
            secs: +((secs * 1000 - s.bornAt) / 1000).toFixed(1),
          }));
          return done({ rows, alive: ai.agents.filter((x) => x.alive).length });
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }),
  SECONDS
);
await b.close();

const rows = r.rows;
if (!rows.length) { console.log('no agents were ever spawned by the mode'); process.exit(0); }
console.log(`\n${MAP}/${MODE} — player stood still for ${SECONDS}s, ${rows.length} agents observed\n`);
console.log('variant     alive  spawned@  closest  ended@  walked  sunk  states');
for (const x of rows.sort((a, c) => a.min - c.min)) {
  console.log(
    `${String(x.variant).padEnd(11)}${String(x.secs + 's').padStart(6)}` +
    `${String(x.first + 'm').padStart(10)}${String(x.min + 'm').padStart(9)}${String(x.last + 'm').padStart(8)}` +
    `${String(x.path + 'm').padStart(8)}${String(x.sunk).padStart(6)}  ${x.states}`
  );
}
const reached = rows.filter((x) => x.min < 3).length;
const stalled = rows.filter((x) => x.path < 3).length;
const gaveUp = rows.filter((x) => x.min > 8 && x.path > 5).length;
console.log(`\nreached the player (<3m): ${reached}/${rows.length}`);
console.log(`never really moved (<3m walked): ${stalled}/${rows.length}`);
console.log(`walked but never arrived (>8m closest): ${gaveUp}/${rows.length}`);
console.log(`median closest approach: ${rows.map((x) => x.min).sort((a, c) => a - c)[rows.length >> 1]}m`);
