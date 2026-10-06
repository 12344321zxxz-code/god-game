# Scorecard baseline — M2b plate simulation

10 seeds per preset (`baseline-0`…`baseline-9`), default presets (Earth 164k cells, Mars/Moon 81k cells, 500 Myr). `npm run score -- 10 --md docs/scorecard-baseline-m2b.md`. Earth values are measured on the same grid from ETOPO (`scripts/earth-ref.ts`).

| Metric | Preset | Pass | Warn | Fail | Values (min – median – max) | Band | Earth |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Height distribution | earth | 10 | 0 | 0 | -5,625 – -5,375 – -4,625 | land peak −0.5–1.5 km, ocean peak −6.5 to −2.5 km | +0.1 km and −4.6 km |
| Height distribution | mars | 10 | 0 | 0 | -5,625 – -5,125 – -4,375 | land peak −0.5–1.5 km, ocean peak −6.5 to −2.5 km | +0.1 km and −4.6 km |
| Height distribution | moon | 9 | 1 | 0 | -5,125 – -4,625 – -2,875 | land peak −0.5–1.5 km, ocean peak −6.5 to −2.5 km | +0.1 km and −4.6 km |
| Mean land height | earth | 10 | 0 | 0 | 549 – 676 – 747 | 350–1,500 m | 665 m, median 390 (ice-free) |
| Mean land height | mars | 7 | 3 | 0 | 797 – 1,045 – 1,896 | 926–3,968 m | 665 m, median 390 (ice-free) |
| Mean land height | moon | 10 | 0 | 0 | 1,389 – 1,920 – 2,456 | 1050–4,500 m | 665 m, median 390 (ice-free) |
| High ground | earth | 10 | 0 | 0 | 0.10 – 0.18 – 0.23 | 8–45% above 1.0 km, 1.5–20% above 2.0 km | 20% above 1 km, 5.5% above 2 km |
| High ground | mars | 3 | 7 | 0 | 0.03 – 0.07 – 0.23 | 8–45% above 2.6 km, 1.5–20% above 5.3 km | 20% above 1 km, 5.5% above 2 km |
| High ground | moon | 2 | 8 | 0 | 0.12 – 0.19 – 0.32 | 8–45% above 3.0 km, 1.5–20% above 6.0 km | 20% above 1 km, 5.5% above 2 km |
| Landmasses | earth | 10 | 0 | 0 | 0.26 – 0.52 – 0.78 | largest 20–95% of land | Afro-Eurasia 57% |
| Landmasses | mars | 9 | 1 | 0 | 0.37 – 0.62 – 0.96 | largest 20–95% of land | Afro-Eurasia 57% |
| Landmasses | moon | 8 | 2 | 0 | 0.30 – 0.75 – 0.98 | largest 20–95% of land | Afro-Eurasia 57% |
| Land far from the sea | earth | 10 | 0 | 0 | 0.62 – 0.66 – 0.69 | 35–90% | 61–66% |
| Land far from the sea | mars | 10 | 0 | 0 | 0.64 – 0.70 – 0.77 | 35–90% | 61–66% |
| Land far from the sea | moon | 10 | 0 | 0 | 0.70 – 0.75 – 0.78 | 35–90% | 61–66% |
| Land in small pieces | earth | 10 | 0 | 0 | 0.02 – 0.02 – 0.03 | 0–12% | ~3% |
| Land in small pieces | mars | 10 | 0 | 0 | 0.01 – 0.01 – 0.03 | 0–12% | ~3% |
| Land in small pieces | moon | 10 | 0 | 0 | 0.00 – 0.01 – 0.01 | 0–12% | ~3% |
| Median ocean crust age | earth | 10 | 0 | 0 | 30.02 – 35.26 – 45.69 | 30–120 Myr | ~60 Myr |
| Median ocean crust age | mars | 9 | 1 | 0 | 27.91 – 37.54 – 48.31 | 30–120 Myr | ~60 Myr |
| Median ocean crust age | moon | 4 | 6 | 0 | 19.69 – 25.12 – 38.04 | 30–120 Myr | ~60 Myr |
| Oldest ocean crust (1% tail) | earth | 10 | 0 | 0 | 226 – 242 – 285 | 100–350 Myr | ~180 Myr (pocket ~340) |
| Oldest ocean crust (1% tail) | mars | 10 | 0 | 0 | 157 – 210 – 241 | 100–350 Myr | ~180 Myr (pocket ~340) |
| Oldest ocean crust (1% tail) | moon | 10 | 0 | 0 | 133 – 151 – 165 | 100–350 Myr | ~180 Myr (pocket ~340) |
| Highest ground (cell average) | earth | 10 | 0 | 0 | 3,889 – 4,715 – 5,689 | 2.8 km–7.9 km | 5.7–6.0 km (summit 8.8 km) |
| Highest ground (cell average) | mars | 0 | 10 | 0 | 4,470 – 5,360 – 6,756 | 7.4 km–20.8 km | 5.7–6.0 km (summit 8.8 km) |
| Highest ground (cell average) | moon | 0 | 10 | 0 | 5,718 – 6,546 – 7,320 | 8.3 km–23.6 km | 5.7–6.0 km (summit 8.8 km) |
| Deepest trench (cell average) | earth | 10 | 0 | 0 | 8,100 – 8,624 – 9,160 | 6.0 km–11.0 km | 7.7–9.0 km (point 11.0 km) |
| Deepest trench (cell average) | mars | 10 | 0 | 0 | 9,127 – 9,851 – 11,249 | 9.0 km–16.5 km | 7.7–9.0 km (point 11.0 km) |
| Deepest trench (cell average) | moon | 8 | 2 | 0 | 8,571 – 9,181 – 10,541 | 9.0 km–16.5 km | 7.7–9.0 km (point 11.0 km) |
| Plate speeds | earth | 10 | 0 | 0 | 21.23 – 26.60 – 28.48 | mean 10–100 mm/yr | mean ~40, max ~100 mm/yr |
| Plate speeds | mars | 10 | 0 | 0 | 12.58 – 22.36 – 24.83 | mean 10–100 mm/yr | mean ~40, max ~100 mm/yr |
| Plate speeds | moon | 10 | 0 | 0 | 17.37 – 22.87 – 28.26 | mean 10–100 mm/yr | mean ~40, max ~100 mm/yr |
| Plate sizes | earth | 10 | 0 | 0 | 0.17 – 0.24 – 0.37 | largest 8–45%, at least 3 over 2% | largest 20%, 8 over 2% |
| Plate sizes | mars | 9 | 1 | 0 | 0.20 – 0.27 – 0.47 | largest 8–45%, at least 3 over 2% | largest 20%, 8 over 2% |
| Plate sizes | moon | 9 | 1 | 0 | 0.21 – 0.34 – 0.62 | largest 8–45%, at least 3 over 2% | largest 20%, 8 over 2% |
| Mountain belts | earth | 10 | 0 | 0 | 462 – 735 – 904 | median over 50 km, widest up to 2,500 km | median ~100–280 km, widest ~2,050 km (Tibet) |
| Mountain belts | mars | 10 | 0 | 0 | 191 – 411 – 584 | median over 50 km, widest up to 2,500 km | median ~100–280 km, widest ~2,050 km (Tibet) |
| Mountain belts | moon | 10 | 0 | 0 | 221 – 243 – 640 | median over 50 km, widest up to 2,500 km | median ~100–280 km, widest ~2,050 km (Tibet) |
| Continental shelves | earth | 10 | 0 | 0 | 10.02 – 23.10 – 35.57 | 0–400 km | 61–66 km mean |
| Continental shelves | mars | 10 | 0 | 0 | 2.18 – 6.19 – 14.30 | 0–400 km | 61–66 km mean |
| Continental shelves | moon | 10 | 0 | 0 | 1.71 – 3.28 – 7.89 | 0–400 km | 61–66 km mean |
| Coastline roughness | earth | 10 | 0 | 0 | 1.17 – 1.20 – 1.23 | 1.1–1.4 | ~1.25 |
| Coastline roughness | mars | 10 | 0 | 0 | 1.13 – 1.17 – 1.20 | 1.1–1.4 | ~1.25 |
| Coastline roughness | moon | 10 | 0 | 0 | 1.14 – 1.17 – 1.24 | 1.1–1.4 | ~1.25 |

## Along the history (Earth preset, 164k cells, 6 seeds, means)

```
Myr   n  land  mean  med  >1k  >2k inter scrap big1  n1%  peak age50 age99  pl
 500  6  31.2   678   495  18.8   5.2  65.3   2.3  40.2   5.8   4.8  36.3   240  35.2
1000  6  31.7   753   503  23.8   7.2  61.8   3.1  65.8   4.5   5.3  39.7   262  35.8
1500  6  30.7   852   579  29.2   9.6  60.3   2.9  49.8   5.7   5.2  38.2   247  34.7
Earth    29.0   665  390 20.0   5.5  63.0   3.0  45.0  6.0   5.8   55   180
flags: 
```

`npx tsx scripts/longscore.ts 128 1500 500 baseline-0 … baseline-5`
