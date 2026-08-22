/**
 * GAME MODES — the rules on top of the shooting.
 *
 * Both modes are the same three-line loop: watch the enemies, and when there
 * are none left, decide what that means and put more there. Everything else —
 * navigation, squads, perception, the garrison itself — already exists, so a
 * mode is a scorekeeper and a spawn schedule rather than a new game.
 *
 * `player.dead` and `player.respawn()`, NOT `player.health`. `health` is a Health
 * OBJECT on the player, not a number — reading it as one silently never fires
 * the death branch, and writing to it destroys the subsystem and takes the whole
 * frame loop down with it. The documented accessors are the contract.
 *
 * Neither mode owns a timer. A round ends when the squad is dead or the player
 * is, and a wave ends when the wave is dead; a clock would only ever end a round
 * that was still interesting. The `timeLeft` the match bar shows is the
 * countdown BETWEEN rounds, which is the only clock either mode actually has.
 */

/** Seconds between rounds/waves — long enough to reload and pick a corner. */
const BREAK = 4;
/** Seconds the corpse stays put after death, so the player sees it happen. */
const DEATH_HOLD = 2.2;

class BaseMode {
  constructor(ctx) {
    this.ctx = ctx;
    this.phase = 'live';
    this.breakLeft = 0;
    this.round = 1;
    /** Consumed by the HUD; see the merge in ui/index.js. */
    ctx.match = { scoreUs: 0, scoreThem: 0, mode: '', timeLeft: 0 };
  }

  get ai() {
    return this.ctx.peek?.('ai');
  }

  get ui() {
    return this.ctx.peek?.('ui');
  }

  aliveCount() {
    const a = this.ai?.agents;
    if (!a) return 0;
    let n = 0;
    for (let i = 0; i < a.length; i++) if (a[i].alive) n++;
    return n;
  }

  /**
   * Clear out the dead before repopulating. Without this the corpse list grows
   * every round and `populate` keeps adding to a scene that never shrinks.
   */
  clearDead() {
    const ai = this.ai;
    if (!ai?.agents) return;
    for (const a of ai.agents) {
      if (a.alive) continue;
      try {
        a.dispose?.();
      } catch {
        /* a corpse that will not despawn must not stop the next round */
      }
    }
    ai.agents = ai.agents.filter((a) => a.alive);
  }

  /**
   * Wipe the board, living and dead. A round is a RESET, not a continuation —
   * ending one while the surviving squad is still shooting means the player
   * respawns into the fire that just killed them, which is what made the first
   * version of this fail its own test: revived on one frame, dead again twenty
   * frames later.
   */
  clearAll() {
    const ai = this.ai;
    if (!ai?.agents) return;
    for (const a of ai.agents) {
      a.alive = false;
      try {
        a.dispose?.();
      } catch {
        /* a body that will not despawn must not stop the next round */
      }
    }
    ai.agents.length = 0;
  }

  announce(title, sub) {
    this.ui?.banner?.show?.(title, sub, 2.4);
  }

  startBreak(seconds = BREAK) {
    this.phase = 'break';
    this.breakLeft = seconds;
  }

  update(dt) {
    if (this.phase === 'break') {
      this.breakLeft -= dt;
      if (this.breakLeft <= 0) {
        this.phase = 'live';
        this.begin();
      }
    } else {
      this.live(dt);
    }
    this.publish();
  }
}

/**
 * STRIKE — round-based.
 *
 * Clear the squad to take the round; die and they take it. First to five. The
 * squad grows every other round rather than every round, so the difficulty step
 * lands after you have had one round to get comfortable at the current size.
 */
class StrikeMode extends BaseMode {
  constructor(ctx) {
    super(ctx);
    this.us = 0;
    this.them = 0;
    this.target = 5;
    this.over = false;
  }

  begin() {
    this.ai?.populate?.({ squads: 2, perSquad: 3 + Math.floor(this.round / 2) });
    this.announce(`ROUND ${this.round}`, `${this.us} — ${this.them}`);
  }

  live() {
    if (this.over) return;
    const player = this.ctx.peek?.('player');

    if (player?.dead) {
      this.them++;
      // Board first, then the player: respawning into a live squad is how the
      // previous version put them straight back on the floor.
      this.clearAll();
      player.respawn?.();
      this.endRound('ROUND LOST');
      return;
    }
    if (this.aliveCount() === 0) {
      this.us++;
      this.endRound('ROUND WON');
    }
  }

  endRound(title) {
    this.clearAll();
    if (this.us >= this.target || this.them >= this.target) {
      this.over = true;
      this.announce(this.us > this.them ? 'MATCH WON' : 'MATCH LOST', `${this.us} — ${this.them}`);
      // Ad policy: between matches only, never mid-round. showInterstitial()
      // itself enforces the 60s minimum gap and the portal certification
      // requirements, so this is just picking the moment.
      this.ctx.events.emit('match:end', {});
      // Reset rather than stop: a portal player who reaches the end should get
      // another match, not a dead screen with no button on it.
      this.us = 0;
      this.them = 0;
      this.round = 0;
      this.over = false;
    } else {
      this.announce(title, `${this.us} — ${this.them}`);
    }
    this.round++;
    this.startBreak();
  }

  publish() {
    const m = this.ctx.match;
    m.scoreUs = this.us;
    m.scoreThem = this.them;
    m.mode = 'STRIKE';
    m.timeLeft = this.phase === 'break' ? Math.max(0, this.breakLeft) : 0;
  }
}

/**
 * HOLDOUT — waves.
 *
 * Wave n is n+3 bodies across three squads, so they arrive from three sides at
 * once rather than as one column. There is no win condition on purpose: the
 * score IS the wave you died on, which is the only number a horde mode needs.
 */
class HordeMode extends BaseMode {
  constructor(ctx) {
    super(ctx);
    this.wave = 1;
    this.best = 0;
    /** Wall-clock of the death currently being held, 0 when alive. */
    this._deathAt = 0;
  }

  /**
   * What this wave is made of.
   *
   * A horde of one body type is one problem repeated, and the answer to it
   * never changes — so the wave number has to change the QUESTION, not just the
   * count. Runts arrive from wave 2 and punish standing still; brutes from
   * wave 4 and cannot be traded with, only avoided. Ghouls stay in the mix the
   * whole way so there is always something that dies to a normal amount of
   * shooting.
   *
   * Entries repeat to weight the roll — populate() picks uniformly from this
   * list, so listing 'ghoul' twice makes it twice as likely.
   */
  roster() {
    const v = ['ghoul', 'ghoul'];
    if (this.wave >= 2) v.push('runt');
    if (this.wave >= 3) v.push('flatty');
    if (this.wave >= 5) v.push('runt');
    if (this.wave >= 4) v.push('brute');
    return v;
  }

  begin() {
    this.clearDead();
    const per = Math.min(8, 1 + Math.ceil(this.wave / 2));
    this.ai?.populate?.({ squads: 3, perSquad: per, variants: this.roster() });
    this.announce(`WAVE ${this.wave}`, `${per * 3} INCOMING`);
  }

  live() {
    const player = this.ctx.peek?.('player');
    if (player?.dead) {
      /**
       * DEATH NEEDS A BEAT BEFORE THE RESPAWN.
       *
       * This used to kill and respawn on the same frame: health hit zero and the
       * player was already standing on the spawn point with a full bar and the
       * wave reset. Reported — accurately — as "I was running and suddenly
       * teleported for no reason", because from the player's side that is
       * exactly what it looks like. The OVERRUN banner was already being posted,
       * but nothing held long enough to connect the banner to the cause, and the
       * body moved 35 metres in one frame.
       *
       * Holding here leaves the corpse where it fell, in view, for long enough
       * to read the banner. Control is released so the death cannot be walked
       * out of, and the actual respawn happens after DEATH_HOLD.
       */
      if (this._deathAt === 0) {
        this._deathAt = this.ctx.time.elapsed;
        this.best = Math.max(this.best, this.wave - 1);
        this.announce('OVERRUN', `WAVE ${this.wave} · BEST ${this.best}`);
        this.clearAll();
        player.setControlEnabled?.(false);
        return;
      }
      if (this.ctx.time.elapsed - this._deathAt < DEATH_HOLD) return;

      this._deathAt = 0;
      player.setControlEnabled?.(true);
      player.respawn?.();
      // A run is over: perks reset with it, or wave 1 starts fully kitted.
      this.ctx.events.emit('player:respawn', {});
      // Ad policy: a run ending is Holdout's session boundary, same as a match
      // in Strike. showInterstitial() enforces the 60s gap itself.
      this.ctx.events.emit('match:end', {});
      this.wave = 1;
      this.startBreak(6);
      return;
    }
    if (this.aliveCount() === 0) {
      /**
       * Drop the chest where the LAST body fell, not on a spawn point: the
       * reward should be where the fight actually ended, which is also the one
       * place the player already knows is clear.
       */
      const last = this.ai?.agents?.[this.ai.agents.length - 1];
      this.ctx.events.emit('wave:cleared', {
        wave: this.wave,
        position: last?.position?.clone?.() ?? null,
      });
      this.wave++;
      this.startBreak();
    }
  }

  publish() {
    const m = this.ctx.match;
    m.scoreUs = this.wave;
    m.scoreThem = this.aliveCount();
    m.mode = 'HOLDOUT';
    m.timeLeft = this.phase === 'break' ? Math.max(0, this.breakLeft) : 0;
  }
}

/** @returns {BaseMode|null} null for `tdm`/`sandbox`, which have no rules. */
export function createMode(ctx) {
  const id = ctx.config?.mode;
  if (id === 'strike') return new StrikeMode(ctx);
  if (id === 'horde') return new HordeMode(ctx);
  return null;
}

/**
 * Subsystem wrapper. Declared after `ai` and `ui` so both exist when the first
 * round is scored, and a no-op for the modes that have no rules — `tdm` still
 * behaves exactly as it always did, with no mode object in the way.
 */
/**
 * Modes that spawn their own enemies, and must therefore start on an EMPTY map.
 *
 * `AiSystem.init()` garrisons every non-sandbox level with a default soldier
 * patrol. For a mode that runs its own waves that garrison is actively
 * destructive, in two ways at once:
 *
 *   1. it is the wrong roster — Holdout asks for ghouls and got
 *      vanguard/irregular/breacher, because the garrison ignores `roster()`;
 *   2. it keeps `aliveCount()` above zero forever, and both modes only start a
 *      wave/round when the board is clear, so `begin()` was NEVER reached.
 *
 * Measured on outpost/horde: stuck on wave 1 indefinitely, fighting a soldier
 * patrol that holds position ~30 m away. That is the "enemies just sit there
 * and never chase" report — they were not horde enemies at all.
 */
export const MODES_OWN_SPAWNING = new Set(['horde', 'strike']);

export class ModeSystem {
  static id = 'mode';
  static deps = ['ai', 'ui'];

  init(ctx) {
    this.ctx = ctx;
    this.mode = createMode(ctx);
    if (this.mode) {
      console.info(`[mode] ${ctx.config.mode}`);
      /**
       * Open on a short break so `begin()` actually runs. BaseMode starts in
       * 'live', and `live()` only calls through to `begin()` once the board is
       * empty — which meant the opening wave depended on someone else having
       * populated the map first. Now the mode always deals its own first hand.
       */
      this.mode.startBreak(1.2);
    }
  }

  update(dt) {
    this.mode?.update(dt);
  }

  dispose() {
    this.mode = null;
    if (this.ctx) this.ctx.match = null;
  }
}
