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
```

Desktop browser with WebGL2 required.

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
    tectonics/snapshot.ts   M1 plates (replaced by the drift sim in M2)
    terrain/elevation.ts    height pass
    generate.ts             pipeline
    engine.ts, worldgen.worker.ts, client.ts, protocol.ts
  render/    three.js view, texture baking, colour maps, arrows
  ui/        control panel, styles
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
| M2 | Drift simulation: plates move in 2 Myr steps, collide, rift, subduct; crust age and orogeny history recorded |
| M3 | Monthly climate (insolation, circulation cells, currents, rain shadows) and exact Köppen zones |
| M4 | Rivers (priority-flood, major basins only), real satellite colours, presets polish |

## Sources

- Artifexian, *The WorldSmith 8.00* — ocean depth table, mountain profiles, peak height vs gravity
- Cortial et al., *Procedural Tectonic Planets* (2019) — the M2 drift model
- Worldbuilding Pasta, *An Apple Pie from Scratch* — tectonics and climate rules
- Andy Gainey, *Procedural Planet Generation* — hex sphere and plate boundaries
- Red Blob Games — sphere map generation, mapgen4
