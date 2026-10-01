# Chicago replacement prompts — the 24 pack-sourced assets

These 24 models never went through Trellis. They were copied verbatim from `art/poc_src`
(a generic sci-fi asset pack) into the game, and they are the only assets in the project that
are off-style rather than low-quality: white sci-fi domes, gothic spires, a pink ice-cream
truck, a hover-racer and a snow groomer, in a game whose art bible asks for near-future
Chicago — brick 3-flats, glass towers, the L tracks, wrecked sedans.

Every prompt below ends with the ART_BIBLE image spec. Generate each at **1024x1024**, drop the
PNG into `art/images/props/<name>.png` using the exact filename in the heading, then run:

```
python tools/trellis.py --batch art/images/props art/raw_glb/props --res 1024 --faces 100000 --tex 2048
node Tools/rebuild-assets.mjs            # in ufoUnityShooter
```

The names must not change: `LevelData.Catalog` keys off these paths, and the heights below are
the real `Prop` heights the level builder scales each model to. A prompt that produces the wrong
proportions will be stretched to fit, so the aspect ratio in the reference matters.

**The balance to hit.** This is the one thing that is easy to get wrong in both directions. The
first pass of these prompts produced beautiful, completely straight Chicago architecture — a
greystone that could have been photographed in 1910 — which is as far off-brief as the white
sci-fi domes it replaced, just in the opposite direction. The setting is **near-future** Chicago
under alien invasion, so every building keeps its historic masonry bones *and* carries a visible
2040s retrofit layer on top. Read it as: the city is real and old, and people have been bolting
technology onto it for twenty years, and last week something started shooting at it.

**Prompt length is the trap.** The retrofit layer below does not survive being appended to a long
architectural description — tested on the greystone: a ~200-word prompt that opened with the
masonry produced a straight period building with the entire tech layer silently dropped, twice.
The image model weights the opening and discards the tail. What works is **short and sci-fi
first**: lead with "Cyberpunk near-future Chicago, year 2045, mid alien invasion", then the
building type in a few words, then the tech, then the damage, and keep the whole thing under
about 120 words. The masonry survives on its own because the building type carries it; the
technology is what needs the prime position.

**Near-future retrofit layer (fold into the prompt, do not append verbatim):**
> Near-future 2040s retrofit over the original masonry: smart-glass window panels in dark
> composite frames, a few glowing cyan or magenta from inside; slim holographic shop and address
> signage; armoured roll-down shutters over the ground-floor openings; a rooftop cluster of comms
> dishes, a small drone landing pad and matte solar skin panels; cable runs clad as solid boxed
> raceways down the facade; thin strips of emergency lighting along the cornice and entry. Light
> invasion damage: two or three boarded or blown-out windows, soot streaks above them, impact
> scoring on the masonry. The building still reads as Chicago brick or limestone first, with the
> technology layered onto it — not as a sci-fi building.

**Shared image spec (append to every prompt):**
> Single object centred, whole object in frame with margin, three-quarter view from slightly
> above, plain flat light-gray background, no floor shadow, even soft studio lighting, no text,
> no watermark, no people. Solid closed masses — no thin dangling wires, cables, aerials or
> wispy elements (the 3D step returns those as splinters), so model every dish, conduit and
> railing as a thick solid form. Photoreal, weathered, night/dusk colour grading with neon and
> fire glow. Square 1024x1024.

---

## Buildings (14)

Chicago vernacular. The invasion is in progress, so light damage is welcome — boarded windows,
soot above openings, a cracked parapet — but keep the mass solid and the silhouette readable.

| file | height | prompt |
|---|---|---|
| `building_residential_010.png` | 9 m | A two-storey Chicago greystone two-flat, rusticated limestone front, bay window, short stone stoop with iron railing, flat roof with a low parapet, brick side wall. |
| `building_residential_013.png` | 11 m | A three-storey Chicago red-brick three-flat, wooden back porch stack on one side, bay windows front, stone lintels, flat roof, small front yard with iron fence. |
| `building_residential_015.png` | 10 m | A Chicago brown-brick courtyard apartment wing, three storeys, symmetrical windows, limestone entry surround, flat roof, fire escape flat against the brick. |
| `building_residential_018.png` | 22 m | A seven-storey 1920s Chicago brick apartment block, terracotta cornice, regular punched windows, ground-floor storefront bays, flat roof with water tank. |
| `building_residential_022.png` | 16 m | A five-storey Chicago mixed-use brick building, retail at street level with awnings, apartments above, corner entrance chamfered, flat roof, painted ghost sign on the side wall. |
| `building_commercial_006.png` | 8 m | A single-storey Chicago corner tavern and storefront row, dark brick, large plate-glass windows, neon sign bracket, flat roof with parapet, roll-down shutter on one bay. |
| `building_industrial_019.png` | 9 m | A low Chicago brick warehouse, loading dock with roll-up steel doors, clerestory windows, flat roof with roof vents, concrete apron. |
| `building_industrial_020.png` | 18 m | A Chicago industrial loft building, six storeys, heavy timber-and-brick construction, tall multi-pane factory windows, freight elevator bulkhead on the roof, water tower on steel legs. |
| `building_skyscraper_016.png` | 46 m | A Chicago mid-century office tower, dark bronze steel frame with uninterrupted glass curtain wall, flat top, plain granite base, Mies van der Rohe idiom. |
| `building_skyscraper_020.png` | 52 m | A Chicago art-deco setback skyscraper, limestone facade stepping back twice toward a slender crown, vertical piers, ornamental spandrels. |
| `building_skyscraper_030.png` | 40 m | A Chicago glass office tower with a gently curved reflective facade, horizontal floor banding, dark mullions, squared-off top with mechanical screen. |
| `building_skyscraper_044.png` | 34 m | A Chicago terracotta-clad commercial tower, early twentieth century, ornate cornice, arched top-floor windows, regular grid of punched openings. |
| `building_skyscraper_046.png` | 58 m | A tall slender Chicago tower with tapering tube-frame structure, cross-bracing visible on the facade, dark glass, flat top with twin antenna stubs kept short and thick. |
| `building_skyscraper_048.png` | 44 m | A Chicago postmodern granite tower, pink-grey stone, punched square windows, stepped crown with a barrel-vaulted top, setback terraces. |

## Civilian vehicles (8)

The catalogue names already say what each one is meant to be — these prompts simply make the
model match the name. Keep them street-legal and American; wrecks and abandonment read as
invasion better than pristine showroom bodies.

| file | catalogue key | height | prompt |
|---|---|---|---|
| `vehicle_civilian_001.png` | `car_001` | 1.4 m | A mid-size American sedan, dull silver, abandoned mid-street, doors shut, slightly dusty, a dent in one rear quarter panel. |
| `vehicle_civilian_003.png` | `car_003` | 1.9 m | A full-size American SUV, dark blue, roof rack, mud on the lower panels, one headlight cracked. |
| `vehicle_civilian_009.png` | `van_009` | 2.3 m | A white American panel delivery van, sliding side door, roof vent, no livery, rust at the wheel arches. |
| `vehicle_civilian_012.png` | `truck_012` | 3.0 m | A box truck with a roll-up rear door and a flat aluminium body, cab-over design, dirty white paint, no logo. |
| `vehicle_civilian_013.png` | `excavator_013` | 3.2 m | A compact tracked excavator, yellow, boom folded down, scratched paint, mud on the tracks. |
| `vehicle_civilian_014.png` | `limo_014` | 1.5 m | A black stretch limousine, long wheelbase, blacked-out rear windows, chrome trim, one flat tyre. |
| `vehicle_civilian_019.png` | `mixer_019` | 3.6 m | A concrete mixer truck, rotating drum, grey and orange, concrete crust on the chute, heavy axles. |
| `vehicle_civilian_021.png` | `hover_021` | 1.6 m | A near-future police interceptor sedan, Chicago police livery — white with blue and black checkerboard band — low-profile light bar, reinforced push bumper. Wheeled, not hovering. |

## Alien vehicles (2)

These two are Covenant-idiom alien craft and should match the enemy palette in the art bible:
violet and bronze alloys, glowing seams, organic curves.

| file | catalogue key | height | prompt |
|---|---|---|---|
| `vehicle_alien_003.png` | `dropship` | 9 m | An alien troop dropship, organic curved violet-bronze hull, two downward-angled engine pods, a troop bay opening along the underside, glowing cyan seams. Solid closed masses, no thin struts. |
| `vehicle_alien_019.png` | `tripod` | 14 m | An alien walker, bulbous armoured command pod on three thick tapering legs, violet alloy plating with bronze trim, single magenta optical lens, glowing seams at the joints. Legs thick and solid, never spindly. |

---

## Notes

- `vehicle_civilian_021` is catalogued as `hover_021`, and the current pack model is a hover
  racer. The prompt above makes it a wheeled police interceptor instead, because the level
  places it on the street next to `police_car` and a hovering racer reads as a different game.
  Keep the hover idiom instead if that was deliberate — just say so and I will swap the prompt.
- `building_skyscraper_046` is the tallest at 58 m and the most visible on the skyline; it is
  worth generating two or three seeds and picking the best.
- The spec forbids thin elements because Trellis returns them as splinters. Antennae, fire
  escapes and railings should be modelled as thick solid masses or left to the texture.
