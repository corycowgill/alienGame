# UFO Shooter 2 — Art Bible

**Setting:** Near-future Chicago under alien invasion. Night/dusk, wet streets, neon, fire glow.
**Enemy spirit:** Halo-style Covenant — a hierarchy of alien species with distinct silhouettes, roles, and
tech (energy shields, plasma, purple/blue/magenta alien alloys, glowing seams). Original designs, no
copyrighted names or likenesses.

## Image spec for Trellis 2 (every model prompt ends with this)
Full body, standing A-pose (arms ~30° from sides), facing camera at a slight 3/4 angle, whole body in
frame with margin, plain flat light-gray background, no floor shadow, even soft studio lighting,
no text, no watermark. Solid closed masses — no thin dangling straps, wires, antennae, or wispy
elements (Trellis returns them as splinters). Square 1024x1024.

## Enemy roster (v2)
| Key | Name | Role | Silhouette | Palette |
|---|---|---|---|---|
| gnat | Gnat | cannon fodder, plasma pistol, panics | small squat 1.2m, triangular head + breathing mask, methane tank backpack | orange/gray armor, cyan seams |
| skirmisher | Skirmisher | fast flanker with arm-mounted energy shield, needle carbine | lean 1.8m, digitigrade legs, hooked beak-like head | teal/bronze armor, violet shield |
| warlord | Warlord | shielded commander, plasma rifle, melee when close | tall 2.4m, broad shoulders, split-mandible jaw, ornate armor | deep blue/gold armor, white-blue shield glow |
| juggernaut | Juggernaut | mini-boss tank, fuel-rod cannon, tower shield | 3.5m hunched mass of armor plates, tiny head | dark orange/black plates, green cannon glow |
| wasp | Wasp | flying harasser, plasma bolts | 1m insectoid drone, four stubby wing-pods, single eye | green/black chitin, yellow eye |
| overseer | Overseer (boss) | hovering boss, spawns Gnats, beam attack | 5m floating egg-shaped command pod with mechanical arms | violet hull, magenta core |

## Weapons (first-person viewmodels)
1. **MA-7 Assault Rifle** — human ballistic rifle, matte black, ammo counter screen
2. **Plasma Rifle** — looted alien, curved organic-purple body, blue vents
3. **Energy Sword** — alien, twin curved blades of blue-white plasma
4. **Rocket Launcher** — human, shoulder-fired, twin tube
5. **Plasma Pistol** (Gnat's weapon, shown in enemy hands)

## Environment
Chicago: brick 3-flats, glass towers, the L tracks, wrecked cars, alien drop pods. Reuse the 14
buildings + 11 civilian vehicles + 3 alien vehicles from `ComfyUI/output/alienGamePOC/3dFiles`.

## Textures / decals (2D, from ChatGPT, tileable where noted)
asphalt (tile), sidewalk concrete (tile), brick (tile), plasma scorch decal (alpha), bullet holes
(alpha sheet), alien blood splatter — violet (alpha), cracked glass decal, skybox (equirect night
city glow), HUD icons (weapons, health, shield, grenade), title key art.
