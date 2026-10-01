// decals.js - Pooled ground decals (plasma scorches, alien blood) from authored decal sheets.
// Each sheet is a 2x2 grid; a decal picks a quadrant by UV offset so four variants cost one texture.
import * as THREE from 'three';
import { loadTexture } from './assets.js';

const _quadGeos = new Map();
const _UP = new THREE.Vector3(0, 1, 0);
function quadrantGeo(q) {
  if (!_quadGeos.has(q)) {
    const g = new THREE.PlaneGeometry(1, 1);
    const uv = g.attributes.uv;
    const ox = (q % 2) * 0.5, oy = (q < 2 ? 0.5 : 0);
    for (let i = 0; i < uv.count; i++) uv.setXY(i, ox + uv.getX(i) * 0.5, oy + uv.getY(i) * 0.5);
    uv.needsUpdate = true;
    g.rotateX(-Math.PI / 2);
    _quadGeos.set(q, g);
  }
  return _quadGeos.get(q);
}

export class DecalPool {
  constructor(scene, url, { count = 40, life = 25, additive = false, tint = 0xffffff } = {}) {
    this.scene = scene;
    this.life = life;
    const map = loadTexture(url, { srgb: true, anisotropy: 4 });
    this.mat = new THREE.MeshBasicMaterial({
      map, transparent: true, depthWrite: false, opacity: 1, color: tint, toneMapped: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, polygonOffset: true, polygonOffsetFactor: -2,
    });
    this.items = [];
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(quadrantGeo(i % 4), this.mat.clone());
      m.visible = false; m.renderOrder = 2; m.matrixAutoUpdate = false;
      scene.add(m);
      this.items.push({ mesh: m, life: 0, max: 1 });
    }
    this.head = 0;
  }
  spawn(position, size, opts = {}) {
    const it = this.items[this.head]; this.head = (this.head + 1) % this.items.length;
    const m = it.mesh;
    m.geometry = quadrantGeo(opts.variant != null ? opts.variant : Math.floor(Math.random() * 4));
    m.position.set(position.x, (opts.y != null ? opts.y : 0.02) + Math.random() * 0.004, position.z);
    m.quaternion.identity(); m.rotation.set(0, opts.rotation != null ? opts.rotation : Math.random() * Math.PI * 2, 0);
    m.scale.setScalar(size * (0.85 + Math.random() * 0.3));
    m.updateMatrix();
    m.material.opacity = opts.opacity != null ? opts.opacity : 1;
    m.visible = true;
    it.life = it.max = opts.life || this.life;
    it.base = m.material.opacity;
    return it;
  }
  // Decal on any surface: `normal` is the face normal; the quad is offset slightly along it.
  spawnOriented(position, normal, size, opts = {}) {
    const it = this.items[this.head]; this.head = (this.head + 1) % this.items.length;
    const m = it.mesh;
    m.geometry = quadrantGeo(opts.variant != null ? opts.variant : Math.floor(Math.random() * 4));
    m.position.copy(position).addScaledVector(normal, 0.02 + Math.random() * 0.004);
    // quadrantGeo faces +Y; rotate so +Y == normal, then spin randomly around it.
    m.quaternion.setFromUnitVectors(_UP, normal);
    m.rotateY(opts.rotation != null ? opts.rotation : Math.random() * Math.PI * 2);
    m.scale.setScalar(size * (0.85 + Math.random() * 0.3));
    m.updateMatrix();
    m.material.opacity = opts.opacity != null ? opts.opacity : 1;
    m.visible = true;
    it.life = it.max = opts.life || this.life; it.base = m.material.opacity;
    return it;
  }
  update(delta) {
    for (const it of this.items) {
      if (!it.mesh.visible) continue;
      it.life -= delta;
      if (it.life <= 0) { it.mesh.visible = false; continue; }
      if (it.life < 4) it.mesh.material.opacity = it.base * (it.life / 4);
    }
  }
  clear() { for (const it of this.items) it.mesh.visible = false; }
  setScene(scene) { for (const it of this.items) { this.scene.remove(it.mesh); scene.add(it.mesh); } this.scene = scene; }
}
