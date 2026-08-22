/**
 * WHY IS SHOOTING A HITCH?
 *
 *   node tools/fireprofile.mjs outpost
 *
 * tools/fire-stutter.mjs already proved the trigger allocates nothing — no
 * geometry, no texture, no shader program. So the cost is WORK, and work needs
 * a sampling profiler, not a counter.
 *
 * Headless has no GPU, so anything under a `render`/`draw` frame is fiction.
 * Everything ABOVE it — audio graph construction, raycasts, agent updates,
 * particle rebuilds — is ordinary JS on an ordinary CPU and is measured
 * honestly. This starts the real V8 profiler, parks the player in front of a
 * live wave, holds the trigger, and reports self-time by function.
 */
import { chromium } from 'playwright';

const MAP = process.argv[2] ?? 'outpost';
const FRAMES = Number(process.argv[3] ?? 320);
const BASE = process.argv[4] ?? 'http://127.0.0.1:5181/';

const b = await chromium.launch({
  headless: true,
  args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'],
});
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto(`${BASE}?map=${MAP}&mode=horde&menu=0`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction('!!window.__ENGINE__', null, { timeout: 300000 });
await p.mouse.click(640, 360);
await p.waitForFunction(() => window.__AUDIO__?.running === true, null, { timeout: 20000 }).catch(() => {});
// Let the shot bank finish baking so the bake is not blamed on the firefight.
await p.waitForFunction(() => window.__AUDIO__?.voiceBank?.banks?.size >= 7, null, { timeout: 90000 }).catch(() => {});
await p.waitForTimeout(800);

// Drag a wave into the player's face so the trigger actually connects.
await p.evaluate(() => {
  const e = window.__ENGINE__;
  const ai = e.ctx.peek('ai');
  const pl = e.ctx.peek('player');
  try { ai.populate({ squads: 3, perSquad: 3 }); } catch {}
  const live = ai.agents.filter((a) => a.alive);
  live.forEach((a, i) => {
    const ang = (i / live.length) * Math.PI * 2;
    a.position.set(pl.position.x + Math.sin(ang) * 7, pl.position.y, pl.position.z + Math.cos(ang) * 7);
  });
});

// Rendering is a software rasteriser here and swamps every sample with
// `(program)`. Stub it: the question is what the SIMULATION costs on the frame
// you pull the trigger, and that is ordinary JS.
await p.evaluate(() => {
  const r = window.__ENGINE__.ctx.get('render').renderer;
  window.__AC__ = { total: 0, byFrame: [] };
  const proto = (globalThis.BaseAudioContext ?? globalThis.AudioContext)?.prototype;
  if (proto) for (const k of Object.getOwnPropertyNames(proto)) {
    if (!k.startsWith('create') || typeof proto[k] !== 'function') continue;
    const o = proto[k];
    proto[k] = function (...a) { window.__AC__.total++; return o.apply(this, a); };
  }
  const ap = globalThis.AudioNode?.prototype;
  if (ap) { const oc = ap.connect; ap.connect = function (...a) { window.__AC__.total++; return oc.apply(this, a); }; }
  r.render = () => {};
});

const cdp = await p.context().newCDPSession(p);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 120 });
await cdp.send('Profiler.start');

const frames = await p.evaluate(
  ({ N }) =>
    new Promise((done) => {
      const eng = window.__ENGINE__;
      const inp = eng.ctx.input;
      const info = eng.ctx.get('render').renderer.info;
      const ai = eng.ctx.peek('ai');
      const out = [];
      let g = info.memory.geometries, t = info.memory.textures, pr = info.programs?.length ?? 0;
      let i = 0;
      let last = performance.now();
      let lastAc = window.__AC__.total;
      const tick = () => {
        const now = performance.now();
        const ac = window.__AC__.total;
        const g2 = info.memory.geometries, t2 = info.memory.textures, p2 = info.programs?.length ?? 0;
        out.push([+(now - last).toFixed(2), ac - lastAc, g2 - g, t2 - t, p2 - pr,
          ai?.agents?.filter((a) => a.alive).length ?? 0, info.render.calls]);
        last = now; lastAc = ac; g = g2; t = t2; pr = p2;
        // Held trigger with brief releases: semi-auto weapons need the edge,
        // and "starting to shoot" is itself the reported symptom.
        // AIM. Without this the trigger fires into empty air and the whole
        // hit path — blood, decals, hitmarker, death, ragdoll — never runs,
        // which is precisely the path the stutter was reported on.
        const mv = eng.ctx.peek('player')?.movement;
        const me = eng.ctx.peek('player')?.position;
        if (mv && me) {
          let best = null, bd = 1e9;
          for (const a of ai?.agents ?? []) {
            if (!a.alive) continue;
            const d = a.position.distanceTo(me);
            if (d < bd) { bd = d; best = a; }
          }
          if (best) {
            mv.yaw = Math.atan2(best.position.x - me.x, best.position.z - me.z);
            mv.pitch = Math.atan2((best.position.y + 1.0) - me.y, bd);
          }
        }
        if (i % 40 === 0) inp._pendingDown.add('Mouse0');
        if (i % 40 === 30) inp._pendingUp.add('Mouse0');
        if (++i >= N) { inp._pendingUp.add('Mouse0'); return done(out); }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }),
  { FRAMES, N: FRAMES }
);

const { profile } = await cdp.send('Profiler.stop');
await b.close();

// --- frame time distribution (CPU-side only, but real) ---
const audioOps = frames.slice(5).map((f) => f[1]);
const s = frames.slice(5).map((f) => f[0]).sort((a, c) => a - c);
const q = (f) => s[Math.floor(s.length * f)];
console.log(`\nframe deltas over ${s.length} frames (headless CPU, no GPU)`);
console.log(`  p50 ${q(0.5).toFixed(1)}ms   p90 ${q(0.9).toFixed(1)}ms   p99 ${q(0.99).toFixed(1)}ms   max ${s[s.length - 1].toFixed(1)}ms`);

const acTot = audioOps.reduce((a, x) => a + x, 0);
const acMax = Math.max(...audioOps);
const acSorted = audioOps.slice().sort((a, c) => a - c);
console.log(`audio graph ops: ${acTot} total, ${(acTot / audioOps.length).toFixed(1)}/frame avg, p99 ${acSorted[Math.floor(acSorted.length * 0.99)]}, max ${acMax} in one frame`);

const worst = frames.map((f, n) => [n, ...f]).sort((a, c) => c[1] - a[1]).slice(0, 8);
console.log(`
worst frames        ms   audioOps  +geo  +tex  +prog  alive  calls`);
for (const w of worst)
  console.log(`  frame ${String(w[0]).padStart(4)}  ${String(w[1]).padStart(8)}${String(w[2]).padStart(11)}${String(w[3]).padStart(6)}${String(w[4]).padStart(6)}${String(w[5]).padStart(7)}${String(w[6]).padStart(7)}${String(w[7]).padStart(7)}`);
const tg = frames.reduce((a, f) => a + Math.max(0, f[2]), 0);
const tt = frames.reduce((a, f) => a + Math.max(0, f[3]), 0);
const tp = frames.reduce((a, f) => a + Math.max(0, f[4]), 0);
console.log(`
created while firing at enemies: geometries +${tg}  textures +${tt}  programs +${tp}`);

// --- self time by function ---
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
const total = profile.samples.length;
for (const id of profile.samples) {
  const n = byId.get(id);
  if (!n) continue;
  const cf = n.callFrame;
  const file = (cf.url || '').split('/').slice(-2).join('/').split('?')[0];
  const key = `${cf.functionName || '(anon)'}  ${file}:${cf.lineNumber + 1}`;
  self.set(key, (self.get(key) ?? 0) + 1);
}
console.log(`\nself time while firing (${total} samples)`);
for (const [k, v] of [...self.entries()].sort((a, c) => c[1] - a[1]).slice(0, 22)) {
  const pct = (v / total) * 100;
  if (pct < 0.4) break;
  console.log(`  ${pct.toFixed(1).padStart(5)}%  ${k}`);
}
