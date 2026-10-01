// waves.js - Wave composition and spawning for the Covenant-style roster.
// Enemies drop in from the sky (dropship beam) at spawn points away from the player.
import * as THREE from 'three';
import { Enemy, ENEMY_TYPES } from './enemies.js';

// Named waves give each fight a shape: a lance of Gnats led by a Warlord reads as a squad,
// not a random bag of enemies.
const WAVE_THEMES = [
  { name: 'SCOUT LANCE', min: 1, mix: { gnat: 1.0 } },
  { name: 'FLANKING PAIR', min: 2, mix: { gnat: 0.6, skirmisher: 0.4 } },
  { name: 'COMMAND SQUAD', min: 3, mix: { gnat: 0.55, skirmisher: 0.25, warlord: 0.2 } },
  { name: 'AIR RAID', min: 4, mix: { wasp: 0.5, gnat: 0.3, skirmisher: 0.2 } },
  { name: 'SIEGE LINE', min: 6, mix: { juggernaut: 0.15, gnat: 0.45, warlord: 0.2, skirmisher: 0.2 } },
  { name: 'SHADOW STRIKE', min: 7, mix: { skirmisher: 0.5, warlord: 0.3, wasp: 0.2 } },
  { name: 'FULL ASSAULT', min: 9, mix: { gnat: 0.3, skirmisher: 0.2, warlord: 0.2, wasp: 0.15, juggernaut: 0.15 } },
];

export class WaveManager {
  constructor(ctx) {
    this.ctx = ctx; // shared enemy context {scene, particles, audio, vfx, colliders}
    this.wave = 0;
    this.enemies = [];
    this.ctx.enemies = this.enemies;
    this.ctx.spawn = (type, pos, opts) => this._spawnAt(type, pos, opts);
    this.state = 'waiting'; // waiting, spawning, active, complete
    this.stateTimer = 0;
    this.spawnPoints = [];
    this.spawnQueue = [];
    this.spawnTimer = 0;
    this.waveTheme = null;
    this._aliveCount = 0;
    this.hpMultiplier = 1; this.speedMultiplier = 1; this.damageMultiplier = 1;
    this.onSpawn = null;
  }

  setSpawnPoints(points) { this.spawnPoints = points; }

  startWave() {
    this.wave++;
    this.state = 'spawning';
    this.spawnQueue = this._compose();
    this.spawnTimer = 0.2;
  }

  _compose() {
    const w = this.wave;
    const count = Math.min(4 + Math.floor(w * 1.8), 32);
    const pool = WAVE_THEMES.filter(t => t.min <= w);
    // Early waves are fixed so the roster is introduced one species at a time.
    this.waveTheme = w <= 3 ? pool[Math.min(w - 1, pool.length - 1)] : pool[Math.floor(Math.random() * pool.length)];
    const mix = this.waveTheme.mix;
    const queue = [];
    const types = Object.keys(mix);
    let remaining = count;
    for (let i = 0; i < types.length; i++) {
      const t = types[i];
      let n = i === types.length - 1 ? remaining : Math.round(count * mix[t]);
      if (t === 'juggernaut') n = Math.min(n, 1 + Math.floor(w / 6));
      if (t === 'warlord') n = Math.min(Math.max(n, w >= 3 ? 1 : 0), w < 6 ? 1 : 2 + Math.floor(w / 6));
      n = Math.max(0, Math.min(n, remaining));
      for (let k = 0; k < n; k++) queue.push({ type: t, elite: false });
      remaining -= n;
    }
    while (remaining-- > 0) queue.push({ type: 'gnat', elite: false });
    // Elites every third wave, boss every fifth.
    if (w >= 3 && w % 3 === 0) {
      let e = Math.min(3, Math.floor(w / 3));
      for (let i = queue.length - 1; i >= 0 && e > 0; i--) { if (queue[i].type !== 'juggernaut') { queue[i].elite = true; e--; } }
    }
    if (w >= 5 && w % 5 === 0) queue.push({ type: 'overseer', elite: false, isBoss: true });
    this.hpMultiplier = 1 + Math.pow(w - 1, 1.12) * 0.07;
    this.speedMultiplier = 1 + (w - 1) * 0.03;
    this.damageMultiplier = 1 + Math.pow(w - 1, 1.05) * 0.035;
    // Commanders spawn first so their squads form around them; shuffle the rest.
    const leaders = queue.filter(q => q.type === 'warlord' || q.isBoss);
    const rest = queue.filter(q => !(q.type === 'warlord' || q.isBoss));
    for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
    return leaders.concat(rest);
  }

  update(delta, playerPos, playerVel) {
    if (this.state === 'spawning') {
      this.spawnTimer -= delta;
      if (this.spawnTimer <= 0 && this.spawnQueue.length > 0) {
        const entry = this.spawnQueue.shift();
        this._spawnEntry(entry, playerPos);
        this.spawnTimer = entry.isBoss ? 1.5 : 0.45;
      }
      if (this.spawnQueue.length === 0) this.state = 'active';
    }
    this._aliveCount = 0;
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (e.update(delta, playerPos, playerVel)) { e.dispose(); this.enemies.splice(i, 1); }
      else if (!e.dead) this._aliveCount++;
    }
    if (this.state === 'active') {
      this.activeTime = (this.activeTime || 0) + delta;
      if (this.activeTime > 75) for (const e of this.enemies) e.aggressive = true;
      // The tail of a wave was the real pacing problem, not its start: ranged aliens hold at
      // keepDistance and plink, so the last one or two would stand off and a wave could take
      // 60-100s to actually close while nothing happened. Once a squad is down to its last few,
      // they commit and come to the player rather than waiting out the 75s global fallback.
      if (this._aliveCount > 0 && this._aliveCount <= 2) for (const e of this.enemies) e.aggressive = true;
    } else this.activeTime = 0;
    if (this.state === 'active' && this._aliveCount === 0) { this.state = 'complete'; this.stateTimer = 3; }
    if (this.state === 'complete') { this.stateTimer -= delta; if (this.stateTimer <= 0) this.state = 'waiting'; }
  }

  _pickSpawn(playerPos) {
    let best = this.spawnPoints[0], bestScore = -1;
    for (const p of this.spawnPoints) {
      const d = p.distanceTo(playerPos);
      // Graded preference, not a binary near/far test. 30-55m is the sweet spot: a threat within
      // a few seconds, but you still see the drop. Far points stay genuinely competitive — with a
      // flat near-beats-far rule every alien in a wave funnels in from the same couple of close
      // corners simultaneously, which reads as a pile-on rather than an assault converging on you.
      let base;
      if (d < 18) base = 0;               // never materialise on top of the player
      else if (d < 30) base = 0.7;
      else if (d <= 55) base = 1;
      else if (d <= 75) base = 0.85;
      else base = 0.6;
      // Spread the arrival directions: whichever point the last alien used is a weaker pick now.
      if (this._lastSpawnPoint === p) base *= 0.45;
      const score = base > 0 ? base + Math.random() * 0.5 : 0;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    this._lastSpawnPoint = best;
    return best.clone().add(new THREE.Vector3((Math.random() - 0.5) * 8, 0, (Math.random() - 0.5) * 8));
  }

  _spawnEntry(entry, playerPos) {
    const pos = this._pickSpawn(playerPos);
    // Squads land together: a warlord's next few followers spawn near it.
    if (entry.type === 'warlord') this._lastLeaderPos = pos.clone();
    else if (this._lastLeaderPos && (entry.type === 'gnat' || entry.type === 'skirmisher') && Math.random() < 0.6) {
      pos.copy(this._lastLeaderPos).add(new THREE.Vector3((Math.random() - 0.5) * 7, 0, (Math.random() - 0.5) * 7));
    }
    this._spawnAt(entry.type, pos, { elite: entry.elite, isBoss: entry.isBoss, dropIn: true });
  }

  _spawnAt(type, pos, opts = {}) {
    if (!ENEMY_TYPES[type]) return null;
    const e = new Enemy(type, pos, this.ctx, {
      elite: opts.elite, hpMul: this.hpMultiplier, speedMul: this.speedMultiplier, dmgMul: this.damageMultiplier,
    });
    this.enemies.push(e);
    if (opts.dropIn && this.ctx.vfx) this.ctx.vfx.createSpawnEffect(pos.clone(), ENEMY_TYPES[type].color);
    if (this.onSpawn) this.onSpawn(e, opts);
    return e;
  }

  getAliveCount() { return this._aliveCount; }
  getTotalCount() { return this.enemies.length; }
  getBoss() { for (const e of this.enemies) if (e.isBoss && !e.dead) return e; return null; }

  cleanup() {
    for (const e of this.enemies) e.dispose();
    this.enemies.length = 0;
    this.spawnQueue = [];
    this._aliveCount = 0;
    this._lastLeaderPos = null;
    this._lastSpawnPoint = null;
  }

  shouldChangeLevelAfterWave() { return this.wave > 0 && this.wave % 5 === 0; }
}
