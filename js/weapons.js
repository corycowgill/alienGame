// weapons.js - Player arsenal: human ballistics + looted alien plasma. Viewmodels are GLBs
// attached to the camera; hit detection is analytic (ray vs enemy capsule) so it works the same
// against every rig regardless of mesh complexity.
import * as THREE from 'three';
import { instantiate } from './assets.js';

export const WEAPONS = {
  rifle: {
    name: 'MA-7 RIFLE', key: '1', kind: 'hitscan', damage: 11, fireRate: 0.095, range: 140, spread: 0.014,
    mag: 32, reserve: Infinity, reload: 1.7, auto: true, headshot: 2.0, shieldMul: 0.7, recoil: 0.012, model: 'rifle',
    pos: [0.28, -0.26, -0.55], rot: [0, -Math.PI / 2, 0], scale: 0.5, muzzle: [0.0, 0.05, -0.55], color: 0xffd080,
  },
  plasmaRifle: {
    name: 'PLASMA RIFLE', key: '2', kind: 'projectile', damage: 16, fireRate: 0.13, speed: 70, range: 120,
    heatPerShot: 0.065, cooldownRate: 0.45, overheatTime: 1.8, auto: true, headshot: 1.3, shieldMul: 2.4, recoil: 0.006, model: 'plasmaRifle',
    pos: [0.3, -0.27, -0.5], rot: [0, -Math.PI / 2, 0], scale: 0.55, muzzle: [0.0, 0.04, -0.6], color: 0x40a0ff,
  },
  energySword: {
    name: 'ENERGY SWORD', key: '3', kind: 'melee', damage: 140, fireRate: 0.6, range: 3.8, lunge: 7.5, arc: 0.85,
    auto: false, headshot: 1.0, shieldMul: 1.6, model: 'energySword',
    pos: [0.34, -0.3, -0.45], rot: [0.15, -Math.PI / 2 - 0.25, 0.1], scale: 0.65, muzzle: [0, 0, -0.5], color: 0x60c0ff,
  },
  rocketLauncher: {
    name: 'ROCKET LAUNCHER', key: '4', kind: 'rocket', damage: 260, splash: 6.5, fireRate: 1.2, speed: 42, range: 150,
    mag: 2, reserve: 8, reload: 2.8, auto: false, headshot: 1.0, shieldMul: 1.0, recoil: 0.06, model: 'rocketLauncher',
    pos: [0.3, -0.24, -0.5], rot: [0, -Math.PI / 2, 0], scale: 0.6, muzzle: [0.0, 0.08, -0.7], color: 0xffa040,
  },
};
export const WEAPON_ORDER = ['rifle', 'plasmaRifle', 'energySword', 'rocketLauncher'];

const _ray = new THREE.Ray();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _m = new THREE.Matrix4();

// Ray vs vertical capsule (centre c on the ground, radius r, height h). Returns t or -1.
function rayCapsule(origin, dir, c, r, h) {
  // Cylinder part in XZ
  const ox = origin.x - c.x, oz = origin.z - c.z;
  const a = dir.x * dir.x + dir.z * dir.z;
  const b = 2 * (ox * dir.x + oz * dir.z);
  const cc = ox * ox + oz * oz - r * r;
  let t = -1;
  if (a > 1e-8) {
    const disc = b * b - 4 * a * cc;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      const t0 = (-b - s) / (2 * a), t1 = (-b + s) / (2 * a);
      for (const tt of [t0, t1]) {
        if (tt < 0) continue;
        const y = origin.y + dir.y * tt;
        if (y >= c.y && y <= c.y + h) { t = tt; break; }
      }
    }
  } else if (cc <= 0) {
    // vertical ray inside the column
    const ty0 = (c.y - origin.y) / dir.y, ty1 = (c.y + h - origin.y) / dir.y;
    const tt = Math.min(ty0, ty1); if (tt >= 0) t = tt;
  }
  if (t >= 0) return t;
  // Caps
  for (const cy of [c.y + r, c.y + h - r]) {
    _v.set(c.x, cy, c.z).sub(origin);
    const tca = _v.dot(dir);
    const d2 = _v.lengthSq() - tca * tca;
    if (d2 > r * r) continue;
    const thc = Math.sqrt(r * r - d2);
    const tt = tca - thc;
    if (tt >= 0 && (t < 0 || tt < t)) t = tt;
  }
  return t;
}

const _wallHit = { point: new THREE.Vector3(), normal: new THREE.Vector3(), dist: Infinity };
function rayBoxes(origin, dir, colliders, maxDist) {
  let best = maxDist; _wallHit.dist = Infinity;
  _ray.set(origin, dir);
  for (let i = 0; i < colliders.length; i++) {
    const b = colliders[i];
    if (b.isWater) continue; // water stops feet, not bullets
    const p = _ray.intersectBox(b, _v2);
    if (!p) continue;
    const d = p.distanceTo(origin);
    if (d >= best) continue;
    best = d; _wallHit.dist = d; _wallHit.point.copy(p);
    // Face normal: whichever slab the point sits on (ties resolved toward the ray origin).
    const e = 1e-3;
    if (Math.abs(p.x - b.min.x) < e) _wallHit.normal.set(-1, 0, 0); else if (Math.abs(p.x - b.max.x) < e) _wallHit.normal.set(1, 0, 0);
    else if (Math.abs(p.z - b.min.z) < e) _wallHit.normal.set(0, 0, -1); else if (Math.abs(p.z - b.max.z) < e) _wallHit.normal.set(0, 0, 1);
    else if (Math.abs(p.y - b.max.y) < e) _wallHit.normal.set(0, 1, 0); else _wallHit.normal.set(0, -1, 0);
  }
  return best;
}

export class WeaponManager {
  constructor(camera, scene, particles, audio) {
    this.camera = camera; this.scene = scene; this.particles = particles; this.audio = audio;
    this.player = null;
    this.colliders = [];
    this.current = 'rifle';
    this.cooldown = 0;
    this.state = {};
    for (const k of WEAPON_ORDER) {
      const w = WEAPONS[k];
      this.state[k] = { mag: w.mag != null ? w.mag : Infinity, reserve: w.reserve != null ? w.reserve : Infinity, heat: 0, overheated: 0, reloading: 0 };
    }
    this.grenades = 3;
    this.projectiles = [];
    this.viewmodels = {};
    this.rig = new THREE.Group();          // sway/recoil pivot
    this.camera.add(this.rig);
    this.recoil = 0; this.swayX = 0; this.swayY = 0; this.bobT = 0;
    this.muzzleLight = new THREE.PointLight(0xffc070, 0, 6, 2);
    this.muzzleLight.position.set(0.25, -0.2, -0.8);
    this.rig.add(this.muzzleLight);
    const fill = new THREE.PointLight(0x9fb4ff, 0.35, 1.6, 2); fill.position.set(-0.3, 0.3, -0.2); this.rig.add(fill);
    this.onHit = null;        // (hit) => void   hit: {enemy, damage, point, headshot, weaponKey}
    this.onRocketHit = null;  // (hits, pos)
    this.onGrenadeHit = null;
    this.onWallHit = null;    // (point, normal, kind) kind: bullet | plasma | blast
    this.zoomed = false;
    this.swingT = 0;
    this.ready = this._loadViewmodels(); // awaited by loadLevel() before it precompiles shaders
    this._projGeo = new THREE.CapsuleGeometry(0.07, 0.4, 3, 8);
    this._rocketGeo = new THREE.CylinderGeometry(0.08, 0.1, 0.7, 8);
    this._projMats = {};
    this.trailPool = [];
  }

  async _loadViewmodels() {
    for (const k of WEAPON_ORDER) {
      const w = WEAPONS[k];
      const holder = new THREE.Group();
      holder.visible = false;
      this.rig.add(holder);
      this.viewmodels[k] = holder;
      let obj;
      let placeholder = false;
      try { obj = await instantiate(w.model); }
      catch (e) { obj = this._placeholderModel(w); placeholder = true; }
      // Fit: longest dimension = 1 unit then scaled by w.scale
      const box = new THREE.Box3().setFromObject(obj); const s = new THREE.Vector3(); box.getSize(s);
      const c = new THREE.Vector3(); box.getCenter(c);
      obj.position.sub(c);
      const wrap = new THREE.Group(); wrap.add(obj);
      wrap.scale.setScalar(w.scale / Math.max(s.x, s.y, s.z, 1e-6));
      wrap.rotation.set(...w.rot);
      holder.position.set(...w.pos);
      holder.add(wrap);
      obj.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; o.renderOrder = 10; if (o.material) { o.material.depthTest = true; if (k === 'energySword' && o.material.map) { o.material.emissive = new THREE.Color(0x3060ff); o.material.emissiveMap = o.material.map; o.material.emissiveIntensity = 0.45; } } } });
      if (k === 'energySword') this._addBladeGlow(holder, w, placeholder);
    }
    this.viewmodels[this.current].visible = true;
  }

  _placeholderModel(w) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.14, 0.8), new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.5, metalness: 0.6 }));
    g.add(body);
    const glow = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.3), new THREE.MeshBasicMaterial({ color: w.color, toneMapped: false }));
    glow.material.color.multiplyScalar(1.2); glow.position.set(0.07, 0.04, -0.2); g.add(glow);
    return g;
  }
  _addBladeGlow(holder, w, placeholder) {
    if (placeholder) {
      const mat = new THREE.MeshBasicMaterial({ color: 0x70d0ff, transparent: true, opacity: 0.55, toneMapped: false, blending: THREE.AdditiveBlending, depthWrite: false });
      mat.color.multiplyScalar(3.5);
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.16, 0.7), mat);
      blade.position.set(0, 0.02, -0.35); holder.add(blade);
    }
    const l = new THREE.PointLight(0x60c0ff, 1.0, 3, 2); l.position.set(0, 0, -0.3); holder.add(l);
    holder.userData.bladeLight = l;
  }

  get weapon() { return WEAPONS[this.current]; }
  get st() { return this.state[this.current]; }

  switchWeapon(key) {
    if (!WEAPONS[key] || key === this.current) return;
    for (const k in this.viewmodels) this.viewmodels[k].visible = false;
    this.current = key;
    if (this.viewmodels[key]) this.viewmodels[key].visible = true;
    this.cooldown = Math.max(this.cooldown, 0.3);
    this.raiseT = 0.3; // pull-up animation
    this.zoomed = false;
    if (this.audio) this.audio.playWeaponSwitch();
  }

  reload() {
    const w = this.weapon, s = this.st;
    if (w.mag == null || s.reloading > 0 || s.mag >= w.mag || s.reserve <= 0) return;
    s.reloading = w.reload;
    if (this.audio) this.audio.playReload();
  }
  addAmmo(key, n) { const s = this.state[key]; if (s) s.reserve = Math.min(s.reserve + n, 99); }
  addGrenade(n) { this.grenades = Math.min(this.grenades + n, 6); }

  ammoText() {
    const w = this.weapon, s = this.st;
    if (w.kind === 'melee') return '∞';
    if (w.heatPerShot != null) return s.overheated > 0 ? 'OVERHEAT' : 'HEAT ' + Math.round(s.heat * 100) + '%';
    return `${s.mag} / ${s.reserve === Infinity ? '∞' : s.reserve}`;
  }
  cooldownPct() {
    const w = this.weapon, s = this.st;
    if (s.reloading > 0) return 1 - s.reloading / w.reload;
    if (w.heatPerShot != null) return 1 - s.heat;
    return this.cooldown > 0 ? 1 - this.cooldown / w.fireRate : 1;
  }

  // Try to fire. Returns true if a shot went out.
  fire(enemies) {
    const w = this.weapon, s = this.st;
    if (this.cooldown > 0 || s.reloading > 0 || s.overheated > 0 || (this.player && this.player.dead)) return false;
    if (w.mag != null && s.mag <= 0) { this.reload(); return false; }
    const fr = w.fireRate * (this.player ? this.player.fireRateMultiplier : 1);
    this.cooldown = fr;
    const dmgMul = this.player ? this.player.damageMultiplier : 1;
    if (w.mag != null) s.mag--;
    if (w.heatPerShot != null) { s.heat = Math.min(1, s.heat + w.heatPerShot); if (s.heat >= 1) { s.overheated = w.overheatTime; if (this.audio && this.audio.playShieldHit) this.audio.playShieldHit(); } }
    this.recoil = Math.min(0.2, this.recoil + (w.recoil || 0.01));
    this.muzzleLight.color.setHex(w.color); this.muzzleLight.intensity = w.kind === 'melee' ? 0 : 6;
    const origin = this.camera.getWorldPosition(_v3.set(0, 0, 0)).clone();
    const dir = this.camera.getWorldDirection(_dir).clone();
    const muzzle = this._muzzleWorld();
    switch (w.kind) {
      case 'hitscan': {
        dir.x += (Math.random() - 0.5) * w.spread * (this.zoomed ? 0.25 : 1); dir.y += (Math.random() - 0.5) * w.spread; dir.z += (Math.random() - 0.5) * w.spread; dir.normalize();
        const hit = this._hitscan(origin, dir, enemies, w, dmgMul);
        const end = hit ? hit.point : _v.copy(origin).addScaledVector(dir, hit === null ? this._wallDist : w.range);
        if (this.particles) { this.particles.createLaserBeam(muzzle, end, 0xffe0a0, 0.05, 0.012); }
        if (!hit && this._wallDist < w.range) {
          if (this.particles) this.particles.createSparks(end, 0xffc060, 5);
          if (this.onWallHit && _wallHit.dist < Infinity) this.onWallHit(_wallHit.point, _wallHit.normal, 'bullet', origin, dir);
        }
        if (this.audio) this.audio.playLaserRifle();
        if (hit && this.onHit) this.onHit(hit);
        break;
      }
      case 'projectile': {
        dir.x += (Math.random() - 0.5) * 0.02; dir.y += (Math.random() - 0.5) * 0.02; dir.normalize();
        this._spawnProjectile(muzzle, dir, w, dmgMul, 'plasma');
        if (this.audio) this.audio.playAlienShoot();
        break;
      }
      case 'rocket': {
        this._spawnProjectile(muzzle, dir, w, dmgMul, 'rocket');
        if (this.audio) this.audio.playRocketLaunch();
        break;
      }
      case 'melee': {
        this.swingT = 0.35;
        // Halo-style lunge: if an enemy is within lunge range in front, the player is pulled to it.
        const target = this._meleeTarget(origin, dir, enemies, w.lunge, w.arc);
        if (target) {
          this.lungeTarget = target.enemy;
          this.lungeTimer = 0.14;
        }
        if (this.particles) this.particles.createSwordSlash(this.camera, 0x60c0ff);
        if (this.audio) this.audio.playLaserSword();
        // Damage is applied slightly after the swing starts (see update) so the lunge lands first.
        this.pendingMelee = { t: 0.1, dmgMul };
        break;
      }
    }
    return true;
  }

  fireAlt(enemies) {
    // Right-click: rifle zoom toggle; energy sword heavy overhead (2x cooldown, 1.6x damage)
    if (this.current === 'rifle') { this.zoomed = !this.zoomed; return; }
    if (this.current === 'energySword' && this.cooldown <= 0) {
      const ok = this.fire(enemies);
      if (ok) { this.cooldown *= 1.8; this.pendingMelee.dmgMul *= 1.6; this.swingT = 0.5; }
    }
  }

  throwGrenade() {
    if (this.grenades <= 0 || (this.player && this.player.dead)) return;
    this.grenades--;
    const origin = this.camera.getWorldPosition(new THREE.Vector3());
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    dir.y += 0.25; dir.normalize();
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), new THREE.MeshStandardMaterial({ color: 0x3050ff, emissive: 0x2040ff, emissiveIntensity: 1.5, roughness: 0.3 }));
    mesh.position.copy(origin).addScaledVector(dir, 0.6);
    this.scene.add(mesh);
    this.projectiles.push({ kind: 'grenade', mesh, vel: dir.multiplyScalar(19), life: 2.2, damage: 190 * (this.player ? this.player.damageMultiplier : 1), splash: 6, gravity: 16, bounce: true });
    if (this.audio) this.audio.playGrenadeThrow();
  }

  _muzzleWorld() {
    const w = this.weapon;
    const vm = this.viewmodels[this.current];
    if (vm) { return vm.localToWorld(_v4.set(w.muzzle[0], w.muzzle[1], w.muzzle[2])).clone(); }
    return this.camera.getWorldPosition(new THREE.Vector3());
  }

  _enemyCapsule(e) {
    const d = e.data; const p = e.mesh.position;
    const r = d.radius * (d.hoverHeight ? 1.6 : 1.15);
    const y = d.hoverHeight ? p.y - d.height * 0.5 : p.y;
    return { c: _v2.set(p.x, y, p.z), r, h: d.height };
  }

  _hitscan(origin, dir, enemies, w, dmgMul) {
    let best = null, bestT = w.range;
    this._wallDist = rayBoxes(origin, dir, this.colliders, w.range);
    bestT = Math.min(bestT, this._wallDist);
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i]; if (e.dead || !e.ready) continue;
      const cap = this._enemyCapsule(e);
      const t = rayCapsule(origin, dir, cap.c, cap.r, cap.h);
      if (t >= 0 && t < bestT) { bestT = t; best = e; }
    }
    if (!best) return null;
    const point = origin.clone().addScaledVector(dir, bestT);
    const cap = this._enemyCapsule(best);
    const headshot = point.y > cap.c.y + cap.h * 0.78 && !best.data.hoverHeight;
    let damage = w.damage * dmgMul * (headshot ? w.headshot : 1);
    if (best.shield > 0) damage *= w.shieldMul;
    return { enemy: best, damage: Math.round(damage), point, headshot, weaponKey: this.current, from: origin, explosive: false };
  }

  _meleeTarget(origin, dir, enemies, range, arc) {
    let best = null, bestD = range;
    for (const e of enemies) {
      if (e.dead || !e.ready) continue;
      _v.subVectors(e.mesh.position, origin); _v.y = 0;
      const d = _v.length() - e.data.radius;
      if (d > bestD) continue;
      _v.normalize(); const f = _v.dot(_v2.set(dir.x, 0, dir.z).normalize());
      if (f < Math.cos(arc)) continue;
      bestD = d; best = e;
    }
    return best ? { enemy: best, dist: bestD } : null;
  }

  _applyMelee(enemies, dmgMul) {
    const w = WEAPONS.energySword;
    const origin = this.camera.getWorldPosition(new THREE.Vector3());
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    let any = false;
    for (const e of enemies) {
      if (e.dead || !e.ready) continue;
      _v.subVectors(e.mesh.position, origin); _v.y = 0;
      const d = _v.length() - e.data.radius;
      if (d > w.range) continue;
      _v.normalize(); if (_v.dot(_v2.set(dir.x, 0, dir.z).normalize()) < Math.cos(w.arc)) continue;
      let damage = w.damage * dmgMul; if (e.shield > 0) damage *= w.shieldMul;
      const point = e.mesh.position.clone(); point.y += e.data.height * 0.6;
      if (this.onHit) this.onHit({ enemy: e, damage: Math.round(damage), point, headshot: false, weaponKey: 'energySword', from: origin, explosive: false, knockback: 6 });
      any = true;
    }
    return any;
  }

  _projMat(kind) {
    if (!this._projMats[kind]) {
      const m = new THREE.MeshBasicMaterial({ color: kind === 'rocket' ? 0xffa040 : 0x40a0ff, toneMapped: false });
      m.color.multiplyScalar(kind === 'rocket' ? 2.0 : 4.0); this._projMats[kind] = m;
    }
    return this._projMats[kind];
  }
  _spawnProjectile(from, dir, w, dmgMul, kind) {
    const mesh = new THREE.Mesh(kind === 'rocket' ? this._rocketGeo : this._projGeo, this._projMat(kind));
    mesh.position.copy(from);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    this.scene.add(mesh);
    this.projectiles.push({ kind, mesh, vel: dir.clone().multiplyScalar(w.speed), life: w.range / w.speed, damage: w.damage * dmgMul, splash: w.splash || 0, w, gravity: 0, trailT: 0 });
  }

  update(delta, enemies, playerPos) {
    const w = this.weapon, s = this.st;
    if (this.cooldown > 0) this.cooldown -= delta;
    for (const k in this.state) {
      const st = this.state[k], wd = WEAPONS[k];
      if (st.reloading > 0) { st.reloading -= delta; if (st.reloading <= 0) { const need = wd.mag - st.mag; const take = Math.min(need, st.reserve); st.mag += take; if (st.reserve !== Infinity) st.reserve -= take; } }
      if (wd.heatPerShot != null) {
        if (st.overheated > 0) { st.overheated -= delta; if (st.overheated <= 0) st.heat = 0.2; }
        else if (k !== this.current || this.cooldown < -0.15) st.heat = Math.max(0, st.heat - wd.cooldownRate * delta);
        else st.heat = Math.max(0, st.heat - wd.cooldownRate * 0.4 * delta);
      }
    }
    // Melee timing: lunge pulls the player, then damage lands.
    if (this.lungeTimer > 0 && this.lungeTarget && !this.lungeTarget.dead) {
      this.lungeTimer -= delta;
      _v.subVectors(this.lungeTarget.mesh.position, playerPos); _v.y = 0;
      const d = _v.length();
      if (d > this.lungeTarget.data.radius + 1.6) { _v.normalize(); playerPos.addScaledVector(_v, Math.min(d - 1.6, 26 * delta)); }
    } else this.lungeTarget = null;
    if (this.pendingMelee) { this.pendingMelee.t -= delta; if (this.pendingMelee.t <= 0) { this._applyMelee(enemies, this.pendingMelee.dmgMul); this.pendingMelee = null; } }

    // Projectiles
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.life -= delta;
      if (p.gravity) p.vel.y -= p.gravity * delta;
      const prev = _v3.copy(p.mesh.position);
      p.mesh.position.addScaledVector(p.vel, delta);
      if (p.kind !== 'grenade') p.mesh.quaternion.setFromUnitVectors(_v4.set(0, 1, 0), _v.copy(p.vel).normalize());
      const stepLen = p.vel.length() * delta;
      _dir.copy(p.vel).normalize();
      let detonate = false, hitEnemy = null, hitPoint = null;
      // Enemies along the swept segment
      for (const e of enemies) {
        if (e.dead || !e.ready) continue;
        const cap = this._enemyCapsule(e);
        const t = rayCapsule(prev, _dir, cap.c, cap.r, cap.h);
        if (t >= 0 && t <= stepLen + 0.05) { hitEnemy = e; hitPoint = prev.clone().addScaledVector(_dir, t); break; }
      }
      // Walls
      const wallT = rayBoxes(prev, _dir, this.colliders, stepLen + 0.05);
      const wallHit = wallT < stepLen + 0.05;
      const groundHit = p.mesh.position.y <= 0.05;
      if (p.kind === 'grenade') {
        if (wallHit) { p.vel.multiplyScalar(-0.35); p.mesh.position.copy(prev); }
        if (groundHit) { p.mesh.position.y = 0.05; p.vel.y = Math.abs(p.vel.y) * 0.3; p.vel.x *= 0.7; p.vel.z *= 0.7; }
        if (hitEnemy || p.life <= 0) detonate = true;
      } else {
        if (hitEnemy || wallHit || groundHit || p.life <= 0) detonate = true;
        if (p.kind === 'rocket' && this.particles) { p.trailT += delta; if (p.trailT > 0.03) { p.trailT = 0; this.particles.createSparks(p.mesh.position, 0xff8040, 2); } }
      }
      if (detonate) {
        const pos = hitPoint || (wallHit ? prev.clone().addScaledVector(_dir, wallT - 0.1) : p.mesh.position.clone());
        if (wallHit && this.onWallHit && _wallHit.dist < Infinity) this.onWallHit(_wallHit.point, _wallHit.normal, p.kind === 'rocket' ? 'blast' : 'plasma', prev.clone(), _dir.clone());
        if (p.splash > 0) {
          const splash = p.splash * (this.player ? this.player.explosionRadiusMultiplier : 1);
          if (this.particles) this.particles.createExplosion(pos, p.kind === 'grenade' ? 0x4080ff : 0xff5020, splash * 0.55, 0.6);
          const hits = [];
          for (const e of enemies) {
            if (e.dead || !e.ready) continue;
            const d = e.mesh.position.distanceTo(pos) - e.data.radius;
            if (d > splash) continue;
            const fall = 1 - Math.max(0, d) / splash;
            let dmg = p.damage * (0.35 + 0.65 * fall);
            const pt = e.mesh.position.clone(); pt.y += e.data.height * 0.5;
            hits.push({ enemy: e, damage: Math.round(dmg), point: pt, headshot: false, weaponKey: p.kind === 'grenade' ? 'grenade' : 'rocketLauncher', from: pos, explosive: true, knockback: 9 * fall });
          }
          if (p.kind === 'grenade') { if (this.audio) this.audio.playGrenadeExplode(); if (this.onGrenadeHit) this.onGrenadeHit(hits, pos); }
          else { if (this.audio) this.audio.playExplosion(); if (this.onRocketHit) this.onRocketHit(hits, pos); }
        } else if (hitEnemy) {
          const cap = this._enemyCapsule(hitEnemy);
          const headshot = hitPoint.y > cap.c.y + cap.h * 0.78 && !hitEnemy.data.hoverHeight;
          let dmg = p.damage * (headshot ? p.w.headshot : 1); if (hitEnemy.shield > 0) dmg *= p.w.shieldMul;
          if (this.particles) this.particles.createImpact(hitPoint, 0x40a0ff, 0.5);
          if (this.onHit) this.onHit({ enemy: hitEnemy, damage: Math.round(dmg), point: hitPoint, headshot, weaponKey: 'plasmaRifle', from: prev.clone(), explosive: false });
        } else if (this.particles) this.particles.createImpact(pos, 0x40a0ff, 0.4);
        this.scene.remove(p.mesh);
        if (p.kind === 'grenade') { p.mesh.geometry.dispose(); p.mesh.material.dispose(); }
        this.projectiles.splice(i, 1);
      }
    }

    // Viewmodel sway / bob / recoil
    this.recoil = Math.max(0, this.recoil - delta * 1.4);
    this.muzzleLight.intensity = Math.max(0, this.muzzleLight.intensity - delta * 60);
    if (this.raiseT > 0) this.raiseT -= delta;
    if (this.swingT > 0) this.swingT -= delta;
    const vm = this.viewmodels[this.current];
    if (vm) {
      const t = performance.now() * 0.001;
      const bob = this._moveSpeed || 0;
      this.bobT += delta * (4 + bob * 0.6);
      const bx = Math.sin(this.bobT) * 0.006 * Math.min(1, bob / 6), by = Math.abs(Math.cos(this.bobT)) * 0.006 * Math.min(1, bob / 6);
      const raise = this.raiseT > 0 ? -0.25 * (this.raiseT / 0.3) : 0;
      const swing = this.swingT > 0 ? Math.sin((1 - this.swingT / 0.35) * Math.PI) : 0;
      vm.position.set(w.pos[0] + bx + this.swayX, w.pos[1] + by + raise - this.recoil * 0.4 + swing * -0.12, w.pos[2] + this.recoil * 0.9 + (this.zoomed ? 0.12 : 0) + swing * -0.25);
      vm.rotation.set(this.recoil * 1.5 + this.swayY + swing * -0.9, this.swayX * 2 + swing * 0.8, swing * 0.5);
      if (this.zoomed) { vm.position.x = 0; vm.position.y = w.pos[1] + 0.1; }
      if (vm.userData.bladeLight) vm.userData.bladeLight.intensity = 0.9 + Math.sin(t * 9) * 0.3 + swing * 1.5;
    }
    this.swayX *= Math.max(0, 1 - 8 * delta); this.swayY *= Math.max(0, 1 - 8 * delta);
  }

  // Called by controls with the frame's mouse delta so the gun lags the look.
  addSway(dx, dy) { this.swayX = THREE.MathUtils.clamp(this.swayX - dx * 0.00025, -0.03, 0.03); this.swayY = THREE.MathUtils.clamp(this.swayY - dy * 0.00025, -0.03, 0.03); }
  setMoveSpeed(v) { this._moveSpeed = v; }

  reset() {
    for (const k of WEAPON_ORDER) { const w = WEAPONS[k]; this.state[k] = { mag: w.mag != null ? w.mag : Infinity, reserve: w.reserve != null ? w.reserve : Infinity, heat: 0, overheated: 0, reloading: 0 }; }
    for (const p of this.projectiles) this.scene.remove(p.mesh);
    this.projectiles.length = 0;
    this.grenades = 3; this.zoomed = false; this.cooldown = 0; this.lungeTarget = null; this.pendingMelee = null;
    this.switchWeapon('rifle');
  }
}
