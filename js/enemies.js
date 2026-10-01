// enemies.js - Halo-spirit alien hierarchy: rigged GLB models, animation state machine,
// recharging energy shields, and per-type AI (flank, strafe, panic, charge, hover, boss).
import * as THREE from 'three';
import { instantiateSkinned, normalize } from './assets.js';

// ---------------------------------------------------------------------------
// Roster. hp = body health, shield = energy shield (recharges after `shieldDelay` s out of
// combat, like Covenant shields). `frontShield` = a physical arm shield that blocks hits that
// arrive within `frontShieldArc` radians of the facing direction.
// ---------------------------------------------------------------------------
export const ENEMY_TYPES = {
  gnat: {
    name: 'GNAT', role: 'ranged', height: 1.25, hp: 45, shield: 0, speed: 4.2, damage: 5,
    attackRate: 1.1, attackRange: 18, keepDistance: 10, points: 100, color: 0xff8a2a, boltColor: 0x33ddff,
    panics: true, radius: 0.45,
  },
  skirmisher: {
    name: 'SKIRMISHER', role: 'skirmisher', height: 1.8, hp: 70, shield: 0, speed: 7.5, damage: 6,
    attackRate: 0.35, burst: 3, attackRange: 26, keepDistance: 14, points: 175, color: 0x2ab7a0, boltColor: 0xd070ff,
    frontShield: 160, frontShieldArc: 0.9, radius: 0.5,
  },
  warlord: {
    name: 'WARLORD', role: 'commander', height: 2.4, hp: 180, shield: 220, shieldDelay: 4, shieldRegen: 60, speed: 5.5, damage: 8,
    attackRate: 0.5, burst: 4, attackRange: 30, keepDistance: 9, meleeRange: 3.2, meleeDamage: 40,
    points: 400, color: 0x2244cc, boltColor: 0x8866ff, radius: 0.7,
  },
  juggernaut: {
    name: 'JUGGERNAUT', role: 'tank', height: 3.5, hp: 900, shield: 0, speed: 2.4, damage: 55,
    attackRate: 2.6, attackRange: 40, keepDistance: 12, points: 1200, color: 0xff6a00, boltColor: 0x66ff44,
    frontShield: 600, frontShieldArc: 0.75, radius: 1.3, splash: 5,
  },
  wasp: {
    name: 'WASP', role: 'aerial', height: 1.0, hp: 50, shield: 0, speed: 9, damage: 4,
    attackRate: 0.6, attackRange: 22, keepDistance: 12, hoverHeight: 5, points: 150, color: 0x9be24a, boltColor: 0xd0ff40,
    radius: 0.5,
  },
  overseer: {
    name: 'OVERSEER', role: 'boss', height: 5.0, hp: 2600, shield: 900, shieldDelay: 6, shieldRegen: 120, speed: 3.5, damage: 16,
    attackRate: 0.18, attackRange: 60, keepDistance: 18, hoverHeight: 7, points: 6000, color: 0x8a2be2, boltColor: 0xff40e0,
    spawnEvery: 12, radius: 2.2, isBoss: true,
  },
};

// Animation clip names produced by tools/blender/rig_biped.py.
const CLIP = { idle: 'Idle', walk: 'Walk', run: 'Run', attack: 'Attack', shoot: 'Shoot', hit: 'Hit', death: 'Death' };

const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _tmp3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _ray = new THREE.Ray();
const _hitP = new THREE.Vector3();
// True when a straight line from `from` to `to` crosses a level collider.
function losBlocked(from, to, colliders) {
  if (!colliders) return false;
  _tmp3.subVectors(to, from); const len = _tmp3.length(); if (len < 1e-3) return false;
  _ray.set(from, _tmp3.multiplyScalar(1 / len));
  for (let i = 0; i < colliders.length; i++) { if (colliders[i].isWater) continue; const p = _ray.intersectBox(colliders[i], _hitP); if (p && p.distanceTo(from) < len) return true; }
  return false;
}
const _UP = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// Shared projectile pool: glowing plasma bolts. One set for all enemies.
// ---------------------------------------------------------------------------
const BOLT_POOL = 96;
let _boltMesh = null, _boltFree = [], _boltActive = [];
let _boltGeo = null;
const _boltMats = new Map();
function _boltMat(color) {
  if (!_boltMats.has(color)) {
    const m = new THREE.MeshBasicMaterial({ color, toneMapped: false, transparent: true, opacity: 0.95 });
    m.color.multiplyScalar(2.2);
    _boltMats.set(color, m);
  }
  return _boltMats.get(color);
}
export function initEnemyProjectiles(scene) {
  _boltGeo = _boltGeo || new THREE.CapsuleGeometry(0.09, 0.5, 3, 8);
  _boltFree.length = 0; _boltActive.length = 0;
  for (let i = 0; i < BOLT_POOL; i++) {
    const m = new THREE.Mesh(_boltGeo, _boltMat(0x33ddff));
    m.rotation.x = Math.PI / 2; // capsule along z
    m.visible = false;
    const g = new THREE.Group(); g.add(m); g.visible = false;
    scene.add(g);
    _boltFree.push({ g, m, vel: new THREE.Vector3(), life: 0, damage: 0, splash: 0, owner: null, gravity: 0 });
  }
}
function _fireBolt(from, dir, speed, color, damage, { splash = 0, gravity = 0, scale = 1 } = {}) {
  const b = _boltFree.pop();
  if (!b) return null;
  b.g.position.copy(from);
  b.vel.copy(dir).multiplyScalar(speed);
  b.g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
  b.m.material = _boltMat(color);
  b.m.scale.setScalar(scale);
  b.life = 4; b.damage = damage; b.splash = splash; b.gravity = gravity;
  b.g.visible = true; b.m.visible = true;
  _boltActive.push(b);
  return b;
}
// Returns hits: [{damage, splash, position}] that reached the player this frame.
export function updateEnemyProjectiles(delta, playerPos, colliders, particles, onGroundHit) {
  const hits = [];
  for (let i = _boltActive.length - 1; i >= 0; i--) {
    const b = _boltActive[i];
    b.life -= delta;
    if (b.gravity) b.vel.y -= b.gravity * delta;
    b.g.position.addScaledVector(b.vel, delta);
    if (b.gravity) b.g.quaternion.setFromUnitVectors(_tmp3.set(0, 0, 1), _tmp2.copy(b.vel).normalize());
    let dead = b.life <= 0 || b.g.position.y < 0;
    // Player hit: capsule from feet to head.
    const dx = b.g.position.x - playerPos.x, dz = b.g.position.z - playerPos.z;
    const dy = b.g.position.y - (playerPos.y - 0.9);
    if (!dead && dx * dx + dz * dz < 0.45 && dy > -0.3 && dy < 2.0) {
      hits.push({ damage: b.damage, position: b.g.position.clone() });
      dead = true;
    }
    if (!dead && b.splash > 0 && dx * dx + dz * dz < b.splash * b.splash && b.g.position.y < 1.2) {
      // fuel-rod splash near the player: proximity detonation
      const d = Math.sqrt(dx * dx + dz * dz);
      hits.push({ damage: b.damage * (1 - d / b.splash), position: b.g.position.clone(), splash: true });
      dead = true;
    }
    if (!dead && colliders) {
      for (let c = 0; c < colliders.length; c++) {
        if (!colliders[c].isWater && colliders[c].containsPoint(b.g.position)) { dead = true; break; }
      }
    }
    if (dead) {
      if (particles) particles.createImpact(b.g.position, b.m.material.color.getHex(), b.splash > 0 ? 2.5 : 0.6);
      if (onGroundHit && b.g.position.y < 0.6) onGroundHit(b.g.position, b.splash > 0);
      b.g.visible = false; b.m.visible = false;
      _boltActive.splice(i, 1); _boltFree.push(b);
    }
  }
  return hits;
}
export function clearEnemyProjectiles() {
  for (const b of _boltActive) { b.g.visible = false; _boltFree.push(b); }
  _boltActive.length = 0;
}

// ---------------------------------------------------------------------------
// Enemy
// ---------------------------------------------------------------------------
export class Enemy {
  constructor(type, position, ctx, opts = {}) {
    this.type = type;
    this.data = ENEMY_TYPES[type];
    this.ctx = ctx; // { scene, particles, audio, vfx, colliders, enemies }
    this.elite = !!opts.elite;
    const hpMul = (opts.hpMul || 1) * (this.elite ? 1.8 : 1);
    this.maxHp = Math.round(this.data.hp * hpMul);
    this.hp = this.maxHp;
    this.maxShield = Math.round((this.data.shield || 0) * (opts.hpMul || 1) * (this.elite ? 1.5 : 1));
    this.shield = this.maxShield;
    this.shieldTimer = 0;
    this.frontShield = this.data.frontShield ? this.data.frontShield * (opts.hpMul || 1) : 0;
    this.frontShieldMax = this.frontShield;
    this.speedMul = (opts.speedMul || 1) * (this.elite ? 1.15 : 1);
    this.dmgMul = (opts.dmgMul || 1) * (this.elite ? 1.4 : 1);
    this.dead = false; this.removeMe = false; this.deathTimer = 0;
    this.attackCooldown = 0.6 + Math.random() * this.data.attackRate;
    this.burstLeft = 0; this.burstTimer = 0;
    this.strafeDir = Math.random() < 0.5 ? -1 : 1;
    this.strafeTimer = 1 + Math.random() * 2;
    this.panicTimer = 0;
    this.hitFlash = 0;
    this.spawnTimer = this.data.spawnEvery || 0;
    this.stateTime = 0;
    this.ready = false;
    this.isBoss = !!this.data.isBoss;
    this.hoverPhase = Math.random() * Math.PI * 2;
    this.velocity = new THREE.Vector3();
    this.knockback = new THREE.Vector3();
    this.yaw = 0;

    // Root: game-space transform. Model child: normalized + oriented.
    this.mesh = new THREE.Group();
    this.mesh.position.copy(position);
    if (this.data.hoverHeight) this.mesh.position.y = this.data.hoverHeight;
    this.mesh.userData.enemy = this;
    ctx.scene.add(this.mesh);
    this.model = null; this.mixer = null; this.actions = {}; this.current = null;
    this.boundsRadius = this.data.radius * 1.4;
    this.hitHeight = this.data.height;
    this._load();
    this._buildShieldFX();
  }

  async _load() {
    let inst;
    try { inst = await instantiateSkinned(this.type); }
    catch (e) { inst = null; }
    if (this.removeMe) return;
    if (!inst) { this._placeholder(); return; }
    const { mesh, animations } = inst;
    normalize(mesh, this.data.height);
    this.model = mesh;
    this.mesh.add(mesh);
    this.mixer = new THREE.AnimationMixer(mesh);
    for (const clip of animations) {
      const a = this.mixer.clipAction(clip);
      this.actions[clip.name] = a;
      if (clip.name === CLIP.attack || clip.name === CLIP.shoot || clip.name === CLIP.hit || clip.name === CLIP.death) {
        a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true;
      }
    }
    this._materials = [];
    mesh.traverse((o) => {
      if (o.isMesh || o.isSkinnedMesh) {
        o.castShadow = true; o.receiveShadow = false;
        // Clone per instance so hit-flash and death-fade don't bleed across enemies.
        o.material = o.material.clone();
        o.material.__shared = false;
        this._materials.push(o.material);
        if (this.elite) { o.material.emissive = new THREE.Color(0xffaa00); o.material.emissiveIntensity = 0.35; }
      }
    });
    this._play(CLIP.idle, 0);
    this.ready = true;
  }

  // No asset on disk yet: a tinted capsule so the game stays playable while art is generated.
  _placeholder() {
    const h = this.data.height;
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(this.data.radius, Math.max(0.1, h - this.data.radius * 2), 4, 10),
      new THREE.MeshStandardMaterial({ color: this.data.color, roughness: 0.6, metalness: 0.3, emissive: this.data.color, emissiveIntensity: 0.15 }));
    m.position.y = h / 2; m.castShadow = true;
    this.model = m; this.mesh.add(m);
    this._materials = [m.material];
    this.ready = true;
  }

  _buildShieldFX() {
    if (!this.maxShield) return;
    const h = this.data.height;
    const geo = new THREE.CapsuleGeometry(this.data.radius * 1.35, Math.max(0.1, h - this.data.radius * 2.7), 4, 14);
    const mat = new THREE.MeshBasicMaterial({ color: 0x66aaff, transparent: true, opacity: 0.0, toneMapped: false, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    mat.color.multiplyScalar(2.2);
    this.shieldMesh = new THREE.Mesh(geo, mat);
    this.shieldMesh.position.y = h / 2;
    this.mesh.add(this.shieldMesh);
    this.shieldFlash = 0;
  }

  _play(name, fade = 0.15, timeScale = 1) {
    const a = this.actions[name];
    if (!a) return;
    if (this.current === a) { a.timeScale = timeScale; return; }
    if (this.current) this.current.fadeOut(fade);
    a.reset().setEffectiveTimeScale(timeScale).setEffectiveWeight(1).fadeIn(fade).play();
    this.current = a;
  }
  _playOnce(name, then = CLIP.idle) {
    const a = this.actions[name];
    if (!a) return 0;
    this._play(name, 0.08);
    this._returnTo = then;
    return a.getClip().duration;
  }

  get position() { return this.mesh.position; }
  get alive() { return !this.dead; }

  // Damage entry point. `from` is the world position the hit came from (for front shields);
  // returns {killed, absorbed} so the weapon layer can play the right feedback.
  takeDamage(amount, from, opts = {}) {
    if (this.dead) return { killed: false, absorbed: false };
    const audio = this.ctx.audio;
    // Physical front shield (skirmisher arm shield, juggernaut tower shield).
    if (this.frontShield > 0 && from && !opts.ignoreFrontShield) {
      _tmp.subVectors(from, this.mesh.position); _tmp.y = 0; _tmp.normalize();
      _tmp2.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      const ang = Math.acos(THREE.MathUtils.clamp(_tmp.dot(_tmp2), -1, 1));
      if (ang < this.data.frontShieldArc) {
        this.frontShield -= amount * (opts.explosive ? 1.5 : 1);
        this.hitFlash = 0.1;
        if (this.ctx.particles) this.ctx.particles.createSparks(opts.point || this.mesh.position, 0xb080ff, 8);
        if (audio && audio.playShieldHit) audio.playShieldHit();
        if (this.frontShield <= 0) { this.frontShield = 0; this._shieldBroken(); }
        return { killed: false, absorbed: true };
      }
    }
    // Energy shield.
    this.shieldTimer = this.data.shieldDelay || 0;
    if (this.shield > 0) {
      const taken = Math.min(this.shield, amount);
      this.shield -= taken; amount -= taken;
      this.shieldFlash = 1.0;
      if (audio && audio.playShieldHit) audio.playShieldHit();
      if (this.shield <= 0) this._shieldPop();
      if (amount <= 0) return { killed: false, absorbed: true };
    }
    this.hp -= amount;
    this.hitFlash = 0.12;
    if (this.knockback && opts.knockback) {
      _tmp.subVectors(this.mesh.position, from); _tmp.y = 0; _tmp.normalize();
      this.knockback.addScaledVector(_tmp, opts.knockback / Math.max(1, this.data.height));
    }
    if (this.hp <= 0) { this._die(); return { killed: true, absorbed: false }; }
    if (this.data.role !== 'tank' && this.data.role !== 'boss' && Math.random() < 0.35 && this._returnTo == null) {
      this._playOnce(CLIP.hit, CLIP.idle); this.stunTimer = 0.25;
    }
    if (this.data.panics && this.hp < this.maxHp * 0.4) this.panicTimer = Math.max(this.panicTimer, 3);
    return { killed: false, absorbed: false };
  }

  _shieldPop() {
    if (this.ctx.particles) this.ctx.particles.createShieldBurst(this.mesh.position, this.data.height, 0x66aaff);
    if (this.ctx.vfx) this.ctx.vfx.showCallout && this.ctx.vfx.showCallout('SHIELD DOWN');
    // Commanders retreat briefly to recharge, like an Elite ducking behind cover.
    if (this.data.role === 'commander') { this.retreatTimer = 2.2; }
  }
  _shieldBroken() {
    if (this.ctx.particles) this.ctx.particles.createShieldBurst(this.mesh.position, this.data.height, 0xb080ff);
    this.stunTimer = 0.6;
    this._playOnce(CLIP.hit, CLIP.idle);
  }

  _die() {
    this.dead = true;
    this.deathTimer = 1.6;
    this.shield = 0;
    if (this.shieldMesh) this.shieldMesh.visible = false;
    if (this.ctx.audio) this.ctx.audio.playAlienDeath();
    const dur = this._playOnce(CLIP.death, null);
    this.deathTimer = Math.max(this.deathTimer, dur + 0.6);
    // Nearby gnats panic when a commander falls.
    if (this.data.role === 'commander' && this.ctx.enemies) {
      for (const e of this.ctx.enemies) {
        if (e !== this && !e.dead && e.data.panics && e.mesh.position.distanceTo(this.mesh.position) < 25) e.panicTimer = 5;
      }
    }
  }

  // Ease yaw toward a target angle (radians), shortest way round.
  _turnToward(want, delta, rate) {
    let d = want - this.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.yaw += d * Math.min(1, rate * delta);
    this.mesh.rotation.y = this.yaw;
  }
  // Yaw toward a world point, smoothly.
  _face(target, delta, rate = 8) {
    _tmp.subVectors(target, this.mesh.position); _tmp.y = 0;
    if (_tmp.lengthSq() < 1e-4) return;
    this._turnToward(Math.atan2(_tmp.x, _tmp.z), delta, rate);
  }
  // Yaw toward the direction actually being travelled (need not be normalized), so the
  // walk/run gait's forward stride matches how the body is really moving instead of always
  // pointing at the player while strafing or backpedaling. Callers snap back to _face(player)
  // for the instant of firing or a melee swing so the shot/hit still lands where aimed.
  _faceHeading(dir, delta, rate = 9) {
    if (dir.lengthSq() < 1e-4) return;
    this._turnToward(Math.atan2(dir.x, dir.z), delta, rate);
  }

  // Move along `dir` (normalized XZ) at speed, sliding along level colliders.
  _move(dir, speed, delta) {
    const p = this.mesh.position;
    const step = speed * delta;
    if (this.detour && this.detour.t > 0) { this.detour.t -= delta; dir = this.detour; }
    // Unstick: if we are inside a collider (bad spawn, knockback), push out along the shortest exit.
    const colA = this.ctx.colliders;
    if (colA) for (let i = 0; i < colA.length; i++) {
      const b = colA[i];
      if (b.max.y < 0.2 || p.x <= b.min.x || p.x >= b.max.x || p.z <= b.min.z || p.z >= b.max.z) continue;
      const ex = [b.min.x - p.x - this.data.radius, b.max.x - p.x + this.data.radius, b.min.z - p.z - this.data.radius, b.max.z - p.z + this.data.radius];
      let k = 0; for (let j = 1; j < 4; j++) if (Math.abs(ex[j]) < Math.abs(ex[k])) k = j;
      if (k < 2) p.x += ex[k]; else p.z += ex[k];
      break;
    }
    const nx = p.x + dir.x * step, nz = p.z + dir.z * step;
    const r = this.data.radius;
    const col = this.ctx.colliders;
    let okX = true, okZ = true;
    const ghost = (this.ghostTimer || 0) > 0;
    if (col) {
      for (let i = 0; i < col.length; i++) {
        const b = col[i];
        if (b.max.y < 0.2 || (ghost && b.soft)) continue;
        if (nx + r > b.min.x && nx - r < b.max.x && p.z + r > b.min.z && p.z - r < b.max.z) okX = false;
        if (p.x + r > b.min.x && p.x - r < b.max.x && nz + r > b.min.z && nz - r < b.max.z) okZ = false;
        if (!okX && !okZ) break;
      }
    }
    if (okX) p.x = nx;
    if (okZ) p.z = nz;
    if (!okX && !okZ) {
      // Boxed in on both axes: slide sideways along the obstacle, whichever way is open.
      for (const sgn of [1, -1]) {
        const sx = p.x + -dir.z * sgn * step, sz = p.z + dir.x * sgn * step;
        let free = true;
        if (col) for (let i = 0; i < col.length; i++) { const b = col[i]; if (b.max.y >= 0.2 && sx + r > b.min.x && sx - r < b.max.x && sz + r > b.min.z && sz - r < b.max.z) { free = false; break; } }
        if (free) { p.x = sx; p.z = sz; okX = true; break; }
      }
      if (!okX) {
        // Cornered: commit to a detour direction for a moment instead of re-deciding every frame
        // (per-frame re-evaluation oscillates in place against a box corner).
        const sgn = Math.random() < 0.5 ? 1 : -1;
        this.detour = { x: -dir.z * sgn, z: dir.x * sgn, t: 0.9 };
        p.x -= dir.x * step; p.z -= dir.z * step;
      }
    }
    // Stuck detector: barely moving for a while -> step over soft props for a moment.
    this._stuckAcc = (this._stuckAcc || 0) + delta;
    if (this._stuckAcc > 1.0) {
      const moved = Math.hypot(p.x - (this._stuckX || p.x), p.z - (this._stuckZ || p.z));
      this._stuckX = p.x; this._stuckZ = p.z; this._stuckAcc = 0;
      if (moved < 0.6) this.ghostTimer = 2.5;
    }
    if (this.ghostTimer > 0) this.ghostTimer -= delta;
    // Keep inside the arena
    const lim = this.ctx.arenaRadius || 120;
    const d2 = p.x * p.x + p.z * p.z;
    if (d2 > lim * lim) { const s = lim / Math.sqrt(d2); p.x *= s; p.z *= s; }
    return okX || okZ;
  }

  _separate(delta) {
    // Push away from other enemies so packs don't clip through each other.
    const list = this.ctx.enemies; if (!list) return;
    const p = this.mesh.position;
    for (let i = 0; i < list.length; i++) {
      const o = list[i]; if (o === this || o.dead) continue;
      if (!!o.data.hoverHeight !== !!this.data.hoverHeight) continue;
      const dx = p.x - o.mesh.position.x, dz = p.z - o.mesh.position.z;
      const d2 = dx * dx + dz * dz, minD = this.data.radius + o.data.radius + 0.3;
      if (d2 < minD * minD && d2 > 1e-4) {
        const d = Math.sqrt(d2), push = (minD - d) * 2.5 * delta;
        p.x += dx / d * push; p.z += dz / d * push;
      }
    }
  }

  _shoot(playerPos, dmg, opts = {}) {
    // Muzzle roughly at chest height, slightly forward.
    const h = this.data.height;
    _tmp.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const from = _tmp2.copy(this.mesh.position).addScaledVector(_tmp, this.data.radius + 0.2);
    from.y += this.data.hoverHeight ? 0 : h * 0.62;
    const target = _tmp3.copy(playerPos); target.y -= 0.35;
    if (opts.lead) target.addScaledVector(opts.lead, 0.25);
    const dir = target.sub(from).normalize();
    // Inaccuracy grows with distance, elites are sharper.
    const spread = (opts.spread != null ? opts.spread : 0.035) * (this.elite ? 0.5 : 1);
    dir.x += (Math.random() - 0.5) * spread; dir.y += (Math.random() - 0.5) * spread * 0.5; dir.z += (Math.random() - 0.5) * spread;
    dir.normalize();
    _fireBolt(from, dir, opts.speed || 28, this.data.boltColor, Math.round(dmg * this.dmgMul), opts);
    if (this.ctx.audio) this.ctx.audio.playAlienShoot();
    if (this.actions[CLIP.shoot] && this._returnTo == null) this._playOnce(CLIP.shoot, CLIP.idle);
    if (this.ctx.particles && this.ctx.particles.createMuzzleFlash) this.ctx.particles.createMuzzleFlash(from, dir, this.data.boltColor);
  }

  // Main update. Returns true when the corpse should be removed.
  update(delta, playerPos, playerVel) {
    if (this.mixer) this.mixer.update(delta);
    // Hit flash / death fade on cloned materials
    if (this._materials) {
      if (this.hitFlash > 0) {
        this.hitFlash -= delta;
        const k = this.hitFlash > 0 ? 1 : 0;
        for (const m of this._materials) { if (m.emissive) { m.emissive.setRGB(k, k * 0.6, k * 0.3); m.emissiveIntensity = k ? 0.9 : (this.elite ? 0.35 : 0); if (k === 0 && this.elite) m.emissive.setHex(0xffaa00); } }
      }
    }
    if (this.dead) {
      this.deathTimer -= delta;
      if (this.data.hoverHeight) { // aircraft fall and spin
        this.mesh.position.y = Math.max(0.3, this.mesh.position.y - 6 * delta);
        this.mesh.rotation.z += 3 * delta; this.mesh.rotation.x += 1.5 * delta;
        if (this.mesh.position.y <= 0.31 && !this._crashed) { this._crashed = true; if (this.ctx.particles) this.ctx.particles.createExplosion(this.mesh.position, 0.8); }
      }
      if (this.deathTimer < 0.7 && this._materials) {
        const a = Math.max(0, this.deathTimer / 0.7);
        for (const m of this._materials) { m.transparent = true; m.opacity = a; }
      }
      return this.deathTimer <= 0;
    }
    if (!this.ready) return false;
    this.stateTime += delta;

    // Energy shield recharge
    if (this.maxShield) {
      if (this.shieldTimer > 0) this.shieldTimer -= delta;
      else if (this.shield < this.maxShield) this.shield = Math.min(this.maxShield, this.shield + (this.data.shieldRegen || 40) * delta);
      if (this.shieldMesh) {
        this.shieldFlash = Math.max(0, this.shieldFlash - delta * 3);
        const base = this.shield > 0 ? 0.012 + 0.012 * Math.sin(this.stateTime * 6) : 0;
        this.shieldMesh.material.opacity = base + this.shieldFlash * 0.35;
        this.shieldMesh.visible = this.shieldMesh.material.opacity > 0.01;
      }
    }
    // Knockback decay
    if (this.knockback.lengthSq() > 1e-4) {
      this._move(_tmp.copy(this.knockback).normalize(), this.knockback.length(), delta);
      this.knockback.multiplyScalar(Math.max(0, 1 - 8 * delta));
    }
    // One-shot animation return
    if (this._returnTo != null && this.current && !this.current.isRunning()) {
      const to = this._returnTo; this._returnTo = null; this._play(to, 0.12);
    }
    if (this.stunTimer > 0) { this.stunTimer -= delta; return false; }
    if (this.retreatTimer > 0) this.retreatTimer -= delta;
    if (this.panicTimer > 0) this.panicTimer -= delta;
    if (this.attackCooldown > 0) this.attackCooldown -= delta;

    _tmp.subVectors(playerPos, this.mesh.position); _tmp.y = 0;
    const dist = _tmp.length();
    const toPlayer = _tmp2.copy(_tmp).normalize();
    const d = this.data;
    // Line of sight, sampled twice a second. Ground units that lose sight of the player for a
    // few seconds stop holding position and hunt — a squad never waits behind a wall forever.
    this._losTimer = (this._losTimer || 0) - delta;
    if (this._losTimer <= 0 && !d.hoverHeight) {
      this._losTimer = 0.5;
      const eye = _tmp3.set(this.mesh.position.x, this.mesh.position.y + d.height * 0.6, this.mesh.position.z);
      const blocked = losBlocked(eye, playerPos, this.ctx.colliders);
      this._noLos = blocked ? (this._noLos || 0) + 0.5 : 0;
    }
    const hunting = this.aggressive || (this._noLos || 0) > 2.5;
    const speed = d.speed * this.speedMul;
    let moved = false, moveSpeed = 0;

    switch (d.role) {
      case 'ranged': { // Gnat: hold range, plink, panic-run when hurt or leaderless
        if (hunting) this.panicTimer = 0;
        let faceDir = toPlayer;
        if (hunting && (this._noLos || 0) > 2.5) {
          this._move(toPlayer, speed * 1.2, delta); moved = true; moveSpeed = speed * 1.2; faceDir = toPlayer;
        } else if (this.panicTimer > 0) {
          // Flee away, zig-zagging, arms up — face the way it's actually running, not the player.
          _tmp3.set(-toPlayer.x + Math.sin(this.stateTime * 7) * 0.6, 0, -toPlayer.z + Math.cos(this.stateTime * 5) * 0.6).normalize();
          this._move(_tmp3, speed * 1.5, delta); moved = true; moveSpeed = speed * 1.5; faceDir = _tmp3;
        } else if (dist > (this.aggressive ? 5 : d.attackRange * 0.85)) {
          this._move(toPlayer, speed * (this.aggressive ? 1.3 : 1), delta); moved = true; moveSpeed = speed; faceDir = toPlayer;
        } else if (dist < d.keepDistance * 0.6 && !this.aggressive) {
          _tmp3.copy(toPlayer).negate(); this._move(_tmp3, speed * 0.8, delta); moved = true; moveSpeed = speed * 0.8; faceDir = _tmp3;
        } else {
          this.strafeTimer -= delta;
          if (this.strafeTimer <= 0) { this.strafeDir *= -1; this.strafeTimer = 1.5 + Math.random() * 2; }
          _tmp3.set(-toPlayer.z * this.strafeDir, 0, toPlayer.x * this.strafeDir);
          this._move(_tmp3, speed * 0.5, delta); moved = true; moveSpeed = speed * 0.5; faceDir = _tmp3;
        }
        this._faceHeading(faceDir, delta, this.panicTimer > 0 ? 12 : 7);
        if (this.panicTimer <= 0 && dist < d.attackRange && this.attackCooldown <= 0 && !(this._noLos > 0)) {
          this._face(playerPos, delta, 16); // plant and aim for the shot
          this._shoot(playerPos, d.damage, { speed: 26, spread: 0.05, lead: playerVel });
          this.attackCooldown = d.attackRate * (0.8 + Math.random() * 0.5);
        }
        break;
      }
      case 'skirmisher': { // fast lateral flanker, arm shield toward the player, needle bursts
        this.strafeTimer -= delta;
        if (this.strafeTimer <= 0) { this.strafeDir *= -1; this.strafeTimer = 0.8 + Math.random() * 1.4; }
        // Orbit at keepDistance; close in when the front shield is up, back off when it's broken.
        const want = this.frontShield > 0 ? d.keepDistance : d.keepDistance * 1.6;
        _tmp3.set(-toPlayer.z * this.strafeDir, 0, toPlayer.x * this.strafeDir);
        if (hunting) _tmp3.set(0, 0, 0);
        if (dist > want + 3 || hunting) _tmp3.addScaledVector(toPlayer, 1.2);
        else if (dist < want - 3) _tmp3.addScaledVector(toPlayer, -1.2);
        _tmp3.normalize();
        this._move(_tmp3, speed, delta); moved = true; moveSpeed = speed;
        // Face the way it's actually circling so the run cycle matches its feet; hold facing the
        // player for as long as it's actively bursting so the shield/carbine track the target.
        const bursting = dist < d.attackRange && this.attackCooldown <= 0 && !(this._noLos > 0);
        if (bursting) this._face(playerPos, delta, 14);
        else this._faceHeading(_tmp3, delta, 11);
        if (dist < d.attackRange && this.attackCooldown <= 0 && !(this._noLos > 0)) {
          if (this.burstLeft <= 0) { this.burstLeft = d.burst; }
          this.burstTimer -= delta;
          if (this.burstTimer <= 0) {
            this._shoot(playerPos, d.damage, { speed: 40, spread: 0.035, scale: 0.6, lead: playerVel });
            this.burstLeft--; this.burstTimer = 0.09;
            if (this.burstLeft <= 0) this.attackCooldown = d.attackRate * 4.5;
          }
        }
        // Slowly regrow the arm shield once it's been down a while.
        if (this.frontShield <= 0) { this._frontRegen = (this._frontRegen || 0) + delta; if (this._frontRegen > 8) { this.frontShield = this.frontShieldMax * 0.6; this._frontRegen = 0; } }
        break;
      }
      case 'commander': { // Warlord: press the attack while shielded, melee up close, fall back to recharge
        let faceDir = null;
        if (this.retreatTimer > 0 || (this.shield <= 0 && this.maxShield && dist < 12)) {
          _tmp3.copy(toPlayer).negate(); _tmp3.x += Math.sin(this.stateTime * 3) * 0.5; _tmp3.normalize();
          this._move(_tmp3, speed * 1.2, delta); moved = true; moveSpeed = speed * 1.2; faceDir = _tmp3;
        } else if (dist < d.meleeRange + 0.3) {
          if (this.attackCooldown <= 0) {
            this._playOnce(CLIP.attack, CLIP.idle);
            this.pendingMelee = 0.28; // lands mid-swing
            this.attackCooldown = 1.1;
          }
        } else if (dist < 7) {
          this._move(toPlayer, speed * 1.6, delta); moved = true; moveSpeed = speed * 1.6; faceDir = toPlayer; // lunge in
        } else if (dist > d.keepDistance || hunting) {
          this._move(toPlayer, speed, delta); moved = true; moveSpeed = speed; faceDir = toPlayer;
        } else {
          this.strafeTimer -= delta;
          if (this.strafeTimer <= 0) { this.strafeDir *= -1; this.strafeTimer = 1.2 + Math.random() * 1.5; }
          _tmp3.set(-toPlayer.z * this.strafeDir, 0, toPlayer.x * this.strafeDir);
          this._move(_tmp3, speed * 0.6, delta); moved = true; moveSpeed = speed * 0.6; faceDir = _tmp3;
        }
        // Face the way it's actually moving; a melee windup or an active burst snaps it to face
        // the player instead, so the sword swing and the shots land where they're aimed.
        const bursting = dist >= d.meleeRange + 0.3 && dist < d.attackRange && this.attackCooldown <= 0 && this.retreatTimer <= 0;
        if (dist < d.meleeRange + 0.3) this._face(playerPos, delta, 10);
        else if (bursting) this._face(playerPos, delta, 14);
        else this._faceHeading(faceDir, delta, 9);
        if (this.pendingMelee != null) {
          this.pendingMelee -= delta;
          if (this.pendingMelee <= 0) {
            this.pendingMelee = null;
            if (dist < d.meleeRange + 0.8) this.ctx.onMelee && this.ctx.onMelee(this, Math.round(d.meleeDamage * this.dmgMul));
          }
        }
        if (dist >= d.meleeRange + 0.3 && dist < d.attackRange && this.attackCooldown <= 0 && this.retreatTimer <= 0) {
          if (this.burstLeft <= 0) this.burstLeft = d.burst;
          this.burstTimer -= delta;
          if (this.burstTimer <= 0) {
            this._shoot(playerPos, d.damage, { speed: 34, spread: 0.045, scale: 0.9, lead: playerVel });
            this.burstLeft--; this.burstTimer = 0.14;
            if (this.burstLeft <= 0) this.attackCooldown = d.attackRate * 3.2;
          }
        }
        break;
      }
      case 'tank': { // Juggernaut: slow advance behind the tower shield, lobbed fuel rods
        this._face(playerPos, delta, 3);
        if (dist > d.keepDistance || hunting) { this._move(toPlayer, speed, delta); moved = true; moveSpeed = speed; }
        if (dist < d.attackRange && this.attackCooldown <= 0 && !(this._noLos > 0)) {
          // Arc the shot so it can be dodged; gravity pulls it down onto the player.
          const t = Math.max(0.6, dist / 22);
          const lead = _tmp3.copy(playerPos).addScaledVector(playerVel, t * 0.6);
          const h = this.data.height * 0.7;
          const from = new THREE.Vector3(this.mesh.position.x + Math.sin(this.yaw) * 1.2, this.mesh.position.y + h, this.mesh.position.z + Math.cos(this.yaw) * 1.2);
          const g = 14;
          const dir = lead.sub(from);
          const flat = Math.sqrt(dir.x * dir.x + dir.z * dir.z);
          const vy = (dir.y + 0.5 * g * t * t) / t;
          const vel = new THREE.Vector3(dir.x / t, vy, dir.z / t);
          const sp = vel.length();
          _fireBolt(from, vel.normalize(), sp, d.boltColor, Math.round(d.damage * this.dmgMul), { splash: d.splash, gravity: g, scale: 2.2 });
          if (this.ctx.audio) this.ctx.audio.playRocketLaunch();
          this._playOnce(CLIP.shoot, CLIP.idle);
          this.attackCooldown = d.attackRate;
        }
        break;
      }
      case 'aerial': { // Wasp: circle overhead, dive to strafe, climb away
        const hover = d.hoverHeight + Math.sin(this.stateTime * 2 + this.hoverPhase) * 1.2;
        this.strafeTimer -= delta;
        if (this.strafeTimer <= 0) { this.strafeDir *= -1; this.strafeTimer = 2 + Math.random() * 2; this.diving = Math.random() < 0.5; }
        _tmp3.set(-toPlayer.z * this.strafeDir, 0, toPlayer.x * this.strafeDir);
        if (dist > d.keepDistance + 4) _tmp3.addScaledVector(toPlayer, 1.0);
        else if (dist < d.keepDistance - 4) _tmp3.addScaledVector(toPlayer, -1.0);
        _tmp3.normalize();
        const p = this.mesh.position;
        p.x += _tmp3.x * speed * delta; p.z += _tmp3.z * speed * delta;
        const targetY = this.diving ? Math.max(2.2, hover * 0.45) : hover;
        p.y += (targetY - p.y) * Math.min(1, 3 * delta);
        // Nose points the way it's actually flying; only snaps to face the player for the shot.
        if (dist < d.attackRange && this.attackCooldown <= 0) this._face(playerPos, delta, 10);
        else this._faceHeading(_tmp3, delta, 6);
        // bank into the turn, relative to its own heading
        if (this.model) { this.model.rotation.z = -this.strafeDir * 0.35; this.model.rotation.x = this.diving ? 0.25 : 0; }
        if (dist < d.attackRange && this.attackCooldown <= 0) {
          this._shoot(playerPos, d.damage, { speed: 32, spread: 0.04, scale: 0.7, lead: playerVel });
          this.attackCooldown = d.attackRate;
        }
        moved = true; moveSpeed = speed;
        break;
      }
      case 'boss': { // Overseer: hover, sweep bolts, spawn gnats, spin up a beam every so often
        const hover = d.hoverHeight + Math.sin(this.stateTime * 1.2) * 1.5;
        this._face(playerPos, delta, 2.5);
        this.strafeTimer -= delta;
        if (this.strafeTimer <= 0) { this.strafeDir *= -1; this.strafeTimer = 3 + Math.random() * 3; }
        _tmp3.set(-toPlayer.z * this.strafeDir, 0, toPlayer.x * this.strafeDir);
        if (dist > d.keepDistance + 6) _tmp3.addScaledVector(toPlayer, 1.0);
        else if (dist < d.keepDistance - 6) _tmp3.addScaledVector(toPlayer, -1.0);
        _tmp3.normalize();
        const p = this.mesh.position;
        p.x += _tmp3.x * speed * delta; p.z += _tmp3.z * speed * delta;
        p.y += (hover - p.y) * Math.min(1, 2 * delta);
        if (this.model) this.model.rotation.y += delta * 0.4;
        if (dist < d.attackRange && this.attackCooldown <= 0) {
          // Three-round sweep from the arms.
          this._shoot(playerPos, d.damage, { speed: 30, spread: 0.06, scale: 1.2, lead: playerVel });
          this.attackCooldown = d.attackRate * (this.shield > 0 ? 3 : 2);
        }
        this.spawnTimer -= delta;
        if (this.spawnTimer <= 0 && this.ctx.spawn) {
          this.spawnTimer = d.spawnEvery;
          for (let i = 0; i < 3; i++) {
            const a = Math.random() * Math.PI * 2;
            this.ctx.spawn('gnat', new THREE.Vector3(p.x + Math.cos(a) * 4, 0, p.z + Math.sin(a) * 4), { dropIn: true });
          }
        }
        moved = true; moveSpeed = speed;
        break;
      }
    }
    if (!d.hoverHeight) this._separate(delta);

    // Locomotion animation from actual movement.
    if (this._returnTo == null) {
      if (moved && moveSpeed > 0.1) {
        const run = moveSpeed > d.speed * 0.95 || this.panicTimer > 0;
        this._play(run ? CLIP.run : CLIP.walk, 0.15, run ? Math.max(0.8, moveSpeed / (d.speed * 1.5)) : Math.max(0.7, moveSpeed / d.speed));
      } else {
        this._play(CLIP.idle, 0.25);
      }
    }
    return false;
  }

  dispose() {
    this.removeMe = true;
    this.ctx.scene.remove(this.mesh);
    if (this.mixer) this.mixer.stopAllAction();
    if (this._materials) for (const m of this._materials) m.dispose();
    if (this.shieldMesh) { this.shieldMesh.geometry.dispose(); this.shieldMesh.material.dispose(); }
    if (this.model && this.model.isMesh) this.model.geometry.dispose();
  }
}
