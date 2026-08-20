/**
 * Walk the player up a named ramp or stair and watch the character controller
 * frame by frame.
 *
 *   node tools/moveprofile.mjs outpost
 *   node tools/moveprofile.mjs miami
 *
 * WHY. "It stutters on stairs" is not something the frame profiler can see:
 * tools/playprofile.mjs measures CPU per system, and a hitch you feel while
 * climbing is usually not CPU at all — it is the swept capsule stepping,
 * un-stepping and re-stepping across a seam, which costs nothing and moves the
 * camera a long way. So this samples MOTION, not time:
 *
 *   dxz        horizontal distance travelled this frame. At 6.1 m/s and 60 Hz
 *              a normal frame is ~0.10 m. Anything several times that is the
 *              controller resolving a penetration, i.e. the "teleport".
 *   dy         vertical. A clean ramp gives a small steady positive value; a
 *              step gives a sawtooth; a POP is the bug.
 *   grounded   losing ground contact mid-climb is what makes a climb feel like
 *              a series of small falls.
 *   steppedUp  the controller's own flag for "I lifted the capsule over a lip".
 *              Firing every frame on a smooth slope means the slope is not
 *              smooth as far as physics is concerned.
 *
 * The run is deterministic: fixed 1/60 steps driven by hand, no rAF, so two
 * runs produce the same numbers and a fix is measurable rather than felt.
 */
import { chromium } from 'playwright';

const MAP = process.argv[2] ?? 'outpost';
const BASE = process.argv[3] ?? 'http://127.0.0.1:5181/';

/** Level-space walks: start, the heading to hold, and how far to go. */
const WALKS = {
  outpost: [
    { name: 'gate ramp  0 -> 0.8', from: [0, -29, 0.2], yaw: 0, frames: 200 },
    { name: 'grand ramp 0.8 -> 3.2', from: [0, 6, 1.0], yaw: 0, frames: 260 },
    { name: 'east->dock 0.8 -> 2.0', from: [22, 4, 1.0], yaw: 0, frames: 240 },
    { name: 'mid->west  0.8 -> 1.6', from: [-2, -10, 1.0], yaw: Math.PI / 2, frames: 160 },
  ],
  miami: [
    { name: 'grand stair 0 -> 2.8', from: [0, 4, 0.2], yaw: 0, frames: 260 },
    { name: 'south->west wing', from: [-24, -20, 0.2], yaw: 0, frames: 200 },
  ],
};

const browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${BASE}?map=${MAP}&menu=0`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('!!window.__ENGINE__', null, { timeout: 300000 });
await page.waitForTimeout(1200);

const runs = await page.evaluate(async (walks) => {
  const e = window.__ENGINE__;
  const ctx = e.ctx;
  const world = ctx.peek('world');
  const pl = ctx.peek('player');
  const inp = ctx.input ?? e.input;
  const out = [];

  for (const walk of walks) {
    const p = world.levelToWorld(walk.from[0], walk.from[2], walk.from[1]);
    // Face along +z in LEVEL space, which is walk.yaw rotated by the level yaw.
    const c0 = pl.character ?? pl.controller ?? pl.movement?.character ?? null;
    const hasTp = typeof pl.teleport === 'function';
    /**
     * `teleport(eye, rot)` takes an EYE position — it subtracts the stance eye
     * height (1.66) to find the feet — and `rot` is read as a YAW NUMBER, or as
     * an Euler's `.y`. Handing it a floor height and `{x:0,y:0,z:0}` put the
     * capsule 1.66 m underground facing world-north, so the profile measured a
     * player walking into a wall rather than up a ramp. Both are level-space
     * values, so the yaw carries LEVEL_YAW.
     */
    p.y += 1.66;
    pl.teleport(p, walk.yaw + 0.5877);
    const posAfterTp = { x: +pl.position.x.toFixed(2), y: +pl.position.y.toFixed(2), z: +pl.position.z.toFixed(2) };
    // settle on the ground before measuring
    let t = performance.now();
    for (let i = 0; i < 30; i++) e.step((t += 1000 / 60));
    const posAfterSettle = { x: +pl.position.x.toFixed(2), y: +pl.position.y.toFixed(2), z: +pl.position.z.toFixed(2) };
    inp._pendingDown?.add('KeyW');

    const c = pl.character ?? pl.controller ?? pl.movement?.character ?? null;
    let prev = pl.position.clone();
    const frames = [];
    for (let i = 0; i < walk.frames; i++) {
      e.step((t += 1000 / 60));
      const cur = pl.position;
      frames.push({
        dxz: Math.hypot(cur.x - prev.x, cur.z - prev.z),
        dy: cur.y - prev.y,
        y: cur.y,
        grounded: c ? !!c.grounded : null,
        stepped: c ? !!c.steppedUp : null,
        blocked: c ? !!c.lastMoveBlocked : null,
      });
      prev = cur.clone();
    }
    inp._pendingUp?.add('KeyW');
    for (let i = 0; i < 10; i++) e.step((t += 1000 / 60));

    const dxz = frames.map((f) => f.dxz).sort((a, b) => a - b);
    const med = dxz[dxz.length >> 1];
    out.push({
      name: walk.name,
      diag: { hasTp, hasCtl: !!c0, want: { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) }, posAfterTp, posAfterSettle },
      startY: +frames[0].y.toFixed(2),
      endY: +frames[frames.length - 1].y.toFixed(2),
      medianStep: +med.toFixed(4),
      maxStep: +Math.max(...frames.map((f) => f.dxz)).toFixed(3),
      // A "jump" is a frame that moved several times the median. Median is used
      // rather than mean so one teleport does not hide the rest.
      jumps: frames.filter((f) => f.dxz > Math.max(med * 4, 0.4)).length,
      maxDyUp: +Math.max(...frames.map((f) => f.dy)).toFixed(3),
      maxDyDown: +Math.min(...frames.map((f) => f.dy)).toFixed(3),
      airborne: frames.filter((f) => f.grounded === false).length,
      steppedFrames: frames.filter((f) => f.stepped).length,
      blockedFrames: frames.filter((f) => f.blocked).length,
      total: frames.length,
      worst: frames
        .map((f, i) => ({ i, ...f }))
        .sort((a, b) => b.dxz - a.dxz)
        .slice(0, 4)
        .map((f) => ({ f: f.i, dxz: +f.dxz.toFixed(3), dy: +f.dy.toFixed(3), g: f.grounded, s: f.stepped })),
    });
  }
  return out;
}, WALKS[MAP] ?? WALKS.outpost);
await browser.close();

console.log(`\n${MAP} — character controller over ${runs.length} climbs\n`);
for (const r of runs) {
  const pct = (n) => `${((n / r.total) * 100).toFixed(0)}%`;
  console.log(`${r.name}`);
  console.log(`  diag ${JSON.stringify(r.diag)}`);
  console.log(`  y ${r.startY} -> ${r.endY}   median step ${r.medianStep} m   max ${r.maxStep} m`);
  console.log(`  jumps(>4x median) ${r.jumps}   airborne ${r.airborne} (${pct(r.airborne)})   steppedUp ${r.steppedFrames} (${pct(r.steppedFrames)})   blocked ${r.blockedFrames}`);
  console.log(`  dy  up ${r.maxDyUp}  down ${r.maxDyDown}`);
  console.log(`  worst frames: ${JSON.stringify(r.worst)}`);
  console.log('');
}
