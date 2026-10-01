// assets.js - GLB/texture loading with caching and skinned-mesh cloning.
//
// Every model in the game is an authored asset (ChatGPT concept -> Trellis 2 -> Blender rig),
// so this module is the single door they come through. `loadModel(key)` fetches once and hands
// out clones; skinned enemies use SkeletonUtils.clone so each instance owns its bones.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const gltfLoader = new GLTFLoader();
const draco = new DRACOLoader();
draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
gltfLoader.setDRACOLoader(draco);
const texLoader = new THREE.TextureLoader();

const _models = new Map();   // key -> Promise<{scene, animations}>
const _textures = new Map();

export const MODEL_FILES = {
  // enemies (rigged, animated)
  gnat: 'assets/models/enemies/gnat.glb',
  skirmisher: 'assets/models/enemies/skirmisher.glb',
  warlord: 'assets/models/enemies/warlord.glb',
  juggernaut: 'assets/models/enemies/juggernaut.glb',
  wasp: 'assets/models/enemies/wasp.glb',
  overseer: 'assets/models/enemies/overseer.glb',
  // weapons (first-person viewmodels)
  rifle: 'assets/models/weapons/rifle.glb',
  plasmaRifle: 'assets/models/weapons/plasma_rifle.glb',
  energySword: 'assets/models/weapons/energy_sword.glb',
  rocketLauncher: 'assets/models/weapons/rocket_launcher.glb',
};

export function loadModel(key) {
  const url = MODEL_FILES[key] || key;
  if (!_models.has(url)) _models.set(url, _loadModelAttempt(url, 0));
  return _models.get(url);
}

// One dropped request used to doom a species for the whole session: the rejected promise stayed in
// _models, so every later spawn resolved instantly to that failure and Enemy._load() fell back to a
// featureless placeholder capsule. Retry a couple of times, and if it still fails, evict the cache
// entry so the next wave gets a fresh attempt instead of inheriting a one-off network blip.
function _loadModelAttempt(url, attempt) {
  return new Promise((resolve, reject) => {
    gltfLoader.load(url, (gltf) => {
      gltf.scene.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
          o.frustumCulled = true;
          if (o.material) _fixMaterial(o.material);
        }
      });
      resolve({ scene: gltf.scene, animations: gltf.animations || [] });
    }, undefined, (err) => {
      if (attempt < 2) {
        setTimeout(() => _loadModelAttempt(url, attempt + 1).then(resolve, reject), 150 * (attempt + 1));
        return;
      }
      _models.delete(url);
      reject(new Error('Failed to load ' + url + ' after 3 attempts: ' + (err && err.message ? err.message : err)));
    });
  });
}

// Trellis exports come through Blender as MeshStandardMaterial with a baked base colour. They
// look flat under game lighting unless we turn roughness/metalness into something plausible and
// promote the glow seams (bright saturated pixels) into emissive via a cheap luminance trick.
function _fixMaterial(mat) {
  if (mat.__fixed) return;
  mat.__fixed = true;
  if (mat.map) {
    mat.map.colorSpace = THREE.SRGBColorSpace;
    mat.map.anisotropy = 4;
  }
  if (mat.isMeshStandardMaterial) {
    if (mat.metalness > 0.6) mat.metalness = 0.35;
    if (mat.roughness < 0.3) mat.roughness = 0.5;
    mat.envMapIntensity = 0.8;
  }
  mat.side = THREE.FrontSide;
}

// Clone for a non-skinned prop (shares geometry + material).
export async function instantiate(key) {
  const { scene } = await loadModel(key);
  return scene.clone(true);
}

// Clone for a skinned character: independent skeleton, shared geometry/material.
export async function instantiateSkinned(key) {
  const { scene, animations } = await loadModel(key);
  const clone = SkeletonUtils.clone(scene);
  return { mesh: clone, animations };
}

export function loadTexture(url, { srgb = true, repeat = null, anisotropy = 8 } = {}) {
  const k = url + '|' + (repeat ? repeat.join(',') : '') + '|' + srgb;
  if (!_textures.has(k)) {
    const t = texLoader.load(url);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = anisotropy;
    if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
    _textures.set(k, t);
  }
  return _textures.get(k);
}

// Fit a loaded object so its bounding box height equals `height` and its feet sit at y=0.
export function normalize(obj, height, { centerXZ = true } = {}) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3(); box.getSize(size);
  const s = height / Math.max(size.y, 1e-6);
  obj.scale.setScalar(s);
  box.setFromObject(obj);
  obj.position.y -= box.min.y;
  if (centerXZ) { obj.position.x -= (box.min.x + box.max.x) / 2; obj.position.z -= (box.min.z + box.max.z) / 2; }
  return obj;
}

// Preload a set of keys, reporting progress. Missing files are reported and skipped so the game
// can still boot while the art pipeline is mid-run.
export async function preload(keys, onProgress) {
  const results = {};
  let done = 0;
  await Promise.all(keys.map(async (k) => {
    try { results[k] = await loadModel(k); }
    catch (e) { console.warn('[assets] missing', k, e.message); results[k] = null; }
    done++;
    if (onProgress) onProgress(done, keys.length, k);
  }));
  return results;
}

export function disposeTree(obj) {
  obj.traverse((o) => {
    if (o.geometry && !o.geometry.__shared) o.geometry.dispose();
    if (o.material && !o.material.__shared) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) { if (m.map && !m.map.__shared) m.map.dispose(); m.dispose(); }
    }
  });
}
