/**
 * Does the horde actually come for you?
 *
 *   node tools/aicheck.mjs outpost
 *   node tools/aicheck.mjs miami 900
 *
 * tools/variant-check.mjs already answers "does each variant build, move and
 * die". That is a different and much weaker question than the one that matters
 * in a horde mode, which is whether every enemy CLOSES THE DISTANCE. An agent
 * that jitters happily in a corner passes variant-check — it moved — and ruins
 * the mode, because the player has to go and find it to end the wave.
 *
 * So this parks the player, spawns a mixed wave, runs the real engine loop and
 * measures per agent:
 *
 *   closed     start distance minus end distance. NEGATIVE means it ran away or
 *              wandered; near zero with a large `travelled` means it is pacing
 *              on the spot, which is the corner-sitting bug.
 *   travelled  path length. Near zero = stuck against something.
 *   sunk       feet below the ground under them. The "stuck under the map" bug.
 *   facing     dot(look direction, direction to player). Around -1 is an agent
 *              literally facing the wall behind it while the player is behind
 *              its back.
 *   acquired   did it ever register the player at all.
 */
import { chromium } from 'playwright';

const MAP = process.argv[2] ?? 'outpost';
const FRAMES = Number(process.argv[3] ?? 600);
const BASE = process.argv[4] ?? 'http://127.0.0.1:5181/';

const browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(`${BASE}?map=${MAP}&mode=horde&menu=0`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('!!window.__ENGINE__', null, { timeout: 300000 });
await page.waitForTimeout(1500);

/** Default is HordeMode's actual roster; pass a comma list to override. */
const VARIANTS = (process.argv[5] ?? 'ghoul,runt,brute,flatty').split(',');
const r = {};
for (const variant of VARIANTS) {
  // One evaluate PER VARIANT. A single call covering all seven exceeded the
  // CDP timeout and returned nothing at all, which is a worse outcome than a
  // partial table — headless steps the engine far slower than a real GPU does.
  const one = await page.evaluate(async ({ FRAMES, variant }) => {
  const e = window.__ENGINE__;
  const ctx = e.ctx;
  const ai = ctx.peek('ai');
  const pl = ctx.peek('player');
  const phys = ctx.peek('physics');

  // Park the player. Where does not matter much, but it must be somewhere the
  // wave has to travel to reach, or "closed" measures nothing.
  const here = pl.position.clone();
  let t = performance.now();
  const step = () => e.step((t += 1000 / 60));

  const out = {};
  {
    const v = variant;
    for (const a of ai.agents.slice()) { try { a.die?.(); } catch {} a.alive = false; }
    for (let i = 0; i < 10; i++) step();
    let made = 0;
    try { made = ai.populate({ squads: 3, perSquad: 3, variants: [v] }); } catch { made = 0; }
    const live = ai.agents.filter((x) => x.alive && x.variantName === v);
    if (!live.length) return { [v]: { spawned: 0, made } };

    const startDist = live.map((a) => a.position.distanceTo(here));
    let prev = live.map((a) => a.position.clone());
    const travelled = live.map(() => 0);
    let acquired = 0;

    for (let i = 0; i < FRAMES; i++) {
      step();
      for (let k = 0; k < live.length; k++) {
        const a = live[k];
        travelled[k] += a.position.distanceTo(prev[k]);
        prev[k].copy(a.position);
      }
    }
    for (const a of live) if (a.hasTarget || a.awareness > 0.5) acquired++;

    const rows = live.map((a, k) => {
      const endDist = a.position.distanceTo(here);
      // From just above the FEET, not from the sky. Rays cast from +8 m hit
        // whatever roof or terrace the agent is walking under and report a
        // healthy agent as buried - which is exactly the false alarm that sent
        // an earlier hunt for an "underground" bug that did not exist. The grid
        // has two storeys now, so walking under things is normal.
        const gy = phys.groundHeight(a.position.x, a.position.z, a.position.y + 0.6);
      const sunk = Number.isFinite(gy) ? gy - a.position.y : 0;
      // Facing: agents carry `yaw`; forward is (sin, cos) in this engine's
      // convention (see movement.js sampling sy/cy).
      const dx = here.x - a.position.x, dz = here.z - a.position.z;
      const L = Math.hypot(dx, dz) || 1e-4;
      const fx = Math.sin(a.yaw ?? 0), fz = Math.cos(a.yaw ?? 0);
      return {
        closed: startDist[k] - endDist,
        travelled: travelled[k],
        sunk,
        facing: (fx * dx + fz * dz) / L,
        state: a.state,
      };
    });
    const med = (xs) => xs.slice().sort((a, b) => a - b)[xs.length >> 1];
    out[v] = {
      spawned: live.length,
      medClosed: +med(rows.map((x) => x.closed)).toFixed(1),
      medTravelled: +med(rows.map((x) => x.travelled)).toFixed(1),
      // "Loitering": moved a long way but got no closer. The corner-sitter.
      loitering: rows.filter((x) => x.travelled > 4 && x.closed < 2).length,
      stuck: rows.filter((x) => x.travelled < 2).length,
      underground: rows.filter((x) => x.sunk > 0.4).length,
      maxSunk: +Math.max(...rows.map((x) => x.sunk)).toFixed(2),
      facingAway: rows.filter((x) => x.facing < 0).length,
      acquired,
      states: [...new Set(rows.map((x) => x.state))],
    };
  }
  return out;
  }, { FRAMES, variant });
  Object.assign(r, one);
  const v = one[variant];
  console.log(`  ${variant.padEnd(10)} ${v && v.spawned ? `spawned ${v.spawned}, closed ${v.medClosed}m, moved ${v.medTravelled}m` : 'did not spawn'}`);
}
await browser.close();

console.log(`\n${MAP} — does the wave close the distance? (${FRAMES} frames)\n`);
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('variant', 11) + pad('spawn', 6) + pad('closed', 8) + pad('moved', 8) +
  pad('loiter', 7) + pad('stuck', 6) + pad('under', 6) + pad('faceaway', 9) + 'states');
for (const [k, v] of Object.entries(r)) {
  if (!v.spawned) { console.log(pad(k, 11) + '0     (variant did not spawn)'); continue; }
  console.log(
    pad(k, 11) + pad(v.spawned, 6) + pad(v.medClosed + 'm', 8) + pad(v.medTravelled + 'm', 8) +
    pad(v.loitering, 7) + pad(v.stuck, 6) + pad(v.underground, 6) + pad(v.facingAway, 9) +
    v.states.join(',')
  );
}
if (errs.length) console.log('\nconsole errors:', errs.slice(0, 4));
