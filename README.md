# God Game — World Gen

A procedural planet generator that runs in the browser: plate tectonics, a
height map, and (soon) climate and rivers on a hex-tiled sphere, shown as a
3D globe or a flat map. It's the world layer for a god game to come.

![Globe, satellite preview](docs/img/earth-satellite-globe.png)

| Elevation | Ocean crust age |
| --- | --- |
| ![](docs/img/earth-elevation-map.png) | ![](docs/img/earth-age-map.png) |

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # unit tests
npm run bench        # timing for every preset × resolution
npm run build        # static site in dist/
npm run build:single # everything in one HTML file (dist-single/index.html)
npm run engine       # rebuild the Rust tectonics engine → src/engine/tecto-wasm.ts
npm run score -- 4 --freq 64   # scorecard over several seeds per preset
```

Desktop browser with WebGL2 required. The compiled engine is committed
(base64 in `src/engine/tecto-wasm.ts`), so Rust is only needed to change it:
`rustup target add wasm32-unknown-unknown`, then `npm run engine`.

## What's in M2b — the plate simulation

The world is now made by running the plates through their history
(default 500 Myr) in a Rust engine compiled to WebAssembly (`engine/`):

- **Rigid plates in their own frames.** Each plate stores its crust
  (thickness, age, type, orogeny history) on the hex grid in its own
  rotating frame; moving a plate is only a rotation, so coastlines and
  mountain belts are carried exactly, never re-interpolated.
- **Subduction and collision.** Where plates overlap, ocean goes under
  anything (the older slab sinks). When two continents meet, their thin
  stretched margins are dragged down with little resistance; full-thickness
  crust jams the trench. The crust that goes under is shortened into the
  upper plate over hundreds of km behind the suture (volume conserved) —
  a belt that widens into a plateau once it reaches ~70 km thickness. The
  two plates weld into one when the collision dies down, not at a set
  amount of shortening.
- **Sea-floor spreading.** Gaps between diverging plates fill with new
  ocean crust at the real opening rate, so crust ages form ridge-parallel
  stripes and ocean depth follows age.
- **Mountain building.** Every sinking slab feeds a narrow volcanic arc.
  A broad cordillera (40–400 km behind the trench) grows only where the
  upper plate advances on the trench, by about a third of that advance,
  and unevenly along the margin; the crust it takes comes off the plate's
  leading edge, which retreats (a plate that shortens gets narrower).
  Island arcs grow into new continental
  crust, the forearc is scraped away, new sea floor thins the continent
  beside it, hot spots build island chains, plume-head plateaus and — under
  continents — broad domes like East Africa's.
- **Isostasy, flow and erosion.** Elevation floats on crust thickness
  (Airy, 0.1515 km per km of crust; water-loaded ×1.45 below sea level;
  ocean depth from age by GDH1). Crust over 62 km flows under its own
  weight (plateaus flatten at 4–5 km; the limit scales with 1/g, like the
  other strength limits). Relief-driven erosion (Ahnert; local relief is a
  few % of the height on plains, up to a third in mountains) moves rock
  downhill and fills land pits only to their spill point; a dead range
  decays over ~135 Myr like the Appalachians, and plains are slowly
  planed toward sea level.
- **Sediment.** Rivers carry it down one channel; under water it fans out,
  mostly along the margin, and waves sweep whatever lies above wave base
  sideways — so deltas feed shelves instead of single lobes running out
  to the abyss. Old sea floor buried under ~13 km of sediment becomes the
  floor of a continental basin. Of the sediment that rides a plate down a
  trench, about half comes back (accretionary wedge and arc magma); the
  rest is lost to the mantle.
- **Plate motions from forces.** Slab pull, gravitational sliding (ridge
  push), collision resistance (against closing motion only) and drag from
  a slowly changing mantle flow, balanced against basal drag and scaled to
  the mantle's vigour.
- **Plate reorganisation.** Big continents rift (small ones rarely), and
  the upwelling that broke them keeps carrying the halves apart for ~80 Myr
  so the rift becomes an ocean instead of stalling as a narrow sea. Old
  ocean breaks away at passive margins (floor > 180 Myr) and founders
  against the continent it left or against younger floor; new plates are
  protected from the plate-count budget, slivers are absorbed.
- **Sea level** comes from the volume of water, which relaxes (~60 Myr)
  toward the level the planet started with — the surface of ~33.5 km-thick
  crust — give or take 200 m to keep the Land slider's share dry. Land
  area is therefore emergent, with the feedback real continents have:
  crust that thickens stands higher and erodes faster, crust that thins
  floods and is spared. Together with the sediment budget this keeps the
  continents' volume, the land share and the mountains level over
  billions of years.
- **Exact bookkeeping.** Every crust column is updated exactly once per
  step; the result does not depend on how the run is chunked or how often
  it is looked at (tested), and is bit-identical across machines.
- **Texture is not simulation.** The world stores cell averages; the
  sub-cell texture (ridges, abyssal hills) is added per pixel when maps
  are painted, scaled so it never moves a coastline.

Some assumptions that matter (each one, when wrong, broke the continents):

- **Continents start inside plates.** Plate boundaries begin at sea, as on
  Earth; a boundary through a continent rifts or crumples it at once.
- **Continents are plains plus drowned margins.** The outer band thins
  seaward like a stretched passive margin; plains stand ~0.5 km above the sea.
- **Sea level is tied to the crust, not to a land quota.** Forcing a fixed
  land share made continental growth flood the plains, and — once crust
  was being lost — drained the sea off the ocean floor to keep the quota.
- **Passive margins rarely turn active**: only very old floor breaks away;
  old ocean also founders against younger ocean (Izu–Bonin style).
- **Only very thick crust (>62 km) flows**; normal crust keeps its ranges.
- **Starting state** (from the M1 sketch): continental crust = land + 0.1
  of the surface; plains ~0.4 km above the sea (Earth's median land height
  is 390 m), the outer band a shelf at wave base and then the slope down
  to ~21 km-thick crust; sea-floor ages from distance to the start plates' own ridges,
  scaled ×0.55 toward the steady state (median ~50 Myr) with a sediment
  blanket of up to 1.5 km.

- **Plates stay whole.** A plate whose crust comes apart becomes separate
  plates; rift cuts are cleaned so both halves are single pieces. The plate
  budget is 3× the Plates slider (Earth: ~15 major/minor plus dozens of
  micro-plates) so new subduction zones live long enough to work.
- **Cordilleras need an advancing upper plate.** Every sinking slab feeds
  a narrow volcanic arc; the broad range (shortening) grows only where the
  upper plate moves toward the trench (Andes vs. Cascades/Japan). This is
  what removed the ranges that used to rim every coast.

- **Mountains need moving continents.** With weak mantle flow under the
  plates continents barely moved, rarely collided and rarely advanced on
  their trenches: the world wore flat. Rifts must not outrun collisions
  either, or the land ends up in ever more, ever smaller pieces.

The scorecard's Earth values are measured, not quoted: real elevation
(ETOPO 20′) is averaged onto the same hex grid and run through the same
code (`scripts/earth-ref.ts`; a test checks that Earth passes every
height and shape check). The harness for "does the world hold up over
time" is `scripts/longscore.ts` (one run per seed, scored every 500 Myr).

- **Every source of crust needs its sink.** Cordillera shortening that
  added crust for free thickened the continents ~15 % per billion years;
  removing it without returning any subducted sediment let erosion bleed
  them away. The budget now closes: erosion → sea → trench → wedge and arc.

Known limits: small pockets of sea floor trapped inside continents can
survive the whole run (the oldest ~0.5 % of the ocean; Earth's eastern
Mediterranean is such a pocket); cell-scale heights (~50 km at the default
grid) cap high ground near 5–6 km, like Earth's highest 50 km averages;
shelves are about half as wide as Earth's; the valleys and ridges inside
a cell are texture, not yet eroded terrain (that is M2c).

It takes about 1.5–3 minutes for the default 164k-cell Earth. The M1 snapshot
engine stays available as a quick sketch.

## What's in M1

- **Hex-sphere grid** — Goldberg polyhedron (dual of a subdivided
  icosahedron), 10k → 655k cells. 12 pentagons, the rest hexagons.
- **Snapshot tectonics** — plates grown by weighted flood fill, each rotating
  about its own Euler pole; boundaries classified convergent / divergent /
  transform from the relative motion across them. Continents are placed
  independently of plates, so plates carry both kinds of crust.
- **Height pass** — ocean depth from crust age (WorldSmith table),
  WorldSmith-style mountain cross-sections by landform type (Andean
  cordillera, collision plateau + foreland, island arc, trench, rift, old
  ranges), relief scaled by 1/g (capped ×3), sea level solved so land covers
  the target fraction.
- **Views** — globe (displacement + bump lighting + atmosphere) and a
  wrap-around flat map, both from one 4096×2048 texture. Map modes:
  satellite (preview), plates, elevation, crust age. Plate-motion arrows,
  hex-cell toggle, relief slider, hover info, PNG export, shareable links.
- **Presets** — Earth, Mars-size, Moon-size and custom. All parameters are in
  real units (km, Myr, m, mm/yr), so every preset runs the same code.

## Layout

```
src/
  core/      rng, noise, presets, heap, half floats
  grid/      hex grid, point→cell locator, texture sampler, distance fields
  sim/
    tectonics/snapshot.ts   M1 plates (quick sketch; starting state for the drift sim)
    tectonics/drift.ts      runs the Rust engine and finishes the height map
    terrain/elevation.ts    height pass
    generate.ts             pipeline
    engine.ts, worldgen.worker.ts, client.ts, protocol.ts
  render/    three.js view, texture baking, colour maps, arrows
  ui/        control panel, styles
  engine/    wasm bridge + embedded engine binary
engine/      Rust plate-tectonics engine (grid, plates, sim, C ABI)
tests/       vitest
scripts/     bench, headless screenshots
```

Generation runs in a Web Worker. The worker keeps the world and a
precomputed texel → triangle map, so switching map modes only re-bakes the
texture (~100 ms). If workers are blocked it falls back to the main thread.

## Roadmap

| Milestone | Scope |
| --- | --- |
| **M1 ✓** | Grid, snapshot plates, height pass, globe + map, panel |
| **M2a ✓** | Planet scorecard: plausibility bands (Earth as reference, not target) |
| **M2b ✓** | Rust plate simulation: forces, subduction, collision, rifting, hot spots, isostasy, erosion |
| M2c | Stream-power erosion (Fastscape-style) for valley-scale relief; faster high-res runs |
| M3 | Monthly climate (insolation, circulation cells, currents, rain shadows) and exact Köppen zones |
| M4 | Rivers (priority-flood, major basins only), real satellite colours, presets polish |

## Sources

- Artifexian, *The WorldSmith 8.00* — ocean depth table, mountain profiles, peak height vs gravity
- Cortial et al., *Procedural Tectonic Planets* (2019) — the M2 drift model
- Viitanen, *Physically Based Terrain Generation* (PlaTec, 2012) — plate-frame crust, collision/merge rules
- Forsyth & Uyeda (1975), Conrad & Lithgow-Bertelloni (2002) — plate driving forces
- Reymer & Schubert (1984) — arc crust growth rates; Ahnert (1970) — denudation vs relief
- Worldbuilding Pasta, *An Apple Pie from Scratch* — tectonics and climate rules
- Andy Gainey, *Procedural Planet Generation* — hex sphere and plate boundaries
- Red Blob Games — sphere map generation, mapgen4
