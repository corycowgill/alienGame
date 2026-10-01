import * as THREE from 'three';
// vfx.js - Screen-space visual effects: shake, hit markers, damage numbers,
//          kill feed, low-health vignette, alien death/spawn VFX, environment particles

import { disposeTree, borrowLight, spawnParticle, getGlowMatTemplate } from './particles.js';

// Shared geometries for spawn effects — same params every call, so allocate
// once and reuse. Marked __shared so disposeTree skips them.
const _spawnBeamGeo = new THREE.CylinderGeometry(0.15, 0.5, 12, 8, 1, true);
_spawnBeamGeo.__shared = true;
const _spawnInnerBeamGeo = new THREE.CylinderGeometry(0.05, 0.2, 12, 8, 1, true);
_spawnInnerBeamGeo.__shared = true;
const _spawnRingGeo = new THREE.TorusGeometry(0.8, 0.06, 6, 16);
_spawnRingGeo.__shared = true;

// ---------------------------------------------------------------------------
// Shared VFX materials — cached at module level.
//
// Chrome trace showed getProgramInfoLog at 12.5% of CPU during the first 20s
// of gameplay. Every death effect, spawn effect, scorch mark, and acid pool
// was allocating a fresh MeshBasicMaterial, each triggering a synchronous
// WebGL shader compile (~50-200ms per unique program). Caching these as
// shared template materials that are cloned for per-instance opacity control
// ensures the WebGL program compiles exactly once per unique configuration.
// ---------------------------------------------------------------------------
function _sharedMat(params) {
  const m = new THREE.MeshBasicMaterial(params);
  m.__shared = true;
  return m;
}
const _vfxMat = {
  // Death effects — need clone() for per-instance opacity animation
  deathFlash: _sharedMat({ color: 0xffffff, transparent: true, opacity: 1 }),
  // Death ring template — color set per-call, opacity animated per-instance
  deathRing: _sharedMat({ color: 0x00ff00, transparent: true, opacity: 0.8 }),
  // Spawn effects
  spawnBeam: _sharedMat({ color: 0x00ff88, transparent: true, opacity: 0.4, side: THREE.DoubleSide }),
  spawnInnerBeam: _sharedMat({ color: 0xaaffcc, transparent: true, opacity: 0.7 }),
  spawnGroundRing: _sharedMat({ color: 0x00ff88, transparent: true, opacity: 0.8 }),
  // Scorch marks — shared directly (opacity fades but slowly, < 15 instances)
  scorchCenter: _sharedMat({ color: 0x111111, transparent: true, opacity: 0.5, depthWrite: false }),
  scorchRing: _sharedMat({ color: 0x331100, transparent: true, opacity: 0.35, depthWrite: false }),
  // Acid pools
  acidPool: _sharedMat({ color: 0x88cc00, transparent: true, opacity: 0.45, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
  acidRim: _sharedMat({ color: 0xaaff00, transparent: true, opacity: 0.25, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
  // Puddles
  puddle: _sharedMat({ color: 0x4488aa, transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
};

// Pre-warm VFX shader programs. Adds temporary meshes using all VFX material
// types to the given scene so that renderer.compile() will force-compile their
// WebGL programs. The meshes are removed immediately after compilation.
// Includes every distinct material configuration used by particles.js and
// vfx.js — each unique combination of (material type, transparent, blending,
// depthWrite, wireframe, toneMapped, side) is a separate WebGL shader program.
export function preWarmVFXMaterials(scene) {
  const tmp = new THREE.Group();
  const dummyGeo = new THREE.PlaneGeometry(0.001, 0.001);
  // All cached VFX materials
  for (const mat of Object.values(_vfxMat)) {
    tmp.add(new THREE.Mesh(dummyGeo, mat));
  }
  // Additional shader program variants used by particles.js explosions:
  // - glowMat template (additive + toneMapped:false — lasers, muzzle, sparks)
  // - MeshBasicMaterial + transparent + wireframe (explosion shells)
  // - MeshBasicMaterial + transparent only (standard VFX)
  const _warmVariants = [
    getGlowMatTemplate(),
    new THREE.MeshBasicMaterial({ transparent: true, wireframe: true }),
    new THREE.MeshBasicMaterial({ transparent: true, wireframe: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    new THREE.MeshBasicMaterial({ transparent: true }),
    // Solid (non-wireframe) additive double-sided variant — enemies.js's shield-capsule material
    // (warlord/overseer) uses exactly this combo and was otherwise only hit on a real spawn.
    new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }),
  ];
  for (const m of _warmVariants) {
    m.__shared = true;
    tmp.add(new THREE.Mesh(dummyGeo, m));
  }
  scene.add(tmp);
  return tmp; // caller removes after renderer.compile()
}

export class VFXManager {
  constructor(camera, scene) {
    this.camera = camera;
    this.scene = scene;

    // Screen shake
    this.shakeIntensity = 0;
    this.shakeDuration = 0;
    this.shakeTimer = 0;
    this.cameraBasePos = new THREE.Vector3();

    // Hit markers
    this.hitMarkerTimer = 0;
    this.hitMarkerKill = false;

    // Damage numbers
    this.damageNumbers = [];
    this._dmgPool = [];
    this._tmpScreenPos = new THREE.Vector3();

    // Kill feed
    this.killFeed = [];

    // Low health
    this.lowHealthPulse = 0;

    // Environment particles
    this.envParticles = null;
    this.envParticleType = 'dust'; // dust, embers

    // Alien death effects
    this.deathEffects = [];

    // Spawn effects
    this.spawnEffects = [];

    this._buildDOM();
  }

  _buildDOM() {
    // Hit marker overlay (CSS cross that appears on hit)
    let hm = document.getElementById('hit-marker');
    if (!hm) {
      hm = document.createElement('div');
      hm.id = 'hit-marker';
      document.body.appendChild(hm);
    }
    this.hitMarkerEl = hm;

    // Damage number container
    let dnc = document.getElementById('damage-numbers');
    if (!dnc) {
      dnc = document.createElement('div');
      dnc.id = 'damage-numbers';
      document.body.appendChild(dnc);
    }
    this.damageNumberContainer = dnc;

    // Kill feed container
    let kf = document.getElementById('kill-feed');
    if (!kf) {
      kf = document.createElement('div');
      kf.id = 'kill-feed';
      document.body.appendChild(kf);
    }
    this.killFeedEl = kf;

    // Low health vignette
    let lhv = document.getElementById('low-health-vignette');
    if (!lhv) {
      lhv = document.createElement('div');
      lhv.id = 'low-health-vignette';
      document.body.appendChild(lhv);
    }
    this.lowHealthVignetteEl = lhv;
  }

  showHealFlash() {
    const flash = document.getElementById('damage-flash');
    if (flash) {
      flash.style.background = 'rgba(0, 255, 100, 0.25)';
      flash.style.opacity = '1';
      setTimeout(() => {
        flash.style.opacity = '0';
        setTimeout(() => { flash.style.background = ''; }, 200);
      }, 150);
    }
  }

  // ========================
  // SCREEN SHAKE
  // ========================
  shake(intensity, duration) {
    // Don't override a stronger shake
    if (intensity > this.shakeIntensity) {
      this.shakeIntensity = intensity;
      this.shakeDuration = duration;
      this.shakeTimer = duration;
    }
  }

  _updateShake(delta) {
    if (this.shakeTimer > 0) {
      this.shakeTimer -= delta;
      const progress = this.shakeTimer / this.shakeDuration;
      const amplitude = this.shakeIntensity * progress;

      // Apply random offset to camera
      this.camera.position.x += (Math.random() - 0.5) * amplitude;
      this.camera.position.y += (Math.random() - 0.5) * amplitude * 0.5;

      if (this.shakeTimer <= 0) {
        this.shakeIntensity = 0;
      }
    }
  }

  // ========================
  // HIT MARKERS
  // ========================
  showHitMarker(isKill = false) {
    this.hitMarkerTimer = 0.2;
    this.hitMarkerKill = isKill;
    this.hitMarkerEl.className = isKill ? 'active kill' : 'active';
  }

  _updateHitMarker(delta) {
    if (this.hitMarkerTimer > 0) {
      this.hitMarkerTimer -= delta;
      if (this.hitMarkerTimer <= 0) {
        this.hitMarkerEl.className = '';
      }
    }
  }

  // ========================
  // DAMAGE NUMBERS
  // ========================
  showDamageNumber(worldPos, damage, isKill = false, isCrit = false) {
    // Cap active damage numbers to avoid DOM/CPU blowup during multi-kills
    if (this.damageNumbers.length >= 60) return;
    let el;
    if (this._dmgPool.length > 0) {
      el = this._dmgPool.pop();
    } else {
      el = document.createElement('div');
    }
    el.className = 'dmg-num' + (isKill ? ' kill' : '') + (isCrit ? ' crit' : '');
    el.textContent = isCrit && !isKill ? `${Math.round(damage)} CRIT` : (isKill ? `${Math.round(damage)} KILL` : Math.round(damage));
    el.style.display = 'block';
    el.style.opacity = '1';
    this.damageNumberContainer.appendChild(el);

    this.damageNumbers.push({
      el,
      worldPos: worldPos.clone(),
      life: 1.0,
      offsetY: 0,
      velocity: -80 - Math.random() * 40,
    });
  }

  _updateDamageNumbers(delta) {
    for (let i = this.damageNumbers.length - 1; i >= 0; i--) {
      const dn = this.damageNumbers[i];
      dn.life -= delta;
      dn.offsetY += dn.velocity * delta;

      const screenPos = this._tmpScreenPos.copy(dn.worldPos).project(this.camera);
      const x = (screenPos.x * 0.5 + 0.5) * window.innerWidth;
      const y = (-screenPos.y * 0.5 + 0.5) * window.innerHeight + dn.offsetY;

      if (screenPos.z < 1) {
        // transform (not left/top) so positioning up to 60 of these every frame is a compositor-
        // only update, not a layout/reflow — with a lot of enemies on screen this was ~half the
        // per-frame render cost. The -50%/-50% self-centering that used to live in the .dmg-num
        // CSS rule is folded in here so one style write does both.
        dn.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
        dn.el.style.opacity = Math.max(0, dn.life);
        dn.el.style.display = 'block';
      } else {
        dn.el.style.display = 'none';
      }

      if (dn.life <= 0) {
        dn.el.style.display = 'none';
        this.damageNumberContainer.removeChild(dn.el);
        this._dmgPool.push(dn.el);
        this.damageNumbers.splice(i, 1);
      }
    }
  }

  // ========================
  // KILL FEED
  // ========================
  addKillFeedEntry(alienName, weaponName) {
    const el = document.createElement('div');
    el.className = 'kill-entry';
    el.innerHTML = `<span class="kf-weapon">${weaponName}</span> ▸ <span class="kf-alien">${alienName}</span>`;
    this.killFeedEl.appendChild(el);

    // Animate in
    requestAnimationFrame(() => el.classList.add('visible'));

    this.killFeed.push({ el, life: 3.0 });

    // Keep max 5 entries
    while (this.killFeed.length > 5) {
      this.killFeed[0].el.remove();
      this.killFeed.shift();
    }
  }

  _updateKillFeed(delta) {
    for (let i = this.killFeed.length - 1; i >= 0; i--) {
      const kf = this.killFeed[i];
      kf.life -= delta;
      if (kf.life < 0.5) {
        kf.el.style.opacity = Math.max(0, kf.life * 2);
      }
      if (kf.life <= 0) {
        kf.el.remove();
        this.killFeed.splice(i, 1);
      }
    }
  }

  // ========================
  // LOW HEALTH EFFECTS
  // ========================
  _updateLowHealth(delta, playerHpPct) {
    if (playerHpPct < 0.3) {
      this.lowHealthPulse += delta * (4 + (1 - playerHpPct / 0.3) * 4);
      const pulseAlpha = 0.15 + Math.sin(this.lowHealthPulse) * 0.1 * (1 - playerHpPct / 0.3);
      this.lowHealthVignetteEl.style.opacity = Math.max(0, pulseAlpha);
      this.lowHealthVignetteEl.style.display = 'block';
    } else {
      this.lowHealthPulse = 0;
      this.lowHealthVignetteEl.style.display = 'none';
    }
  }

  // ========================
  // ALIEN DEATH EFFECTS
  // ========================
  createDeathEffect(position, color, size = 1) {
    const group = new THREE.Group();
    group.position.copy(position);

    // Dissolution particles — routed to the GPU point field (additive).
    // Previously allocated 16-24 mesh instances per death, each with its
    // own material. That was a real allocation spike on multi-kills.
    const pieceCount = 16 + Math.floor(Math.random() * 8);
    for (let i = 0; i < pieceCount; i++) {
      spawnParticle('additive', {
        position,
        velocity: {
          x: (Math.random() - 0.5) * 6,
          y: Math.random() * 5 + 1,
          z: (Math.random() - 0.5) * 6,
        },
        gravity: 8,
        life: 0.75,
        sizeStart: 0.28 * size,
        sizeEnd: 0.05 * size,
        color: Math.random() > 0.3 ? color : 0x00ff00,
        alpha: 1,
      });
    }

    // Energy release flash — structural, stays as a mesh.
    // Clone from pre-compiled template so the WebGL program is reused.
    const flashMat = _vfxMat.deathFlash.clone();
    const flash = new THREE.Mesh(
      new THREE.SphereGeometry(0.5 * size, 8, 8),
      flashMat
    );
    group.add(flash);

    // Expanding energy ring — structural.
    const ringMat = _vfxMat.deathRing.clone();
    ringMat.color.setHex(color);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.3 * size, 0.04, 6, 16),
      ringMat
    );
    ring.rotation.x = Math.PI / 2;
    group.add(ring);

    // Glowing orbs that float up — also routed to the additive point field.
    for (let i = 0; i < 5; i++) {
      spawnParticle('additive', {
        position,
        velocity: {
          x: (Math.random() - 0.5) * 1.5,
          y: 2 + Math.random() * 3,
          z: (Math.random() - 0.5) * 1.5,
        },
        gravity: 0,
        drag: 0.5,
        life: 0.8,
        sizeStart: 0.18,
        sizeEnd: 0.08,
        color: 0x88ffaa,
        alpha: 0.8,
      });
    }

    // Pooled point light (decay handled centrally — no shader recompile)
    borrowLight(position, color, 4, 8, 0.8);

    this.scene.add(group);
    this.deathEffects.push({
      group, flash, ring,
      life: 0.8, maxLife: 0.8
    });
  }

  _updateDeathEffects(delta) {
    for (let i = this.deathEffects.length - 1; i >= 0; i--) {
      const d = this.deathEffects[i];
      d.life -= delta;
      const progress = 1 - d.life / d.maxLife;

      // Flash fades fast
      d.flash.material.opacity = Math.max(0, 1 - progress * 4);
      const fScale = 1 + progress * 2;
      d.flash.scale.set(fScale, fScale, fScale);

      // Ring expands
      const rScale = 1 + progress * 5;
      d.ring.scale.set(rScale, rScale, rScale * 0.3);
      d.ring.material.opacity = Math.max(0, 0.8 * (1 - progress));

      // Pieces + orbs are driven by the GPU particle fields — no per-mesh
      // update here.

      if (d.life <= 0) {
        this.scene.remove(d.group);
        disposeTree(d.group);
        this.deathEffects.splice(i, 1);
      }
    }
  }

  // ========================
  // ALIEN SPAWN EFFECTS
  // ========================
  createSpawnEffect(position, color) {
    const group = new THREE.Group();
    group.position.copy(position);

    // Teleport beam (vertical column of light) — shared geometry + cloned
    // material from pre-compiled template (avoids per-spawn shader compile).
    const beam = new THREE.Mesh(_spawnBeamGeo, _vfxMat.spawnBeam.clone());
    beam.position.y = 6;
    group.add(beam);

    // Inner beam (brighter) — shared geometry
    const innerBeam = new THREE.Mesh(_spawnInnerBeamGeo, _vfxMat.spawnInnerBeam.clone());
    innerBeam.position.y = 6;
    group.add(innerBeam);

    // Ground ring — shared geometry
    const groundRing = new THREE.Mesh(_spawnRingGeo, _vfxMat.spawnGroundRing.clone());
    groundRing.rotation.x = -Math.PI / 2;
    groundRing.position.y = 0.05;
    group.add(groundRing);

    // Sparkles routed to the additive point field. They lose the spiral
    // motion but gain zero-allocation spawn — 12 mesh allocs per enemy
    // spawn was a real hitch on wave starts.
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2;
      spawnParticle('additive', {
        position: {
          x: position.x + Math.cos(angle) * 0.6,
          y: position.y + i * 0.3,
          z: position.z + Math.sin(angle) * 0.6,
        },
        velocity: {
          x: Math.cos(angle) * 0.3,
          y: 2 + Math.random() * 1.5,
          z: Math.sin(angle) * 0.3,
        },
        gravity: 0,
        life: 0.55,
        sizeStart: 0.15,
        sizeEnd: 0.02,
        color: 0x88ffcc,
        alpha: 0.9,
      });
    }

    // Pooled point light 1 unit above the spawn position
    borrowLight(
      { x: position.x, y: position.y + 1, z: position.z },
      0x00ff88, 3, 10, 0.6
    );

    this.scene.add(group);
    this.spawnEffects.push({
      group, beam, innerBeam, groundRing,
      life: 0.6, maxLife: 0.6
    });
  }

  _updateSpawnEffects(delta) {
    for (let i = this.spawnEffects.length - 1; i >= 0; i--) {
      const s = this.spawnEffects[i];
      s.life -= delta;
      const progress = 1 - s.life / s.maxLife;

      // Beam fades from top down
      s.beam.material.opacity = Math.max(0, 0.4 * (1 - progress));
      s.innerBeam.material.opacity = Math.max(0, 0.7 * (1 - progress));
      s.beam.scale.y = Math.max(0.1, 1 - progress);
      s.beam.position.y = 6 * (1 - progress * 0.5);

      // Ground ring expands and fades
      const rs = 1 + progress * 2;
      s.groundRing.scale.set(rs, rs, rs);
      s.groundRing.material.opacity = Math.max(0, 0.8 * (1 - progress));

      // Sparkles now live in the GPU point field — no per-mesh update.

      if (s.life <= 0) {
        this.scene.remove(s.group);
        disposeTree(s.group);
        this.spawnEffects.splice(i, 1);
      }
    }
  }

  // ========================
  // ENVIRONMENT PARTICLES
  // ========================
  initEnvironmentParticles(type = 'dust') {
    this.envParticleType = type;
    if (this.envParticles) {
      this.scene.remove(this.envParticles);
    }
    if (this._envParticles2) {
      this.scene.remove(this._envParticles2);
      this._envParticles2 = null;
    }

    // Primary particles - increased count
    const count = 350;
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 80;
      positions[i * 3 + 1] = Math.random() * 18;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 80;

      if (type === 'embers') {
        velocities[i * 3] = (Math.random() - 0.5) * 0.4;
        velocities[i * 3 + 1] = 0.5 + Math.random() * 1.2;
        velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.4;
      } else {
        velocities[i * 3] = (Math.random() - 0.5) * 0.6;
        velocities[i * 3 + 1] = -0.1 + Math.random() * 0.2;
        velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.6;
      }
    }

    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.userData.velocities = velocities;

    const color = type === 'embers' ? 0xff6622 : 0x888888;
    const size = type === 'embers' ? 0.06 : 0.04;
    const mat = new THREE.PointsMaterial({
      color,
      size,
      transparent: true,
      opacity: type === 'embers' ? 0.6 : 0.3,
      blending: type === 'embers' ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    this.envParticles = new THREE.Points(geo, mat);
    this.scene.add(this.envParticles);

    // Secondary particle layer - ash/debris floating (always present)
    const count2 = 120;
    const geo2 = new THREE.BufferGeometry();
    const pos2 = new Float32Array(count2 * 3);
    const vel2 = new Float32Array(count2 * 3);
    for (let i = 0; i < count2; i++) {
      pos2[i * 3] = (Math.random() - 0.5) * 70;
      pos2[i * 3 + 1] = 1 + Math.random() * 10;
      pos2[i * 3 + 2] = (Math.random() - 0.5) * 70;
      vel2[i * 3] = (Math.random() - 0.5) * 0.3;
      vel2[i * 3 + 1] = -0.05 + Math.random() * 0.15;
      vel2[i * 3 + 2] = (Math.random() - 0.5) * 0.3;
    }
    geo2.setAttribute('position', new THREE.Float32BufferAttribute(pos2, 3));
    geo2.userData.velocities = vel2;
    const mat2 = new THREE.PointsMaterial({
      color: 0x555544,
      size: 0.12,
      transparent: true,
      opacity: 0.2,
    });
    this._envParticles2 = new THREE.Points(geo2, mat2);
    this.scene.add(this._envParticles2);
  }

  _updateEnvironmentParticles(delta) {
    if (!this.envParticles) return;

    const positions = this.envParticles.geometry.attributes.position.array;
    const velocities = this.envParticles.geometry.userData.velocities;
    const camPos = this.camera.position;
    const count1 = positions.length / 3;
    const isDust = this.envParticleType === 'dust';
    const nowSec = isDust ? performance.now() * 0.001 : 0;

    for (let i = 0; i < count1; i++) {
      const idx = i * 3;
      positions[idx] += velocities[idx] * delta;
      positions[idx + 1] += velocities[idx + 1] * delta;
      positions[idx + 2] += velocities[idx + 2] * delta;

      if (isDust) {
        positions[idx] += Math.sin(nowSec + i) * 0.003;
      }

      // Squared-distance check — avoids Math.sqrt per particle
      const dx = positions[idx] - camPos.x;
      const dz = positions[idx + 2] - camPos.z;

      if (dx * dx + dz * dz > 900 || positions[idx + 1] > 20 || positions[idx + 1] < 0) {
        const angle = Math.random() * Math.PI * 2;
        const r = 5 + Math.random() * 25;
        positions[idx] = camPos.x + Math.cos(angle) * r;
        positions[idx + 1] = Math.random() * 12;
        positions[idx + 2] = camPos.z + Math.sin(angle) * r;
      }
    }

    this.envParticles.geometry.attributes.position.needsUpdate = true;

    // Update secondary ash/debris particles
    if (this._envParticles2) {
      const pos2 = this._envParticles2.geometry.attributes.position.array;
      const vel2 = this._envParticles2.geometry.userData.velocities;
      const time = performance.now() * 0.001;
      const count2 = pos2.length / 3;

      for (let i = 0; i < count2; i++) {
        const idx = i * 3;
        pos2[idx] += vel2[idx] * delta;
        pos2[idx + 1] += vel2[idx + 1] * delta;
        pos2[idx + 2] += vel2[idx + 2] * delta;

        pos2[idx] += Math.sin(time * 0.5 + i * 1.7) * 0.002;
        pos2[idx + 1] += Math.cos(time * 0.3 + i * 2.1) * 0.001;

        const dx2 = pos2[idx] - camPos.x;
        const dz2 = pos2[idx + 2] - camPos.z;

        if (dx2 * dx2 + dz2 * dz2 > 1225 || pos2[idx + 1] > 14 || pos2[idx + 1] < -0.5) {
          const angle2 = Math.random() * Math.PI * 2;
          const r2 = 4 + Math.random() * 28;
          pos2[idx] = camPos.x + Math.cos(angle2) * r2;
          pos2[idx + 1] = 0.5 + Math.random() * 10;
          pos2[idx + 2] = camPos.z + Math.sin(angle2) * r2;
        }
      }

      this._envParticles2.geometry.attributes.position.needsUpdate = true;
    }
  }

  // ========================
  // RAIN WEATHER SYSTEM
  // ========================
  initRain() {
    if (this._rain) {
      this.scene.remove(this._rain);
      disposeTree(this._rain);
    }
    if (this._rainSplashes) {
      this.scene.remove(this._rainSplashes);
      disposeTree(this._rainSplashes);
    }

    const count = 800;
    const positions = new Float32Array(count * 6);
    const velocities = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const x = (Math.random() - 0.5) * 60;
      const y = Math.random() * 25;
      const z = (Math.random() - 0.5) * 60;
      const streakLen = 0.4 + Math.random() * 0.3;
      positions[i * 6] = x;
      positions[i * 6 + 1] = y;
      positions[i * 6 + 2] = z;
      positions[i * 6 + 3] = x + 0.02;
      positions[i * 6 + 4] = y + streakLen;
      positions[i * 6 + 5] = z;
      velocities[i * 3] = (Math.random() - 0.5) * 0.5;
      velocities[i * 3 + 1] = -12 - Math.random() * 6;
      velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.5;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.userData.velocities = velocities;
    geo.userData.count = count;
    const mat = new THREE.LineBasicMaterial({
      color: 0x8899bb, transparent: true, opacity: 0.2,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this._rain = new THREE.LineSegments(geo, mat);
    this._rain.frustumCulled = false;
    this.scene.add(this._rain);

    // Splash ring pool on ground
    const splashCount = 40;
    const splashPos = new Float32Array(splashCount * 3);
    const splashSizes = new Float32Array(splashCount);
    for (let i = 0; i < splashCount; i++) {
      splashPos[i * 3] = (Math.random() - 0.5) * 50;
      splashPos[i * 3 + 1] = 0.05;
      splashPos[i * 3 + 2] = (Math.random() - 0.5) * 50;
      splashSizes[i] = 0;
    }
    const splashGeo = new THREE.BufferGeometry();
    splashGeo.setAttribute('position', new THREE.Float32BufferAttribute(splashPos, 3));
    splashGeo.setAttribute('aSize', new THREE.Float32BufferAttribute(splashSizes, 1));
    splashGeo.userData.life = new Float32Array(splashCount);
    splashGeo.userData.count = splashCount;
    const splashMat = new THREE.PointsMaterial({
      color: 0xaabbcc, size: 0.3, transparent: true, opacity: 0.3,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this._rainSplashes = new THREE.Points(splashGeo, splashMat);
    this._rainSplashes.frustumCulled = false;
    this.scene.add(this._rainSplashes);
    this._rainSplashIdx = 0;
  }

  _updateRain(delta) {
    if (!this._rain) return;
    const positions = this._rain.geometry.attributes.position.array;
    const velocities = this._rain.geometry.userData.velocities;
    const count = this._rain.geometry.userData.count;
    const camPos = this.camera.position;

    for (let i = 0; i < count; i++) {
      const vi = i * 3;
      const pi = i * 6;
      const dx = velocities[vi] * delta;
      const dy = velocities[vi + 1] * delta;
      const dz = velocities[vi + 2] * delta;
      positions[pi] += dx;
      positions[pi + 1] += dy;
      positions[pi + 2] += dz;
      positions[pi + 3] += dx;
      positions[pi + 4] += dy;
      positions[pi + 5] += dz;

      if (positions[pi + 1] < 0) {
        // Spawn splash
        if (this._rainSplashes) {
          const sg = this._rainSplashes.geometry;
          const sp = sg.attributes.position.array;
          const sl = sg.userData.life;
          const si = this._rainSplashIdx % sg.userData.count;
          sp[si * 3] = positions[pi];
          sp[si * 3 + 1] = 0.05;
          sp[si * 3 + 2] = positions[pi + 2];
          sl[si] = 0.3;
          sg.attributes.position.needsUpdate = true;
          this._rainSplashIdx++;
        }
        const angle = Math.random() * Math.PI * 2;
        const r = 5 + Math.random() * 25;
        const nx = camPos.x + Math.cos(angle) * r;
        const nz = camPos.z + Math.sin(angle) * r;
        const ny = 15 + Math.random() * 10;
        const streakLen = 0.4 + Math.random() * 0.3;
        positions[pi] = nx;
        positions[pi + 1] = ny;
        positions[pi + 2] = nz;
        positions[pi + 3] = nx + 0.02;
        positions[pi + 4] = ny + streakLen;
        positions[pi + 5] = nz;
      }

      const distX = positions[pi] - camPos.x;
      const distZ = positions[pi + 2] - camPos.z;
      if (distX * distX + distZ * distZ > 900) {
        const angle = Math.random() * Math.PI * 2;
        const r = 5 + Math.random() * 25;
        positions[pi] = camPos.x + Math.cos(angle) * r;
        positions[pi + 1] = Math.random() * 20;
        positions[pi + 2] = camPos.z + Math.sin(angle) * r;
        positions[pi + 3] = positions[pi] + 0.02;
        positions[pi + 4] = positions[pi + 1] + 0.5;
        positions[pi + 5] = positions[pi + 2];
      }
    }
    this._rain.geometry.attributes.position.needsUpdate = true;

    // Update splashes
    if (this._rainSplashes) {
      const sl = this._rainSplashes.geometry.userData.life;
      const sc = this._rainSplashes.geometry.userData.count;
      let anyAlive = false;
      for (let i = 0; i < sc; i++) {
        if (sl[i] > 0) {
          sl[i] -= delta;
          anyAlive = true;
        }
      }
      if (anyAlive) {
        this._rainSplashes.material.opacity = 0.3;
      }
    }
  }

  // ========================
  // GROUND FOG / MIST LAYER
  // ========================
  initGroundFog() {
    if (this._groundFog) {
      this.scene.remove(this._groundFog);
      disposeTree(this._groundFog);
    }
    const fogMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uOpacity: { value: 0.18 },
        uColor: { value: new THREE.Color(0x223344) },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform float uTime;
        uniform float uOpacity;
        uniform vec3 uColor;
        varying vec2 vUv;
        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          float a = hash(i);
          float b = hash(i + vec2(1.0, 0.0));
          float c = hash(i + vec2(0.0, 1.0));
          float d = hash(i + vec2(1.0, 1.0));
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }
        float fbm(vec2 p) {
          float v = 0.0;
          v += 0.5 * noise(p); p *= 2.01;
          v += 0.25 * noise(p); p *= 2.02;
          v += 0.125 * noise(p);
          return v;
        }
        void main() {
          vec2 uv = vUv * 3.0;
          float n = fbm(uv + uTime * 0.08);
          float n2 = fbm(uv * 1.5 - uTime * 0.05 + 3.7);
          float fog = (n + n2) * 0.5;
          float edge = smoothstep(0.0, 0.2, vUv.x) * smoothstep(1.0, 0.8, vUv.x)
                     * smoothstep(0.0, 0.2, vUv.y) * smoothstep(1.0, 0.8, vUv.y);
          gl_FragColor = vec4(uColor, fog * uOpacity * edge);
        }
      `,
    });
    const fogPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(160, 160),
      fogMat
    );
    fogPlane.rotation.x = -Math.PI / 2;
    fogPlane.position.y = 0.3;
    fogPlane.renderOrder = 1;
    this._groundFog = fogPlane;
    this._groundFogMat = fogMat;
    this.scene.add(fogPlane);
  }

  _updateGroundFog(delta) {
    if (!this._groundFog) return;
    this._groundFogMat.uniforms.uTime.value += delta;
    this._groundFog.position.x = this.camera.position.x;
    this._groundFog.position.z = this.camera.position.z;
  }

  // ========================
  // LIGHTNING SYSTEM
  // ========================
  initLightning() {
    this._lightningTimer = 3 + Math.random() * 8;
    this._lightningFlash = 0;
    this._lightningLight = new THREE.DirectionalLight(0xccddff, 0);
    this._lightningLight.position.set(50, 100, 30);
    this.scene.add(this._lightningLight);
  }

  _updateLightning(delta) {
    if (!this._lightningLight) return;
    this._lightningTimer -= delta;
    if (this._lightningTimer <= 0) {
      this._lightningFlash = 0.15 + Math.random() * 0.1;
      this._lightningLight.intensity = 2 + Math.random() * 3;
      this._lightningLight.position.set(
        (Math.random() - 0.5) * 100,
        80 + Math.random() * 40,
        (Math.random() - 0.5) * 100
      );
      this._lightningTimer = 4 + Math.random() * 12;
      if (Math.random() < 0.4) {
        this._lightningDoubleTimer = 0.08 + Math.random() * 0.06;
      }
    }
    if (this._lightningFlash > 0) {
      this._lightningFlash -= delta;
      if (this._lightningFlash <= 0) {
        this._lightningLight.intensity = 0;
        if (this._lightningDoubleTimer > 0) {
          this._lightningDoubleTimer -= delta;
          if (this._lightningDoubleTimer <= 0) {
            this._lightningFlash = 0.06;
            this._lightningLight.intensity = 1.5;
            this._lightningDoubleTimer = 0;
          }
        }
      } else {
        this._lightningLight.intensity *= 0.85;
      }
    }
  }

  // ========================
  // SMOKE WISPS
  // ========================
  initSmokeWisps() {
    if (this._smokeWisps) {
      this.scene.remove(this._smokeWisps);
      disposeTree(this._smokeWisps);
    }
    const count = 30;
    const positions = new Float32Array(count * 3);
    const alphas = new Float32Array(count);
    const phases = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 80;
      positions[i * 3 + 1] = 0.3 + Math.random() * 2;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 80;
      alphas[i] = 0.05 + Math.random() * 0.1;
      phases[i] = Math.random() * Math.PI * 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.userData.alphas = alphas;
    geo.userData.phases = phases;
    geo.userData.count = count;
    const mat = new THREE.PointsMaterial({
      color: 0x556677, size: 3.0, transparent: true, opacity: 0.08,
      blending: THREE.NormalBlending, depthWrite: false,
      sizeAttenuation: true,
    });
    this._smokeWisps = new THREE.Points(geo, mat);
    this._smokeWisps.frustumCulled = false;
    this.scene.add(this._smokeWisps);
  }

  _updateSmokeWisps(delta) {
    if (!this._smokeWisps) return;
    const pos = this._smokeWisps.geometry.attributes.position.array;
    const phases = this._smokeWisps.geometry.userData.phases;
    const count = this._smokeWisps.geometry.userData.count;
    const t = performance.now() * 0.001;
    const camPos = this.camera.position;
    for (let i = 0; i < count; i++) {
      const idx = i * 3;
      pos[idx] += Math.sin(t * 0.3 + phases[i]) * 0.01;
      pos[idx + 1] += Math.sin(t * 0.2 + phases[i] * 1.3) * 0.003;
      pos[idx + 2] += Math.cos(t * 0.25 + phases[i] * 0.7) * 0.01;
      const dx = pos[idx] - camPos.x;
      const dz = pos[idx + 2] - camPos.z;
      if (dx * dx + dz * dz > 1600 || pos[idx + 1] > 4) {
        const angle = Math.random() * Math.PI * 2;
        const r = 5 + Math.random() * 30;
        pos[idx] = camPos.x + Math.cos(angle) * r;
        pos[idx + 1] = 0.3 + Math.random() * 1.5;
        pos[idx + 2] = camPos.z + Math.sin(angle) * r;
      }
    }
    this._smokeWisps.geometry.attributes.position.needsUpdate = true;
  }

  // ========================
  // GROUND SCORCH MARKS
  // ========================
  createScorchMark(position, radius) {
    if (!this._scorchMarks) this._scorchMarks = [];
    if (this._scorchMarks.length > 15) {
      const old = this._scorchMarks.shift();
      this.scene.remove(old.mesh);
      disposeTree(old.mesh);
    }
    // Clone from pre-compiled templates — avoids per-explosion shader compile.
    const scorch = new THREE.Mesh(
      new THREE.CircleGeometry(radius, 12),
      _vfxMat.scorchCenter.clone()
    );
    scorch.rotation.x = -Math.PI / 2;
    scorch.position.set(position.x, 0.015, position.z);
    this.scene.add(scorch);
    this._scorchMarks.push({ mesh: scorch, life: 12 });

    // Burn ring around the scorch
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(radius * 0.8, radius * 1.1, 16),
      _vfxMat.scorchRing.clone()
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(position.x, 0.016, position.z);
    this.scene.add(ring);
    this._scorchMarks.push({ mesh: ring, life: 12 });
  }

  _updateScorchMarks(delta) {
    if (!this._scorchMarks) return;
    for (let i = this._scorchMarks.length - 1; i >= 0; i--) {
      const s = this._scorchMarks[i];
      s.life -= delta;
      if (s.life < 3) {
        s.mesh.material.opacity *= 0.98;
      }
      if (s.life <= 0) {
        this.scene.remove(s.mesh);
        disposeTree(s.mesh);
        this._scorchMarks.splice(i, 1);
      }
    }
  }

  // ========================
  // ACID POOLS (Spitter ground hazards)
  // ========================
  createAcidPool(position, radius = 2.5) {
    if (!this._acidPools) this._acidPools = [];
    if (this._acidPools.length > 10) {
      const old = this._acidPools.shift();
      this.scene.remove(old.group);
      disposeTree(old.group);
    }
    const group = new THREE.Group();
    // Clone from pre-compiled templates — avoids per-pool shader compile.
    const poolMat = _vfxMat.acidPool.clone();
    poolMat.color.setHex(0x88cc00);
    poolMat.color.multiplyScalar(1.5);
    const pool = new THREE.Mesh(new THREE.CircleGeometry(radius, 16), poolMat);
    pool.rotation.x = -Math.PI / 2;
    pool.position.y = 0.02;
    group.add(pool);
    const rimMat = _vfxMat.acidRim.clone();
    const rim = new THREE.Mesh(new THREE.RingGeometry(radius * 0.85, radius * 1.05, 16), rimMat);
    rim.rotation.x = -Math.PI / 2;
    rim.position.y = 0.025;
    group.add(rim);
    group.position.set(position.x, 0, position.z);
    this.scene.add(group);
    this._acidPools.push({
      group, poolMat, rimMat, pool,
      life: 6, maxLife: 6, radius,
      position: new THREE.Vector3(position.x, 0, position.z),
    });
  }

  _updateAcidPools(delta, playerPos) {
    if (!this._acidPools) return null;
    let totalDamage = 0;
    for (let i = this._acidPools.length - 1; i >= 0; i--) {
      const ap = this._acidPools[i];
      ap.life -= delta;
      const t = performance.now() * 0.003;
      const pulse = 0.35 + 0.1 * Math.sin(t + i * 2);
      const fadeOut = ap.life < 2 ? ap.life / 2 : 1;
      ap.poolMat.opacity = pulse * fadeOut;
      ap.rimMat.opacity = 0.25 * fadeOut;
      ap.pool.scale.setScalar(1 + 0.03 * Math.sin(t * 1.5 + i));
      if (playerPos) {
        const dx = ap.position.x - playerPos.x;
        const dz = ap.position.z - playerPos.z;
        if (dx * dx + dz * dz < ap.radius * ap.radius) {
          totalDamage += 8 * delta;
        }
      }
      if (ap.life <= 0) {
        this.scene.remove(ap.group);
        disposeTree(ap.group);
        this._acidPools.splice(i, 1);
      }
    }
    return totalDamage > 0 ? totalDamage : null;
  }

  // ========================
  // CHROMATIC ABERRATION
  // ========================
  triggerChromaticAberration(intensity = 1) {
    this._chromaTimer = 0.25 * intensity;
    this._chromaIntensity = intensity;
    const el = document.getElementById('chromatic-aberration');
    if (el) {
      el.style.display = 'block';
      el.style.opacity = String(Math.min(1, 0.6 * intensity));
    }
  }

  _updateChromaticAberration(delta) {
    if (!this._chromaTimer || this._chromaTimer <= 0) return;
    this._chromaTimer -= delta;
    const el = document.getElementById('chromatic-aberration');
    if (el) {
      if (this._chromaTimer <= 0) {
        el.style.display = 'none';
        el.style.opacity = '0';
        this._chromaTimer = 0;
      } else {
        const t = this._chromaTimer / (0.25 * this._chromaIntensity);
        el.style.opacity = String(0.6 * this._chromaIntensity * t);
      }
    }
  }

  // ========================
  // WET GROUND PUDDLES
  // ========================
  initPuddles() {
    if (this._puddles) {
      for (const p of this._puddles) {
        this.scene.remove(p.mesh);
        disposeTree(p.mesh);
      }
    }
    this._puddles = [];
    const count = 12;
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const r = 5 + Math.random() * 40;
      const x = Math.cos(angle) * r;
      const z = Math.sin(angle) * r;
      const size = 0.8 + Math.random() * 2.5;
      const mat = _vfxMat.puddle.clone();
      const mesh = new THREE.Mesh(new THREE.CircleGeometry(size, 10), mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(x, 0.012, z);
      this.scene.add(mesh);
      this._puddles.push({ mesh, mat, phase: Math.random() * Math.PI * 2, size });
    }
  }

  _updatePuddles(delta) {
    if (!this._puddles) return;
    // Throttle — shimmer is low-frequency, every 3rd frame is fine
    this._puddleFrame = (this._puddleFrame || 0) + 1;
    if ((this._puddleFrame % 3) !== 0) return;
    const t = performance.now() * 0.001;
    for (const p of this._puddles) {
      const shimmer = 0.06 + 0.04 * Math.sin(t * 1.5 + p.phase) + 0.02 * Math.sin(t * 3.1 + p.phase * 2);
      p.mat.opacity = shimmer;
    }
  }

  // ========================
  // LIGHT DUST MOTES
  // ========================
  initDustMotes() {
    if (this._dustMotes) {
      this.scene.remove(this._dustMotes);
      disposeTree(this._dustMotes);
    }
    const count = 60;
    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 60;
      positions[i * 3 + 1] = 0.5 + Math.random() * 8;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 60;
      sizes[i] = 0.5 + Math.random() * 1.5;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('size', new THREE.Float32BufferAttribute(sizes, 1));
    geo.userData._count = count;
    geo.userData._phases = Array.from({ length: count }, () => Math.random() * Math.PI * 2);
    const mat = new THREE.PointsMaterial({
      color: 0xffeedd, size: 0.045, transparent: true, opacity: 0.12,
      blending: THREE.AdditiveBlending, depthWrite: false,
      sizeAttenuation: true,
    });
    this._dustMotes = new THREE.Points(geo, mat);
    this._dustMotes.frustumCulled = false;
    this.scene.add(this._dustMotes);
  }

  _updateDustMotes(delta) {
    if (!this._dustMotes) return;
    // Throttle — dust motes drift slowly, updating every other frame is imperceptible
    // and halves the GPU buffer upload cost.
    this._dustMoteFrame = (this._dustMoteFrame || 0) + 1;
    if ((this._dustMoteFrame & 1) !== 0) return;
    const pos = this._dustMotes.geometry.attributes.position.array;
    const count = this._dustMotes.geometry.userData._count;
    const phases = this._dustMotes.geometry.userData._phases;
    const t = performance.now() * 0.001;
    const camPos = this.camera.position;
    for (let i = 0; i < count; i++) {
      const idx = i * 3;
      pos[idx] += Math.sin(t * 0.15 + phases[i]) * 0.01;
      pos[idx + 1] += Math.sin(t * 0.1 + phases[i] * 1.7) * 0.008;
      pos[idx + 2] += Math.cos(t * 0.12 + phases[i] * 0.9) * 0.01;
      const dx = pos[idx] - camPos.x;
      const dz = pos[idx + 2] - camPos.z;
      if (dx * dx + dz * dz > 900 || pos[idx + 1] > 10 || pos[idx + 1] < 0) {
        const a = Math.random() * Math.PI * 2;
        const r = 3 + Math.random() * 25;
        pos[idx] = camPos.x + Math.cos(a) * r;
        pos[idx + 1] = 0.5 + Math.random() * 6;
        pos[idx + 2] = camPos.z + Math.sin(a) * r;
      }
    }
    this._dustMotes.geometry.attributes.position.needsUpdate = true;
    const pulse = 0.08 + 0.04 * Math.sin(t * 0.5);
    this._dustMotes.material.opacity = pulse;
  }

  // ========================
  // MAIN UPDATE
  // ========================
  update(delta, playerHpPct, playerPos) {
    this._updateShake(delta);
    this._updateHitMarker(delta);
    this._updateDamageNumbers(delta);
    this._updateKillFeed(delta);
    this._updateLowHealth(delta, playerHpPct);
    this._updateDeathEffects(delta);
    this._updateSpawnEffects(delta);
    this._updateEnvironmentParticles(delta);
    this._updateRain(delta);
    this._updateGroundFog(delta);
    this._updateLightning(delta);
    this._updateSmokeWisps(delta);
    this._updatePuddles(delta);
    this._updateDustMotes(delta);
    this._updateScorchMarks(delta);
    this._updateChromaticAberration(delta);
    this.lastAcidDamage = this._updateAcidPools(delta, playerPos);
  }

  cleanup() {
    // Remove and dispose 3D effects
    for (const d of this.deathEffects) {
      this.scene.remove(d.group);
      disposeTree(d.group);
    }
    for (const s of this.spawnEffects) {
      this.scene.remove(s.group);
      disposeTree(s.group);
    }
    if (this.envParticles) {
      this.scene.remove(this.envParticles);
      disposeTree(this.envParticles);
    }
    if (this._envParticles2) {
      this.scene.remove(this._envParticles2);
      disposeTree(this._envParticles2);
    }
    if (this._rain) {
      this.scene.remove(this._rain);
      disposeTree(this._rain);
      this._rain = null;
    }
    if (this._rainSplashes) {
      this.scene.remove(this._rainSplashes);
      disposeTree(this._rainSplashes);
      this._rainSplashes = null;
    }
    if (this._groundFog) {
      this.scene.remove(this._groundFog);
      disposeTree(this._groundFog);
      this._groundFog = null;
    }
    if (this._lightningLight) {
      this.scene.remove(this._lightningLight);
      this._lightningLight = null;
    }
    if (this._smokeWisps) {
      this.scene.remove(this._smokeWisps);
      disposeTree(this._smokeWisps);
      this._smokeWisps = null;
    }
    if (this._puddles) {
      for (const p of this._puddles) {
        this.scene.remove(p.mesh);
        disposeTree(p.mesh);
      }
      this._puddles = null;
    }
    if (this._dustMotes) {
      this.scene.remove(this._dustMotes);
      disposeTree(this._dustMotes);
      this._dustMotes = null;
    }
    if (this._scorchMarks) {
      for (const s of this._scorchMarks) {
        this.scene.remove(s.mesh);
        disposeTree(s.mesh);
      }
      this._scorchMarks = [];
    }
    if (this._acidPools) {
      for (const ap of this._acidPools) {
        this.scene.remove(ap.group);
        disposeTree(ap.group);
      }
      this._acidPools = [];
    }
    this.deathEffects = [];
    this.spawnEffects = [];
    this.envParticles = null;
    this._envParticles2 = null;

    // Clear DOM elements
    for (const dn of this.damageNumbers) dn.el.remove();
    for (const el of this._dmgPool) el.remove();
    for (const kf of this.killFeed) kf.el.remove();
    this.damageNumbers = [];
    this._dmgPool = [];
    this.killFeed = [];
    this.hitMarkerTimer = 0;
    this.hitMarkerEl.className = '';
    this.lowHealthVignetteEl.style.display = 'none';
    const chromaEl = document.getElementById('chromatic-aberration');
    if (chromaEl) { chromaEl.style.display = 'none'; chromaEl.style.opacity = '0'; }
    this._chromaTimer = 0;
  }
}
