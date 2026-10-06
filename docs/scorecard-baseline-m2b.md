# Scorecard baseline — M2b plate simulation

10 seeds per preset (`baseline-0`…`baseline-9`), default presets (Earth 164k cells, Mars/Moon 81k cells, 500 Myr). `npm run score -- 10 --md docs/scorecard-baseline-m2b.md`. Earth values are measured on the same grid from ETOPO (`scripts/earth-ref.ts`).

| Metric | Preset | Pass | Warn | Fail | Values (min – median – max) | Band | Earth |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Height distribution | earth | 10 | 0 | 0 | -5,375 – -5,125 – -5,125 | land peak −0.5–1.5 km, ocean peak −6.5 to −2.5 km | +0.1 km and −4.6 km |
| Height distribution | mars | 10 | 0 | 0 | -5,375 – -5,125 – -4,625 | land peak −0.5–1.5 km, ocean peak −6.5 to −2.5 km | +0.1 km and −4.6 km |
| Height distribution | moon | 9 | 1 | 0 | -5,125 – -4,625 – -3,125 | land peak −0.5–1.5 km, ocean peak −6.5 to −2.5 km | +0.1 km and −4.6 km |
| Mean land height | earth | 10 | 0 | 0 | 397 – 527 – 1,017 | 350–1,500 m | 665 m, median 390 (ice-free) |
| Mean land height | mars | 10 | 0 | 0 | 516 – 891 – 1,414 | 350–3,968 m | 665 m, median 390 (ice-free) |
| Mean land height | moon | 10 | 0 | 0 | 1,153 – 1,489 – 1,786 | 350–4,500 m | 665 m, median 390 (ice-free) |
| High ground | earth | 10 | 0 | 0 | 0.09 – 0.16 – 0.26 | 8–45% above 1.0 km, 1.5–20% above 2.0 km | 20% above 1 km, 5.5% above 2 km |
| High ground | mars | 7 | 3 | 0 | 0.05 – 0.13 – 0.25 | 8–45% above 1.6 km, 1.5–20% above 3.3 km | 20% above 1 km, 5.5% above 2 km |
| High ground | moon | 10 | 0 | 0 | 0.17 – 0.31 – 0.44 | 8–45% above 1.7 km, 1.5–20% above 3.5 km | 20% above 1 km, 5.5% above 2 km |
| Landmasses | earth | 10 | 0 | 0 | 0.21 – 0.46 – 0.89 | largest 20–95% of land | Afro-Eurasia 57% |
| Landmasses | mars | 8 | 2 | 0 | 0.29 – 0.54 – 0.98 | largest 20–95% of land | Afro-Eurasia 57% |
| Landmasses | moon | 10 | 0 | 0 | 0.30 – 0.68 – 0.95 | largest 20–95% of land | Afro-Eurasia 57% |
| Land far from the sea | earth | 10 | 0 | 0 | 0.52 – 0.63 – 0.73 | 35–90% | 61–66% |
| Land far from the sea | mars | 10 | 0 | 0 | 0.59 – 0.72 – 0.81 | 35–90% | 61–66% |
| Land far from the sea | moon | 10 | 0 | 0 | 0.63 – 0.67 – 0.75 | 35–90% | 61–66% |
| Land in small pieces | earth | 10 | 0 | 0 | 0.01 – 0.02 – 0.03 | 0–12% | ~3% |
| Land in small pieces | mars | 10 | 0 | 0 | 0.01 – 0.02 – 0.03 | 0–12% | ~3% |
| Land in small pieces | moon | 10 | 0 | 0 | 0.00 – 0.01 – 0.02 | 0–12% | ~3% |
| Median ocean crust age | earth | 8 | 2 | 0 | 28.90 – 32.99 – 38.63 | 30–120 Myr | ~60 Myr |
| Median ocean crust age | mars | 10 | 0 | 0 | 37.25 – 40.00 – 46.63 | 30–120 Myr | ~60 Myr |
| Median ocean crust age | moon | 3 | 7 | 0 | 18.14 – 24.62 – 41.03 | 30–120 Myr | ~60 Myr |
| Oldest ocean crust (1% tail) | earth | 10 | 0 | 0 | 220 – 263 – 284 | 100–350 Myr | ~180 Myr (pocket ~340) |
| Oldest ocean crust (1% tail) | mars | 10 | 0 | 0 | 190 – 236 – 259 | 100–350 Myr | ~180 Myr (pocket ~340) |
| Oldest ocean crust (1% tail) | moon | 10 | 0 | 0 | 156 – 191 – 261 | 100–350 Myr | ~180 Myr (pocket ~340) |
| Highest ground (cell average) | earth | 10 | 0 | 0 | 3,832 – 4,940 – 7,082 | 2.8 km–7.9 km | 5.7–6.0 km (summit 8.8 km) |
| Highest ground (cell average) | mars | 10 | 0 | 0 | 6,840 – 9,358 – 11,714 | 4.5 km–20.8 km | 5.7–6.0 km (summit 8.8 km) |
| Highest ground (cell average) | moon | 10 | 0 | 0 | 6,410 – 9,691 – 10,978 | 4.8 km–23.6 km | 5.7–6.0 km (summit 8.8 km) |
| Deepest trench (cell average) | earth | 10 | 0 | 0 | 8,497 – 9,596 – 9,937 | 6.0 km–11.0 km | 7.7–9.0 km (point 11.0 km) |
| Deepest trench (cell average) | mars | 10 | 0 | 0 | 9,845 – 11,326 – 12,245 | 9.0 km–16.5 km | 7.7–9.0 km (point 11.0 km) |
| Deepest trench (cell average) | moon | 10 | 0 | 0 | 9,686 – 10,468 – 11,207 | 9.0 km–16.5 km | 7.7–9.0 km (point 11.0 km) |
| Plate speeds | earth | 10 | 0 | 0 | 21.60 – 25.80 – 27.87 | mean 10–100 mm/yr | mean ~40, max ~100 mm/yr |
| Plate speeds | mars | 10 | 0 | 0 | 15.53 – 22.01 – 28.13 | mean 10–100 mm/yr | mean ~40, max ~100 mm/yr |
| Plate speeds | moon | 10 | 0 | 0 | 15.91 – 26.27 – 32.02 | mean 10–100 mm/yr | mean ~40, max ~100 mm/yr |
| Plate sizes | earth | 10 | 0 | 0 | 0.16 – 0.26 – 0.44 | largest 8–45%, at least 3 over 2% | largest 20%, 8 over 2% |
| Plate sizes | mars | 8 | 2 | 0 | 0.19 – 0.34 – 0.54 | largest 8–45%, at least 3 over 2% | largest 20%, 8 over 2% |
| Plate sizes | moon | 9 | 1 | 0 | 0.23 – 0.32 – 0.58 | largest 8–45%, at least 3 over 2% | largest 20%, 8 over 2% |
| Mountain belts | earth | 10 | 0 | 0 | 393 – 528 – 1,322 | median over 50 km, widest up to 2,500 km | median ~100–280 km, widest ~2,050 km (Tibet) |
| Mountain belts | mars | 10 | 0 | 0 | 123 – 218 – 376 | median over 50 km, widest up to 2,500 km | median ~100–280 km, widest ~2,050 km (Tibet) |
| Mountain belts | moon | 10 | 0 | 0 | 64.41 – 153 – 205 | median over 50 km, widest up to 2,500 km | median ~100–280 km, widest ~2,050 km (Tibet) |
| Continental shelves | earth | 10 | 0 | 0 | 16.46 – 32.06 – 50.06 | 0–400 km | 61–66 km mean |
| Continental shelves | mars | 10 | 0 | 0 | 1.88 – 14.67 – 22.88 | 0–400 km | 61–66 km mean |
| Continental shelves | moon | 10 | 0 | 0 | 6.15 – 9.02 – 10.84 | 0–400 km | 61–66 km mean |
| Coastline roughness | earth | 10 | 0 | 0 | 1.20 – 1.25 – 1.30 | 1.1–1.4 | ~1.25 |
| Coastline roughness | mars | 10 | 0 | 0 | 1.18 – 1.22 – 1.26 | 1.1–1.4 | ~1.25 |
| Coastline roughness | moon | 10 | 0 | 0 | 1.13 – 1.21 – 1.24 | 1.1–1.4 | ~1.25 |

## Along the history (Earth preset, 164k cells)

Six seeds, means (the build before the last review fixes):

```
Myr   n  land  mean  med  >1k  >2k inter scrap big1  n1%  peak age50 age99 shelf  pl
 500  6  30.2   623   330  15.7   6.2  65.7   2.0  55.2   5.3   5.6  45.8   247  27.5  34.8
1000  6  29.0   666   444  21.7   5.0  60.5   2.6  51.5   6.2   5.0  34.2   271  27.2  36.0
1500  6  28.7   819   549  26.7   8.5  63.2   3.1  61.8   5.5   6.1  34.2   244  23.7  35.3
Earth    29.0   665  390 20.0   5.5  63.0   3.0  45.0  6.0   5.8   55   180    64
```

Three seeds on the final build:

```
seed          Myr  land  mean  med  >1k  >2k inter scrap big1 n1%  peak  age50 age99 shelf pl  flags
baseline-0     500  30%   488  293  13%  3.4  63%   2.3  23%   9   4.5     32   274    29 36  
baseline-0    1000  30%   486  271  14%  3.2  60%   2.9  42%   7   4.8     36   285    25 36  
baseline-0    1500  28%   512  289  14%  3.5  55%   2.3  32%   5   6.6     33   278    38 36  
baseline-1     500  31%   539  324  16%  3.9  67%   1.3  60%   5   4.9     38   268    28 34  
baseline-1    1000  31%   620  404  18%  4.2  65%   1.9  44%   5   5.3     47   267    19 35  
baseline-1    1500  29%   982  628  30% 10.6  67%   3.1  83%   4   5.8     30   252    22 31  
baseline-2     500  30%   418  269  10%  1.6  63%   1.8  34%   6   5.4     30   245    50 35  warn:crust-median
baseline-2    1000  29%  1406  752  40% 21.4  73%   2.4  62%   2   6.2     34   240    19 36  warn:high-ground
baseline-2    1500  29%   896  704  34%  7.8  68%   4.0  28%   6   4.3     33   273    19 33  
MEAN           500  30%   481  295  13%  3.0  64%   1.8  39% 6.7   4.9     33   262    36
MEAN          1000  30%   837  476  24%  9.6  66%   2.4  50% 4.7   5.4     39   264    21
MEAN          1500  29%   797  541  26%  7.3  63%   3.1  48% 5.0   5.6     32   268    27
EARTH              29%   665  390  20%  5.5  63%   3.0  ~45%   6   5.8     ~55  ~180    64
```

`npx tsx scripts/longscore.ts 128 1500 500 baseline-0 …`
