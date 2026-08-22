/**
 * Real GPU frame times, idle vs firing.
 *
 * Every other harness here runs headless, where WebGL is software-rasterised
 * and frame times are fiction. This one opens a REAL browser on the real GPU,
 * so the numbers mean something. It costs a visible window for ~30s.
 *
 * Measures three phases back to back so they share thermal and driver state:
 *   idle    standing still, not shooting        <- the baseline
 *   aim     tracking a live wave, not shooting  <- cost of enemies existing
 *   fire    tracking and holding the trigger    <- the reported symptom
 */
import { chromium } from 'playwright';

const MAP = process.argv[2] ?? 'outpost';
const PER = Number(process.argv[3] ?? 240);
const BASE = process.argv[4] ?? 'http://127.0.0.1:5181/';

const b = await chromium.launch({
  headless: false,
  args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required',
         '--window-position=0,0', '--window-size=1280,760'],
});
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
// Stamp hitches IN PAGE TIME so they can be attributed to a phase. The node-side
// console event fires too late to correlate.
await p.addInitScript(() => {
  window.__HITCH__ = [];
  window.__PHASE__ = 'boot';
  const o = console.log.bind(console);
  console.log = (...a) => {
    const s = String(a[0] ?? '');
    if (s.startsWith('[hitch]')) window.__HITCH__.push({ t: performance.now(), phase: window.__PHASE__, s: a.join(' ') });
    return o(...a);
  };
});

await p.goto(`${BASE}?map=${MAP}&mode=horde&menu=0`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction('!!window.__ENGINE__', null, { timeout: 300000 });
await p.mouse.click(640, 360);
await p.waitForTimeout(Number(process.env.SETTLE ?? 3000));

const r = await p.evaluate(
  ({ PER }) =>
    new Promise((done) => {
      const e = window.__ENGINE__;
      const ai = e.ctx.peek('ai');
      const pl = e.ctx.peek('player');
      const inp = e.ctx.input;
      const mv = pl.movement;
      const info = e.ctx.get('render').renderer.info;

      const phases = { idle: [], aim: [], fire: [] };
      const res = { idle: { geo: 0, tex: 0, prog: 0 }, aim: { geo: 0, tex: 0, prog: 0 }, fire: { geo: 0, tex: 0, prog: 0 } };
      let g = info.memory.geometries, t = info.memory.textures, pr = info.programs?.length ?? 0;
      const order = ['idle', 'aim', 'fire'];
      let ph = 0, i = 0, last = performance.now();
      let spawned = false;
      const calls = { idle: 0, aim: 0, fire: 0 };

      const tick = () => {
        const now = performance.now();
        const dt = now - last;
        last = now;
        const name = order[ph];
        window.__PHASE__ = name;
        const g2 = info.memory.geometries, t2 = info.memory.textures, p2 = info.programs?.length ?? 0;
        if (i > 3) { res[name].geo += Math.max(0, g2 - g); res[name].tex += Math.max(0, t2 - t); res[name].prog += Math.max(0, p2 - pr); }
        g = g2; t = t2; pr = p2;
        if (i > 3) { phases[name].push(+dt.toFixed(2)); calls[name] = info.render.calls; }

        if (name !== 'idle') {
          if (!spawned) {
            spawned = true;
            try { ai.populate({ squads: 3, perSquad: 3 }); } catch {}
            const live = ai.agents.filter((a) => a.alive);
            live.forEach((a, k) => {
              const ang = (k / live.length) * Math.PI * 2;
              a.position.set(pl.position.x + Math.sin(ang) * 9, pl.position.y, pl.position.z + Math.cos(ang) * 9);
            });
          }
          let best = null, bd = 1e9;
          for (const a of ai.agents) {
            if (!a.alive) continue;
            const d = a.position.distanceTo(pl.position);
            if (d < bd) { bd = d; best = a; }
          }
          if (best) {
            mv.yaw = Math.atan2(best.position.x - pl.position.x, best.position.z - pl.position.z);
            mv.pitch = Math.atan2(best.position.y + 1.0 - pl.position.y, bd);
          }
        }
        if (name === 'fire') {
          if (i % 50 === 0) inp._pendingDown.add('Mouse0');
          if (i % 50 === 42) inp._pendingUp.add('Mouse0');
        }

        if (++i >= PER) {
          inp._pendingUp.add('Mouse0');
          i = 0;
          if (++ph >= order.length) return done({ phases, calls, res, progTotal: info.programs?.length ?? 0, alive: ai.agents.filter((a) => a.alive).length, hitches: window.__HITCH__ });
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }),
  { PER }
);
const hitches = r.hitches ?? [];
await b.close();

const q = (a, f) => a.slice().sort((x, y) => x - y)[Math.floor(a.length * f)];
console.log(`\n${MAP} — REAL GPU frame times, ${PER} frames per phase\n`);
console.log('phase   p50      p90      p99      max      >20ms   >33ms   drawcalls   created late');
for (const k of ['idle', 'aim', 'fire']) {
  const a = r.phases[k];
  const over20 = a.filter((x) => x > 20).length;
  const over33 = a.filter((x) => x > 33).length;
  console.log(
    `${k.padEnd(8)}${q(a, .5).toFixed(1).padStart(5)}ms ${q(a, .9).toFixed(1).padStart(7)}ms ` +
    `${q(a, .99).toFixed(1).padStart(6)}ms ${Math.max(...a).toFixed(1).padStart(7)}ms ` +
    `${String(over20).padStart(6)} ${String(over33).padStart(7)}   ${String(r.calls[k]).padStart(6)}` +
    `   +${r.res[k].prog}prog +${r.res[k].geo}geo +${r.res[k].tex}tex`
  );
}
console.log(`\nenemies alive at end: ${r.alive}`);
if (hitches.length) { console.log(`\nengine [hitch] reports (${hitches.length}):`); for (const h of hitches.slice(0, 12)) console.log('  ' + h); }
