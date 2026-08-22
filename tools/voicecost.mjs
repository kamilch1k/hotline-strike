/**
 * Which VOICE builds the expensive frame?
 *
 * fireprofile.mjs found frames creating 226 Web Audio nodes in one go. That is
 * a synchronous main-thread stall on real hardware and invisible to
 * renderer.info. This attributes those operations to the voice kind that caused
 * them, by counting graph mutations across each `_build` call.
 */
import { chromium } from 'playwright';

const MAP = process.argv[2] ?? 'outpost';
const FRAMES = Number(process.argv[3] ?? 400);
const BASE = process.argv[4] ?? 'http://127.0.0.1:5181/';

const b = await chromium.launch({
  headless: true,
  args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'],
});
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.addInitScript(() => {
  window.__AC__ = { total: 0 };
  const proto = (globalThis.BaseAudioContext ?? globalThis.AudioContext)?.prototype;
  if (proto) for (const k of Object.getOwnPropertyNames(proto)) {
    if (!k.startsWith('create') || typeof proto[k] !== 'function') continue;
    const o = proto[k];
    proto[k] = function (...a) { window.__AC__.total++; return o.apply(this, a); };
  }
  const ap = globalThis.AudioNode?.prototype;
  if (ap) { const oc = ap.connect; ap.connect = function (...a) { window.__AC__.total++; return oc.apply(this, a); }; }
});
await p.goto(`${BASE}?map=${MAP}&mode=horde&menu=0`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction('!!window.__ENGINE__', null, { timeout: 300000 });
await p.mouse.click(640, 360);
await p.waitForFunction(() => window.__AUDIO__?.running === true, null, { timeout: 20000 }).catch(() => {});
await p.waitForFunction(() => window.__AUDIO__?.voiceBank?.banks?.size >= 7, null, { timeout: 90000 }).catch(() => {});
await p.waitForTimeout(800);

const r = await p.evaluate(
  ({ N }) =>
    new Promise((done) => {
      const e = window.__ENGINE__;
      const ai = e.ctx.peek('ai');
      const pl = e.ctx.peek('player');
      const audio = window.__AUDIO__;
      e.ctx.get('render').renderer.render = () => {};
      try { ai.populate({ squads: 3, perSquad: 3 }); } catch {}
      const live = ai.agents.filter((a) => a.alive);
      live.forEach((a, i) => {
        const ang = (i / live.length) * Math.PI * 2;
        a.position.set(pl.position.x + Math.sin(ang) * 7, pl.position.y, pl.position.z + Math.cos(ang) * 7);
      });

      const kinds = {};
      const o = audio._build.bind(audio);
      audio._build = (k, ...a) => {
        const before = window.__AC__.total;
        const v = o(k, ...a);
        const cost = window.__AC__.total - before;
        const s = (kinds[k] ??= { calls: 0, ops: 0, max: 0 });
        s.calls++; s.ops += cost; s.max = Math.max(s.max, cost);
        return v;
      };

      const inp = e.ctx.input;
      const perFrame = [];
      let i = 0, lastAc = window.__AC__.total;
      const tick = () => {
        const ac = window.__AC__.total;
        perFrame.push(ac - lastAc);
        lastAc = ac;
        if (i % 40 === 0) inp._pendingDown.add('Mouse0');
        if (i % 40 === 30) inp._pendingUp.add('Mouse0');
        if (++i >= N) { inp._pendingUp.add('Mouse0'); return done({ kinds, perFrame }); }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }),
  { N: FRAMES }
);
await b.close();

const f = r.perFrame.slice(3).sort((a, c) => a - c);
console.log(`\nops per frame: p50 ${f[f.length >> 1]}  p90 ${f[Math.floor(f.length * .9)]}  p99 ${f[Math.floor(f.length * .99)]}  max ${f[f.length - 1]}`);
console.log(`\nkind          calls    ops   ops/call   worst`);
const rows = Object.entries(r.kinds).sort((a, c) => c[1].ops - a[1].ops);
let tot = 0;
for (const [k, v] of rows) {
  tot += v.ops;
  console.log(`  ${k.padEnd(12)}${String(v.calls).padStart(5)}${String(v.ops).padStart(8)}${(v.ops / v.calls).toFixed(1).padStart(10)}${String(v.max).padStart(8)}`);
}
console.log(`  ${'TOTAL'.padEnd(12)}${''.padStart(5)}${String(tot).padStart(8)}`);
