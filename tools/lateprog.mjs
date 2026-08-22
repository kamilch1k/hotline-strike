/**
 * WHICH shader compiles mid-fight?
 *
 * tools/hitchlog.mjs (HEADED=1) reproduces a 253 ms freeze during a horde
 * match, attributed to `render` with `+1 programs`. That is a shader the
 * prewarm pass missed being translated by the driver on the frame it is first
 * drawn — a quarter-second stall, on the real GPU, in normal play.
 *
 * This plays the same session and names the offender: every program that
 * appears AFTER boot, with its shader name, its material, and the wall time the
 * frame cost. Feed the answer back into the prewarm pass.
 */
import { chromium } from 'playwright';

const URL = process.argv[2] ?? 'http://127.0.0.1:5181/?map=outpost&mode=horde&menu=0';
const SECONDS = Number(process.argv[3] ?? 45);

const b = await chromium.launch({
  headless: !!process.env.HEADLESS,
  args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required',
         '--window-position=0,0', '--window-size=1280,760'],
});
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));

await p.goto(URL, { waitUntil: 'domcontentloaded' });
await p.waitForFunction('!!window.__ENGINE__', null, { timeout: 300000 });
await p.mouse.click(640, 360);
await p.waitForTimeout(Number(process.env.SETTLE ?? 4000)); // let boot + prewarm + fx self-warm fully settle

const out = await p.evaluate(
  (secs) =>
    new Promise((done) => {
      const e = window.__ENGINE__;
      const renderer = e.ctx.get('render').renderer;
      const info = renderer.info;
      const inp = e.ctx.input;

      const seen = new Set(info.programs.map((x) => x.cacheKey));
      const baseline = seen.size;
      const late = [];

      // Name the material that owns a program: three stores only a shader name
      // and a cache key on the program, so walk the scene for the material whose
      // program object matches.
      const owner = (prog) => {
        let hit = null;
        for (const sc of [e.ctx.peek('render')?.scene, e.scene].filter(Boolean)) {
          sc.traverse((o) => {
            if (hit) return;
            const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
            for (const m of mats) {
              if (m && m.__webglShader?.program === prog.program) { hit = `${o.name || o.type} / ${m.name || m.type}`; return; }
            }
          });
        }
        return hit;
      };

      const keys = ['KeyW', 'KeyD', 'KeyS', 'KeyA'];
      let held = null;
      const t0 = performance.now();
      let last = t0;
      const tick = () => {
        const now = performance.now();
        const dt = now - last;
        last = now;
        const t = now - t0;

        if (info.programs.length && info.programs.some((x) => !seen.has(x.cacheKey))) {
          for (const pr of info.programs) {
            if (seen.has(pr.cacheKey)) continue;
            seen.add(pr.cacheKey);
            late.push({
              t: +(t / 1000).toFixed(1),
              ms: +dt.toFixed(1),
              name: pr.name ?? '(unnamed)',
              owner: owner(pr),
              key: String(pr.cacheKey ?? '').slice(0, 150),
            });
          }
        }

        const want = keys[Math.floor(t / 1200) % 4];
        if (want !== held) { if (held) inp._pendingUp.add(held); inp._pendingDown.add(want); held = want; }
        const ph = t % 1000;
        if (ph < 16) inp._pendingDown.add('Mouse0');
        else if (ph > 400 && ph < 416) inp._pendingUp.add('Mouse0');
        inp._rawLook.x += 6;

        if (t > secs * 1000) {
          if (held) inp._pendingUp.add(held);
          inp._pendingUp.add('Mouse0');
          return done({ baseline, total: info.programs.length, late });
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }),
  SECONDS
);
await b.close();

console.log(`\nprograms at boot: ${out.baseline}   at end: ${out.total}   compiled late: ${out.late.length}\n`);
for (const l of out.late) {
  console.log(`  t=${l.t}s  frame ${l.ms}ms  shader "${l.name}"  owner: ${l.owner ?? '(not in scene)'}`);
  console.log(`     key: ${l.key}`);
}
if (!out.late.length) console.log('  (none — everything was warm)');
