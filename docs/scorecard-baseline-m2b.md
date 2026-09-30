# Scorecard baseline — M2b plate simulation

10 seeds per preset (`baseline-0`…`baseline-9`), default presets (Earth 164k cells, Mars/Moon 81k cells, 500 Myr). `npm run score -- 10 --md docs/scorecard-baseline-m2b.md`.

| Metric | Preset | Pass | Warn | Fail | Values (min – median – max) | Band | Earth |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Height distribution | earth | 10 | 0 | 0 | -5,375 – -5,125 – -4,625 | land peak −0.5–1.5 km, ocean peak −6.5 to −2.5 km | ~+0.1 km and ~−4.5 km |
| Height distribution | mars | 10 | 0 | 0 | -5,375 – -5,125 – -4,875 | land peak −0.5–1.5 km, ocean peak −6.5 to −2.5 km | ~+0.1 km and ~−4.5 km |
| Height distribution | moon | 10 | 0 | 0 | -4,875 – -3,875 – -3,375 | land peak −0.5–1.5 km, ocean peak −6.5 to −2.5 km | ~+0.1 km and ~−4.5 km |
| Mean land height | earth | 10 | 0 | 0 | 397 – 449 – 514 | 200–2,000 m | ~840 m |
| Mean land height | mars | 4 | 6 | 0 | 457 – 518 – 583 | 529–5,291 m | ~840 m |
| Mean land height | moon | 3 | 7 | 0 | 414 – 585 – 733 | 600–6,000 m | ~840 m |
| Landmasses | earth | 10 | 0 | 0 | 0.30 – 0.35 – 0.89 | largest 20–95% of land | Afro-Eurasia 57% |
| Landmasses | mars | 9 | 1 | 0 | 0.29 – 0.55 – 0.98 | largest 20–95% of land | Afro-Eurasia 57% |
| Landmasses | moon | 10 | 0 | 0 | 0.31 – 0.46 – 0.88 | largest 20–95% of land | Afro-Eurasia 57% |
| Median ocean crust age | earth | 8 | 2 | 0 | 28.52 – 35.76 – 37.84 | 30–120 Myr | ~60 Myr |
| Median ocean crust age | mars | 10 | 0 | 0 | 36.29 – 43.65 – 61.38 | 30–120 Myr | ~60 Myr |
| Median ocean crust age | moon | 2 | 8 | 0 | 16.97 – 26.03 – 39.38 | 30–120 Myr | ~60 Myr |
| Oldest ocean crust (1% tail) | earth | 10 | 0 | 0 | 244 – 264 – 283 | 100–350 Myr | ~180 Myr (pocket ~340) |
| Oldest ocean crust (1% tail) | mars | 10 | 0 | 0 | 202 – 241 – 278 | 100–350 Myr | ~180 Myr (pocket ~340) |
| Oldest ocean crust (1% tail) | moon | 10 | 0 | 0 | 149 – 160 – 229 | 100–350 Myr | ~180 Myr (pocket ~340) |
| Highest ground (cell average) | earth | 10 | 0 | 0 | 3,431 – 4,290 – 6,840 | 2.8 km–7.9 km | ~6 km (summit 8.8 km) |
| Highest ground (cell average) | mars | 5 | 5 | 0 | 4,260 – 8,792 – 10,317 | 7.4 km–20.8 km | ~6 km (summit 8.8 km) |
| Highest ground (cell average) | moon | 3 | 7 | 0 | 4,051 – 6,999 – 10,555 | 8.3 km–23.6 km | ~6 km (summit 8.8 km) |
| Deepest trench (cell average) | earth | 10 | 0 | 0 | 8,042 – 8,747 – 9,330 | 6.0 km–11.0 km | ~8.5 km (point 11.0 km) |
| Deepest trench (cell average) | mars | 7 | 3 | 0 | 8,580 – 9,513 – 10,813 | 9.0 km–16.5 km | ~8.5 km (point 11.0 km) |
| Deepest trench (cell average) | moon | 8 | 2 | 0 | 8,530 – 9,418 – 10,818 | 9.0 km–16.5 km | ~8.5 km (point 11.0 km) |
| Plate speeds | earth | 10 | 0 | 0 | 21.67 – 23.96 – 25.02 | mean 10–100 mm/yr | mean ~40, max ~100 mm/yr |
| Plate speeds | mars | 9 | 1 | 0 | 8.67 – 16.84 – 22.14 | mean 10–100 mm/yr | mean ~40, max ~100 mm/yr |
| Plate speeds | moon | 10 | 0 | 0 | 13.27 – 21.81 – 24.20 | mean 10–100 mm/yr | mean ~40, max ~100 mm/yr |
| Plate sizes | earth | 10 | 0 | 0 | 0.11 – 0.17 – 0.24 | largest 8–45%, at least 3 over 2% | largest 20%, 8 over 2% |
| Plate sizes | mars | 10 | 0 | 0 | 0.18 – 0.28 – 0.34 | largest 8–45%, at least 3 over 2% | largest 20%, 8 over 2% |
| Plate sizes | moon | 10 | 0 | 0 | 0.14 – 0.18 – 0.33 | largest 8–45%, at least 3 over 2% | largest 20%, 8 over 2% |
| Mountain belts | earth | 10 | 0 | 0 | 215 – 269 – 315 | 100–1,500 km wide | Andes ~300 km, Tibet ~1,000 km |
| Mountain belts | mars | 10 | 0 | 0 | 55.91 – 127 – 164 | 100–1,500 km wide | Andes ~300 km, Tibet ~1,000 km |
| Mountain belts | moon | 3 | 7 | 0 | 48.30 – 81.58 – 96.85 | 100–1,500 km wide | Andes ~300 km, Tibet ~1,000 km |
| Continental shelves | earth | 10 | 0 | 0 | 15.30 – 25.03 – 35.69 | 0–400 km | ~80 km mean |
| Continental shelves | mars | 10 | 0 | 0 | 6.02 – 12.52 – 18.88 | 0–400 km | ~80 km mean |
| Continental shelves | moon | 10 | 0 | 0 | 3.67 – 9.75 – 12.86 | 0–400 km | ~80 km mean |
| Coastline roughness | earth | 10 | 0 | 0 | 1.15 – 1.20 – 1.24 | 1.1–1.4 | ~1.25 |
| Coastline roughness | mars | 10 | 0 | 0 | 1.15 – 1.19 – 1.22 | 1.1–1.4 | ~1.25 |
| Coastline roughness | moon | 10 | 0 | 0 | 1.17 – 1.21 – 1.28 | 1.1–1.4 | ~1.25 |
