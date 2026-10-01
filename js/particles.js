import * as THREE from 'three';
// particles.js - Enhanced laser beams, explosions, muzzle flashes, sword slashes

// Glow material template cache. Three.js compiles a distinct WebGL shader
// program for each unique material configuration (transparent, blending,
// depthWrite, toneMapped flags). All glowMat calls share the same flag set,
// so only ONE program is compiled. We cache a single template and clone()
// from it — clones inherit the already-compiled program, avoiding the
// 50-200ms synchronous getProgramInfoLog stall per material that the Chrome
// trace showed consuming 12.5% of CPU during the first 20s of gameplay.
//
// clone() is cheap (~0.02ms) vs new material + compile (~50-200ms). Per-shot
// instances are still needed because beams/explosions mutate opacity per-
// instance during their lifetime.
let _glowMatTemplate = null;
function glowMat(color, opacity = 1.0, intensity = 1.0) {
  if (!_glowMatTemplate) {
    _glowMatTemplate = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    _glowMatTemplate.__shared = true;
  }
  const mat = _glowMatTemplate.clone();
  mat.color.setHex(color);
  mat.opacity = opacity;
  if (intensity !== 1.0) {
    mat.color.multiplyScalar(intensity);
  }
  return mat;
}

// Expose the template for pre-warm (renderer.compile needs it in the scene).
export function getGlowMatTemplate() {
  if (!_glowMatTemplate) glowMat(0xffffff); // force template creation
  return _glowMatTemplate;
}

// ---------------------------------------------------------------------------
// Shared PointLight pool.
//
// Three.js bakes NUM_POINT_LIGHTS as a #define into every MeshPhongMaterial
// shader. Adding or removing a PointLight at runtime changes that macro and
// forces Three to recompile every affected material — hundreds of cars,
// buildings, props, and alien meshes. Each compile stalls the main thread
// for 50–200ms, producing the visible "jitter" when firing rockets or
// triggering explosions.
//
// The fix: pre-allocate a fixed pool of PointLights at scene setup and never
// add/remove more. Effects "borrow" a slot — we reposition it, set color and
// intensity, and schedule decay. NUM_POINT_LIGHTS is constant → zero runtime
// recompiles.
// ---------------------------------------------------------------------------
const _poolSlots = [];
const POOL_SIZE = 6;

export function initLightPool(scene) {
  // Remove any lights from a previous scene/level
  for (const slot of _poolSlots) {
    if (slot.light.parent) slot.light.parent.remove(slot.light);
  }
  _poolSlots.length = 0;
  for (let i = 0; i < POOL_SIZE; i++) {
    const light = new THREE.PointLight(0xffffff, 0, 10);
    // Stays visible=true forever, even when idle: three.js only counts *visible* lights toward
    // the NUM_POINT_LIGHTS shader define, so toggling .visible on/off here would silently defeat
    // the whole point of this pool (see the "Shared PointLight pool" comment above) — intensity 0
    // already makes an idle slot contribute nothing to the render.
    scene.add(light);
    _poolSlots.push({
      light,
      life: 0,
      maxLife: 0,
      baseIntensity: 0,
      inUse: false,
    });
  }
}

export function borrowLight(position, color, intensity, distance, duration) {
  if (_poolSlots.length === 0) return null;
  // Prefer an idle slot; otherwise steal the slot with the least life left.
  let slot = null;
  for (let i = 0; i < _poolSlots.length; i++) {
    if (!_poolSlots[i].inUse) { slot = _poolSlots[i]; break; }
  }
  if (!slot) {
    let minLife = Infinity;
    for (let i = 0; i < _poolSlots.length; i++) {
      if (_poolSlots[i].life < minLife) {
        minLife = _poolSlots[i].life;
        slot = _poolSlots[i];
      }
    }
  }
  const light = slot.light;
  light.color.setHex(color);
  light.distance = distance;
  light.intensity = intensity;
  light.position.copy(position);
  slot.life = duration;
  slot.maxLife = duration;
  slot.baseIntensity = intensity;
  slot.inUse = true;
  return light;
}

export function updateLightPool(delta) {
  for (let i = 0; i < _poolSlots.length; i++) {
    const slot = _poolSlots[i];
    if (!slot.inUse) continue;
    slot.life -= delta;
    if (slot.life <= 0) {
      slot.light.intensity = 0;
      slot.inUse = false;
    } else {
      const t = slot.life / slot.maxLife;
      slot.light.intensity = slot.baseIntensity * t;
    }
  }
}

// Recursively dispose all geometries and materials in a subtree. Essential to
// prevent GPU buffer leaks: Three.js does NOT auto-free GPU resources when a
// mesh is removed from the scene — you must dispose() explicitly. Without this
// the game leaks VBOs/textures on every shot, causing frame rate to degrade.
export function disposeTree(obj) {
  if (!obj) return;
  obj.traverse((child) => {
    if (child.geometry && !child.geometry.__shared) {
      child.geometry.dispose();
    }
    const mat = child.material;
    if (mat) {
      if (Array.isArray(mat)) {
        for (const m of mat) {
          if (m && !m.__shared) m.dispose();
        }
      } else if (!mat.__shared) {
        mat.dispose();
      }
    }
  });
}

// ---------------------------------------------------------------------------
// GPU-resident point field.
//
// Previously every explosion allocated 40–75 THREE.Mesh instances with unique
// geometries/materials for fire, sparks, smoke, and debris, then ran them
// through the full per-object transform pipeline for ~1s before GCing them.
// Mega-explosions caused visible hitches even after trimming counts.
//
// This replaces the per-particle mesh soup with a single THREE.Points object
// per blending mode (additive / normal). Each field owns pre-allocated flat
// Float32Array state (position, velocity, life, size curve, color, alpha) and
// a ring-buffer spawn index. One draw call per field regardless of how many
// explosions are active. Zero allocations on spawn. The custom ShaderMaterial
// handles per-particle size and alpha via vertex attributes.
// ---------------------------------------------------------------------------
class PointField {
  constructor(scene, { capacity, blending }) {
    this.capacity = capacity;
    this.head = 0;

    // CPU-side per-particle state.
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pz = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.gravity = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.sizeA = new Float32Array(capacity);
    this.sizeB = new Float32Array(capacity);
    this.r = new Float32Array(capacity);
    this.g = new Float32Array(capacity);
    this.b = new Float32Array(capacity);
    this.alpha0 = new Float32Array(capacity);

    // GPU attribute buffers — written each frame, compacted to active count.
    this.positions = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity);
    this.alphas = new Float32Array(capacity);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    // Positions are updated per frame from world-space CPU state; skip Three's
    // own bounds computation entirely.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending,
      toneMapped: false,
      vertexShader: /* glsl */`
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aAlpha;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = aColor;
          vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * (300.0 / max(0.1, -mv.z));
        }
      `,
      fragmentShader: /* glsl */`
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          if (d > 0.5) discard;
          float soft = 1.0 - smoothstep(0.25, 0.5, d);
          gl_FragColor = vec4(vColor, vAlpha * soft);
        }
      `,
    });
    mat.__shared = true; // prevent disposeTree from wiping the shared shader

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.matrixAutoUpdate = false;
    scene.add(this.points);
    this.scene = scene;
    this.geo = geo;
    this.mat = mat;
  }

  spawn(opts) {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    const p = opts.position, v = opts.velocity;
    this.px[i] = p.x; this.py[i] = p.y; this.pz[i] = p.z;
    this.vx[i] = v.x; this.vy[i] = v.y; this.vz[i] = v.z;
    this.gravity[i] = opts.gravity || 0;
    this.drag[i] = opts.drag || 0;
    this.life[i] = opts.life;
    this.maxLife[i] = opts.life;
    this.sizeA[i] = opts.sizeStart;
    this.sizeB[i] = opts.sizeEnd !== undefined ? opts.sizeEnd : opts.sizeStart;
    const c = opts.color;
    this.r[i] = ((c >> 16) & 0xff) / 255;
    this.g[i] = ((c >> 8) & 0xff) / 255;
    this.b[i] = (c & 0xff) / 255;
    this.alpha0[i] = opts.alpha !== undefined ? opts.alpha : 1;
  }

  update(delta) {
    const cap = this.capacity;
    const positions = this.positions, colors = this.colors;
    const sizes = this.sizes, alphas = this.alphas;
    let write = 0;
    for (let i = 0; i < cap; i++) {
      let life = this.life[i];
      if (life <= 0) continue;
      life -= delta;
      if (life <= 0) { this.life[i] = 0; continue; }
      this.life[i] = life;
      const d = this.drag[i];
      if (d > 0) {
        const decay = Math.max(0, 1 - d * delta);
        this.vx[i] *= decay; this.vy[i] *= decay; this.vz[i] *= decay;
      }
      this.vy[i] -= this.gravity[i] * delta;
      this.px[i] += this.vx[i] * delta;
      this.py[i] += this.vy[i] * delta;
      this.pz[i] += this.vz[i] * delta;
      const t = life / this.maxLife[i]; // 1 → 0 over lifetime
      const sz = this.sizeB[i] + (this.sizeA[i] - this.sizeB[i]) * t;
      const al = this.alpha0[i] * t;
      const p3 = write * 3;
      positions[p3] = this.px[i];
      positions[p3 + 1] = this.py[i];
      positions[p3 + 2] = this.pz[i];
      colors[p3] = this.r[i];
      colors[p3 + 1] = this.g[i];
      colors[p3 + 2] = this.b[i];
      sizes[write] = sz;
      alphas[write] = al;
      write++;
    }
    const prevRange = this.geo.drawRange.count;
    this.geo.setDrawRange(0, write);
    if (write > 0 || prevRange > 0) {
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.aColor.needsUpdate = true;
      this.geo.attributes.aSize.needsUpdate = true;
      this.geo.attributes.aAlpha.needsUpdate = true;
    }
  }

  clear() {
    this.life.fill(0);
    this.geo.setDrawRange(0, 0);
    this.head = 0;
  }

  dispose() {
    if (this.points.parent) this.points.parent.remove(this.points);
    this.geo.dispose();
    this.mat.dispose();
  }
}

// Module-level field pool so level transitions can rebuild it.
let _additiveField = null;
let _normalField = null;

export function initParticleFields(scene) {
  if (_additiveField) _additiveField.dispose();
  if (_normalField) _normalField.dispose();
  _additiveField = new PointField(scene, { capacity: 512, blending: THREE.AdditiveBlending });
  _normalField = new PointField(scene, { capacity: 512, blending: THREE.NormalBlending });
}

export function spawnParticle(type, opts) {
  const field = type === 'additive' ? _additiveField : _normalField;
  if (field) field.spawn(opts);
}

function updateParticleFields(delta) {
  if (_additiveField) _additiveField.update(delta);
  if (_normalField) _normalField.update(delta);
}

function clearParticleFields() {
  if (_additiveField) _additiveField.clear();
  if (_normalField) _normalField.clear();
}

export function getActiveLightCount() {
  let count = 0;
  for (let i = 0; i < _poolSlots.length; i++) {
    if (_poolSlots[i].inUse) count++;
  }
  return count;
}

export function getActiveParticleCount() {
  let count = 0;
  if (_additiveField) count += _additiveField.geo.drawRange.count;
  if (_normalField) count += _normalField.geo.drawRange.count;
  return count;
}

// ---------------------------------------------------------------------------
// Shared unit primitives for per-shot visuals.
//
// createLaserBeam used to allocate 3 CylinderGeometry instances per fire,
// _createImpactSparks allocated 6 BoxGeometry + 1 SphereGeometry per hit,
// and createAlienBolt allocated several sphere+box geometries per projectile.
// All of these are identical up to a scale factor — the cylinder is always
// length=1 along +Z, the impact spheres are unit spheres, the sparks are
// unit cubes. Sharing a single geometry per shape and scaling the mesh on
// construction eliminates the per-shot geometry alloc without changing the
// visuals at all.
// ---------------------------------------------------------------------------
const _UNIT_CYL_Z = new THREE.CylinderGeometry(1, 1, 1, 8);
_UNIT_CYL_Z.rotateX(Math.PI / 2);
_UNIT_CYL_Z.__shared = true;
const _UNIT_SPHERE_8 = new THREE.SphereGeometry(1, 8, 8);
_UNIT_SPHERE_8.__shared = true;
const _UNIT_SPHERE_6 = new THREE.SphereGeometry(1, 6, 6);
_UNIT_SPHERE_6.__shared = true;
const _UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
_UNIT_BOX.__shared = true;

// Muzzle flash geometries — identical on every shot, so cache at module level.
// Cone already points along +Z (rotated from default +Y) to match the flash
// orientation in createMuzzleFlash.
const _MUZZLE_CONE = new THREE.ConeGeometry(0.12, 0.3, 6);
_MUZZLE_CONE.rotateX(-Math.PI / 2);
_MUZZLE_CONE.translate(0, 0, 0.15);
_MUZZLE_CONE.__shared = true;
const _MUZZLE_FLARE = new THREE.PlaneGeometry(0.3, 0.05);
_MUZZLE_FLARE.__shared = true;

// Sword slash arcs — four toruses, all constant across every melee swing.
const _SWORD_MAIN = new THREE.TorusGeometry(1.2, 0.04, 4, 20, Math.PI);
_SWORD_MAIN.__shared = true;
const _SWORD_INNER = new THREE.TorusGeometry(1.2, 0.015, 4, 20, Math.PI);
_SWORD_INNER.__shared = true;
const _SWORD_TRAIL_1 = new THREE.TorusGeometry(1.2, 0.08, 4, 16, Math.PI);
_SWORD_TRAIL_1.__shared = true;
const _SWORD_TRAIL_2 = new THREE.TorusGeometry(1.2, 0.12, 4, 16, Math.PI);
_SWORD_TRAIL_2.__shared = true;

// Scratch vectors shared by hot per-shot paths to avoid allocating Vector3
// on every muzzle flash / sword slash.
const _scratchVec = new THREE.Vector3();

export class ParticleSystem {
  constructor(scene) {
    this.scene = scene;
    this.beams = [];
    this.explosions = [];
    this.muzzleFlashes = [];
    this.impacts = [];
    initLightPool(scene);
    initParticleFields(scene);
  }

  createLaserBeam(from, to, color = 0xff0000, duration = 0.1, width = 0.03) {
    const dir = new THREE.Vector3().subVectors(to, from);
    const len = dir.length();

    // Core beam - bright white center (additive) - shared unit cylinder, scaled
    const core = new THREE.Mesh(_UNIT_CYL_Z, glowMat(0xffffff, 1.0, 4.0));
    core.scale.set(width, width, len);
    const mid = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
    core.position.copy(mid);
    core.lookAt(to);

    // Inner glow layer
    const inner = new THREE.Mesh(_UNIT_CYL_Z, glowMat(color, 0.7, 2.5));
    inner.scale.set(2.5, 2.5, 1); // relative to parent scale
    core.add(inner);

    // Outer glow layer
    const outer = new THREE.Mesh(_UNIT_CYL_Z, glowMat(color, 0.22));
    outer.scale.set(5, 5, 1);
    core.add(outer);

    this.scene.add(core);
    this.beams.push({ mesh: core, life: duration, maxLife: duration });

    // Impact sparkle at hit point
    this._createImpactSparks(to, color, duration * 2.5);

    return core;
  }

  _createImpactSparks(position, color, duration) {
    const group = new THREE.Group();
    group.position.copy(position);

    // Central flash
    const flash = new THREE.Mesh(_UNIT_SPHERE_8, glowMat(0xffffff, 1, 3.5));
    flash.scale.setScalar(0.15);
    group.add(flash);

    // Spark rays that fly outward
    const sparks = [];
    for (let i = 0; i < 6; i++) {
      const spark = new THREE.Mesh(_UNIT_BOX, glowMat(color, 0.95, 2.0));
      spark.scale.set(0.02, 0.02, 0.12);
      spark.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      spark.velocity = new THREE.Vector3(
        (Math.random() - 0.5) * 8,
        Math.random() * 6,
        (Math.random() - 0.5) * 8
      );
      group.add(spark);
      sparks.push(spark);
    }

    this.scene.add(group);
    this.impacts.push({ group, flash, sparks, life: duration, maxLife: duration });
  }

  createAlienBolt(from, to, speed = 30, alienType = 'grunt') {
    const dir = new THREE.Vector3().subVectors(to, from).normalize();
    const boltGroup = new THREE.Group();

    // Different bolt styles per alien type
    if (alienType === 'spitter') {
      // Acid glob - larger, dripping, yellow-green
      const core = new THREE.Mesh(_UNIT_SPHERE_8, glowMat(0xccff33, 1, 3.0));
      core.scale.set(0.12 * 0.8, 0.12, 0.12 * 1.5);
      boltGroup.add(core);
      const innerGlow = new THREE.Mesh(_UNIT_SPHERE_8, glowMat(0x88cc00, 0.6, 2.0));
      innerGlow.scale.setScalar(0.2);
      boltGroup.add(innerGlow);
      const outerGlow = new THREE.Mesh(_UNIT_SPHERE_6, glowMat(0x66aa00, 0.2));
      outerGlow.scale.setScalar(0.35);
      boltGroup.add(outerGlow);
      // Dripping acid trail
      for (let i = 1; i <= 5; i++) {
        const drip = new THREE.Mesh(_UNIT_SPHERE_6, glowMat(0xaaff00, 0.7 / i));
        drip.scale.setScalar(0.04 + (0.08 / i));
        drip.position.set((Math.random() - 0.5) * 0.1, (Math.random() - 0.5) * 0.1, -i * 0.2);
        boltGroup.add(drip);
      }
    } else if (alienType === 'drone') {
      // Rapid energy pulse - small, fast, blue-white
      const core = new THREE.Mesh(_UNIT_SPHERE_6, glowMat(0xddeeff, 1, 3.5));
      core.scale.set(0.06, 0.06, 0.06 * 3);
      boltGroup.add(core);
      const glow = new THREE.Mesh(_UNIT_SPHERE_6, glowMat(0x4488ff, 0.5, 2.0));
      glow.scale.set(0.12, 0.12, 0.12 * 2);
      boltGroup.add(glow);
      // Electric crackle lines
      for (let i = 0; i < 3; i++) {
        const crackle = new THREE.Mesh(_UNIT_BOX, glowMat(0x88ccff, 0.8, 2.0));
        crackle.scale.set(0.015, 0.015, 0.25);
        crackle.rotation.set(Math.random() * 0.5, 0, Math.random() * Math.PI);
        boltGroup.add(crackle);
      }
    } else {
      // Standard green energy bolt (grunt)
      const core = new THREE.Mesh(_UNIT_SPHERE_8, glowMat(0xaaffaa, 1, 3.0));
      core.scale.set(0.08, 0.08, 0.08 * 2);
      boltGroup.add(core);
      const innerGlow = new THREE.Mesh(_UNIT_SPHERE_8, glowMat(0x00ff00, 0.6, 2.0));
      innerGlow.scale.set(0.15, 0.15, 0.15 * 1.5);
      boltGroup.add(innerGlow);
      const outerGlow = new THREE.Mesh(_UNIT_SPHERE_6, glowMat(0x00ff00, 0.2));
      outerGlow.scale.setScalar(0.3);
      boltGroup.add(outerGlow);
      // Trail particles
      for (let i = 1; i <= 3; i++) {
        const trail = new THREE.Mesh(_UNIT_SPHERE_6, glowMat(0x00ff00, 0.5 / i));
        trail.scale.setScalar(0.05 / i);
        trail.position.z = -i * 0.15;
        boltGroup.add(trail);
      }
    }

    boltGroup.position.copy(from);
    boltGroup.lookAt(to);

    this.scene.add(boltGroup);
    const dmg = alienType === 'spitter' ? 20 : (alienType === 'drone' ? 10 : 8);
    return { mesh: boltGroup, direction: dir, speed, life: 3, damage: dmg, alienType };
  }

  // Sniper tracer - slow-fading bright beam with traveling bolt
  createSniperTracer(from, to, color = 0x8800ff) {
    const dir = new THREE.Vector3().subVectors(to, from);
    const len = dir.length();

    // Bright core beam - shared unit cylinder, scaled
    const core = new THREE.Mesh(_UNIT_CYL_Z, glowMat(0xffffff, 1, 4.5));
    core.scale.set(0.015, 0.015, len);
    const mid = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
    core.position.copy(mid);
    core.lookAt(to);

    // Inner glow (relative scale vs parent 0.015 -> 0.04 = ~2.667x)
    const inner = new THREE.Mesh(_UNIT_CYL_Z, glowMat(color, 0.8, 3.0));
    inner.scale.set(0.04 / 0.015, 0.04 / 0.015, 1);
    core.add(inner);

    // Wide outer glow
    const outer = new THREE.Mesh(_UNIT_CYL_Z, glowMat(color, 0.18));
    outer.scale.set(0.1 / 0.015, 0.1 / 0.015, 1);
    core.add(outer);

    // Traveling bolt along beam path
    const bolt = new THREE.Mesh(_UNIT_SPHERE_8, glowMat(0xffffff, 1, 4.5));
    bolt.scale.set(0.08, 0.08, 0.08 * 4);
    const boltGlow = new THREE.Mesh(_UNIT_SPHERE_6, glowMat(color, 0.6, 2.5));
    // boltGlow is a child of bolt which has non-uniform scale — apply inverse
    // so the glow renders spherical rather than being stretched along Z.
    boltGlow.scale.set(0.2 / 0.08, 0.2 / 0.08, 0.2 / (0.08 * 4));
    bolt.add(boltGlow);
    bolt.position.copy(from);
    bolt.lookAt(to);

    this.scene.add(core);
    this.scene.add(bolt);

    // Borrow a pooled light that travels with the bolt (updated per frame)
    const boltLight = borrowLight(from, color, 3, 8, 0.4);

    this.beams.push({
      mesh: core, life: 0.4, maxLife: 0.4,
      bolt, boltLight, boltFrom: from.clone(), boltTo: to.clone(), boltProgress: 0
    });

    // Impact sparks at hit point
    this._createImpactSparks(to, color, 0.5);
  }

  // Weapon-specific impact effects
  createWeaponImpact(position, weaponType) {
    if (weaponType === 'sniperRifle') {
      this._createSniperImpact(position);
    } else if (weaponType === 'laserSword') {
      this._createSwordImpact(position);
    }
    // laserRifle uses default _createImpactSparks from createLaserBeam
  }

  _createSniperImpact(position) {
    const group = new THREE.Group();
    group.position.copy(position);

    // Large purple flash
    const flash = new THREE.Mesh(
      _UNIT_SPHERE_8,
      new THREE.MeshBasicMaterial({ color: 0xddaaff, transparent: true, opacity: 1 })
    );
    flash.scale.setScalar(0.4);
    group.add(flash);

    // Electric arcs radiating outward
    const sparks = [];
    for (let i = 0; i < 8; i++) {
      const arc = new THREE.Mesh(
        _UNIT_BOX,
        new THREE.MeshBasicMaterial({ color: 0xaa66ff, transparent: true, opacity: 0.9 })
      );
      arc.scale.set(0.02, 0.02, 0.3 + Math.random() * 0.3);
      arc.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      arc.velocity = new THREE.Vector3(
        (Math.random() - 0.5) * 6,
        Math.random() * 4 + 1,
        (Math.random() - 0.5) * 6
      );
      group.add(arc);
      sparks.push(arc);
    }

    // Purple energy ring
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.2, 0.03, 6, 16),
      new THREE.MeshBasicMaterial({ color: 0x8800ff, transparent: true, opacity: 0.8 })
    );
    ring.rotation.x = Math.PI / 2;
    group.add(ring);

    borrowLight(position, 0x8800ff, 4, 6, 0.4);

    this.scene.add(group);
    this.impacts.push({ group, flash, sparks, ring, life: 0.4, maxLife: 0.4, type: 'sniper' });
  }

  _createSwordImpact(position) {
    const group = new THREE.Group();
    group.position.copy(position);

    // Blue energy burst
    const flash = new THREE.Mesh(
      _UNIT_SPHERE_8,
      new THREE.MeshBasicMaterial({ color: 0xaaddff, transparent: true, opacity: 1 })
    );
    flash.scale.setScalar(0.3);
    group.add(flash);

    // Energy slash lines
    const sparks = [];
    for (let i = 0; i < 5; i++) {
      const slash = new THREE.Mesh(
        _UNIT_BOX,
        new THREE.MeshBasicMaterial({ color: 0x44aaff, transparent: true, opacity: 0.8 })
      );
      slash.scale.set(0.01, 0.5 + Math.random() * 0.3, 0.01);
      slash.rotation.z = (Math.random() - 0.5) * 1.5;
      slash.velocity = new THREE.Vector3(0, 0, 0);
      group.add(slash);
      sparks.push(slash);
    }

    // Blue sparkle particles
    for (let i = 0; i < 6; i++) {
      const spark = new THREE.Mesh(
        _UNIT_BOX,
        new THREE.MeshBasicMaterial({ color: 0x88ccff, transparent: true, opacity: 0.9 })
      );
      spark.scale.setScalar(0.03);
      spark.velocity = new THREE.Vector3(
        (Math.random() - 0.5) * 5,
        Math.random() * 3,
        (Math.random() - 0.5) * 5
      );
      group.add(spark);
      sparks.push(spark);
    }

    borrowLight(position, 0x0088ff, 5, 6, 0.3);

    this.scene.add(group);
    this.impacts.push({ group, flash, sparks, life: 0.3, maxLife: 0.3, type: 'sword' });
  }

  createMegaExplosion(position, size = 7) {
    // Spectacular plasma-rocket detonation: huge flash, multiple shockwaves,
    // plasma core, debris, sparks, and trailing fire.
    const group = new THREE.Group();
    group.position.copy(position);

    const accent = 0x00ffee;
    const hot = 0xffffff;
    const glow = 0x88ffff;

    // === Core flash - very bright white icosahedron ===
    const flashGeo = new THREE.IcosahedronGeometry(size * 0.6, 1);
    const flashMat = new THREE.MeshBasicMaterial({ color: hot, transparent: true, opacity: 1, toneMapped: false });
    flashMat.color.multiplyScalar(5.0); // HDR for bloom
    const flash = new THREE.Mesh(flashGeo, flashMat);
    group.add(flash);

    // Secondary core - cyan plasma fireball
    const coreGeo = new THREE.SphereGeometry(size * 0.5, 16, 16);
    const coreMat = new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.9, toneMapped: false });
    coreMat.color.multiplyScalar(3.5);
    const core = new THREE.Mesh(coreGeo, coreMat);
    core.scale.set(0.2, 0.2, 0.2);
    group.add(core);

    // Outer halo - expands wider
    const haloGeo = new THREE.SphereGeometry(size * 0.9, 14, 14);
    const haloMat = new THREE.MeshBasicMaterial({ color: glow, transparent: true, opacity: 0.5, toneMapped: false });
    haloMat.color.multiplyScalar(2.0);
    const halo = new THREE.Mesh(haloGeo, haloMat);
    halo.scale.set(0.15, 0.15, 0.15);
    group.add(halo);

    // === Multi-layered shockwave rings ===
    const rings = [];
    for (let r = 0; r < 3; r++) {
      const ringGeo = new THREE.TorusGeometry(size * 0.35, 0.12 - r * 0.03, 8, 32);
      const ringMat = new THREE.MeshBasicMaterial({
        color: r === 0 ? hot : (r === 1 ? accent : glow),
        transparent: true, opacity: 0.85 - r * 0.15,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = Math.PI / 2;
      ring.scale.set(0.05, 0.05, 0.05);
      ring.userData.delay = r * 0.05;
      group.add(ring);
      rings.push(ring);
    }

    // Vertical shockwave ring (perpendicular)
    const vRingGeo = new THREE.TorusGeometry(size * 0.4, 0.08, 6, 24);
    const vRingMat = new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.6 });
    const vRing = new THREE.Mesh(vRingGeo, vRingMat);
    vRing.scale.set(0.05, 0.05, 0.05);
    group.add(vRing);
    rings.push(vRing);

    // Expanding wireframe shell
    const shellGeo = new THREE.IcosahedronGeometry(size, 2);
    const shellMat = new THREE.MeshBasicMaterial({
      color: accent, transparent: true, opacity: 0.5, wireframe: true,
    });
    const shell = new THREE.Mesh(shellGeo, shellMat);
    shell.scale.set(0.1, 0.1, 0.1);
    group.add(shell);

    // Outer electrified wireframe sphere (larger, slower)
    const outerShellGeo = new THREE.SphereGeometry(size * 1.2, 14, 10);
    const outerShellMat = new THREE.MeshBasicMaterial({
      color: glow, transparent: true, opacity: 0.25, wireframe: true,
    });
    const outerShell = new THREE.Mesh(outerShellGeo, outerShellMat);
    outerShell.scale.set(0.1, 0.1, 0.1);
    group.add(outerShell);

    // === Plasma fire particles — pushed to additive point field ===
    // sizeStart is in world units; shader converts to screen pixels via 1/z.
    for (let i = 0; i < 18; i++) {
      const ang = Math.random() * Math.PI * 2;
      const speed = size * (2 + Math.random() * 3);
      spawnParticle('additive', {
        position: position,
        velocity: { x: Math.cos(ang) * speed, y: Math.random() * size * 4 + 1, z: Math.sin(ang) * speed },
        gravity: 3,
        life: 0.9 + Math.random() * 0.4,
        sizeStart: 1.4 + Math.random() * 0.8,
        sizeEnd: 0.15,
        color: Math.random() > 0.4 ? accent : hot,
        alpha: 1,
      });
    }

    // === Spark streaks — fast, bright, falling ===
    for (let i = 0; i < 24; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const spd = size * (4 + Math.random() * 4);
      spawnParticle('additive', {
        position: position,
        velocity: {
          x: Math.sin(phi) * Math.cos(theta) * spd,
          y: Math.cos(phi) * spd + 2,
          z: Math.sin(phi) * Math.sin(theta) * spd,
        },
        gravity: 20,
        life: 0.5 + Math.random() * 0.4,
        sizeStart: 0.35,
        sizeEnd: 0.05,
        color: Math.random() > 0.5 ? hot : accent,
        alpha: 1,
      });
    }

    // === Thick dark smoke (rises) ===
    for (let i = 0; i < 10; i++) {
      spawnParticle('normal', {
        position: position,
        velocity: {
          x: (Math.random() - 0.5) * size * 2,
          y: Math.random() * size * 3 + 2,
          z: (Math.random() - 0.5) * size * 2,
        },
        gravity: 1,
        drag: 0.4,
        life: 1.2,
        sizeStart: 1.5,
        sizeEnd: 5.5,
        color: 0x1a1a1a,
        alpha: 0.75,
      });
    }

    // === Debris chunks ===
    for (let i = 0; i < 14; i++) {
      spawnParticle('normal', {
        position: position,
        velocity: {
          x: (Math.random() - 0.5) * size * 6,
          y: Math.random() * size * 5,
          z: (Math.random() - 0.5) * size * 6,
        },
        gravity: 12,
        life: 1.1,
        sizeStart: 0.55,
        sizeEnd: 0.25,
        color: Math.random() > 0.5 ? accent : 0xffaa00,
        alpha: 1,
      });
    }

    // === Ground scorch decal (larger) ===
    const scorch = new THREE.Mesh(
      new THREE.CircleGeometry(size * 1.3, 20),
      new THREE.MeshBasicMaterial({ color: 0x050510, transparent: true, opacity: 0.7 })
    );
    scorch.rotation.x = -Math.PI / 2;
    scorch.position.y = -position.y + 0.03;
    group.add(scorch);
    // Scorch glow ring inside the burn mark
    const scorchGlow = new THREE.Mesh(
      new THREE.RingGeometry(size * 0.4, size * 1.2, 20),
      new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.35 })
    );
    scorchGlow.rotation.x = -Math.PI / 2;
    scorchGlow.position.y = -position.y + 0.035;
    group.add(scorchGlow);

    // Bright pooled point lights (decay handled by pool)
    borrowLight(position, accent, 18, size * 10, 1.4);
    borrowLight(position, hot, 12, size * 6, 0.7);

    this.scene.add(group);
    this.explosions.push({
      group, flash, fireball: core, halo, ring: rings[0], rings, vRing,
      sphere: shell, outerShell,
      scorch, scorchGlow,
      life: 1.4, maxLife: 1.4, size,
      isMega: true,
    });
  }

  createExplosion(position, color = 0xff4400, size = 3, duration = 0.5) {
    const group = new THREE.Group();
    group.position.copy(position);

    // Central flash - bright icosahedron
    const flashGeo = new THREE.IcosahedronGeometry(size * 0.5, 1);
    const flash = new THREE.Mesh(flashGeo, glowMat(0xffffcc, 1, 4.0));
    group.add(flash);

    // Inner fireball
    const fireGeo = new THREE.SphereGeometry(size * 0.4, 12, 12);
    const fireball = new THREE.Mesh(fireGeo, glowMat(0xff8800, 1, 2.5));
    fireball.scale.set(0.3, 0.3, 0.3);
    group.add(fireball);

    // Expanding shockwave ring
    const ringGeo = new THREE.TorusGeometry(size * 0.3, 0.08, 6, 24);
    const ring = new THREE.Mesh(ringGeo, glowMat(0xffaa44, 0.9, 2.0));
    ring.rotation.x = Math.PI / 2;
    ring.scale.set(0.1, 0.1, 0.1);
    group.add(ring);

    // Expanding wireframe sphere
    const sphereGeo = new THREE.SphereGeometry(size, 12, 12);
    const sphereMat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.5, wireframe: true,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    const sphere = new THREE.Mesh(sphereGeo, sphereMat);
    sphere.scale.set(0.1, 0.1, 0.1);
    group.add(sphere);

    // Fire particles — additive point field
    for (let i = 0; i < 12; i++) {
      spawnParticle('additive', {
        position: position,
        velocity: {
          x: (Math.random() - 0.5) * size * 3,
          y: Math.random() * size * 4 + 2,
          z: (Math.random() - 0.5) * size * 3,
        },
        gravity: 4,
        life: 0.5 + Math.random() * 0.3,
        sizeStart: 0.8 + Math.random() * 0.5,
        sizeEnd: 0.1,
        color: Math.random() > 0.5 ? 0xff6600 : 0xff2200,
        alpha: 1,
      });
    }

    // Smoke particles — normal blended point field
    for (let i = 0; i < 8; i++) {
      spawnParticle('normal', {
        position: position,
        velocity: {
          x: (Math.random() - 0.5) * size * 1.5,
          y: Math.random() * size * 2 + 1,
          z: (Math.random() - 0.5) * size * 1.5,
        },
        gravity: 0.5,
        drag: 0.5,
        life: 0.9,
        sizeStart: 1.0,
        sizeEnd: 3.5,
        color: 0x222222,
        alpha: 0.6,
      });
    }

    // Debris chunks — normal blended point field
    for (let i = 0; i < 15; i++) {
      spawnParticle('normal', {
        position: position,
        velocity: {
          x: (Math.random() - 0.5) * size * 5,
          y: Math.random() * size * 4,
          z: (Math.random() - 0.5) * size * 5,
        },
        gravity: 12,
        life: 0.7,
        sizeStart: 0.45,
        sizeEnd: 0.2,
        color: Math.random() > 0.5 ? color : 0xffff00,
        alpha: 1,
      });
    }

    // Ground scorch decal
    const scorch = new THREE.Mesh(
      new THREE.CircleGeometry(size * 0.8, 16),
      new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.5 })
    );
    scorch.rotation.x = -Math.PI / 2;
    scorch.position.y = -position.y + 0.02;
    group.add(scorch);

    // Bright pooled light (decay handled by pool)
    borrowLight(position, color, 8, size * 8, duration);

    this.scene.add(group);
    this.explosions.push({
      group, flash, fireball, ring, sphere, scorch,
      life: duration, maxLife: duration, size
    });
  }

  createMuzzleFlash(position, direction, color = 0xff0000) {
    const group = new THREE.Group();
    group.position.copy(position);

    // Flash cone (shared geometry, already +Z-oriented with 0.15 z-offset baked in)
    const cone = new THREE.Mesh(_MUZZLE_CONE, glowMat(0xffffff, 1.0, 4.0));
    group.add(cone);

    // Flash sphere (shared unit sphere scaled to 0.08 radius)
    const sphere = new THREE.Mesh(_UNIT_SPHERE_6, glowMat(color, 0.9, 3.0));
    sphere.scale.setScalar(0.08);
    group.add(sphere);

    // Star flare planes (cross pattern) — shared plane geometry
    for (let i = 0; i < 3; i++) {
      const flareMat = glowMat(color, 0.75, 2.0);
      flareMat.side = THREE.DoubleSide;
      const flare = new THREE.Mesh(_MUZZLE_FLARE, flareMat);
      flare.rotation.z = (i / 3) * Math.PI;
      group.add(flare);
    }

    // Orient to face direction using scratch vector (no per-shot Vector3 alloc)
    _scratchVec.set(
      position.x + direction.x,
      position.y + direction.y,
      position.z + direction.z
    );
    group.lookAt(_scratchVec);

    // Pooled point light (decay handled by pool)
    borrowLight(position, color, 5, 8, 0.1);

    this.scene.add(group);
    this.muzzleFlashes.push({ group, life: 0.06 });
  }

  createSwordSlash(camera, color = 0x0088ff) {
    const group = new THREE.Group();

    // Main arc - bright edge (shared torus)
    group.add(new THREE.Mesh(_SWORD_MAIN, glowMat(0xaaddff, 1.0, 3.0)));

    // Inner arc - white core
    group.add(new THREE.Mesh(_SWORD_INNER, glowMat(0xffffff, 1.0, 4.5)));

    // Trailing glow arcs
    const trail1 = new THREE.Mesh(_SWORD_TRAIL_1, glowMat(color, 0.5, 2.0));
    trail1.rotation.z = 0.08;
    group.add(trail1);
    const trail2 = new THREE.Mesh(_SWORD_TRAIL_2, glowMat(color, 0.25, 1.5));
    trail2.rotation.z = 0.16;
    group.add(trail2);

    // Sparkle particles along the arc (shared unit box)
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI;
      const sparkle = new THREE.Mesh(_UNIT_BOX, glowMat(0xffffff, 1.0, 3.0));
      sparkle.scale.setScalar(0.03);
      sparkle.position.set(Math.cos(angle) * 1.2, Math.sin(angle) * 1.2, 0);
      group.add(sparkle);
    }

    // Position in front of camera using scratch vector (no per-slash Vector3 alloc)
    camera.getWorldDirection(_scratchVec);
    group.position.set(
      camera.position.x + _scratchVec.x * 1.5,
      camera.position.y + _scratchVec.y * 1.5 - 0.3,
      camera.position.z + _scratchVec.z * 1.5
    );
    group.quaternion.copy(camera.quaternion);
    this.scene.add(group);
    this.beams.push({ mesh: group, life: 0.2, maxLife: 0.2 });
  }

  update(delta) {
    // Decay all pooled point lights in one pass
    updateLightPool(delta);
    // Advance GPU particle fields (fire/sparks/smoke/debris)
    updateParticleFields(delta);

    // Update beams
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i];
      b.life -= delta;
      const alpha = Math.max(0, b.life / b.maxLife);
      if (b.mesh.material) {
        b.mesh.material.opacity = alpha;
      }
      // Update child materials directly via children array (no traverse)
      const children = b.mesh.children;
      for (let ci = 0, clen = children.length; ci < clen; ci++) {
        const child = children[ci];
        if (child.material && child.material.transparent) {
          child.material.opacity = alpha;
        }
      }

      // Sniper tracer bolt animation
      if (b.bolt) {
        b.boltProgress = Math.min(1, b.boltProgress + delta * 8);
        b.bolt.position.lerpVectors(b.boltFrom, b.boltTo, b.boltProgress);
        // Pool light follows the bolt; pool handles intensity decay on its own
        if (b.boltLight) b.boltLight.position.copy(b.bolt.position);
        const boltAlpha = Math.max(0, 1 - b.boltProgress);
        const boltChildren = b.bolt.children;
        for (let bi = 0, blen = boltChildren.length; bi < blen; bi++) {
          const bc = boltChildren[bi];
          if (bc.material && bc.material.transparent) {
            bc.material.opacity = boltAlpha;
          }
        }
        if (b.bolt.material && b.bolt.material.transparent) {
          b.bolt.material.opacity = boltAlpha;
        }
        if (b.boltProgress >= 1 || b.life <= 0) {
          this.scene.remove(b.bolt);
          disposeTree(b.bolt);
          b.bolt = null;
        }
      }

      if (b.life <= 0) {
        this.scene.remove(b.mesh);
        disposeTree(b.mesh);
        if (b.bolt) {
          this.scene.remove(b.bolt);
          disposeTree(b.bolt);
        }
        this.beams.splice(i, 1);
      }
    }

    // Update impacts
    for (let i = this.impacts.length - 1; i >= 0; i--) {
      const imp = this.impacts[i];
      imp.life -= delta;
      const progress = 1 - imp.life / imp.maxLife;

      if (imp.flash) {
        imp.flash.material.opacity = Math.max(0, 1 - progress * 3);
        const s = 1 + progress * (imp.type === 'sniper' ? 2 : 1);
        imp.flash.scale.set(s, s, s);
      }
      for (let si = 0, slen = imp.sparks.length; si < slen; si++) {
        const spark = imp.sparks[si];
        if (spark.velocity && (spark.velocity.x || spark.velocity.y || spark.velocity.z)) {
          spark.position.x += spark.velocity.x * delta;
          spark.position.y += spark.velocity.y * delta;
          spark.position.z += spark.velocity.z * delta;
          spark.velocity.y -= 15 * delta;
        }
        spark.material.opacity = Math.max(0, 1 - progress);
      }
      // Sniper impact ring expansion
      if (imp.ring) {
        const rs = 1 + progress * 4;
        imp.ring.scale.set(rs, rs, rs);
        imp.ring.material.opacity = Math.max(0, 0.8 * (1 - progress));
      }
      if (imp.life <= 0) {
        this.scene.remove(imp.group);
        disposeTree(imp.group);
        this.impacts.splice(i, 1);
      }
    }

    // Update explosions
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const e = this.explosions[i];
      e.life -= delta;
      const progress = 1 - e.life / e.maxLife;

      // Flash fades fast - slower fade for mega explosions
      const flashFade = e.isMega ? 2.2 : 3;
      e.flash.material.opacity = Math.max(0, 1 - progress * flashFade);
      const flashS = e.isMega ? (0.5 + progress * 2.5) : (1 + progress * 0.5);
      e.flash.scale.set(flashS, flashS, flashS);

      // Mega halo expansion
      if (e.halo) {
        const haloS = 0.15 + progress * 3;
        e.halo.scale.set(haloS, haloS, haloS);
        e.halo.material.opacity = Math.max(0, 0.5 * (1 - progress * 1.8));
      }
      // Extra shockwave rings
      if (e.rings) {
        for (let ri = 0; ri < e.rings.length; ri++) {
          const r = e.rings[ri];
          const pr = Math.max(0, (progress - (r.userData.delay || 0)) * 1.5);
          const rs = 0.05 + pr * 5;
          if (ri < 3) {
            r.scale.set(rs, rs, rs * 0.2);
          } else {
            r.scale.set(rs, rs, rs);
            r.rotation.y += delta * 2;
          }
          r.material.opacity = Math.max(0, (r.material.userData?.base ?? 0.85) * (1 - pr));
          if (!r.material.userData.base) r.material.userData.base = r.material.opacity / Math.max(0.01, (1 - pr));
        }
      }
      // Outer wireframe shell
      if (e.outerShell) {
        const os = 0.1 + progress * 2.5;
        e.outerShell.scale.set(os, os, os);
        e.outerShell.material.opacity = Math.max(0, 0.25 * (1 - progress));
        e.outerShell.rotation.x += delta * 0.5;
        e.outerShell.rotation.y += delta * 0.7;
      }
      // Scorch glow ring
      if (e.scorchGlow) {
        e.scorchGlow.material.opacity = Math.min(0.35, progress * 1.5) * (1 - Math.max(0, progress - 0.7) * 3);
      }
      // Fireball expands then fades
      if (e.fireball) {
        const fbS = 0.3 + progress * 2;
        e.fireball.scale.set(fbS, fbS, fbS);
        e.fireball.material.opacity = Math.max(0, 0.8 * (1 - progress * 1.5));
      }

      // Shockwave ring expands fast
      if (e.ring) {
        const rs = progress * 4;
        e.ring.scale.set(rs, rs, rs * 0.3);
        e.ring.material.opacity = Math.max(0, 0.7 * (1 - progress));
      }

      // Wireframe sphere expands
      const s = progress * 2;
      e.sphere.scale.set(s, s, s);
      e.sphere.material.opacity = Math.max(0, 0.4 * (1 - progress));

      // Fire / smoke / spark / debris particles now live in the GPU point
      // fields — no per-particle mesh updates here.

      // Scorch fades in then out
      if (e.scorch) {
        e.scorch.material.opacity = Math.min(0.5, progress * 2) * (1 - Math.max(0, progress - 0.8) * 5);
      }

      if (e.life <= 0) {
        this.scene.remove(e.group);
        disposeTree(e.group);
        this.explosions.splice(i, 1);
      }
    }

    // Update muzzle flashes
    for (let i = this.muzzleFlashes.length - 1; i >= 0; i--) {
      const m = this.muzzleFlashes[i];
      m.life -= delta;
      if (m.life <= 0) {
        if (m.group) {
          this.scene.remove(m.group);
          disposeTree(m.group);
        } else if (m.light) {
          this.scene.remove(m.light);
        }
        this.muzzleFlashes.splice(i, 1);
      }
    }
  }

  cleanup() {
    this.beams.forEach(b => {
      this.scene.remove(b.mesh);
      disposeTree(b.mesh);
      if (b.bolt) {
        this.scene.remove(b.bolt);
        disposeTree(b.bolt);
      }
    });
    this.explosions.forEach(e => {
      this.scene.remove(e.group);
      disposeTree(e.group);
    });
    this.muzzleFlashes.forEach(m => {
      if (m.group) {
        this.scene.remove(m.group);
        disposeTree(m.group);
      } else if (m.light) {
        this.scene.remove(m.light);
      }
    });
    this.impacts.forEach(imp => {
      this.scene.remove(imp.group);
      disposeTree(imp.group);
    });
    this.beams = [];
    this.explosions = [];
    this.muzzleFlashes = [];
    this.impacts = [];
    clearParticleFields();
  }
  // ---- v2 adapters (enemies.js / weapons.js call these) ----
  // Burning wreck: a few hot additive flame particles + a slow grey smoke column, per frame.
  spawnFire(position, delta, size = 1) {
    const n = Math.min(4, Math.round(delta * 90 * size));
    for (let i = 0; i < n; i++) {
      spawnParticle('add', {
        position: new THREE.Vector3(position.x + (Math.random() - 0.5) * 1.2 * size, position.y, position.z + (Math.random() - 0.5) * 1.2 * size),
        velocity: new THREE.Vector3((Math.random() - 0.5) * 0.8, 1.8 + Math.random() * 2.2, (Math.random() - 0.5) * 0.8),
        gravity: -1.5, drag: 0.6, life: 0.5 + Math.random() * 0.5, sizeStart: 0.45 * size, sizeEnd: 0.05, color: Math.random() < 0.5 ? 0xff7a1a : 0xffc040,
      });
    }
    if (Math.random() < delta * 12) {
      spawnParticle('normal', {
        position: new THREE.Vector3(position.x, position.y + 0.8, position.z),
        velocity: new THREE.Vector3((Math.random() - 0.5) * 0.6, 1.2 + Math.random(), (Math.random() - 0.5) * 0.6),
        gravity: -0.4, drag: 0.3, life: 3 + Math.random() * 2, sizeStart: 0.8 * size, sizeEnd: 3.5 * size, color: 0x2a2a30, alpha: 0.35,
      });
    }
  }
  // Small impact burst of glowing sparks + a short flash at a world point.
  createImpact(position, color = 0x33ddff, size = 0.6) {
    const n = Math.round(6 + size * 8);
    for (let i = 0; i < n; i++) {
      const sp = 3 + Math.random() * 5 * size;
      spawnParticle('add', {
        position, velocity: new THREE.Vector3((Math.random() - 0.5) * sp, Math.random() * sp * 0.8, (Math.random() - 0.5) * sp),
        gravity: 9, drag: 2, life: 0.25 + Math.random() * 0.3, sizeStart: 0.08 * size + 0.05, sizeEnd: 0.0, color,
      });
    }
    if (size >= 1.5) this.createExplosion(position, color, size, 0.45);
  }
  createSparks(position, color = 0xffaa44, count = 10) {
    for (let i = 0; i < count; i++) {
      spawnParticle('add', {
        position, velocity: new THREE.Vector3((Math.random() - 0.5) * 8, Math.random() * 6, (Math.random() - 0.5) * 8),
        gravity: 12, drag: 1, life: 0.2 + Math.random() * 0.35, sizeStart: 0.07, sizeEnd: 0.0, color,
      });
    }
  }
  // Energy shield popping: a fast-expanding translucent shell plus a ring of sparks.
  createShieldBurst(position, height = 2, color = 0x66aaff) {
    const c = new THREE.Vector3(position.x, position.y + height / 2, position.z);
    this.createExplosion(c, color, height * 0.55, 0.3);
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      spawnParticle('add', {
        position: c, velocity: new THREE.Vector3(Math.cos(a) * 7, (Math.random() - 0.3) * 4, Math.sin(a) * 7),
        gravity: 4, drag: 2, life: 0.4 + Math.random() * 0.3, sizeStart: 0.12, sizeEnd: 0.0, color,
      });
    }
  }

}
