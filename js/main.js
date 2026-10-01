// main.js - Entry point: renderer, menu, game loop, and the glue between systems.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { FPSControls } from './controls.js';
import { AudioManager } from './audio.js';
import { ParticleSystem, initLightPool, initParticleFields, disposeTree } from './particles.js';
import { WeaponManager, WEAPONS, WEAPON_ORDER } from './weapons.js';
import { WaveManager } from './waves.js';
import { Player, PERKS } from './player.js';
import { HUD } from './hud.js';
import { HelpGuide } from './help.js';
import { VFXManager, preWarmVFXMaterials } from './vfx.js';
import { LEVELS, buildLevel } from './level.js';
import { ENEMY_TYPES, initEnemyProjectiles, updateEnemyProjectiles, clearEnemyProjectiles } from './enemies.js';
import { preload, instantiate, instantiateSkinned, normalize, MODEL_FILES } from './assets.js';
import { PerfProfiler } from './perf.js';
import { DecalPool } from './decals.js';

const VERSION = 'v2.0.0';
const perf = new PerfProfiler();
const GameState = { MENU: 'menu', PLAYING: 'playing', PAUSED: 'paused', GAME_OVER: 'gameOver' };

let state = GameState.MENU;
let scene, camera, renderer, composer, renderPass, bloomPass;
let controls, audio, particles, weapons, waveManager, player, hud, helpGuide, vfx, clock;
let menuScene, menuCamera, menuRenderer, menuModel;
let scorchDecals, bloodDecals, bulletDecals, envMap;
let currentLevelIndex = 0, currentLevelData = null, selectedStartLevel = 0;
let _perkPending = false, _loadingLevel = false;
let currentWeaponIdx = 0;
const dom = {};

// Feel
let _killTimeScale = 1, _killTimeScaleTimer = 0, _recentKills = 0, _recentKillTimer = 0;
const MULTI_KILL_WINDOW = 1.0, MULTI_KILL_THRESHOLD = 3;
const KILL_STREAK_NAMES = ['', '', '', 'TRIPLE KILL', 'QUAD KILL', 'RAMPAGE', 'UNSTOPPABLE', 'GODLIKE', 'LEGENDARY'];
let _footstepTimer = 0, _crosshairFireTimer = 0, _crosshairHitTimer = 0, _lastHp = 100, _killStreakTimer = 0, _heartbeatTimer = 0, _dashSoundPlayed = false;
let _dmgDirTimers = { n: 0, s: 0, e: 0, w: 0 };
let _seenEnemyTypes = new Set(), _calloutTimer = 0;
let _lastPlayerPos = new THREE.Vector3(), _playerVel = new THREE.Vector3();
const _tmp = new THREE.Vector3(), _tmp2 = new THREE.Vector3();

// Pickups
const _pickups = [];
let _pickupGeo = null; const _pickupMats = {};
const PICKUP_HEAL = 25, PICKUP_SHIELD = 35, PICKUP_LIFETIME = 16, PICKUP_DROP_CHANCE = 0.28;

const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_TOUCH = IS_IOS || ('ontouchstart' in window && navigator.maxTouchPoints > 0);
const DEBUG = new URLSearchParams(location.search).has('debug');

function $(id) { return document.getElementById(id); }

// ===== INIT =====
async function init() {
  try { await _init(); }
  catch (e) {
    const loading = $('loading');
    if (loading) { loading.style.whiteSpace = 'pre-wrap'; loading.style.fontSize = '14px'; loading.style.padding = '20px'; loading.style.textAlign = 'left'; loading.textContent = 'ERROR during init:\n' + (e && e.stack ? e.stack : e); }
    console.error('Init failed:', e);
  }
}

async function _init() {
  const canvas = $('gameCanvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = true;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 700);
  camera.position.set(0, 1.7, 0);

  composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, { type: THREE.HalfFloatType }));
  composer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  composer.setSize(window.innerWidth, window.innerHeight);
  renderPass = new RenderPass(new THREE.Scene(), camera);
  composer.addPass(renderPass);
  bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.55, 0.45, 0.9);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());
  const smaa = new SMAAPass(window.innerWidth, window.innerHeight);
  composer.addPass(smaa);

  // Image-based lighting so alien alloys and gun metal pick up reflections at night.
  const pmrem = new THREE.PMREMGenerator(renderer); envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; pmrem.dispose();
  clock = new THREE.Clock();
  audio = new AudioManager();
  hud = new HUD();
  helpGuide = new HelpGuide(); helpGuide.init();
  _cacheDom();
  const vt = document.querySelector('.version-tag'); if (vt) vt.textContent = VERSION;

  // Preload everything that exists; missing files fall back to placeholders inside each system.
  const status = $('load-status');
  const keys = Object.keys(MODEL_FILES);
  await preload(keys, (done, total, k) => { if (status) status.innerHTML = `<div style="font-size:22px;font-weight:bold;">LOADING ASSETS</div><div style="margin-top:8px;opacity:.7">${done}/${total} — ${k}</div>`; });

  initMenu();
  setupEventListeners();

  const loadReady = $('load-ready'), loadingEl = $('loading');
  if (status) status.style.display = 'none';
  if (loadReady) loadReady.style.display = 'block';
  const enter = () => { loadingEl.style.display = 'none'; audio.startMenuMusic(); loadingEl.removeEventListener('click', enter); document.removeEventListener('keydown', enterKey); };
  const enterKey = (e) => { if (e.code === 'Enter' || e.code === 'Space') { e.preventDefault(); enter(); } };
  loadingEl.addEventListener('click', enter);
  document.addEventListener('keydown', enterKey);
  if (DEBUG) { enter(); _installDebugHook(); }
  animate();
}

function _cacheDom() {
  for (const id of ['crosshair', 'speed-lines', 'kill-streak', 'health-bar-container', 'enemy-callout', 'wave-countdown', 'reload-bar-container', 'reload-bar', 'boss-health', 'boss-bar-fill', 'boss-name', 'damage-flash', 'scope-overlay', 'weapon-model', 'shield-bar', 'shield-bar-container'])
    dom[id] = $(id);
  dom.dmgDir = { n: document.querySelector('.dmg-dir-n'), s: document.querySelector('.dmg-dir-s'), e: document.querySelector('.dmg-dir-e'), w: document.querySelector('.dmg-dir-w') };
}

// ===== MENU =====
async function initMenu() {
  const menuCanvas = $('menu-canvas');
  menuRenderer = new THREE.WebGLRenderer({ canvas: menuCanvas, alpha: true, antialias: true });
  menuRenderer.setSize(window.innerWidth, window.innerHeight);
  menuRenderer.setClearColor(0x000000, 0);
  menuRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  menuRenderer.outputColorSpace = THREE.SRGBColorSpace;
  menuScene = new THREE.Scene();
  menuScene.fog = new THREE.FogExp2(0x06061a, 0.012);
  menuCamera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 500);
  menuCamera.position.set(0, 2.2, 12); menuCamera.lookAt(0, 2.5, 0);
  const n = 2500, sp = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { sp[i * 3] = (Math.random() - 0.5) * 400; sp[i * 3 + 1] = (Math.random() - 0.2) * 300; sp[i * 3 + 2] = (Math.random() - 0.5) * 400 - 100; }
  const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  menuScene.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 0.6, fog: false })));
  menuScene.add(new THREE.AmbientLight(0x3050a0, 0.8));
  const key = new THREE.DirectionalLight(0xa0c0ff, 1.8); key.position.set(5, 8, 6); menuScene.add(key);
  const rim = new THREE.DirectionalLight(0xff40e0, 1.2); rim.position.set(-6, 4, -8); menuScene.add(rim);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0x0c0c1c, roughness: 0.9 }));
  ground.rotation.x = -Math.PI / 2; menuScene.add(ground);
  // Menu centrepiece: the Overseer (or a Warlord) if its model exists, else the gnat.
  for (const k of ['overseer', 'warlord', 'gnat']) {
    try { const m = await instantiate(k); normalize(m, k === 'overseer' ? 5 : 3.2); menuModel = new THREE.Group(); menuModel.add(m); menuModel.position.set(0, k === 'overseer' ? 1.5 : 0, 0); menuScene.add(menuModel); break; }
    catch (e) { /* try next */ }
  }
}

function updateMenu(delta) {
  if (!menuRenderer) return;
  if (menuModel) { menuModel.rotation.y += delta * 0.35; menuModel.position.y += Math.sin(performance.now() * 0.0012) * 0.002; }
  menuRenderer.render(menuScene, menuCamera);
}

// ===== EVENTS =====
function setupEventListeners() {
  $('btn-start').addEventListener('click', () => startGame());
  $('btn-help').addEventListener('click', () => helpGuide.open());
  $('btn-restart').addEventListener('click', () => startGame());
  $('btn-menu').addEventListener('click', returnToMenu);
  $('btn-select-level').addEventListener('click', () => { $('level-select').style.display = 'flex'; });
  $('btn-back-menu').addEventListener('click', () => { $('level-select').style.display = 'none'; });
  document.querySelectorAll('.level-btn').forEach(btn => btn.addEventListener('click', () => { $('level-select').style.display = 'none'; selectedStartLevel = parseInt(btn.dataset.level); startGame(); }));
  $('gameCanvas').addEventListener('click', () => { if (state === GameState.PLAYING && !helpGuide.isOpen && !_perkPending) controls.lock(); });

  const wireTouchBtn = (id, onPress) => { const el = $(id); if (!el) return; el.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); if (state !== GameState.PLAYING || helpGuide.isOpen) return; onPress(); }, { passive: false }); };
  wireTouchBtn('touch-fire', () => fireWeapon());
  wireTouchBtn('touch-jump', () => { if (controls) controls.touchJump(); });
  wireTouchBtn('touch-weapon', () => cycleWeapon(1));

  document.addEventListener('keydown', (e) => {
    if (state === GameState.PLAYING) {
      switch (e.code) {
        case 'Digit1': selectWeapon(0); break;
        case 'Digit2': selectWeapon(1); break;
        case 'Digit3': selectWeapon(2); break;
        case 'Digit4': selectWeapon(3); break;
        case 'KeyQ': weapons.throwGrenade(); break;
        case 'KeyR': weapons.reload(); break;
        case 'KeyH': case 'Tab': e.preventDefault(); helpGuide.toggle(); if (helpGuide.isOpen) controls.unlock(); break;
      }
    }
    if (e.code === 'Escape' && helpGuide.isOpen) helpGuide.close();
    if (e.code === 'F3') { e.preventDefault(); perf.toggle(); }
    if (e.code === 'F4') { e.preventDefault(); perf.dumpReport(); }
  });
  document.addEventListener('mousedown', (e) => {
    if (state !== GameState.PLAYING || !controls.isLocked || helpGuide.isOpen) return;
    if (e.button === 0) { _fireHeld = true; fireWeapon(); }
    else if (e.button === 2) weapons.fireAlt(waveManager.enemies);
  });
  document.addEventListener('mouseup', (e) => { if (e.button === 0) _fireHeld = false; });
  document.addEventListener('mousemove', (e) => { if (weapons && controls && controls.isLocked) weapons.addSway(e.movementX, e.movementY); });
  document.addEventListener('wheel', (e) => { if (state !== GameState.PLAYING || !controls.isLocked || helpGuide.isOpen) return; cycleWeapon(e.deltaY > 0 ? 1 : -1); });
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('resize', () => {
    const w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.setSize(w, h); composer.setSize(w, h); bloomPass.setSize(w, h);
    if (menuRenderer) { menuRenderer.setSize(w, h); menuCamera.aspect = w / h; menuCamera.updateProjectionMatrix(); }
  });
}
let _fireHeld = false;

function selectWeapon(i) { currentWeaponIdx = i; weapons.switchWeapon(WEAPON_ORDER[i]); }
function cycleWeapon(d) { currentWeaponIdx = (currentWeaponIdx + d + WEAPON_ORDER.length) % WEAPON_ORDER.length; weapons.switchWeapon(WEAPON_ORDER[currentWeaponIdx]); }

function _setupGamepadCallbacks() {
  const playing = () => state === GameState.PLAYING && !helpGuide.isOpen;
  controls.onGamepadFire = () => { if (playing()) fireWeapon(); };
  controls.onGamepadFireHold = () => { if (playing()) fireWeapon(); };
  controls.onGamepadZoom = () => { if (playing()) weapons.fireAlt(waveManager.enemies); };
  controls.onGamepadWeapon1 = () => { if (playing()) selectWeapon(0); };
  controls.onGamepadWeapon2 = () => { if (playing()) selectWeapon(1); };
  controls.onGamepadWeapon3 = () => { if (playing()) selectWeapon(2); };
  controls.onGamepadGrenade = () => { if (playing()) weapons.throwGrenade(); };
  controls.onGamepadCycleWeapon = () => { if (playing()) cycleWeapon(1); };
  controls.onGamepadHelp = () => { if (state === GameState.PLAYING) { helpGuide.toggle(); if (helpGuide.isOpen) controls.unlock(); } };
  controls.onGamepadStart = () => {
    if (state === GameState.MENU || state === GameState.GAME_OVER) startGame();
    else if (state === GameState.PLAYING && !controls.isLocked && !helpGuide.isOpen) controls.lock();
  };
  controls.onGamepadBack = () => { if (helpGuide.isOpen) helpGuide.close(); };
}

// ===== GAME FLOW =====
async function startGame() {
  if (_loadingLevel) return;
  if (!audio.ctx) audio.init();
  audio.resume(); audio.stopMenuMusic();
  state = GameState.PLAYING;
  currentLevelIndex = selectedStartLevel;
  _seenEnemyTypes = new Set(); _lastHp = 100; _recentKills = 0; _killTimeScale = 1;
  $('main-menu').style.display = 'none'; $('game-over').style.display = 'none';
  for (const id of ['hud', 'crosshair', 'scanlines', 'vignette']) $(id).style.display = 'block';
  if (dom['weapon-model']) dom['weapon-model'].style.display = 'none';

  scene = new THREE.Scene();
  controls = new FPSControls(camera, renderer.domElement);
  controls.speed = 9.5; controls.sprintMultiplier = 1.65;
  _setupGamepadCallbacks();
  if (IS_TOUCH) { controls.enableTouchControls({ onFire: () => fireWeapon(), onJump: () => controls.touchJump(), onCycleWeapon: () => cycleWeapon(1) }); $('touch-controls').classList.add('active'); }

  particles = new ParticleSystem(scene);
  vfx = new VFXManager(camera, scene);
  scorchDecals = new DecalPool(scene, 'assets/decals/scorch.png', { count: 48, life: 30 });
  bloodDecals = new DecalPool(scene, 'assets/decals/blood.png', { count: 64, life: 40 });
  bulletDecals = new DecalPool(scene, 'assets/decals/bullet.png', { count: 120, life: 45 });
  weapons = new WeaponManager(camera, scene, particles, audio);
  weapons.onHit = processHit;
  weapons.onRocketHit = (hits, pos) => { if (vfx) vfx.shake(0.3, 0.5); scorchDecals.spawn(pos, 6.5); for (const h of hits) processHit(h); };
  weapons.onGrenadeHit = (hits, pos) => { if (vfx) vfx.shake(0.25, 0.4); scorchDecals.spawn(pos, 5); for (const h of hits) processHit(h); };
  const _rc = new THREE.Raycaster(); const _n = new THREE.Vector3();
  weapons.onWallHit = (point, normal, kind, origin, dir) => {
    // The collider box is a loose fit; refine against the real building mesh so decals sit on it.
    if (origin && dir && currentLevelData) {
      _rc.set(origin, dir); _rc.far = origin.distanceTo(point) + 2.5;
      const hits = _rc.intersectObjects(currentLevelData.group.children, true);
      const h = hits.find(x => x.face && x.object.isMesh && x.object.geometry.type !== 'PlaneGeometry');
      if (h) { point = h.point; normal = _n.copy(h.face.normal).transformDirection(h.object.matrixWorld); if (normal.dot(dir) > 0) normal.negate(); }
    }
    if (kind === 'bullet') bulletDecals.spawnOriented(point, normal, 0.22);
    else if (kind === 'plasma') scorchDecals.spawnOriented(point, normal, 0.9, { opacity: 0.8, life: 20 });
    else scorchDecals.spawnOriented(point, normal, 5, { life: 30 });
  };
  player = new Player(); weapons.player = player;
  // Player has a Halo-style recharging shield: starts full, recharges after 4s out of combat.
  player.maxShield = 60; player.shield = 60; player.shieldRegenDelay = 4; player.shieldRegenRate = 25;
  scene.add(camera);

  waveManager = new WaveManager({ scene, particles, audio, vfx, colliders: [], onMelee: onEnemyMelee });
  await loadLevel(currentLevelIndex);
  audio.startMusic(); audio.startAmbient();
  controls.lock();
  _lastPlayerPos.copy(camera.position);
}

async function loadLevel(index) {
  _loadingLevel = true;
  if (currentLevelData) {
    waveManager.cleanup(); _clearPickups(); clearEnemyProjectiles();
    scene.remove(currentLevelData.group); disposeTree(currentLevelData.group);
    // fresh scene
    scene = new THREE.Scene(); scene.add(camera);
    particles.scene = scene; vfx.scene = scene; weapons.scene = scene; waveManager.ctx.scene = scene;
    scorchDecals.setScene(scene); bloodDecals.setScene(scene); bulletDecals.setScene(scene);
  }
  initLightPool(scene); initParticleFields(scene); initEnemyProjectiles(scene);
  currentLevelIndex = index % LEVELS.length;
  const def = LEVELS[currentLevelIndex];
  const status = $('wave-countdown'); if (status) { status.textContent = 'DEPLOYING · ' + def.name; status.style.display = 'block'; }
  scene.environment = envMap; scene.environmentIntensity = 0.55;
  currentLevelData = await buildLevel(scene, def);
  if (status) status.style.display = 'none';
  waveManager.setSpawnPoints(currentLevelData.spawnPoints);
  waveManager.ctx.colliders = currentLevelData.colliders; waveManager.ctx.arenaRadius = currentLevelData.arenaRadius;
  weapons.colliders = currentLevelData.colliders;
  controls.bound = currentLevelData.arenaRadius;
  camera.position.copy(currentLevelData.playerStart);
  if (vfx) { vfx.initEnvironmentParticles('embers'); vfx.initGroundFog(); vfx.initSmokeWisps(); vfx.initDustMotes(); vfx.initPuddles(); if (def.weather === 'rain') vfx.initRain(); }
  renderPass.scene = scene;
  // Pre-compile every shader program the level can possibly need — enemy models, weapon
  // viewmodels, VFX materials — while the "DEPLOYING" screen is up, instead of paying a one-time
  // stall the first time each thing actually appears in a firefight (first spawn of each alien
  // type, first switch to each weapon). Parked far below the arena, frustum culling disabled so
  // an actual render() still binds and uploads their textures to the GPU — compile() alone only
  // builds the shader *program*; the texture upload/mipmap cost (often the bigger of the two for
  // a 2048px baked albedo) is still deferred to first real use otherwise.
  await weapons.ready;
  const warm = preWarmVFXMaterials(scene);
  // Placed AT the level's real spawn points (not an arbitrary nearby spot) and rendered for real
  // (not just compile()'d) so whatever a given spawn point's local lighting/shadow situation
  // needs — main pass, shadow depth pass, everything — gets built once here instead of on a real
  // spawn mid-firefight. A one-frame appearance during the "DEPLOYING" transition is the trade.
  const warmTypes = Object.keys(ENEMY_TYPES);
  const spawnSpots = currentLevelData.spawnPoints;
  const warmMats = [];
  for (let i = 0; i < warmTypes.length; i++) {
    try {
      const { mesh } = await instantiateSkinned(warmTypes[i]);
      const p = spawnSpots && spawnSpots.length ? spawnSpots[i % spawnSpots.length] : { x: 0, z: 6 };
      mesh.position.set(p.x, 1, p.z);
      // Clone materials the same way Enemy._load() does (js/enemies.js) so this prewarms the exact
      // per-instance material every real spawn actually renders with, not the shared source material.
      mesh.traverse((o) => {
        if (o.isMesh) {
          o.frustumCulled = false;
          if (o.material) { o.material = o.material.clone(); warmMats.push(o.material); }
        }
      });
      warm.add(mesh);
    } catch (e) { /* asset not generated yet — nothing to warm */ }
  }
  renderer.compile(scene, camera);
  composer.render(); // real draw call: forces texture upload + warms the post-fx shader variants
  composer.render(); // twice, cheap insurance against any first-frame-only setup path
  // Enemy.update()'s death-fade (js/enemies.js) flips material.transparent false->true on first
  // death — `transparent` is part of three.js's shader cache key, so that flip alone forces a fresh
  // compile, and it was landing mid-firefight the first time each enemy type died (measured 200ms-2s
  // stalls, scattered through combat, on top of an already-busy dense scene). Toggle it here on the
  // warmed clones and render once more so the "dying" shader variant is already compiled too.
  for (const m of warmMats) { m.transparent = true; m.opacity = 0.99; }
  composer.render();
  // No disposeTree() here: instantiateSkinned() shares geometry/materials with the cached model
  // (SkeletonUtils.clone only clones the bone hierarchy), so every real enemy spawned later
  // reuses these same GPU buffers — disposing them would break every future spawn of that type.
  // Nothing unique was allocated per warm-up call; removing from the scene is enough.
  scene.remove(warm);
  hud.showWaveAnnouncement(waveManager.wave + 1, def.name, true);
  _loadingLevel = false;
}

function returnToMenu() {
  state = GameState.MENU; selectedStartLevel = 0;
  $('main-menu').style.display = 'flex'; $('game-over').style.display = 'none'; $('level-select').style.display = 'none';
  for (const id of ['hud', 'crosshair', 'scanlines', 'vignette']) $(id).style.display = 'none';
  const tc = $('touch-controls'); if (tc) tc.classList.remove('active');
  audio.stopMusic(); audio.stopAmbient(); audio.stopHeartbeat(); audio.startMenuMusic();
  _hideOverlays();
  if (waveManager) waveManager.cleanup();
  if (vfx) vfx.cleanup();
  if (scorchDecals) { scorchDecals.clear(); bloodDecals.clear(); bulletDecals.clear(); }
  _clearPickups(); clearEnemyProjectiles();
}

function gameOver() {
  state = GameState.GAME_OVER;
  controls.unlock(); audio.stopMusic(); audio.stopAmbient(); audio.stopHeartbeat();
  const tc = $('touch-controls'); if (tc) tc.classList.remove('active');
  for (const id of ['hud', 'crosshair', 'scope-overlay', 'scanlines', 'vignette']) $(id).style.display = 'none';
  $('game-over').style.display = 'flex';
  const perkEl = $('perk-select'); if (perkEl) perkEl.style.display = 'none'; _perkPending = false;
  $('go-waves').textContent = waveManager.wave; $('go-kills').textContent = player.kills; $('go-score').textContent = player.score;
  const bc = $('go-combo'); if (bc) bc.textContent = player.bestCombo;
  _clearPickups(); _hideOverlays();
}

function _hideOverlays() {
  for (const id of ['boss-health', 'enemy-callout', 'wave-countdown', 'kill-streak']) { const el = dom[id] || $(id); if (el) { el.style.display = 'none'; el.classList && el.classList.remove('active', 'mega'); } }
  if (dom['scope-overlay']) dom['scope-overlay'].style.display = 'none';
}

// ===== COMBAT =====
function fireWeapon() {
  if (!weapons || player.dead) return;
  const fired = weapons.fire(waveManager.enemies);
  if (fired) { if (dom.crosshair) { dom.crosshair.classList.add('firing'); _crosshairFireTimer = 0.08; } }
}

function processHit(hit) {
  const e = hit.enemy;
  if (!e || e.dead) return;
  const res = e.takeDamage(hit.damage, hit.from, { point: hit.point, explosive: hit.explosive, knockback: hit.knockback });
  if (dom.crosshair) { dom.crosshair.classList.add('hit'); _crosshairHitTimer = 0.12; }
  if (hit.headshot && !res.absorbed && audio.playCritHit) audio.playCritHit();
  else if (!res.absorbed) audio.playAlienHit();
  if (particles && hit.point) particles.createImpact(hit.point, res.absorbed ? 0x80a0ff : 0xff60c0, hit.explosive ? 0.3 : 0.5);
  if (vfx) {
    vfx.showHitMarker(res.killed);
    _tmp.set(e.mesh.position.x, e.mesh.position.y + e.data.height + 0.2, e.mesh.position.z);
    vfx.showDamageNumber(_tmp, res.absorbed ? 'SHIELD' : hit.damage, res.killed, hit.headshot);
    vfx.shake(hit.weaponKey === 'rocketLauncher' ? 0.05 : hit.weaponKey === 'energySword' ? 0.04 : 0.015, 0.06);
  }
  if (res.killed) onKill(e, hit);
}

function onKill(e, hit) {
  player.addKill();
  player.addScore(e.data.points * (e.elite ? 3 : 1));
  _recentKills++; _recentKillTimer = MULTI_KILL_WINDOW;
  if (_recentKills >= MULTI_KILL_THRESHOLD) {
    _killTimeScale = 0.35; _killTimeScaleTimer = 0.4; audio.playMultiKill();
    const name = KILL_STREAK_NAMES[Math.min(_recentKills, KILL_STREAK_NAMES.length - 1)];
    const ks = dom['kill-streak'];
    if (name && ks) { ks.textContent = name; ks.classList.remove('active', 'mega'); void ks.offsetWidth; ks.classList.add('active'); if (_recentKills >= 6) ks.classList.add('mega'); ks.style.display = ''; _killStreakTimer = 1.5; }
    _recentKills = 0;
  }
  if (player.vampireHeal > 0) player.heal(player.vampireHeal);
  if (!e.data.hoverHeight) bloodDecals.spawn(e.mesh.position, 1.2 + e.data.height * 0.5);
  if (vfx) { vfx.addKillFeedEntry(e.data.name, WEAPONS[hit.weaponKey] ? WEAPONS[hit.weaponKey].name : 'GRENADE'); vfx.createDeathEffect(e.mesh.position, e.data.color, e.data.height * 0.5); }
  const dropChance = PICKUP_DROP_CHANCE + (e.data.hp > 150 ? 0.2 : 0) + player.dropRateBonus;
  if (e.elite || e.isBoss || Math.random() < dropChance) {
    const r = Math.random();
    const type = e.isBoss ? 'shield' : r < 0.45 ? 'health' : r < 0.7 ? 'shield' : r < 0.9 ? 'ammo' : 'grenade';
    _spawnPickup(e.mesh.position, type);
  }
  if (e.isBoss && vfx) { vfx.shake(0.6, 1.2); particles.createMegaExplosion && particles.createMegaExplosion(e.mesh.position, 8); }
}

function onEnemyMelee(enemy, damage) {
  if (player.dead) return;
  player.takeDamage(damage, audio);
  if (vfx) { vfx.shake(0.35, 0.3); vfx.triggerChromaticAberration && vfx.triggerChromaticAberration(0.8); }
  _showDamageDirection(enemy.mesh.position);
}

function _showDamageDirection(enemyPos) {
  _tmp.subVectors(enemyPos, camera.position); _tmp.y = 0; _tmp.normalize();
  camera.getWorldDirection(_tmp2); _tmp2.y = 0; _tmp2.normalize();
  const f = _tmp.dot(_tmp2); const r = _tmp.x * _tmp2.z - _tmp.z * _tmp2.x;
  const k = Math.abs(f) > Math.abs(r) ? (f > 0 ? 'n' : 's') : (r > 0 ? 'w' : 'e');
  _dmgDirTimers[k] = 0.6;
  if (dom.dmgDir[k]) dom.dmgDir[k].classList.add('active');
}

// ===== PICKUPS =====
function _initPickupPrimitives() {
  if (_pickupGeo) return;
  _pickupGeo = new THREE.IcosahedronGeometry(0.22, 1); _pickupGeo.__shared = true;
  const mk = (c) => { const m = new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.9, toneMapped: false }); m.color.multiplyScalar(3); m.__shared = true; return m; };
  _pickupMats.health = mk(0x00ff66); _pickupMats.shield = mk(0x0088ff); _pickupMats.ammo = mk(0xffaa00); _pickupMats.grenade = mk(0x44ff44);
}
function _spawnPickup(position, type) {
  _initPickupPrimitives();
  const mesh = new THREE.Mesh(_pickupGeo, _pickupMats[type] || _pickupMats.health);
  mesh.position.set(position.x, 0.6, position.z);
  // No dedicated PointLight here: adding/removing a light changes the scene's light count, which
  // forces three.js to recompile every affected material's shader (a 50-200ms stall) — and
  // pickups drop often enough in combat that this was a frequent, very visible hitch. The
  // additive/toneMapped:false material plus bloom already reads as "glowing" without one.
  scene.add(mesh);
  _pickups.push({ mesh, life: PICKUP_LIFETIME, type });
}
function _updatePickups(delta, playerPos) {
  for (let i = _pickups.length - 1; i >= 0; i--) {
    const p = _pickups[i]; p.life -= delta;
    p.mesh.position.y = 0.6 + Math.sin(performance.now() * 0.004 + i) * 0.15; p.mesh.rotation.y += delta * 2;
    if (p.life < 3) p.mesh.visible = Math.sin(p.life * 10) > 0;
    const dx = p.mesh.position.x - playerPos.x, dz = p.mesh.position.z - playerPos.z;
    if (dx * dx + dz * dz < 4 && !player.dead) {
      if (p.type === 'health') { player.heal(PICKUP_HEAL); vfx && vfx.showHealFlash(); }
      else if (p.type === 'shield') { player.addShield(PICKUP_SHIELD); }
      else if (p.type === 'ammo') { weapons.addAmmo('rocketLauncher', 2); weapons.state.rifle.reserve = Infinity; }
      else if (p.type === 'grenade') weapons.addGrenade(1);
      audio.playPickup(); _removePickup(i); continue;
    }
    if (p.life <= 0) _removePickup(i);
  }
}
function _removePickup(i) { scene.remove(_pickups[i].mesh); _pickups.splice(i, 1); }
function _clearPickups() { for (const p of _pickups) scene.remove(p.mesh); _pickups.length = 0; }

// ===== PERKS =====
function _showPerkSelection(onComplete) {
  const el = $('perk-select'); if (!el) { onComplete(); return; }
  controls.unlock();
  const pool = PERKS.slice(); for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const choices = pool.slice(0, 3);
  el.innerHTML = '<div class="perk-title">CHOOSE AN UPGRADE</div><div class="perk-cards"></div>';
  const cards = el.querySelector('.perk-cards'); _perkPending = true;
  for (const perk of choices) {
    const card = document.createElement('button'); card.className = 'perk-card';
    card.innerHTML = `<div class="perk-name">${perk.name}</div><div class="perk-desc">${perk.desc}</div>`;
    card.addEventListener('click', () => { if (!_perkPending) return; player.addPerk(perk.id); if (perk.id === 'quickFeet') controls.speed = 9.5 * player.speedMultiplier; el.style.display = 'none'; _perkPending = false; hud.updatePerks(player.perks); controls.lock(); onComplete(); });
    cards.appendChild(card);
  }
  el.style.display = 'flex';
}

// ===== LOOP =====
let lastWaveState = '';
function animate() {
  requestAnimationFrame(animate);
  let delta = Math.min(clock.getDelta(), 0.05);
  if (state === GameState.MENU) { updateMenu(delta); return; }
  if (state !== GameState.PLAYING || helpGuide.isOpen || _perkPending || _loadingLevel) return;
  step(delta);
  // The draw call must sit inside the profiled frame. perf.frameEnd() used to fire at the end of
  // step(), so the F3 overlay's 'render' row read 0.00ms forever and its frame time/FPS excluded
  // the most expensive thing in the loop — the one number you'd actually want when diagnosing lag.
  perf.sectionBegin('render');
  composer.render();
  perf.sectionEnd('render');
  perf.frameEnd();
}

function step(delta) {
  if (_killTimeScaleTimer > 0) { _killTimeScaleTimer -= delta; if (_killTimeScaleTimer <= 0) _killTimeScale = 1; }
  if (_recentKillTimer > 0) { _recentKillTimer -= delta; if (_recentKillTimer <= 0) _recentKills = 0; }
  delta *= _killTimeScale;
  perf.frameBegin();

  perf.sectionBegin('controls');
  controls.update(delta, currentLevelData ? currentLevelData.colliders : []);
  perf.sectionEnd('controls');
  // Player velocity (for enemy lead and weapon bob)
  _playerVel.subVectors(camera.position, _lastPlayerPos).divideScalar(Math.max(delta, 1e-4)); _lastPlayerPos.copy(camera.position);
  weapons.setMoveSpeed(Math.hypot(_playerVel.x, _playerVel.z));

  player.update(delta);
  _updatePlayerShield(delta);
  particles.update(delta);
  if (_fireHeld && weapons.weapon.auto) fireWeapon();
  perf.sectionBegin('weapons'); weapons.update(delta, waveManager.enemies, camera.position); perf.sectionEnd('weapons');
  hud.updateAnnouncement(delta);

  // Footsteps / dash
  if (controls.onGround && controls.direction.length() > 0.1 && controls.dashTimer <= 0) { _footstepTimer -= delta; if (_footstepTimer <= 0) { audio.playFootstep(controls.sprint); _footstepTimer = controls.sprint ? 0.28 : 0.4; } } else _footstepTimer = 0;
  if (controls.dashTimer > 0 && !_dashSoundPlayed) { audio.playDash(); _dashSoundPlayed = true; }
  if (controls.dashTimer <= 0) _dashSoundPlayed = false;

  // Crosshair timers
  if (_crosshairFireTimer > 0) { _crosshairFireTimer -= delta; if (_crosshairFireTimer <= 0 && dom.crosshair) dom.crosshair.classList.remove('firing'); }
  if (_crosshairHitTimer > 0) { _crosshairHitTimer -= delta; if (_crosshairHitTimer <= 0 && dom.crosshair) dom.crosshair.classList.remove('hit'); }
  if (player.hp < _lastHp && dom['health-bar-container']) { const h = dom['health-bar-container']; h.classList.remove('damage-flash'); void h.offsetWidth; h.classList.add('damage-flash'); }
  _lastHp = player.hp;
  const hpPct = player.hp / player.maxHp;
  if (hpPct < 0.25 && hpPct > 0) { audio.startHeartbeat(); _heartbeatTimer -= delta; if (_heartbeatTimer <= 0) { audio._pulseHeartbeat(); _heartbeatTimer = 0.8 + hpPct * 2; } } else { audio.stopHeartbeat(); _heartbeatTimer = 0; }
  if (_killStreakTimer > 0) { _killStreakTimer -= delta; if (_killStreakTimer <= 0 && dom['kill-streak']) dom['kill-streak'].classList.remove('active', 'mega'); }
  for (const k in _dmgDirTimers) { if (_dmgDirTimers[k] > 0) { _dmgDirTimers[k] -= delta; if (_dmgDirTimers[k] <= 0 && dom.dmgDir[k]) dom.dmgDir[k].classList.remove('active'); } }
  if (dom['scope-overlay']) dom['scope-overlay'].style.display = weapons.zoomed ? 'block' : 'none';
  camera.fov += ((weapons.zoomed ? 42 : 75) - camera.fov) * Math.min(1, 10 * delta); camera.updateProjectionMatrix();

  perf.sectionBegin('vfx'); vfx.update(delta, hpPct, camera.position); perf.sectionEnd('vfx');

  // Waves
  perf.sectionBegin('waves');
  const prevState = waveManager.state;
  waveManager.update(delta, camera.position, _playerVel);
  perf.sectionEnd('waves');
  if (waveManager.state === 'complete' && prevState !== 'complete') {
    audio.playWaveComplete(); hud.showWaveComplete(waveManager.wave);
    if (waveManager.shouldChangeLevelAfterWave() && !DEBUG_NO_LEVEL_CHANGE) {
      _showPerkSelection(async () => { await loadLevel(currentLevelIndex + 1); });
    } else if (waveManager.wave % 2 === 0) {
      _showPerkSelection(() => {});
    }
  }
  if (waveManager.state === 'waiting') {
    waveManager.startWave();
    hud.showWaveAnnouncement(waveManager.wave, currentLevelData.name, false, waveManager.waveTheme ? waveManager.waveTheme.name : null);
  }
  lastWaveState = waveManager.state;

  // Enemy projectiles -> player
  const hits = updateEnemyProjectiles(delta, camera.position, currentLevelData.colliders, particles, (pos, splash) => scorchDecals.spawn(pos, splash ? 5 : 0.8, { opacity: splash ? 1 : 0.7, life: splash ? 30 : 12 }));
  scorchDecals.update(delta); bloodDecals.update(delta); bulletDecals.update(delta);
  for (const h of hits) {
    if (player.dead) break;
    if (controls.dashTimer > 0) continue; // dash i-frames
    player.takeDamage(Math.round(h.damage), audio);
    _showDamageDirection(h.position);
    if (vfx) vfx.shake(h.splash ? 0.3 : 0.08, 0.15);
  }

  // Enemy callout on first sighting
  for (const e of waveManager.enemies) {
    if (!e.dead && !_seenEnemyTypes.has(e.type)) {
      _seenEnemyTypes.add(e.type);
      if (dom['enemy-callout']) { dom['enemy-callout'].textContent = 'NEW CONTACT: ' + e.data.name; dom['enemy-callout'].style.display = 'block'; _calloutTimer = 3; }
    }
  }
  if (_calloutTimer > 0) { _calloutTimer -= delta; if (_calloutTimer <= 0 && dom['enemy-callout']) dom['enemy-callout'].style.display = 'none'; }
  _updateBossHealthBar();
  _updatePickups(delta, camera.position);
  _updateFires(delta);
  if (currentLevelData.lightPool) currentLevelData.lightPool.update(camera.position);
  if (currentLevelData.water) currentLevelData.water.material.uniforms.time.value += delta * 0.6;
  if (currentLevelData.ship) { currentLevelData.ship.rotation.y += delta * currentLevelData.ship.userData.spin; currentLevelData.ship.position.y = 150 + Math.sin(performance.now() * 0.0003) * 4; }

  // HUD
  const st = weapons.st, w = weapons.weapon;
  hud.update(player, waveManager, {
    name: w.name, cooldownPct: weapons.cooldownPct(), currentKey: weapons.current, ammoText: weapons.ammoText(), iconIndex: WEAPON_ORDER.indexOf(weapons.current),
    isReloading: st.reloading > 0, reloadPct: st.reloading > 0 ? 1 - st.reloading / w.reload : 0, ammo: st.mag, maxAmmo: w.mag == null ? Infinity : w.mag, grenadeCount: weapons.grenades,
  }, currentLevelData.name, controls);
  if (dom['shield-bar']) dom['shield-bar'].style.width = Math.max(0, player.shield / player.maxShield * 100) + '%';
  if (dom['reload-bar-container']) { dom['reload-bar-container'].style.display = st.reloading > 0 ? 'block' : 'none'; if (st.reloading > 0 && dom['reload-bar']) dom['reload-bar'].style.width = Math.round((1 - st.reloading / w.reload) * 100) + '%'; }
  camera.getWorldDirection(_tmp);
  hud.drawMinimap(camera.position, _tmp, waveManager.enemies, 180);

  if (player.dead) { gameOver(); return; }
}
const DEBUG_NO_LEVEL_CHANGE = false;

function _updatePlayerShield(delta) {
  // Halo-style shield: absorbed in Player.takeDamage (shield first), recharges after a delay.
  if (player.dead) return;
  if (player.regenTimer > 0) return; // regenTimer is reset on damage by Player.takeDamage
  if (player.shield < player.maxShield) {
    if (player.shield <= 0 && !player._shieldWasDown) { player._shieldWasDown = true; }
    player.shield = Math.min(player.maxShield, player.shield + player.shieldRegenRate * delta);
    if (player.shield >= player.maxShield && player._shieldWasDown) { player._shieldWasDown = false; audio.playPickup && audio.playPickup(); }
  }
}

function _updateBossHealthBar() {
  const boss = waveManager.getBoss();
  const el = dom['boss-health']; if (!el) return;
  if (boss) {
    el.style.display = 'block';
    const total = boss.maxHp + boss.maxShield, cur = boss.hp + boss.shield;
    if (dom['boss-bar-fill']) { dom['boss-bar-fill'].style.width = Math.max(0, cur / total * 100) + '%'; dom['boss-bar-fill'].style.background = boss.shield > 0 ? 'linear-gradient(90deg,#4080ff,#a0e0ff)' : 'linear-gradient(90deg,#ff2060,#ff9040)'; }
    if (dom['boss-name']) dom['boss-name'].textContent = boss.data.name + (boss.shield > 0 ? ' — SHIELDED' : '');
  } else el.style.display = 'none';
}

function _updateFires(delta) {
  if (!currentLevelData || !currentLevelData.fires) return;
  const t = performance.now() * 0.001;
  for (const f of currentLevelData.fires) {
    f.light.intensity = f.base * (0.75 + 0.25 * Math.sin(t * 11 + f.phase) * Math.sin(t * 7.3 + f.phase * 2));
    particles.spawnFire(f.pos, delta, 2.2);
    if (Math.random() < delta * 6) particles.createSparks(f.pos, 0xff6020, 1);
  }
}

// ===== DEBUG HOOK (playtest harness) =====
function _installDebugHook() {
  window.__ufo = {
    startRun: async (level = 0) => { selectedStartLevel = level; await startGame(); return { level: currentLevelData && currentLevelData.name }; },
    step: (seconds) => { const dt = 1 / 60; let n = Math.round(seconds / dt); while (n-- > 0) { if (state === GameState.PLAYING && !_perkPending && !_loadingLevel) step(dt); } },
    render: () => { if (state === GameState.PLAYING) composer.render(); },
    counts: () => ({ wave: waveManager && waveManager.wave, alive: waveManager && waveManager.getAliveCount(), hp: player && player.hp, shield: player && player.shield, score: player && player.score, state, enemies: waveManager ? waveManager.enemies.map(e => e.type + (e.ready ? '' : '(loading)') + (e.model && e.model.isMesh ? '[placeholder]' : '')) : [] }),
    spawn: (type, x, z) => waveManager && waveManager._spawnAt(type, new THREE.Vector3(x, 0, z), {}),
    lookAt: (x, y, z) => { camera.lookAt(x, y, z); controls.euler.setFromQuaternion(camera.quaternion, 'YXZ'); },
    teleport: (x, z) => { camera.position.set(x, 1.7, z); },
    setInvulnerable: (on) => { player.takeDamage = on ? () => {} : Player.prototype.takeDamage.bind(player); },
    pickPerk: () => { const c = document.querySelector('.perk-card'); if (c) c.click(); },
    fire: () => fireWeapon(), selectWeapon,
    three: { get scene() { return scene; }, camera, renderer },
    stats: () => ({ _r: renderer.render(scene, camera), calls: renderer.info.render.calls, tris: renderer.info.render.triangles, programs: renderer.info.programs ? renderer.info.programs.length : 0, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures }),
    state: () => state,
    get weapons() { return weapons; }, get waves() { return waveManager; }, get player() { return player; }, get controls() { return controls; },
    get perf() { return perf; }, // per-section frame breakdown; harness can enable it and read stats without the F3 overlay
  };
}

if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', init); else init();
