/**
 * Follow ONE agent, frame by frame, and record why it is or is not closing.
 *
 * Aggregate tools say "it walked 95 m and got no closer". They cannot say
 * whether it is pathing to the wrong place, being physically blocked, losing
 * the target, or simply being told to stop. This samples the agent's own
 * decision state every frame and prints the timeline.
 */
import { chromium } from 'playwright';

const MAP = process.argv[2] ?? 'outpost';
const MODE = process.argv[3] ?? 'horde';
const SECONDS = Number(process.argv[4] ?? 30);
const BASE = process.argv[5] ?? 'http://127.0.0.1:5181/';

const b = await chromium.launch({ headless: true, args: ['--mute-audio'] });
const p = await b.newPage({ viewport: { width: 900, height: 560 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto(`${BASE}?map=${MAP}&mode=${MODE}&menu=0`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction('!!window.__ENGINE__', null, { timeout: 300000 });
await p.waitForTimeout(2500);

const r = await p.evaluate(
  (secs) =>
    new Promise((done) => {
      const e = window.__ENGINE__;
      const ai = e.ctx.peek('ai');
      const pl = e.ctx.peek('player');
      e.ctx.get('render').renderer.render = () => {};

      const gi = ai.grid.nearest(0, 0, 0, 24);
      if (gi >= 0) {
        pl.teleport({ x: ai.grid.worldX(ai.grid.ixOf(gi)), y: ai.grid.floor[gi] + 1.66, z: ai.grid.worldZ(ai.grid.izOf(gi)) }, 0);
      }

      const rows = [];
      let subject = null;
      let prev = null;
      const t0 = performance.now();
      const tick = () => {
        const t = (performance.now() - t0) / 1000;
        if (!subject || !subject.alive) {
          subject = ai.agents.find((a) => a.alive) ?? null;
          prev = subject ? subject.position.clone() : null;
        }
        if (subject) {
          const d = subject.position.distanceTo(pl.position);
          const moved = prev ? subject.position.distanceTo(prev) : 0;
          prev.copy(subject.position);
          rows.push({
            t: +t.toFixed(1),
            dist: +d.toFixed(1),
            moved: +(moved * 60).toFixed(2), // per-second speed
            state: subject.state,
            want: +(subject.desiredSpeed ?? 0).toFixed(2),
            pathLen: subject.pathLen ?? 0,
            pathIdx: subject.pathIndex ?? 0,
            hasMT: subject.hasMoveTarget ? 1 : 0,
            mtErr: subject.hasMoveTarget && subject.moveTarget
              ? +subject.moveTarget.distanceTo(pl.position).toFixed(1) : -1,
            hasTgt: subject.hasTarget ? 1 : 0,
            age: +(subject.lastKnownAge ?? 0).toFixed(1),
            aware: +(subject.awareness ?? 0).toFixed(2),
            // lastMoveBlocked lives on the CONTROLLER, not the agent.
            blocked: subject.controller?.lastMoveBlocked ? 1 : 0,
            spd: +(subject.speed ?? 0).toFixed(2),
            stuck: +(subject.stuckTimer ?? 0).toFixed(1),
            grounded: subject.grounded === undefined ? -1 : (subject.grounded ? 1 : 0),
            wpd: subject.hasMoveTarget && subject.pathIndex < subject.pathLen && subject.path[subject.pathIndex]
              ? +subject.path[subject.pathIndex].distanceTo(subject.position).toFixed(2) : -1,
            px: +subject.position.x.toFixed(1), py: +subject.position.y.toFixed(2), pz: +subject.position.z.toFixed(1),
          });
        }
        if (t > secs) {
          // Diagnose the exact stuck spot rather than inferring it.
          const g = ai.grid;
          const a = subject;
          const diag = {};
          if (a) {
            const ai_ = g.nearest(a.position.x, a.position.z, a.position.y);
            const pi_ = g.nearest(pl.position.x, pl.position.z, pl.position.y);
            diag.agentSnap = ai_;
            diag.agentSnapY = ai_ >= 0 ? +g.floor[ai_].toFixed(2) : null;
            diag.agentSnapLayer = ai_ >= 0 ? g.layerOf(ai_) : null;
            diag.agentSnapDist = ai_ >= 0
              ? +Math.hypot(g.worldX(g.ixOf(ai_)) - a.position.x, g.worldZ(g.izOf(ai_)) - a.position.z).toFixed(2) : null;
            diag.playerSnap = pi_;
            diag.playerSnapY = pi_ >= 0 ? +g.floor[pi_].toFixed(2) : null;
            diag.playerSnapLayer = pi_ >= 0 ? g.layerOf(pi_) : null;
            const out = [];
            diag.findPath = g.findPath(a.position, pl.position, out);
            diag.agentCellWalkable = g.walkableAny(g.cellX(a.position.x), g.cellZ(a.position.z));
            diag.agentPos = { x: +a.position.x.toFixed(2), y: +a.position.y.toFixed(2), z: +a.position.z.toFixed(2) };
            diag.playerPos = { x: +pl.position.x.toFixed(2), y: +pl.position.y.toFixed(2), z: +pl.position.z.toFixed(2) };
            // same component?
            if (ai_ >= 0 && pi_ >= 0) {
              const total = g.n * g.layers;
              const seen = new Uint8Array(total);
              const st = [ai_]; seen[ai_] = 1;
              const DXl = [1,-1,0,0,1,1,-1,-1], DZl = [0,0,1,-1,1,-1,1,-1];
              let found = false;
              while (st.length) {
                const cur = st.pop();
                if (cur === pi_) { found = true; break; }
                const cx = g.ixOf(cur), cz = g.izOf(cur), cy = g.floor[cur];
                for (let d = 0; d < 8; d++) {
                  const ni = g.layerNear(cx + DXl[d], cz + DZl[d], cy);
                  if (ni < 0 || seen[ni]) continue;
                  seen[ni] = 1; st.push(ni);
                }
              }
              diag.sameComponent = found;
            }
          }
          return done({ rows, diag });
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }),
  SECONDS
);
await b.close();
const rows = r.rows ?? r;
console.log('diagnosis: ' + JSON.stringify(r.diag ?? {}, null, 1));

console.log('\n   t  dist  speed  want  state      path idx mt mtErr tgt  age aware blk gnd');
for (let i = 0; i < rows.length; i += 15) {
  const x = rows[i];
  console.log(
    `${String(x.t).padStart(4)}${String(x.dist).padStart(6)}${String(x.moved).padStart(7)}` +
    `${String(x.spd).padStart(5)}${String(x.want).padStart(6)}  ${String(x.state).padEnd(9)}` +
    `${String(x.pathLen).padStart(3)}${String(x.pathIdx).padStart(4)}${String(x.wpd).padStart(6)}` +
    `${String(x.mtErr).padStart(6)}${String(x.blocked).padStart(4)}${String(x.stuck).padStart(6)}` +
    `${String(x.grounded).padStart(4)}   ${x.px},${x.py},${x.pz}`
  );
}
const states = {};
for (const x of rows) states[x.state] = (states[x.state] ?? 0) + 1;
console.log('\nstate histogram:', JSON.stringify(states));
const blocked = rows.filter((x) => x.blocked).length;
console.log(`frames blocked: ${blocked}/${rows.length}`);
console.log(`net closed: ${(rows[0].dist - rows[rows.length - 1].dist).toFixed(1)}m`);
