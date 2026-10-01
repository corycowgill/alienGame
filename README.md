# UFO Invasion II

Browser FPS built on Three.js r170. The sequel to [UFO Invasion](https://ufoshooter.onrender.com):
same wave-survival loop in Chicago, but nothing is procedural any more — every enemy, weapon,
building, vehicle, texture and decal is an authored asset produced by an AI art pipeline and
rigged in Blender. Enemies are an original alien hierarchy in the spirit of Halo's Covenant.

## Play

```bash
npm install
npm run serve          # http://127.0.0.1:8080
```

`WASD` move · mouse look · `LMB` fire · `RMB` aim / heavy swing · `1-4` weapons · `Q` grenade ·
`R` reload · `Shift` sprint · `Space` jump · `E` dash · `Tab` field guide. Xbox controller and
touch controls carry over from v1.

## The enemies

| | Role | How it fights |
|---|---|---|
| **Gnat** | cannon fodder | plinks from range, panics when its Warlord dies |
| **Skirmisher** | flanker | strafes fast; arm shield blocks frontal hits — flank it |
| **Warlord** | commander | recharging energy shield, plasma bursts, falls back to recharge, lunges to melee |
| **Juggernaut** | tank | tower shield, lobbed fuel-rod shots with splash |
| **Wasp** | aerial | dives to strafe |
| **Overseer** | boss (every 5th wave) | hovers, spawns Gnats, sweeps plasma; shielded |

Plasma strips shields (2.4x), bullets hurt flesh, rockets solve Juggernauts, the sword lunges.

## Levels

1. **The Loop** — downtown: skyline of towers, the L track along the north edge, neon, barricaded plaza.
2. **River North** — warehouse district in the rain, overturned wrecks, burning cars.
3. **Lakefront** — Navy Pier: half the arena is Lake Michigan (reflective water), fight down the pier
   to the ferris wheel; drops land on the pier head.

Street dressing (barriers, sandbags, hydrants, traffic lights, dumpsters, wrecks, rubble, drop pods,
bus shelters, L track, ferris wheel, yachts, kiosks) is all authored via the same pipeline and placed
by `props:` / `deco:` lists in `js/level.js`. Bullet holes and plasma scorches land on the real
building meshes; alien blood and blast marks on the ground.

## Asset pipeline

```
ChatGPT (concept, A-pose, flat grey)  ->  art/images/*.png
python tools/trellis.py               ->  art/raw_glb/*.glb       (Trellis 2 on Hugging Face)
tools/blender/rig_biped.py            ->  rigged GLB, 7 clips     (headless Blender 5.2)
node tools/optimize-glb.mjs           ->  assets/models/**        (Draco + WebP, ~1 MB each)
node tools/view-anim.mjs / validate-glb.mjs                        (contact sheets)
node tools/playtest.mjs smoke|enemies|probe --gpu                  (headless Chrome harness)
```

`tools/prop_pipeline.py` watches `art/images/props/` and turns any new PNG into an optimized prop GLB.
Textures, decals, HUD icons and portraits come from ChatGPT too: `tools/make_tileable.py` seams them,
`tools/make_decal.py` turns black-background sheets into RGBA decals. The art direction and the
exact prompt spec live in `art/ART_BIBLE.md`.

## Layout

```
index.html            shell, HUD, menus (from v1, re-skinned)
js/main.js            renderer, composer (bloom + SMAA), game loop, glue
js/assets.js          GLB/texture loading, skinned cloning, normalisation
js/enemies.js         roster, AI, shields, projectiles, animation state machine
js/waves.js           squad composition, drop-ins, elites, boss cadence
js/weapons.js         viewmodels, hitscan/projectile/melee, grenades
js/level.js           two Chicago levels assembled from the asset catalogue
js/decals.js          pooled ground decals
js/particles.js, vfx.js, hud.js, controls.js, player.js, audio.js, help.js   (v1 systems, adapted)
assets/models/{enemies,weapons,props}  assets/textures  assets/decals  assets/ui  assets/audio
tools/                pipeline + harness scripts
```
