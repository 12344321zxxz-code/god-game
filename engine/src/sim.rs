//! The plate-tectonics simulation.
//!
//! State lives in two places:
//! * **Plates** carry crust (thickness, age, type, orogeny history) in their
//!   own rotating frames — see `plate.rs`.
//! * **World fields** live in the mantle frame on the fixed grid: the
//!   resolved "who is on top here" view, plus things that stay put while
//!   plates slide over them (slabs, trenches, hot spots).
//!
//! One step (`dt` Myr, sized so the fastest plate moves ~1.5 cells):
//!  1. rotate plates
//!  2. coverage — for every world cell, which plates have crust there
//!  3. resolve overlaps — ocean subducts under anything, the older ocean goes
//!     down, continent never subducts; continent–continent collisions stack
//!     crust onto the upper plate (crust is conserved)
//!  4. fill gaps with new ocean crust (sea-floor spreading)
//!  5. world processes → thickness changes: arc/cordillera thickening above
//!     slabs, rift thinning, hot spots, gravitational crustal flow,
//!     erosion + sediment routing
//!  6. write the changes back into the plates
//!  7. forces → new plate motions (slab pull, gravitational sliding /
//!     ridge push, collision resistance, basal drag)
//!  8. events: continental rifting, subduction initiation at old passive
//!     margins, suturing (plate merges), cleanup of slivers
//!
//! Elevation is isostatic: continents float on their thickness, ocean floor
//! sinks with age (Parsons & Sclater via the WorldSmith table).

use crate::grid::Grid;
use crate::math::*;
use crate::params::Params;
use crate::plate::{EMPTY, Plate};
use crate::rng::{Noise, Rng};
use std::cmp::Reverse;
use std::collections::{BTreeMap, BinaryHeap};

const NONE: u32 = u32::MAX;
const TAU: f64 = 4.0 * std::f64::consts::PI;

/// Orogeny codes (must match `Orogeny` in src/sim/world.ts).
pub mod oro {
    pub const NONE: u8 = 0;
    pub const ANDEAN: u8 = 1;
    pub const HIMALAYAN: u8 = 2;
    pub const FORELAND: u8 = 3;
    pub const ARC: u8 = 4;
    pub const TRENCH: u8 = 5;
    pub const RIFT: u8 = 6;
    pub const ANCIENT: u8 = 7;
    pub const HOTSPOT: u8 = 8;
}

// ---- crust constants (km) ----
pub const OCEAN_THICK: f32 = 7.0;
/// Continental crust stretched thinner than this becomes ocean floor.
const CONT_MIN: f32 = 12.0;
/// Arc / plateau crust thicker than this is buoyant and joins the continents.
const ARC_TO_CONT: f32 = 26.0;
/// Thermal age given to continental crust stretched into sea floor: the
/// lithosphere under a rifted margin is old and cold, so it sits deep
/// (setting 0, i.e. ridge-hot, made it pop up ~3 km on conversion).
const RIFTED_OCEAN_AGE: f32 = 80.0;
/// Thickest crust the lithosphere can hold up at 1 g (km); weaker gravity
/// supports more (∝ √(g⊕/g), so Mars-size worlds reach ~130 km).
const MAX_THICK_EARTH: f32 = 95.0;

// ---- force constants (relative; overall speed is normalised) ----
const K_SLAB: f64 = 1.0;
const K_GPE: f64 = 0.012;
const K_COLL: f64 = 3.0;
/// Basal drag weight of continental lithosphere relative to oceanic (deep keels).
const DRAG_CONT: f64 = 2.0;
/// Timescale (Myr) on which the ocean volume relaxes toward the land target.
const WATER_RELAX_MYR: f64 = 150.0;
/// Sea floor older than this (Myr) starts to founder at plate edges.
const INIT_CHECK_MYR: f64 = 10.0;
/// After a breakaway neither plate starts another for this long (Myr).
const INIT_QUIET_MYR: f64 = 40.0;
/// Oceanic crust plus sediment thicker than this (km) counts as
/// continental basin crust.
const BASIN_TO_CONT: f32 = 20.0;
/// Crust thicker than this flows at depth and spreads sideways: what
/// flattens Tibet and the Altiplano into plateaus (60–70 km thick, 4–5 km
/// high) instead of letting them grow higher.
const FLOW_ONSET_KM: f32 = 62.0;
/// Plume swell under continents relative to oceans. Continental domes are
/// as high as oceanic swells or higher (Ethiopia/East Africa, Hoggar,
/// Tibesti: 1–2 km over ~1000 km; Hawaii: ~1.2 km).
const CONT_SWELL: f64 = 1.0;
/// Local relief (what Ahnert's erosion law uses) is at most this share of
/// a range's height: valleys are cut into the range, not down to sea
/// level (about a third of the height in mountains, far less on
/// plateaus). With isostasy a dead range then decays with an e-folding
/// time of ~150 Myr — the Appalachians and Urals, ~300 Myr old, still
/// stand near 1 km.
const RELIEF_SHARE: f64 = 0.25;
/// Collision shortening: e-folding width behind the suture, how far it can
/// reach, and the crust thickness the belt holds before growing outward
/// (Tibet: ~70 km; scaled with relief like the other limits).
const COLL_WIDTH_KM: f64 = 300.0;
const COLL_REACH_KM: f32 = 1200.0;
const COLL_THICK_BASE: f64 = 35.0;
const COLL_THICK_EARTH: f64 = 70.0;
const FOUNDER_AGE: f32 = 150.0;
/// Clock (Myr) of the slow surface processes (uplift, flow, erosion, hot spots).
const PROC_DT: f64 = 1.0;
/// Relative speed (mm/yr) below which a boundary neither consumes nor makes crust.
const MIN_RATE: f64 = 3.0;
/// Hard cap on any plate's speed, mm/yr.
const MAX_SPEED: f64 = 160.0;

const DEPTH_LUT_N: usize = 1024;
/// √age step of the depth lookup table (covers 0–625 Myr).
const DEPTH_LUT_STEP: f64 = 25.0 / DEPTH_LUT_N as f64;
static DEPTH_LUT: std::sync::OnceLock<Vec<f32>> = std::sync::OnceLock::new();

/// Fast table version of `ocean_depth` (m).
#[inline]
pub fn ocean_depth_fast(t: f32) -> f32 {
    let lut = DEPTH_LUT.get_or_init(|| (0..=DEPTH_LUT_N + 1).map(|i| ocean_depth((i as f64 * DEPTH_LUT_STEP).powi(2)) as f32).collect());
    let x = t.max(0.0).sqrt() / DEPTH_LUT_STEP as f32;
    let i = (x as usize).min(DEPTH_LUT_N);
    let f = (x - i as f32).min(1.0);
    lut[i] + (lut[i + 1] - lut[i]) * f
}

/// Ocean depth (positive m) for sea-floor age in Myr: GDH1 (Stein & Stein
/// 1992), the standard fit to observed depths. Unlike the older Parsons &
/// Sclater curve it flattens at ~5.65 km, so old basins are not overdeep.
pub fn ocean_depth(t: f64) -> f64 {
    let t = t.max(0.0);
    if t < 20.0 { 2600.0 + 365.0 * t.sqrt() } else { 5651.0 - 2473.0 * (-0.0278 * t).exp() }
}

/// Isostatic surface height (km, relative to a fixed datum) of a crust column.
#[inline]
pub fn crust_elev(thick: f32, age: f32, cont: u8, sea: f64) -> f64 {
    if cont != 0 {
        // Airy slope (1 − ρc/ρm) ≈ 0.1515, offset calibrated on Earth
        // (cratons ~38 km at ~+0.7 km, Tibet ~70 km at ~5.6 km). Below water the
        // column sinks further (water load): ×ρm/(ρm − ρw) ≈ 1.45.
        // The load is taken relative to the current sea level `sea`, so the
        // curve is continuous across the shoreline whatever the sea level.
        let e = 0.1515 * thick as f64 - 5.3;
        if e < sea { sea + (e - sea) * 1.45 } else { e }
    } else {
        // Extra (e.g. sedimented or plateau) oceanic crust, water loaded:
        // (ρm − ρoc)/(ρm − ρw) = (3.3 − 2.9)/(3.3 − 1.03) ≈ 0.176.
        -ocean_depth_fast(age) as f64 / 1000.0 + (thick as f64 - OCEAN_THICK as f64) * 0.176
    }
}

/// A continental collision between two plates.
#[derive(Clone, Copy, Default)]
struct Collision {
    /// Continental crust consumed lately (sr, fading over ~30 Myr): the
    /// collision's current vigour.
    recent: f64,
    /// Highest `recent` so far.
    peak: f64,
    /// All crust consumed so far (sr).
    total: f64,
    /// How long (Myr) the vigour has been under half its peak.
    waning: f64,
}

/// A patch of mantle flow that drags the plates above it (convection cell).
struct MantleCell {
    centre: V3,
    /// Rotation (rad/Myr) of the flow under this patch.
    omega: V3,
    /// Angular radius (rad).
    radius: f64,
    /// Lasting convection cell (wanders for ever) or the fading flow of
    /// an upwelling that broke a continent.
    lasting: bool,
}

/// Typical speed of the mantle flow under the plates, mm/yr (at the default
/// mantle vigour of 35 mm/yr mean plate speed; scales with it).
const MANTLE_FLOW: f64 = 30.0;
/// Mantle flow away from a fresh continental rift: speed (mm/yr) and how
/// long it lasts (e-folding, Myr). The Atlantic has opened ~40 mm/yr for
/// 150 Myr.
const RIFT_DRIVE: f64 = 20.0;
const RIFT_DRIVE_MYR: f64 = 80.0;
/// Angular radius (rad) of a mantle-flow patch.
const MANTLE_CELL_RADIUS: f64 = 0.9;

struct Hotspot {
    pos: V3,
    /// Crust added at the centre, km/Myr.
    rate: f64,
    radius_km: f64,
    age: f64,
    life: f64,
}

#[derive(Default, Clone, Copy)]
pub struct Stats {
    pub steps: u64,
    pub rifts: u32,
    pub merges: u32,
    pub sub_inits: u32,
    pub ocean_splits: u32,
    pub removed: u32,
    pub subducted_area: f64,
    pub created_area: f64,
    pub last_dt: f64,
    /// Rock eroded, sr·km (× R² = km³).
    pub eroded: f64,
    /// Diagnostics: area of ocean→continent conversions by cause, of
    /// continental crust copied into rounding gaps, and of continent lost by thinning.
    pub conv_arc: f64,
    pub conv_hot: f64,
    pub copy_cont: f64,
    pub cont_lost: f64,
    /// Continental crust volume budget (sr·km): subduction, rift, hot spot,
    /// erosion, deposition, collision stacking, flow.
    pub budget: [f64; 7],
    /// Debug (TECTO_ADV): cell·Myr of active continental margin by how fast
    /// the upper plate advances on the trench (<−10, −10…2, 2…10, 10…25,
    /// >25 mm/yr), then Σ dt·convergence and Σ dt.
    pub adv_hist: [f64; 8],
}

/// Multi-source Dijkstra over the grid with reusable buffers.
struct Dijkstra {
    dist: Vec<f32>,
    src: Vec<u32>,
    touched: Vec<u32>,
    heap: BinaryHeap<Reverse<(u32, u32)>>,
}

impl Dijkstra {
    fn new(n: usize) -> Dijkstra {
        Dijkstra { dist: vec![f32::INFINITY; n], src: vec![NONE; n], touched: vec![], heap: BinaryHeap::new() }
    }
    fn reset(&mut self) {
        for &c in &self.touched {
            self.dist[c as usize] = f32::INFINITY;
            self.src[c as usize] = NONE;
        }
        self.touched.clear();
        self.heap.clear();
    }
    /// Distances in km from `sources`, spreading only where `allow(cell, source index)`.
    fn run(&mut self, g: &Grid, radius: f64, sources: &[u32], max_km: f32, allow: impl Fn(usize, usize) -> bool) {
        self.reset();
        for (i, &c) in sources.iter().enumerate() {
            let c = c as usize;
            if self.dist[c] > 0.0 {
                if self.dist[c].is_infinite() {
                    self.touched.push(c as u32);
                }
                self.dist[c] = 0.0;
                self.src[c] = i as u32;
                self.heap.push(Reverse((0f32.to_bits(), c as u32)));
            }
        }
        let r = radius as f32;
        while let Some(Reverse((db, c))) = self.heap.pop() {
            let d = f32::from_bits(db);
            let c = c as usize;
            if d > self.dist[c] {
                continue;
            }
            let si = self.src[c] as usize;
            for k in g.off[c] as usize..g.off[c + 1] as usize {
                let nb = g.nbrs[k] as usize;
                let nd = d + g.elen[k] * r;
                if nd > max_km || nd >= self.dist[nb] || !allow(nb, si) {
                    continue;
                }
                if self.dist[nb].is_infinite() {
                    self.touched.push(nb as u32);
                }
                self.dist[nb] = nd;
                self.src[nb] = si as u32;
                self.heap.push(Reverse((nd.to_bits(), nb as u32)));
            }
        }
    }
}

pub struct Sim {
    pub g: Grid,
    pub prm: Params,
    pub plates: Vec<Plate>,
    rng: Rng,
    noise: Noise,
    pub time: f64,
    next_id: u32,
    id_to_idx: Vec<i32>,

    // coverage scratch
    cand_n: Vec<u8>,
    cand: Vec<(u32, u32)>,
    mark: Vec<u32>,
    stamp: u32,
    hint: Vec<u32>,
    level: Vec<u8>,
    stack: Vec<u32>,

    // resolved world view (valid after `coverage` + `fill_gaps`)
    pub owner: Vec<i32>,
    oslot: Vec<u32>,
    owner_id: Vec<u32>,
    prev_owner: Vec<u32>,
    zone: Vec<u8>,
    newcrust: Vec<u8>,
    pub thick_w: Vec<f32>,
    pub age_w: Vec<f32>,
    pub cont_w: Vec<u8>,
    oro_w: Vec<u8>,
    oroage_w: Vec<f32>,
    pub elev: Vec<f32>,

    // per-step changes
    dthick: Vec<f32>,
    oro_set: Vec<u8>,

    // mantle-frame fields that persist between steps
    trench: Vec<f32>,
    swell: Vec<f32>,
    /// Continental crust driven into a collision this step (km·sr), per world cell.
    coll_in: Vec<f32>,
    slab: Vec<f32>,
    slab_pid: Vec<u32>,
    sz: Vec<f32>,
    sz_low: Vec<u32>,
    cz: Vec<f32>,
    cz_low: Vec<u32>,
    cz_top: Vec<u32>,
    hotspots: Vec<Hotspot>,
    mantle: Vec<MantleCell>,
    /// Collisions between pairs of plates (by id).
    pair_coll: BTreeMap<(u32, u32), Collision>,

    dij: Dijkstra,
    order: Vec<u32>,
    carry: Vec<f32>,
    work: Vec<f32>,
    pub sea_level: f64,
    /// Ocean water volume, sr·km.
    water: f64,
    pub stats: Stats,
    proc_acc: f64,
    max_thick: f32,
    /// Seconds spent per stage (native builds only).
    pub prof: [f64; 13],
    next_check: f64,

    // outputs
    pub out_owner: Vec<u32>,
    pub out_oro: Vec<u8>,
    pub out_plates: Vec<f64>,
    pub out_stats: Vec<f64>,
}

pub const PLATE_FIELDS: usize = 8;
pub const STAT_FIELDS: usize = 32;

impl Sim {
    pub fn new(g: Grid, prm: Params) -> Sim {
        let n = g.n;
        let max_thick = 35.0 + (MAX_THICK_EARTH - 35.0) * (prm.relief() as f32).sqrt();
        let seed = prm.seed;
        Sim {
            rng: Rng::stream(seed, "drift"),
            noise: Noise::new(seed, "drift-noise"),
            g,
            prm,
            plates: vec![],
            time: 0.0,
            next_id: 0,
            id_to_idx: vec![],
            cand_n: vec![0; n],
            cand: vec![(0, 0); 4 * n],
            mark: vec![0; n],
            stamp: 0,
            hint: vec![0; n],
            level: vec![0; n],
            stack: vec![],
            owner: vec![-1; n],
            oslot: vec![0; n],
            owner_id: vec![NONE; n],
            prev_owner: vec![NONE; n],
            zone: vec![0; n],
            newcrust: vec![0; n],
            thick_w: vec![0.0; n],
            age_w: vec![0.0; n],
            cont_w: vec![0; n],
            oro_w: vec![0; n],
            oroage_w: vec![0.0; n],
            elev: vec![0.0; n],
            dthick: vec![0.0; n],
            oro_set: vec![0; n],
            trench: vec![0.0; n],
            swell: vec![0.0; n],
            coll_in: vec![0.0; n],
            slab: vec![0.0; n],
            slab_pid: vec![NONE; n],
            sz: vec![0.0; n],
            sz_low: vec![NONE; n],
            cz: vec![0.0; n],
            cz_low: vec![NONE; n],
            cz_top: vec![NONE; n],
            hotspots: vec![],
            mantle: vec![],
            pair_coll: BTreeMap::new(),
            dij: Dijkstra::new(n),
            order: (0..n as u32).collect(),
            carry: vec![0.0; n],
            work: vec![0.0; n],
            sea_level: 0.0,
            water: 0.0,
            stats: Stats::default(),
            prof: [0.0; 13],
            proc_acc: 0.0,
            max_thick,
            next_check: 10.0,
            out_owner: vec![0; n],
            out_oro: vec![0; n],
            out_plates: vec![],
            out_stats: vec![0.0; STAT_FIELDS],
        }
    }

    #[inline]
    fn r(&self) -> f64 {
        self.prm.radius
    }

    fn spacing_km(&self) -> f64 {
        self.g.spacing * self.prm.radius
    }

    /// Initial state: plate index, crust type, thickness and age per cell,
    /// and each plate's angular velocity (rad/Myr, xyz).
    pub fn init(&mut self, plate: &[u32], cont: &[u8], thick: &[f32], age: &[f32], omega: &[f64]) {
        let n = self.g.n;
        let np = omega.len() / 3;
        self.plates = (0..np)
            .map(|i| Plate::new(i as u32, n, Quat::IDENTITY, [omega[3 * i], omega[3 * i + 1], omega[3 * i + 2]]))
            .collect();
        self.next_id = np as u32;
        for c in 0..n {
            let p = (plate[c] as usize).min(np - 1);
            let o = if cont[c] != 0 && thick[c] > 42.0 { oro::ANCIENT } else { oro::NONE };
            self.plates[p].add(c, c, thick[c], age[c], cont[c], o, 1000.0);
            self.prev_owner[c] = p as u32;
        }
        self.plates.retain(|p| p.live > 0);
        self.rebuild_ids();
        self.init_hotspots();
        let mut r = Rng::stream(self.prm.seed, "mantle");
        let k = MANTLE_FLOW * self.vigour() / self.prm.radius;
        self.mantle = (0..6).map(|_| MantleCell { centre: r.unit_vec(), omega: scale(r.unit_vec(), k), radius: MANTLE_CELL_RADIUS, lasting: true }).collect();
        self.update_bounds();
        self.refresh_view();
        // The ocean holds a fixed amount of water: enough to leave the
        // requested land fraction at the start. From then on sea level
        // follows the basins (and land area is emergent), instead of being
        // forced to a land fraction — forcing it drowned continental
        // interiors whenever mountain belts grew.
        let mut idx: Vec<usize> = (0..self.g.n).collect();
        idx.sort_by(|&a, &b| self.elev[b].total_cmp(&self.elev[a]).then(a.cmp(&b)));
        let mut acc = 0.0;
        let mut sea = self.elev[idx[self.g.n - 1]] as f64;
        for &c in &idx {
            acc += self.g.area[c];
            if acc >= self.prm.land_fraction * TAU {
                sea = self.elev[c] as f64;
                break;
            }
        }
        self.sea_level = sea;
        // the water load depends on the sea level: settle once more
        self.compute_elev();
        let mut idx: Vec<usize> = (0..self.g.n).collect();
        idx.sort_by(|&a, &b| self.elev[b].total_cmp(&self.elev[a]).then(a.cmp(&b)));
        let mut acc = 0.0;
        for &c in &idx {
            acc += self.g.area[c];
            if acc >= self.prm.land_fraction * TAU {
                self.sea_level = self.elev[c] as f64;
                break;
            }
        }
        let sea = self.sea_level;
        self.compute_elev();
        self.water = (0..self.g.n).map(|c| self.g.area[c] * (sea - self.elev[c] as f64).max(0.0)).sum();
    }

    /// Sea level (km) that leaves the requested land fraction dry, given
    /// `self.order`. The land fraction is the player's control; the
    /// continents' shape (plains + drowned margins) decides where it cuts.
    fn sea_for_land(&self) -> f64 {
        let goal = self.prm.land_fraction * TAU;
        let mut acc = 0.0;
        for &c in &self.order {
            acc += self.g.area[c as usize];
            if acc >= goal {
                return self.elev[c as usize] as f64;
            }
        }
        self.elev[self.order[self.g.n - 1] as usize] as f64
    }

    /// Ocean volume (sr·km) if the sea stood at `sea` km.
    fn volume_at(&self, sea: f64) -> f64 {
        let mut v = 0.0;
        for c in 0..self.g.n {
            let d = sea - self.elev[c] as f64;
            if d > 0.0 {
                v += self.g.area[c] * d;
            }
        }
        v
    }

    /// Sea level (km) at which the ocean holds `self.water`, given `self.order`
    /// (cells by descending elevation).
    fn sea_for_volume(&self) -> f64 {
        // fill from the deepest cell up: V(s) = Σ_{e_j < s} A_j (s − e_j)
        let (mut a, mut ae) = (0.0f64, 0.0f64);
        let n = self.g.n;
        for i in (0..n).rev() {
            let c = self.order[i] as usize;
            let e = self.elev[c] as f64;
            // volume if the sea stood at this cell's height
            if a > 0.0 && a * e - ae >= self.water {
                return (self.water + ae) / a;
            }
            a += self.g.area[c];
            ae += self.g.area[c] * e;
        }
        (self.water + ae) / a
    }

    /// Mantle vigour relative to the default (the Mantle vigour slider):
    /// the flow under the plates scales with it, like the plates' own speeds.
    fn vigour(&self) -> f64 {
        self.prm.mean_speed / 35.0
    }

    fn rebuild_ids(&mut self) {
        self.id_to_idx = vec![-1; self.next_id as usize + 1];
        for (i, p) in self.plates.iter().enumerate() {
            self.id_to_idx[p.id as usize] = i as i32;
        }
    }

    #[inline]
    fn idx(&self, id: u32) -> Option<usize> {
        if id == NONE {
            return None;
        }
        self.id_to_idx.get(id as usize).copied().filter(|&i| i >= 0).map(|i| i as usize)
    }

    /// Surface velocity of plate `pi` at world cell `c`, km/Myr (= mm/yr).
    #[inline]
    fn vel(&self, pi: usize, c: usize) -> V3 {
        scale(cross(self.plates[pi].omega, self.g.pos[c]), self.prm.radius)
    }

    fn init_hotspots(&mut self) {
        let mut r = Rng::stream(self.prm.seed, "hotspots");
        for _ in 0..self.prm.hotspots {
            let life = r.range(40.0, 160.0);
            let h = Hotspot { pos: r.unit_vec(), rate: hotspot_rate(&mut r), radius_km: 90.0, age: r.range(0.0, life), life };
            self.hotspots.push(h);
        }
    }

    // -----------------------------------------------------------------
    // main loop

    /// Advances the simulation by about `myr` million years (at most `max_steps` steps).
    pub fn run(&mut self, myr: f64, max_steps: u32) -> f64 {
        // Whole steps only: clipping the last step to `end` would make the
        // result depend on how the caller chunks the run.
        let end = self.time + myr;
        let mut steps = 0;
        while self.time < end - 1e-6 && steps < max_steps {
            let dt = self.choose_dt();
            self.step(dt);
            steps += 1;
        }
        self.time
    }

    fn choose_dt(&self) -> f64 {
        let vmax = self.plates.iter().map(|p| len(p.omega) * self.prm.radius).fold(1.0, f64::max);
        (1.5 * self.spacing_km() / vmax).clamp(0.1, self.prm.max_dt)
    }

    pub fn step(&mut self, dt: f64) {
        self.time += dt;
        self.stats.steps += 1;
        self.stats.last_dt = dt;
        self.decay_fields(dt);
        for p in &mut self.plates {
            p.advance(dt);
            p.age_myr += dt;
        }
        macro_rules! timed {
            ($i:expr, $e:expr) => {{
                #[cfg(not(target_arch = "wasm32"))]
                let t0 = std::time::Instant::now();
                $e;
                #[cfg(not(target_arch = "wasm32"))]
                {
                    self.prof[$i] += t0.elapsed().as_secs_f64();
                }
            }};
        }
        timed!(0, self.coverage(true));
        timed!(1, self.local_pass(dt));
        timed!(2, self.fill_gaps(dt, true));
        timed!(3, self.gather_world());
        self.dthick.fill(0.0);
        self.oro_set.fill(0);
        // Slow surface processes run on a ~1 Myr clock (several motion
        // steps at high resolution) with the time accumulated since.
        self.proc_acc += dt;
        let run_proc = self.proc_acc >= PROC_DT;
        let pdt = self.proc_acc;
        if run_proc {
            self.proc_acc = 0.0;
            timed!(4, self.subduction(pdt));
        }
        timed!(5, self.collision_marks());
        timed!(5, self.rift_thinning());
        if run_proc {
            timed!(6, self.hotspots_step(pdt));
            timed!(7, self.crustal_flow(pdt));
            timed!(8, self.erosion(pdt));
        }
        timed!(9, self.apply_deltas(dt));
        timed!(10, self.update_bounds());
        if run_proc {
            timed!(11, self.forces(pdt));
        }
        timed!(12, self.events(dt));
        for c in 0..self.g.n {
            self.prev_owner[c] = self.owner_id[c];
        }
    }

    fn decay_fields(&mut self, dt: f64) {
        let ks = (-dt / 15.0).exp() as f32;
        let kz = (-dt / 4.0).exp() as f32;
        let kc = (-dt / 10.0).exp() as f32;
        let kt = (-dt / 3.0).exp() as f32;
        for c in 0..self.g.n {
            self.slab[c] *= ks;
            self.sz[c] *= kz;
            self.cz[c] *= kc;
            self.trench[c] *= kt;
        }
        let kp = (-dt / 30.0).exp();
        self.pair_coll.retain(|_, v| {
            v.recent *= kp;
            v.waning = if v.recent < 0.5 * v.peak { v.waning + dt } else { 0.0 };
            v.recent > 1e-6
        });
    }

    /// Recomputes each plate's centroid (local frame), area and continental area.
    fn update_bounds(&mut self) {
        let g = &self.g;
        for p in &mut self.plates {
            let mut sum = [0.0; 3];
            let (mut a, mut ca) = (0.0, 0.0);
            for s in 0..p.cell.len() {
                if !p.alive[s] {
                    continue;
                }
                let r = p.cell[s] as usize;
                sum = add(sum, scale(g.pos[r], g.area[r]));
                a += g.area[r];
                if p.cont[s] != 0 {
                    ca += g.area[r];
                }
            }
            p.cen = normalize(sum);
            p.area = a;
            p.cont_area = ca;
            p.maybe_compact();
        }
    }

    // -----------------------------------------------------------------
    // coverage and overlap resolution

    /// Resolves the world view: for every cell, which plate's crust is on
    /// top (`owner`, `oslot`). With `mutate` false it only reads plate state
    /// (used for output), so asking for a picture never changes the planet.
    fn coverage(&mut self, mutate: bool) {
        let n = self.g.n;
        self.cand_n.fill(0);
        // Each plate floods out from where its columns were last step: cells
        // where it has crust keep spreading, misses spread at most two rings.
        for pi in 0..self.plates.len() {
            let p = &self.plates[pi];
            let qi = p.q.conj();
            self.stamp = self.stamp.wrapping_add(1);
            if self.stamp == 0 {
                self.mark.fill(0);
                self.stamp = 1;
            }
            let st = self.stamp;
            self.stack.clear();
            for s in 0..p.cell.len() {
                if !p.alive[s] {
                    continue;
                }
                let c = p.world[s] as usize;
                if self.mark[c] != st {
                    self.mark[c] = st;
                    self.hint[c] = p.cell[s];
                    self.level[c] = 0;
                    self.stack.push(c as u32);
                }
            }
            while let Some(c) = self.stack.pop() {
                let c = c as usize;
                let r = self.g.nearest_from(qi.rotate(self.g.pos[c]), self.hint[c] as usize);
                let s = p.slot_of[r];
                let lvl = if s != EMPTY {
                    let k = self.cand_n[c] as usize;
                    if k < 4 {
                        self.cand[4 * c + k] = (pi as u32, s as u32);
                        self.cand_n[c] += 1;
                    }
                    0
                } else {
                    self.level[c] + 1
                };
                if lvl > 2 {
                    continue;
                }
                for &d in self.g.nb(c) {
                    let d = d as usize;
                    if self.mark[d] != st {
                        self.mark[d] = st;
                        self.hint[d] = r as u32;
                        self.level[d] = lvl;
                        self.stack.push(d as u32);
                    }
                }
            }
        }
        // resolve
        for c in 0..n {
            let k = self.cand_n[c] as usize;
            self.zone[c] = 0;
            self.newcrust[c] = 0;
            if k == 0 {
                self.owner[c] = -1;
                self.owner_id[c] = NONE;
                continue;
            }
            let mut best = self.cand[4 * c];
            for i in 1..k {
                let o = self.cand[4 * c + i];
                if self.on_top(o, best, c) {
                    best = o;
                }
            }
            if k > 1 {
                self.zone[c] = 1;
            }
            self.set_owner(c, best.0 as usize, best.1 as usize);
        }
        // A single column of one plate walled in by another is a leftover
        // (rounding ghost): drop it and let the gap fill patch the hole.
        let mut drop: Vec<(usize, usize, usize)> = vec![];
        for c in 0..n {
            if !mutate {
                break;
            }
            let o = self.owner[c];
            if o < 0 || self.cand_n[c] != 1 {
                continue;
            }
            let nb = self.g.nb(c);
            let first = self.owner[nb[0] as usize];
            if first >= 0 && first != o && nb.iter().all(|&d| self.owner[d as usize] == first) {
                drop.push((c, o as usize, self.oslot[c] as usize));
            }
        }
        for (c, pi, s) in drop {
            self.plates[pi].remove(s);
            self.owner[c] = -1;
            self.owner_id[c] = NONE;
            self.cand_n[c] = 0;
        }
        self.mark_visible();
        // widen the overlap zone by one ring (edge quantisation)
        for c in 0..n {
            if self.zone[c] == 1 {
                for &d in self.g.nb(c) {
                    if self.zone[d as usize] == 0 {
                        self.zone[d as usize] = 2;
                    }
                }
            }
        }
    }

    /// Flags every slot that is on top somewhere (`vis` = 1).
    fn mark_visible(&mut self) {
        for p in &mut self.plates {
            p.vis.iter_mut().for_each(|v| *v = 0);
        }
        for c in 0..self.g.n {
            let o = self.owner[c];
            if o >= 0 {
                self.plates[o as usize].vis[self.oslot[c] as usize] = 1;
            }
        }
    }

    #[inline]
    fn set_owner(&mut self, c: usize, pi: usize, s: usize) {
        let p = &self.plates[pi];
        self.owner[c] = pi as i32;
        self.oslot[c] = s as u32;
        self.owner_id[c] = p.id;
        self.cont_w[c] = p.cont[s];
    }

    /// Does candidate `a` override candidate `b` at world cell `c`?
    fn on_top(&self, a: (u32, u32), b: (u32, u32), c: usize) -> bool {
        let (pa, pb) = (&self.plates[a.0 as usize], &self.plates[b.0 as usize]);
        let (sa, sb) = (a.1 as usize, b.1 as usize);
        let (ca, cb) = (pa.cont[sa] != 0, pb.cont[sb] != 0);
        if ca != cb {
            return ca; // continent always floats
        }
        let prev = self.prev_owner[c];
        if ca {
            // continent–continent: keep the current upper plate; otherwise the
            // more continental (more buoyant) plate overrides
            if prev == pa.id {
                return true;
            }
            if prev == pb.id {
                return false;
            }
            return pa.cont_area / pa.area.max(1e-12) >= pb.cont_area / pb.area.max(1e-12);
        }
        // ocean–ocean: the older (denser) slab sinks; hysteresis keeps polarity stable
        let bonus = |id: u32| if prev == id { 15.0 } else { 0.0 };
        pa.age[sa] as f64 - bonus(pa.id) <= pb.age[sb] as f64 - bonus(pb.id)
    }

    /// Every plate checks each of its crust columns against the resolved view:
    /// columns under another plate's crust are subducted or, if continental
    /// under continental, stacked onto the upper plate.
    fn local_pass(&mut self, dt: f64) {
        let g = &self.g;
        let rk = self.prm.radius;
        let omegas: Vec<V3> = self.plates.iter().map(|p| p.omega).collect();
        let cell_km = self.g.spacing * rk;
        for pi in 0..self.plates.len() {
            let p = &mut self.plates[pi];
            let q = p.q;
            let pid = p.id;
            for s in 0..p.cell.len() {
                if !p.alive[s] {
                    continue;
                }
                let w = q.rotate(g.pos[p.cell[s] as usize]);
                let c = g.nearest_from(w, p.world[s] as usize);
                p.world[s] = c as u32;
                let o = self.owner[c];
                // A column that is on top at some cell of the view is still
                // visible crust: the forward (slot → cell) and inverse
                // (cell → slot) nearest-cell maps disagree for a few % of
                // columns, and consuming those ate the upper plate's crust.
                if o < 0 || o as usize == pi || self.zone[c] == 0 || p.vis[s] != 0 {
                    continue;
                }
                // Only a real convergence consumes crust. Overlaps from
                // nearest-cell rounding (plates at rest, shearing past each
                // other) just stay hidden and reappear when the rounding flips.
                let pc = g.pos[c];
                let mut toward_p = [0.0; 3];
                let mut edge = false;
                for &d in g.nb(c) {
                    if self.owner_id[d as usize] == pid {
                        toward_p = add(toward_p, sub(g.pos[d as usize], pc));
                        edge = true;
                    }
                }
                let toward_p = tangent(toward_p, pc);
                if edge && len(toward_p) <= 1e-12 {
                    continue; // no direction to converge along: leave it hidden
                }
                if edge {
                    let rel = scale(cross(sub(omegas[pi], omegas[o as usize]), pc), rk);
                    let conv = -dot(rel, normalize(toward_p));
                    // Rounding makes edge overlaps every step whatever the speed;
                    // consume them only as fast as the plates really converge
                    // (unconsumed ones sink deeper next step and go then).
                    if conv >= MIN_RATE && self.rng.f() > conv * dt / cell_km {
                        continue;
                    }
                    if conv < MIN_RATE {
                        continue; // not converging: stays hidden (rounding overlap)
                    }
                }
                if p.cont[s] != 0 {
                    if self.cont_w[c] == 0 {
                        continue; // a continent never goes under ocean (edge jitter)
                    }
                    // its crust is shortened into the upper plate (see collision_belts)
                    self.coll_in[c] += p.thick[s] * g.area[c] as f32;
                    // A stretched margin (thin crust) is dragged down with
                    // little resistance; full-thickness crust is too buoyant
                    // and jams the trench. So the margins between two
                    // continents are used up before the collision proper
                    // starts, and the suture is a mountain belt, not a
                    // leftover shallow sea.
                    let hard = smoothstep(26.0, 34.0, p.thick[s] as f64);
                    self.cz[c] = self.cz[c].max(hard as f32);
                    self.cz_low[c] = pid;
                    self.cz_top[c] = self.owner_id[c];
                    let key = if pid < self.owner_id[c] { (pid, self.owner_id[c]) } else { (self.owner_id[c], pid) };
                    let e = self.pair_coll.entry(key).or_default();
                    e.recent += hard * g.area[c];
                    e.total += hard * g.area[c];
                    e.peak = e.peak.max(e.recent);
                    p.remove(s);
                } else {
                    let f = (p.age[s] as f64 / 80.0).clamp(0.1, 1.0);
                    self.slab[c] += (g.area[c] * f) as f32;
                    self.slab_pid[c] = pid;
                    self.sz[c] = 1.0;
                    self.sz_low[c] = pid;
                    self.stats.subducted_area += g.area[c];
                    p.remove(s);
                }
            }
        }
    }

    /// Uncovered cells get fresh ocean crust from a neighbouring plate
    /// (preferring the plate that was there before).
    fn fill_gaps(&mut self, dt: f64, mutate: bool) {
        let cell_km = self.g.spacing * self.prm.radius;
        let n = self.g.n;
        let mut gaps: Vec<usize> = (0..n).filter(|&c| self.owner[c] < 0).collect();
        let mut choice: Vec<(usize, usize)> = vec![];
        let mut rounds = 0;
        while !gaps.is_empty() && rounds < 200 {
            rounds += 1;
            choice.clear();
            let mut rest = vec![];
            for &c in &gaps {
                let mut ids: [(u32, u32); 8] = [(NONE, 0); 8];
                let mut m = 0;
                for &d in self.g.nb(c) {
                    let o = self.owner[d as usize];
                    if o < 0 {
                        continue;
                    }
                    let o = o as u32;
                    if let Some(e) = ids[..m].iter_mut().find(|e| e.0 == o) {
                        e.1 += 1;
                    } else if m < 8 {
                        ids[m] = (o, 1);
                        m += 1;
                    }
                }
                if m == 0 {
                    rest.push(c);
                    continue;
                }
                let prev = self.prev_owner[c];
                let pick = ids[..m]
                    .iter()
                    .find(|e| self.plates[e.0 as usize].id == prev)
                    .or_else(|| ids[..m].iter().max_by_key(|e| e.1))
                    .unwrap()
                    .0 as usize;
                choice.push((c, pick));
            }
            if choice.is_empty() {
                // isolated holes (should not happen): give them to plate 0
                for &c in &rest {
                    choice.push((c, 0));
                }
                rest.clear();
            }
            for &(c, pi) in &choice {
                let donor = self.g.nb(c).iter().map(|&d| d as usize).find(|&d| self.owner[d] == pi as i32);
                if !mutate {
                    // view only: show the neighbouring column
                    let ds = donor.map(|d| self.oslot[d] as usize).unwrap_or_else(|| self.plates[pi].slots().next().unwrap_or(0));
                    self.set_owner(c, pi, ds);
                    continue;
                }
                // rounding opens edge gaps every step: only a share matching the
                // real opening rate becomes new sea floor, the rest copies the edge
                let rate = self.diverging(c, pi);
                let ridge = rate > MIN_RATE && self.rng.f() < rate * dt / cell_km;
                // enclosed by this plate alone → a hole in its crust (nearest-cell
                // sampling of freshly made or merged crust skips ~1 cell in 10)
                // (neighbours that were themselves gaps a moment ago don't
                // count: the middle of a wide opening is not a hole, and
                // copying crust into it filled rifts with continent)
                let enclosed = self.g.nb(c).iter().all(|&d| self.owner[d as usize] == pi as i32 && self.cand_n[d as usize] > 0);
                let p = &mut self.plates[pi];
                let r = self.g.nearest(p.q.conj().rotate(self.g.pos[c]));
                let s = if p.slot_of[r] != EMPTY {
                    p.slot_of[r] as usize
                } else if ridge || donor.is_none() {
                    self.stats.created_area += self.g.area[c];
                    p.add(r, c, OCEAN_THICK, 0.0, 0, oro::NONE, 1000.0)
                } else if enclosed {
                    let ds = self.oslot[donor.unwrap()] as usize;
                    let (t, a, k, o, oa) = (p.thick[ds], p.age[ds], p.cont[ds], p.oro[ds], p.oro_age[ds]);
                    // (only continental copies are counted: holes in fresh
                    // sea floor are routine)
                    if k != 0 {
                        self.stats.copy_cont += self.g.area[c];
                    }
                    p.add(r, c, t, a, k, o, oa)
                } else {
                    // rounding gap at an edge: show the neighbouring column, change nothing
                    self.oslot[donor.unwrap()] as usize
                };
                self.set_owner(c, pi, s);
                self.plates[pi].vis[s] = 1;
                if ridge {
                    self.newcrust[c] = 1;
                }
            }
            gaps = rest;
        }
    }

    /// Opening rate (mm/yr) between plate `pi` and its neighbours at gap cell `c`.
    fn diverging(&self, c: usize, pi: usize) -> f64 {
        let g = &self.g;
        let pc = g.pos[c];
        let mut mine = [0.0; 3];
        let mut others: [(i32, V3); 6] = [(-1, [0.0; 3]); 6];
        let mut m = 0;
        for &d in g.nb(c) {
            let o = self.owner[d as usize];
            if o < 0 {
                continue;
            }
            let v = sub(g.pos[d as usize], pc);
            if o as usize == pi {
                mine = add(mine, v);
            } else if let Some(e) = others[..m].iter_mut().find(|e| e.0 == o) {
                e.1 = add(e.1, v);
            } else if m < 6 {
                others[m] = (o, v);
                m += 1;
            }
        }
        let mut best: f64 = 0.0;
        for &(o, v) in &others[..m] {
            let dir = normalize(tangent(sub(v, mine), pc));
            let rel = sub(self.vel(o as usize, c), self.vel(pi, c));
            best = best.max(dot(rel, dir));
        }
        best
    }

    fn gather_world(&mut self) {
        for c in 0..self.g.n {
            let o = self.owner[c];
            if o < 0 {
                continue;
            }
            let p = &self.plates[o as usize];
            let s = self.oslot[c] as usize;
            self.thick_w[c] = p.thick[s];
            self.age_w[c] = p.age[s];
            self.cont_w[c] = p.cont[s];
            self.oro_w[c] = p.oro[s];
            self.oroage_w[c] = p.oro_age[s];
        }
        self.compute_elev();
    }

    fn compute_elev(&mut self) {
        let sea = self.sea_level;
        for c in 0..self.g.n {
            let h = self.thick_w[c] + self.dthick[c];
            self.elev[c] = (crust_elev(h, self.age_w[c], self.cont_w[c], sea) + self.swell[c] as f64 - self.trench[c] as f64) as f32;
        }
    }

    // -----------------------------------------------------------------
    // world processes

    /// Thickening above active slabs (Andean cordilleras / island arcs) and trenches.
    fn subduction(&mut self, dt: f64) {
        let n = self.g.n;
        let rk = self.r();
        let mut sources: Vec<u32> = vec![];
        let mut conv_of: Vec<f32> = vec![];
        let mut adv_of: Vec<f32> = vec![];
        let mut trench_src: Vec<u32> = vec![];
        let mut trench_depth: Vec<f32> = vec![];
        let relief = self.prm.relief();
        for c in 0..n {
            if self.sz[c] < 0.25 || self.owner[c] < 0 {
                continue;
            }
            let low = self.sz_low[c];
            if self.owner_id[c] == low {
                continue;
            }
            let Some(li) = self.idx(low) else { continue };
            let pc = self.g.pos[c];
            let mut nsum = [0.0; 3];
            let mut lows: [u32; 8] = [0; 8];
            let mut m = 0;
            for &d in self.g.nb(c) {
                if self.owner_id[d as usize] == low {
                    nsum = add(nsum, sub(self.g.pos[d as usize], pc));
                    if m < 8 {
                        lows[m] = d;
                        m += 1;
                    }
                }
            }
            if m == 0 {
                continue;
            }
            let nrm = normalize(tangent(nsum, pc));
            let rel = sub(self.vel(li, c), self.vel(self.owner[c] as usize, c));
            let conv = -dot(rel, nrm);
            if conv <= 0.0 {
                continue;
            }
            sources.push(c as u32);
            conv_of.push(conv as f32);
            // trench-ward motion of the overriding plate itself: an upper
            // plate that advances on the trench is shortened (Andes); one
            // that moves away stretches its back-arc (Marianas, Japan Sea)
            adv_of.push(dot(self.vel(self.owner[c] as usize, c), nrm) as f32);
            if flag("TECTO_ADV") && self.cont_w[c] != 0 && conv > 15.0 {
                let adv = dot(self.vel(self.owner[c] as usize, c), nrm);
                let bin = if adv < -10.0 { 0 } else if adv < 2.0 { 1 } else if adv < 10.0 { 2 } else if adv < 25.0 { 3 } else { 4 };
                self.stats.adv_hist[bin] += dt;
                self.stats.adv_hist[5] += dt * conv;
                self.stats.adv_hist[6] += dt;
            }
            // trench depth grows with convergence: slow boundaries barely
            // flex the plate, fast ones (≥ 50 mm/yr) 3–4 km deep
            let depth = (4.0 * smoothstep(5.0, 50.0, conv) * relief.min(1.5)) as f32;
            for &d in &lows[..m] {
                trench_src.push(d);
                trench_depth.push(depth);
            }
        }
        if !sources.is_empty() {
            let owner = &self.owner;
            let src_owner: Vec<i32> = sources.iter().map(|&c| owner[c as usize]).collect();
            self.dij.run(&self.g, rk, &sources, 420.0, |d, si| owner[d] == src_owner[si]);
            let tmax = 35.0 + 30.0 * relief.sqrt();
            // Cordillera growth: magmatic addition plus tectonic shortening.
            // A rigid plate cannot shorten, and taking the volume from
            // elsewhere on the continent (tried: a back-arc band, then the
            // whole interior) dug drowned basins behind every range, so the
            // growth is simply added; erosion carries it back to the ocean.
            for &d in &self.dij.touched {
                let d = d as usize;
                let x = self.dij.dist[d] as f64;
                let si = self.dij.src[d] as usize;
                // slow or oblique convergence (< ~15 mm/yr normal to the
                // margin) builds nothing — otherwise every sluggish
                // boundary that ever touched a coast left a range behind
                let k = (conv_of[si] as f64 - 15.0).max(0.0) * dt / 40.0;
                let h = (self.thick_w[d] + self.dthick[d]) as f64;
                let amount = if self.cont_w[d] != 0 {
                    // Two parts. Arc magmatism (~40 km³ per km of arc per
                    // Myr, Reymer & Schubert) feeds a narrow volcanic chain
                    // ~100–160 km behind the trench wherever slab sinks.
                    let arc = 0.3 * (-((x - 130.0) / 45.0).powi(2)).exp() * ((tmax - h) / 20.0).clamp(0.0, 1.0) * k;
                    // Shortening builds the broad cordillera, and only where
                    // the upper plate advances on the trench (Uyeda &
                    // Kanamori; Lamb & Davis): Andes, not Cascades — so
                    // most margins carry an arc, few a high range.
                    // About a quarter of the upper plate's advance is taken up
                    // by shortening (Andes: ~10 of ~30–45 mm/yr), the rest by
                    // trench retreat; spread over the ~250 km-wide belt that is
                    // ~0.25·v·H/250 ≈ 0.038 km of crust per Myr per mm/yr.
                    // Inherited structure makes some stretches of a margin
                    // shorten far more than others (segments fixed to the plate).
                    let pl = &self.plates[self.owner[d] as usize];
                    let lp = self.g.pos[pl.cell[self.oslot[d] as usize] as usize];
                    let seg = (1.0 + 2.2 * self.noise.fbm(lp, 4.0, 2)).clamp(0.1, 2.2);
                    let push = 0.038 * seg * (adv_of[si] as f64 - 2.0).max(0.0) * dt;
                    let shape = smoothstep(40.0, 110.0, x) * (1.0 - smoothstep(240.0, 400.0, x));
                    let short = shape * ((tmax - h) / 30.0).clamp(0.0, 1.0) * push.min(k * 2.0);
                    // subduction erosion scrapes the forearc (≈ as much as arcs add)
                    let scrape = 0.5 * (-(x / 60.0).powi(2)).exp() * k;
                    arc + short - scrape
                } else {
                    let shape = (-((x - 140.0) / 60.0).powi(2)).exp();
                    // arc magmatism ≈ 40 km³ per km of arc per Myr (Reymer & Schubert)
                    0.25 * shape * ((tmax * 0.6 - h) / 20.0).clamp(0.0, 1.0) * k
                };
                if amount != 0.0 {
                    self.dthick[d] += amount as f32;
                    if self.cont_w[d] != 0 {
                        self.stats.budget[0] += amount * self.g.area[d];
                    }
                    if amount > 0.05 * k {
                        self.oro_set[d] = if self.cont_w[d] != 0 { oro::ANDEAN } else { oro::ARC };
                    }
                }
            }
        }
        if !trench_src.is_empty() {
            let owner = &self.owner;
            let src_owner: Vec<i32> = trench_src.iter().map(|&c| owner[c as usize]).collect();
            self.dij.run(&self.g, rk, &trench_src, 100.0, |d, si| owner[d] == src_owner[si]);
            for &d in &self.dij.touched {
                let d = d as usize;
                if self.cont_w[d] != 0 {
                    continue;
                }
                let x = self.dij.dist[d];
                // trenches are ~50–100 km wide
                let depth = trench_depth[self.dij.src[d] as usize] * (-(x / 30.0).powi(2)).exp();
                if depth > self.trench[d] {
                    self.trench[d] = depth;
                }
            }
        }
    }

    /// Continental crust that went under another continent this step is
    /// shortened into the upper plate. Continental lithosphere is weak: the
    /// shortening spreads hundreds of km behind the suture (Tibet, Tian
    /// Shan and the Alps' forelands, not a single line of peaks), fading
    /// with distance and moving outward as the belt nearest the suture
    /// reaches the thickness the crust can hold. Volume is conserved.
    fn collision_belts(&mut self) {
        let n = self.g.n;
        // (crust queued at a cell that is no longer continent — a suture
        // leftover whose cell changed hands — has nowhere to go and is dropped)
        let src: Vec<u32> = (0..n as u32)
            .filter(|&c| self.coll_in[c as usize] > 0.0 && self.owner[c as usize] >= 0 && self.cont_w[c as usize] != 0)
            .collect();
        if src.is_empty() {
            self.coll_in.fill(0.0);
            return;
        }
        let rk = self.r();
        let hold = COLL_THICK_BASE + (COLL_THICK_EARTH - COLL_THICK_BASE) * self.prm.relief().sqrt();
        let owner = &self.owner;
        let cont = &self.cont_w;
        let so: Vec<i32> = src.iter().map(|&c| owner[c as usize]).collect();
        self.dij.run(&self.g, rk, &src, COLL_REACH_KM, |d, si| owner[d] == so[si] && cont[d] != 0);
        // One belt = the connected ground reached from one stretch of
        // suture. Its crust is pooled: sharing it out source by source would
        // leave a source with another right behind it nothing but its own
        // cell to thicken.
        let mut belt = vec![u32::MAX; n];
        let mut vol: Vec<f64> = vec![];
        let mut wsum: Vec<f64> = vec![];
        let mut stack: Vec<u32> = vec![];
        let weight = |sim: &Sim, d: usize| -> f64 {
            let x = sim.dij.dist[d] as f64;
            let h = (sim.thick_w[d] + sim.dthick[d]) as f64;
            (-x / COLL_WIDTH_KM).exp() * ((hold - h) / 15.0).clamp(0.03, 1.0) * sim.g.area[d]
        };
        for i in 0..self.dij.touched.len() {
            let d0 = self.dij.touched[i] as usize;
            if belt[d0] != u32::MAX {
                continue;
            }
            let k = vol.len() as u32;
            let (mut v, mut w) = (0.0, 0.0);
            belt[d0] = k;
            stack.push(d0 as u32);
            while let Some(d) = stack.pop() {
                let d = d as usize;
                w += weight(self, d);
                if self.dij.dist[d] == 0.0 {
                    v += self.coll_in[d] as f64;
                }
                for &e in self.g.nb(d) {
                    let e = e as usize;
                    if belt[e] == u32::MAX && self.dij.dist[e].is_finite() && self.owner[e] == self.owner[d] {
                        belt[e] = k;
                        stack.push(e as u32);
                    }
                }
            }
            vol.push(v);
            wsum.push(w);
        }
        for i in 0..self.dij.touched.len() {
            let d = self.dij.touched[i] as usize;
            let k = belt[d] as usize;
            if wsum[k] <= 0.0 {
                continue;
            }
            // (thickness before this step for every cell: collect, then apply)
            self.work[d] = (vol[k] * weight(self, d) / wsum[k] / self.g.area[d]) as f32;
        }
        for i in 0..self.dij.touched.len() {
            let d = self.dij.touched[i] as usize;
            let add = self.work[d];
            self.work[d] = 0.0;
            self.dthick[d] += add;
            self.stats.budget[5] += add as f64 * self.g.area[d];
            if add > 0.02 {
                self.oro_set[d] = oro::HIMALAYAN;
            }
        }
        self.coll_in.fill(0.0);
    }

    /// Marks collision belts (the thickening itself is done in collision_belts).
    fn collision_marks(&mut self) {
        let n = self.g.n;
        self.collision_belts();
        let mut top_src = vec![];
        let mut low_src = vec![];
        for c in 0..n {
            if self.cz[c] < 0.3 || self.owner[c] < 0 {
                continue;
            }
            if self.owner_id[c] == self.cz_top[c] {
                top_src.push(c as u32);
                for &d in self.g.nb(c) {
                    if self.owner_id[d as usize] == self.cz_low[c] {
                        low_src.push(d);
                    }
                }
            }
        }
        let rk = self.r();
        if !top_src.is_empty() {
            let owner = &self.owner;
            let so: Vec<i32> = top_src.iter().map(|&c| owner[c as usize]).collect();
            self.dij.run(&self.g, rk, &top_src, 400.0, |d, si| owner[d] == so[si] && self.cont_w[d] != 0);
            for &d in &self.dij.touched {
                self.oro_set[d as usize] = oro::HIMALAYAN;
            }
        }
        if !low_src.is_empty() {
            let owner = &self.owner;
            let so: Vec<i32> = low_src.iter().map(|&c| owner[c as usize]).collect();
            self.dij.run(&self.g, rk, &low_src, 180.0, |d, si| owner[d] == so[si] && self.cont_w[d] != 0);
            for &d in &self.dij.touched {
                if self.oro_set[d as usize] == 0 {
                    self.oro_set[d as usize] = oro::FORELAND;
                }
            }
        }
    }

    /// Continental crust next to newly formed sea floor is stretched thin
    /// (rift shoulders → passive margins with shelves).
    fn rift_thinning(&mut self) {
        if flag("TECTO_NO_RIFTTHIN") {
            return;
        }
        let src: Vec<u32> = (0..self.g.n as u32).filter(|&c| self.newcrust[c as usize] != 0).collect();
        if src.is_empty() {
            return;
        }
        let cont = &self.cont_w;
        self.dij.run(&self.g, self.prm.radius, &src, 220.0, |d, _| cont[d] != 0);
        // Each new sea-floor column beside a continent thins it once (the
        // ridge then moves away), so the thinning per column scales with the
        // cell size to keep the total per km of margin resolution-free
        // (calibrated at ~111 km cells).
        let per = 0.06 * self.spacing_km() / 111.0;
        for &d in &self.dij.touched {
            let d = d as usize;
            if self.cont_w[d] == 0 {
                continue;
            }
            let x = self.dij.dist[d] as f64;
            let h = (self.thick_w[d] + self.dthick[d]) as f64;
            let thin = per * (h - 15.0).max(0.0) * (-x / 70.0).exp();
            self.dthick[d] -= thin as f32;
            self.stats.budget[1] -= thin * self.g.area[d];
            if x < 120.0 {
                self.oro_set[d] = oro::RIFT;
            }
        }
    }

    fn hotspots_step(&mut self, dt: f64) {
        self.swell.fill(0.0);
        let rk = self.prm.radius;
        let reach = 700.0 / rk; // radians
        let mut rng = Rng::stream(self.prm.seed ^ (self.stats.steps.wrapping_mul(0x9E37)), "hs-step");
        for hi in 0..self.hotspots.len() {
            {
                let h = &mut self.hotspots[hi];
                h.age += dt;
                if h.age > h.life {
                    h.pos = rng.unit_vec();
                    h.rate = hotspot_rate(&mut rng);
                    h.life = rng.range(40.0, 160.0);
                    h.age = 0.0;
                }
            }
            let (hp, rate, rad, age) = {
                let h = &self.hotspots[hi];
                (h.pos, h.rate, h.radius_km, h.age)
            };
            // plume head: a few Myr of flood volcanism over a wide area
            let (mult, r_eff) = if age < 6.0 && rate > 1.2 { (2.0, rad * 2.5) } else { (1.0, rad) };
            let swell_amp = 0.9 * (rate / 1.5).clamp(0.2, 1.0).sqrt();
            self.stamp = self.stamp.wrapping_add(1).max(1);
            let st = self.stamp;
            let seed = self.g.nearest(hp);
            self.stack.clear();
            self.stack.push(seed as u32);
            self.mark[seed] = st;
            let cos_reach = reach.cos();
            while let Some(c) = self.stack.pop() {
                let c = c as usize;
                let x = angle(self.g.pos[c], hp) * rk;
                // dynamic uplift: a broad ~1 km swell under oceans, weaker under
                // thick continental lithosphere
                let damp = if self.cont_w[c] != 0 { CONT_SWELL } else { 1.0 };
                self.swell[c] += (damp * swell_amp * (-(x / 450.0).powi(2)).exp()) as f32;
                if x < 3.0 * r_eff {
                    // thick continental lithosphere lets little melt through
                    // (no Hawaii-style edifices on continents; flood basalts
                    // spread thin)
                    let lid = if self.cont_w[c] != 0 { 0.15 } else { 1.0 };
                    let add = lid * rate * mult * dt * (-(x / r_eff).powi(2)).exp();
                    self.dthick[c] += add as f32;
                    if self.cont_w[c] != 0 {
                        self.stats.budget[2] += add * self.g.area[c];
                    }
                    if add > 0.1 * dt {
                        self.oro_set[c] = oro::HOTSPOT;
                    }
                }
                for &d in self.g.nb(c) {
                    let d = d as usize;
                    if self.mark[d] != st && dot(self.g.pos[d], hp) >= cos_reach {
                        self.mark[d] = st;
                        self.stack.push(d as u32);
                    }
                }
            }
        }
    }

    /// Gravitational spreading of thick crust (plateaus flatten, roots
    /// spread) plus slow background smoothing — continental cells only.
    fn crustal_flow(&mut self, dt: f64) {
        if flag("TECTO_NO_FLOW") {
            return;
        }
        let n = self.g.n;
        let l = self.spacing_km();
        let w0 = 4.0 / (6.0 * l * l); // hex-grid Laplacian weight per neighbour
        // background: one explicit step (stable while dt·κ·w0·6 < 1)
        // cold continental crust barely flows; a little keeps single-cell spikes in check
        let k_bg = 5.0 * self.prm.gravity.min(1.0);
        let sub_bg = ((dt * k_bg * w0 * 6.0) / 0.45).ceil().max(1.0) as usize;
        let h = &mut self.work;
        for c in 0..n {
            h[c] = self.thick_w[c] + self.dthick[c];
        }
        let mut hn = h.clone();
        let hdt = dt / sub_bg as f64;
        for _ in 0..sub_bg {
            for c in 0..n {
                if self.cont_w[c] == 0 {
                    continue;
                }
                let mut acc = 0.0;
                for &d in self.g.nb(c) {
                    let d = d as usize;
                    if self.cont_w[d] != 0 {
                        acc += (h[d] - h[c]) as f64;
                    }
                }
                hn[c] = h[c] + (hdt * k_bg * w0 * acc) as f32;
            }
            h.copy_from_slice(&hn);
        }
        // channel flow in thick crust
        // Lower-crustal flow needs hot, very thick crust (Tibet, Altiplano:
        // >55 km). Letting ordinary 42 km crust flow smeared every range
        // into a broad, low rim within a few Myr.
        let k_ch = 4000.0 * self.prm.gravity.min(2.0);
        let phi = |x: f32| (((x - FLOW_ONSET_KM) / 15.0).clamp(0.0, 1.6) as f64).powi(2);
        let active: Vec<u32> = (0..n as u32)
            .filter(|&c| {
                let c = c as usize;
                self.cont_w[c] != 0 && (h[c] > FLOW_ONSET_KM || self.g.nb(c).iter().any(|&d| h[d as usize] > FLOW_ONSET_KM))
            })
            .collect();
        if !active.is_empty() {
            let kmax = k_ch * phi(self.max_thick);
            let nsub = ((dt * kmax * w0 * 6.0) / 0.45).ceil().clamp(1.0, 400.0) as usize;
            let sdt = dt / nsub as f64;
            for _ in 0..nsub {
                for &c in &active {
                    let c = c as usize;
                    let mut acc = 0.0;
                    for &d in self.g.nb(c) {
                        let d = d as usize;
                        if self.cont_w[d] == 0 {
                            continue;
                        }
                        let k = k_ch * phi(h[c].max(h[d]));
                        acc += k * (h[d] - h[c]) as f64;
                    }
                    hn[c] = h[c] + (sdt * w0 * acc) as f32;
                }
                for &c in &active {
                    h[c as usize] = hn[c as usize];
                }
            }
        }
        for c in 0..n {
            if self.cont_w[c] != 0 {
                let before = self.dthick[c];
                self.dthick[c] = h[c] - self.thick_w[c];
                self.stats.budget[6] += (self.dthick[c] - before) as f64 * self.g.area[c];
            }
        }
    }

    /// Relief-driven erosion (Ahnert: denudation ≈ 0.1535·relief per Myr) with
    /// the eroded rock routed downhill and deposited in basins and on shelves.
    fn erosion(&mut self, dt: f64) {
        let n = self.g.n;
        self.compute_elev();
        // descending elevation; the order barely changes step to step, so an
        // adaptive stable sort over last step's order is nearly linear
        let elev = &self.elev;
        let key = |c: u32| {
            let b = elev[c as usize].to_bits();
            let k = if b & 0x8000_0000 != 0 { !b } else { b | 0x8000_0000 };
            !k
        };
        self.order.sort_by_key(|&c| key(c));
        // Sea level from a fixed volume of ocean water (set at the start to
        // give the requested land fraction). Holding the land fraction fixed
        // instead meant every bit of continental growth — arcs, ranges —
        // pushed the sea up over the continents' plains.
        let sea = if flag("TECTO_FIXED_LAND") {
            self.sea_for_land()
        } else {
            // Over hundreds of Myr the ocean trades water with the mantle
            // and the continents are planed toward base level, which keeps
            // Earth's freeboard steady; model that as a slow relaxation of
            // the water volume toward the requested land share (τ 150 Myr).
            // Short-term sea level still follows the basins.
            let target = self.volume_at(self.sea_for_land());
            self.water += (target - self.water) * (1.0 - (-dt / WATER_RELAX_MYR).exp());
            self.sea_for_volume()
        };
        self.sea_level = sea;
        let k = if flag("TECTO_NO_EROSION") { 0.0 } else { 0.1535 * self.prm.erosion };
        let rk = self.prm.radius;
        self.carry.fill(0.0);
        for i in 0..n {
            let c = self.order[i] as usize;
            let e = self.elev[c] as f64 - sea;
            // steepest-descent receiver
            let mut rcv = usize::MAX;
            let mut best = self.elev[c];
            let mut slope: f64 = 0.0;
            for kk in self.g.off[c] as usize..self.g.off[c + 1] as usize {
                let d = self.g.nbrs[kk] as usize;
                if self.elev[d] < best {
                    best = self.elev[d];
                    rcv = d;
                }
                let s = (self.elev[c] - self.elev[d]) as f64 / (self.g.elen[kk] as f64 * rk);
                slope = slope.max(s);
            }
            let mut vol = self.carry[c] as f64; // sr·km of rock
            if e > 0.0 {
                // local relief of the drainage basins Ahnert measured: small on
                // plains (a few % of height), large on steep ground
                // (plains: ~2 m/Myr of rock at 0.5 km, like cratons' cosmogenic rates)
                // (slopes under ~3 m/km are plains — at 60 km cells they are
                // mostly cell-to-cell noise, and letting them count wore the
                // cratons down five times faster than Earth's)
                let relief = (0.015 * e + 80.0 * (slope - 0.003).max(0.0)).min(RELIEF_SHARE * e);
                let rock = (k * relief * dt).min(0.5 * e / 0.1515); // km of crust
                self.dthick[c] -= rock as f32;
                if self.cont_w[c] != 0 {
                    self.stats.budget[3] -= rock * self.g.area[c];
                }
                self.stats.eroded += rock * self.g.area[c];
                vol += rock * self.g.area[c];
            }
            if vol <= 0.0 {
                continue;
            }
            // deposit: sea floor fills toward just below sea level; a land
            // pit fills only to its spill point (at 60 km cells most "pits"
            // are artefacts, and real rivers carry the load on to the sea —
            // trapping it all on land thickened the continents without end);
            // what is left is carried off to the deep ocean.
            if e < -0.15 || rcv == usize::MAX {
                let fac = if self.cont_w[c] != 0 { 0.1515 * 1.45 } else { 0.176 };
                let room = if rcv == usize::MAX {
                    if e > 0.0 {
                        let spill = self.g.nb(c).iter().map(|&d| self.elev[d as usize]).fold(f32::INFINITY, f32::min) as f64 - sea;
                        ((spill - e) / 0.1515).max(0.0)
                    } else {
                        f64::INFINITY
                    }
                } else {
                    ((-0.15 - e) / fac).max(0.0)
                };
                let dep = (vol / self.g.area[c]).min(room);
                self.dthick[c] += dep as f32;
                if self.cont_w[c] != 0 {
                    self.stats.budget[4] += dep * self.g.area[c];
                }
                vol -= dep * self.g.area[c];
            }
            if rcv != usize::MAX && vol > 0.0 {
                self.carry[rcv] += vol as f32;
            }
        }
    }

    /// Writes the world-frame changes back into the plate columns. Each
    /// visible column takes its cell's change exactly once (through the same
    /// cell → column map the view was built with); hidden duplicates follow
    /// the cell they sit under, so they don't resurface stale.
    fn apply_deltas(&mut self, dt: f64) {
        let dtf = dt as f32;
        for c in 0..self.g.n {
            let o = self.owner[c];
            if o < 0 {
                continue;
            }
            let p = &mut self.plates[o as usize];
            let s = self.oslot[c] as usize;
            if p.vis[s] != 1 {
                continue; // already updated through another cell
            }
            p.vis[s] = 2;
            p.thick[s] += self.dthick[c];
            if self.oro_set[c] != 0 {
                p.oro[s] = self.oro_set[c];
                p.oro_age[s] = 0.0;
            }
        }
        for pi in 0..self.plates.len() {
            let p = &mut self.plates[pi];
            for s in 0..p.cell.len() {
                if !p.alive[s] {
                    continue;
                }
                let c = p.world[s] as usize;
                if p.vis[s] == 0 && self.owner[c] == pi as i32 {
                    p.thick[s] += self.dthick[c];
                    if self.oro_set[c] != 0 {
                        p.oro[s] = self.oro_set[c];
                        p.oro_age[s] = 0.0;
                    }
                }
                p.age[s] += dtf;
                p.oro_age[s] += dtf;
                if p.cont[s] != 0 && p.thick[s] < CONT_MIN {
                    // stretched to breakup: becomes (cold, deep) sea floor
                    self.stats.cont_lost += self.g.area[p.cell[s] as usize];
                    p.cont[s] = 0;
                    p.age[s] = RIFTED_OCEAN_AGE;
                } else if p.cont[s] == 0 && p.thick[s] > BASIN_TO_CONT && p.age[s] > 50.0 {
                    // Old sea floor buried under ~13 km or more of sediment (a
                    // trapped basin like the Caspian, or the foot of a big
                    // delta) no longer behaves as oceanic plate: too buoyant
                    // to sink, it is from here on the floor of a
                    // continental basin, and fills up like one.
                    p.cont[s] = 1;
                    self.stats.conv_arc += self.g.area[p.cell[s] as usize];
                } else if p.cont[s] == 0
                    && p.thick[s] > ARC_TO_CONT
                    && p.oro_age[s] < 10.0
                    && matches!(p.oro[s], oro::ARC | oro::ANDEAN | oro::HOTSPOT)
                {
                    // magmatic (arc / plateau) crust is buoyant
                    p.cont[s] = 1;
                    let a = self.g.area[p.cell[s] as usize];
                    if p.oro[s] == oro::HOTSPOT { self.stats.conv_hot += a } else { self.stats.conv_arc += a }
                }
                p.thick[s] = p.thick[s].clamp(3.0, self.max_thick);
            }
        }
    }

    // -----------------------------------------------------------------
    // dynamics

    fn forces(&mut self, dt: f64) {
        let n = self.g.n;
        let np = self.plates.len();
        let mut m = vec![[[0.0f64; 3]; 3]; np];
        let mut m0 = vec![[[0.0f64; 3]; 3]; np];
        let mut tq = vec![[0.0f64; 3]; np];
        let mut tm = vec![[0.0f64; 3]; np];
        self.compute_elev();
        // mantle flow drifts slowly (≈150 Myr memory)
        {
            let k = MANTLE_FLOW * self.vigour() / self.prm.radius;
            let a = (-dt / 150.0).exp();
            let b = (1.0 - a * a).sqrt();
            let fade = (-dt / RIFT_DRIVE_MYR).exp();
            let floor = 0.05 * RIFT_DRIVE * self.vigour() / self.prm.radius;
            for mc in &mut self.mantle {
                if !mc.lasting {
                    mc.omega = scale(mc.omega, fade);
                    continue;
                }
                let kick = scale(self.rng.unit_vec(), k * self.rng.normal().abs());
                mc.omega = add(scale(mc.omega, a), scale(kick, b));
                mc.centre = normalize(add(mc.centre, scale(self.rng.unit_vec(), 0.05 * dt.sqrt())));
            }
            self.mantle.retain(|mc| mc.lasting || len(mc.omega) > floor);
        }
        for c in 0..n {
            let o = self.owner[c];
            if o < 0 {
                continue;
            }
            let o = o as usize;
            let p = self.g.pos[c];
            let a = self.g.area[c];
            let w = if self.cont_w[c] != 0 { DRAG_CONT } else { 1.0 };
            let mut om = [0.0; 3];
            for mc in &self.mantle {
                // Gaussian in chord distance (≈ angle for the sizes used)
                let d2 = 2.0 - 2.0 * dot(p, mc.centre);
                let g = (-d2 / (mc.radius * mc.radius)).exp();
                om = add(om, scale(mc.omega, g));
            }
            for i in 0..3 {
                for j in 0..3 {
                    let v = (if i == j { 1.0 } else { 0.0 }) - p[i] * p[j];
                    m[o][i][j] += w * a * v;
                    m0[o][i][j] += a * v;
                    tm[o][i] += w * a * v * om[j];
                }
            }
            // gravitational sliding: −∇h within the plate (ridge push, plateau push)
            let mut grad = [0.0; 3];
            let mut cnt = 0;
            for &d in self.g.nb(c) {
                let d = d as usize;
                if self.owner[d] as usize != o {
                    continue;
                }
                let dv = sub(self.g.pos[d], p);
                let l2 = dot(dv, dv);
                grad = add(grad, scale(dv, (self.elev[d] - self.elev[c]) as f64 / l2));
                cnt += 1;
            }
            if cnt > 0 {
                let f = scale(tangent(grad, p), -K_GPE * a * 2.0 / self.g.nb(c).len() as f64);
                tq[o] = add(tq[o], cross(p, f));
            }
        }
        // Old sea floor is gravitationally unstable: where it borders younger
        // or continental crust of another plate it starts to sink on its own
        // (spontaneous subduction initiation), seeding a slab that then pulls.
        for c in 0..n {
            let o = self.owner[c];
            if o < 0 || self.cont_w[c] != 0 || self.age_w[c] < FOUNDER_AGE {
                continue;
            }
            let age = self.age_w[c];
            let younger_neighbour = self.g.nb(c).iter().any(|&d| {
                let d = d as usize;
                // intra-oceanic initiation (Izu–Bonin style): old floor against
                // clearly younger floor of another plate; or old floor broken
                // away from a passive margin, against the continent it left
                self.owner[d] >= 0 && self.owner[d] != o && (self.cont_w[d] != 0 || self.age_w[d] + 30.0 < age)
            });
            if younger_neighbour {
                let f = ((age - FOUNDER_AGE) / 100.0).min(1.0) as f64;
                self.slab[c] += (self.g.area[c] * f * dt / 4.0) as f32;
                self.slab_pid[c] = self.owner_id[c];
            }
        }
        // slab pull
        for c in 0..n {
            if self.slab[c] < 1e-9 {
                continue;
            }
            let Some(li) = self.idx(self.slab_pid[c]) else { continue };
            let p = self.g.pos[c];
            let mut dir = [0.0; 3];
            let (mut ins, mut outs) = (0, 0);
            for &d in self.g.nb(c) {
                let d = d as usize;
                let v = sub(self.g.pos[d], p);
                if self.owner[d] == li as i32 {
                    dir = sub(dir, v);
                    ins += 1;
                } else {
                    dir = add(dir, v);
                    outs += 1;
                }
            }
            if ins == 0 || outs == 0 {
                continue;
            }
            let f = scale(normalize(tangent(dir, p)), K_SLAB * self.slab[c] as f64);
            tq[li] = add(tq[li], cross(p, f));
        }
        // collision resistance
        for c in 0..n {
            if self.cz[c] < 0.01 {
                continue;
            }
            let (Some(lo), Some(top)) = (self.idx(self.cz_low[c]), self.idx(self.cz_top[c])) else { continue };
            if lo == top {
                continue;
            }
            let p = self.g.pos[c];
            // resist only the closing motion: a collision zone must not glue
            // plates that have started to pull apart or slide past
            let mut toward_lo = [0.0; 3];
            for &d in self.g.nb(c) {
                if self.owner[d as usize] == lo as i32 {
                    toward_lo = add(toward_lo, sub(self.g.pos[d as usize], p));
                }
            }
            let nrm = tangent(toward_lo, p);
            if len(nrm) < 1e-12 {
                continue;
            }
            let nrm = normalize(nrm);
            let rel = sub(self.vel(lo, c), self.vel(top, c));
            let conv = -dot(rel, nrm);
            if conv <= 0.0 {
                continue;
            }
            let f = scale(nrm, K_COLL * self.cz[c] as f64 * self.g.area[c] * (conv / 10.0).min(1.0));
            tq[lo] = add(tq[lo], cross(p, f));
            tq[top] = sub(tq[top], cross(p, f));
        }
        // torque balance against basal drag → target angular velocities
        let rk = self.prm.radius;
        // plate-boundary forces (scaled below) and mantle drag (physical units)
        let mut wf = vec![[0.0; 3]; np];
        let mut wm = vec![[0.0; 3]; np];
        for i in 0..np {
            let a = self.plates[i].area.max(1e-9);
            let mut mi = m[i];
            for (d, row) in mi.iter_mut().enumerate() {
                row[d] += 0.05 * a;
            }
            wf[i] = solve3(mi, tq[i]).unwrap_or([0.0; 3]);
            wm[i] = solve3(mi, tm[i]).unwrap_or([0.0; 3]);
        }
        // choose the force scale so the area-weighted RMS speed matches the
        // mantle's vigour (constant heat flow): |s·wf + wm|² = target²
        let quad = |x: V3, y: V3, mm: &[[f64; 3]; 3]| {
            let mut q = 0.0;
            for a in 0..3 {
                for b in 0..3 {
                    q += x[a] * mm[a][b] * y[b];
                }
            }
            q
        };
        let (mut qa, mut qb, mut qc, mut den) = (0.0, 0.0, 0.0, 0.0);
        for i in 0..np {
            qa += quad(wf[i], wf[i], &m0[i]);
            qb += quad(wf[i], wm[i], &m0[i]);
            qc += quad(wm[i], wm[i], &m0[i]);
            den += self.plates[i].area;
        }
        let tgt2 = (self.prm.mean_speed / rk).powi(2) * den;
        let s = if qa > 1e-30 {
            let disc = (qb * qb - qa * (qc - tgt2)).max(0.0);
            ((-qb + disc.sqrt()) / qa).max(0.0)
        } else {
            0.0
        };
        let relax = 1.0 - (-dt / 8.0).exp();
        for (i, p) in self.plates.iter_mut().enumerate() {
            let mut t = add(scale(wf[i], s), wm[i]);
            let sp = len(t) * rk;
            if sp > MAX_SPEED {
                t = scale(t, MAX_SPEED / sp);
            }
            p.omega = add(p.omega, scale(sub(t, p.omega), relax));
        }
    }

    // -----------------------------------------------------------------
    // events

    fn events(&mut self, dt: f64) {
        // (1) splits that use the resolved world view (indices still valid)
        if self.time >= self.next_check {
            self.next_check = self.time + INIT_CHECK_MYR;
            if flag("TECTO_TRACE") {
                for p in &self.plates {
                    eprintln!("trace t={:.0} id {} area {:.4} cont {:.4} speed {:.0} age {:.0}", self.time, p.id, p.area, p.cont_area, len(p.omega) * self.prm.radius, p.age_myr);
                }
            }
            // a plate cut in two (consumed through its middle, or rifted
            // along a ragged line) must not move its pieces rigidly together
            if self.split_pieces() {
                self.coverage(true);
                self.fill_gaps(0.0, true);
                self.gather_world();
            }
            // physical need beats the plate budget: cleanup merges the
            // smallest plate away if this pushes the count over the limit.
            // Up to three new subduction zones per check.
            for _ in 0..3 {
                if !self.subduction_initiation() {
                    break;
                }
                self.stats.sub_inits += 1;
                // plate indices changed: refresh the view before anything reads it
                self.coverage(true);
                self.fill_gaps(0.0, true);
                self.gather_world();
            }
        }
        // (2) continental rifting (Poisson; big continents rift more often)
        {
            let mut chosen = None;
            for i in 0..self.plates.len() {
                let p = &self.plates[i];
                let f = p.cont_area / TAU;
                if f < 0.012 || p.age_myr < 25.0 {
                    continue;
                }
                // Big continents trap mantle heat and rift; small ones rarely
                // do. A large continent (Africa, Eurasia: 6–10 % of the
                // surface) rifts about once in 500 Myr, a small one (Australia:
                // under 2 %) about once in 2 Gyr, a supercontinent within a few
                // tens of Myr. More than that and rifts outrun collisions:
                // the land ends up in ever more, ever smaller pieces.
                let lambda = self.prm.rift_rate * (1.0 / 2000.0 + smoothstep(0.02, 0.08, f) / 650.0 + smoothstep(0.15, 0.30, f) / 40.0);
                if self.rng.f() < lambda * dt {
                    chosen = Some(i);
                    break;
                }
            }
            if let Some(i) = chosen {
                if self.rift(i, true, false) {
                    self.stats.rifts += 1;
                }
            }
            // very large plates break up too (like the Pacific's ancestors)
            let big = (0..self.plates.len()).find(|&i| self.plates[i].area / TAU > 0.3 && self.plates[i].age_myr > 25.0);
            if let Some(i) = big {
                if self.rng.f() < dt / 100.0 && self.rift(i, false, false) {
                    self.stats.ocean_splits += 1;
                }
            }
        }
        // (3) suturing
        let mut merge = None;
        let mut ended = None;
        for (&(a, b), v) in &self.pair_coll {
            let (Some(ia), Some(ib)) = (self.idx(a), self.idx(b)) else { continue };
            // Two continents weld into one plate when their collision dies
            // down — not at a set amount of shortening: India has driven
            // ~2000 km into Asia and is still going, the Urals stopped early.
            // A real collision (not a glancing touch) whose vigour has fallen
            // to half its peak is over. Driving in the whole smaller
            // continent ends it too.
            let small = self.plates[ia].cont_area.min(self.plates[ib].cont_area);
            // (at least a handful of cells, and a lull that lasts, so the
            // dice of a slow, short front don't decide it)
            let real = (0.1 * small).clamp(0.0005, 0.003).max(8.0 * TAU / self.g.n as f64);
            let waned = v.peak > real && v.waning > 10.0;
            if !(waned || v.total > small.clamp(0.01, 0.25)) {
                continue;
            }
            // still touching? A collision that ended because the plates
            // moved apart (or one of them rifted) welds nothing.
            let mut contact = 0;
            for c in 0..self.g.n {
                if self.cont_w[c] == 0 || self.owner_id[c] != a {
                    continue;
                }
                contact += self.g.nb(c).iter().filter(|&&d| self.owner_id[d as usize] == b && self.cont_w[d as usize] != 0).count();
            }
            if contact >= 3 {
                merge = Some((ia, ib, a, b));
            } else {
                ended = Some((a, b));
            }
            break;
        }
        if let Some(key) = ended {
            self.pair_coll.remove(&key);
        }
        if let Some((ia, ib, a, b)) = merge {
            let (keep, gone) = if self.plates[ia].area >= self.plates[ib].area { (ia, ib) } else { (ib, ia) };
            if std::env::var("TECTO_DEBUG").is_ok() {
                let v = self.pair_coll[&(a, b)];
                eprintln!("t={:.0} suture: consumed {:.4} sr (peak {:.4}, recent {:.4}), continents {:.3} and {:.3} sr", self.time, v.total, v.peak, v.recent, self.plates[ia].cont_area, self.plates[ib].cont_area);
            }
            self.pair_coll.remove(&(a, b));
            self.merge(keep, gone, true);
            self.stats.merges += 1;
        }
        // (4) cleanup: dead plates and slivers
        self.cleanup();
        // (5) keep the plate count in range
        while self.plates.len() < self.prm.min_plates {
            let i = (0..self.plates.len())
                .max_by(|&a, &b| self.plates[a].area.partial_cmp(&self.plates[b].area).unwrap())
                .unwrap();
            let cont = self.plates[i].cont_area / TAU > 0.012;
            if !self.rift(i, cont, false) && !self.rift(i, false, false) {
                break;
            }
        }
    }

    /// Connected groups of plate `pi`'s columns in its own frame (hidden
    /// columns count: a plate overridden across its middle is still one
    /// plate). Returns the group of each slot (u32::MAX for dead slots)
    /// and each group's area. `side` optionally restricts the flood to
    /// slots with the same flag.
    fn slot_groups(&self, pi: usize, side: Option<&[bool]>) -> (Vec<u32>, Vec<f64>) {
        let p = &self.plates[pi];
        let mut grp = vec![u32::MAX; p.cell.len()];
        let mut areas = vec![];
        let mut st = vec![];
        for s0 in p.slots() {
            if grp[s0] != u32::MAX {
                continue;
            }
            let k = areas.len() as u32;
            let mut a = 0.0;
            grp[s0] = k;
            st.clear();
            st.push(s0);
            while let Some(s) = st.pop() {
                let r = p.cell[s] as usize;
                a += self.g.area[r];
                for &d in self.g.nb(r) {
                    let t = p.slot_of[d as usize];
                    if t == EMPTY {
                        continue;
                    }
                    let t = t as usize;
                    if grp[t] == u32::MAX && side.is_none_or(|f| f[t] == f[s]) {
                        grp[t] = k;
                        st.push(t);
                    }
                }
            }
            areas.push(a);
        }
        (grp, areas)
    }

    /// A plate whose crust has come apart (consumed through its middle)
    /// must not move its pieces rigidly together: pieces above sliver size
    /// become plates of their own. Returns whether anything changed.
    fn split_pieces(&mut self) -> bool {
        let min_area = 0.0015 * TAU;
        let mut changed = false;
        let np = self.plates.len();
        for pi in 0..np {
            let (grp, areas) = self.slot_groups(pi, None);
            if areas.len() < 2 {
                continue;
            }
            let main = (0..areas.len()).max_by(|&a, &b| areas[a].total_cmp(&areas[b])).unwrap();
            // pieces as local cells: each split may compact the plate and
            // renumber its slots, so slots are looked up only when used
            let mut cells: Vec<Vec<u32>> = vec![vec![]; areas.len()];
            for s in self.plates[pi].slots() {
                cells[grp[s] as usize].push(self.plates[pi].cell[s]);
            }
            for (k, &a) in areas.iter().enumerate() {
                if k == main || a < min_area {
                    continue;
                }
                let p = &self.plates[pi];
                let slots: Vec<usize> = cells[k].iter().map(|&r| p.slot_of[r as usize]).filter(|&t| t != EMPTY).map(|t| t as usize).collect();
                // a small piece joins the plate it borders most (by the
                // view); only a large one carries on as a plate of its own
                let mut into = None;
                if a < 4.0 * min_area {
                    let mut border: BTreeMap<u32, u32> = BTreeMap::new();
                    for &s in &slots {
                        for &d in self.g.nb(p.world[s] as usize) {
                            let o = self.owner_id[d as usize];
                            if o != NONE && o != p.id {
                                *border.entry(o).or_insert(0) += 1;
                            }
                        }
                    }
                    into = border.iter().max_by_key(|(id, v)| (**v, std::cmp::Reverse(**id))).map(|(id, _)| *id);
                }
                let (omega, age, id, quiet) = (p.omega, p.age_myr, p.id, p.quiet_until);
                if let Some(ni) = self.split(pi, &slots, omega) {
                    self.plates[ni].age_myr = age;
                    self.plates[ni].quiet_until = quiet;
                    changed = true;
                    if std::env::var("TECTO_DEBUG").is_ok() {
                        eprintln!("t={:.0} detached piece of id {} ({:.4} sr)", self.time, id, a);
                    }
                    if let Some(keep) = into.and_then(|t| self.idx(t)) {
                        if keep != ni {
                            // (ni is the last plate, so no index shifts)
                            self.merge(keep, ni, false);
                        }
                    }
                }
            }
        }
        changed
    }

    fn cleanup(&mut self) {
        // dead
        let before = self.plates.len();
        self.plates.retain(|p| p.live > 0);
        if self.plates.len() != before {
            self.stats.removed += (before - self.plates.len()) as u32;
            self.rebuild_ids();
        }
        // slivers and excess plates merge into their main neighbour
        let min_area = 0.0015 * TAU;
        let mut slab_of: BTreeMap<u32, f64> = BTreeMap::new();
        for c in 0..self.g.n {
            if self.slab[c] > 0.0 {
                *slab_of.entry(self.slab_pid[c]).or_insert(0.0) += self.slab[c] as f64;
            }
        }
        loop {
            let np = self.plates.len();
            if np <= 2 {
                break;
            }
            let over = np > self.prm.max_plates;
            // Over budget, the smallest *established* plate goes: merging a
            // just-born plate straight back into its parent undid every new
            // subduction zone once the budget was full.
            let smallest = |ok: &dyn Fn(usize) -> bool| {
                (0..np).filter(|&i| ok(i)).min_by(|&a, &b| self.plates[a].area.total_cmp(&self.plates[b].area))
            };
            // ...and preferably one without a sinking slab: a plate being
            // pulled down a trench is the one recycling old sea floor
            let pulling = |i: usize| slab_of.get(&self.plates[i].id).copied().unwrap_or(0.0) > 1e-4 * self.plates[i].area;
            let cand = smallest(&|i| self.plates[i].area < min_area).or_else(|| {
                if over {
                    smallest(&|i| self.plates[i].age_myr >= 40.0 && !pulling(i))
                        .or_else(|| smallest(&|i| self.plates[i].age_myr >= 40.0))
                        .or_else(|| smallest(&|_| true))
                } else {
                    None
                }
            });
            let Some(small) = cand else { break };
            let Some(into) = self.main_neighbour(small) else { break };
            self.merge(into, small, false);
            self.stats.removed += 1;
        }
    }

    /// The plate sharing the most world-grid edges with plate `pi` (by the
    /// current view; falls back to the nearest plate centre).
    fn main_neighbour(&self, pi: usize) -> Option<usize> {
        let id = self.plates[pi].id;
        let mut counts: BTreeMap<u32, u32> = BTreeMap::new();
        for c in 0..self.g.n {
            if self.owner_id[c] != id {
                continue;
            }
            for &d in self.g.nb(c) {
                let o = self.owner_id[d as usize];
                if o != id && o != NONE {
                    *counts.entry(o).or_insert(0) += 1;
                }
            }
        }
        let best = counts.iter().filter(|(k, _)| self.idx(**k).is_some()).max_by_key(|(_, v)| **v).map(|(k, _)| *k);
        if let Some(b) = best {
            return self.idx(b);
        }
        let cen = self.plates[pi].q.rotate(self.plates[pi].cen);
        (0..self.plates.len()).filter(|&j| j != pi).max_by(|&a, &b| {
            let da = dot(self.plates[a].q.rotate(self.plates[a].cen), cen);
            let db = dot(self.plates[b].q.rotate(self.plates[b].cen), cen);
            da.partial_cmp(&db).unwrap()
        })
    }

    /// Moves all crust of plate `gone` into plate `keep` (momentum-weighted
    /// motion). `suture`: a collision merge (restarts the rifting clock);
    /// sliver cleanup leaves the keeper's clock alone.
    ///
    /// The crust is gathered, not scattered: every cell of `keep`'s frame
    /// under `gone`'s footprint samples `gone` once. Scattering each column
    /// to its nearest cell left holes (two columns on one cell) and stacked
    /// a column onto its own twin (thickness spikes).
    fn merge(&mut self, keep: usize, gone: usize, suture: bool) {
        if keep == gone {
            return;
        }
        if std::env::var("TECTO_DEBUG").is_ok() {
            eprintln!("t={:.0} merge id {} (area {:.3}) into id {} (area {:.3})", self.time, self.plates[gone].id, self.plates[gone].area, self.plates[keep].id, self.plates[keep].area);
        }
        let b = self.plates.remove(gone);
        let keep = if gone < keep { keep - 1 } else { keep };
        let g = &self.g;
        // cells of keep's frame that b's columns land on, plus one ring
        self.stamp = self.stamp.wrapping_add(1).max(1);
        let st = self.stamp;
        let a_inv = self.plates[keep].q.conj();
        let to_b = b.q.conj().mul(self.plates[keep].q);
        let mut cand: Vec<u32> = vec![];
        for s in b.slots() {
            let r = g.nearest_from(a_inv.rotate(b.q.rotate(g.pos[b.cell[s] as usize])), b.world[s] as usize);
            for d in std::iter::once(r as u32).chain(g.nb(r).iter().copied()) {
                if self.mark[d as usize] != st {
                    self.mark[d as usize] = st;
                    cand.push(d);
                }
            }
        }
        cand.sort_unstable();
        let a = &mut self.plates[keep];
        let (wa, wb) = (a.area.max(1e-12), b.area.max(0.0));
        a.omega = scale(add(scale(a.omega, wa), scale(b.omega, wb)), 1.0 / (wa + wb));
        for &r in &cand {
            let r = r as usize;
            let rb = g.nearest(to_b.rotate(g.pos[r]));
            let sb = b.slot_of[rb];
            if sb == EMPTY {
                continue;
            }
            let sb = sb as usize;
            let ts = a.slot_of[r];
            if ts == EMPTY {
                let w = g.nearest_from(a.q.rotate(g.pos[r]), b.world[sb] as usize);
                a.add(r, w, b.thick[sb], b.age[sb], b.cont[sb], b.oro[sb], b.oro_age[sb]);
            } else {
                let ts = ts as usize;
                if b.cont[sb] != 0 && a.cont[ts] != 0 {
                    // continent still under continent at the suture: shortened
                    // into the belt like the rest of the collision (stacking it
                    // on the spot left single cells 80–90 km thick)
                    self.coll_in[a.world[ts] as usize] += b.thick[sb] * g.area[r] as f32;
                } else if b.cont[sb] != 0 {
                    a.thick[ts] = b.thick[sb];
                    a.cont[ts] = 1;
                    a.age[ts] = b.age[sb];
                    a.oro[ts] = b.oro[sb];
                    a.oro_age[ts] = b.oro_age[sb];
                }
            }
        }
        if suture {
            a.age_myr = 0.0;
        }
        let bid = b.id;
        self.pair_coll.retain(|k, _| k.0 != bid && k.1 != bid);
        self.rebuild_ids();
        self.update_bounds();
    }

    /// Splits plate `pi`. Continental rifts cut through the continent's
    /// centre and open like a hinge; ocean splits cut large oceanic plates.
    /// `converge`: make the halves close instead (old ocean breaking to subduct).
    fn rift(&mut self, pi: usize, continental: bool, converge: bool) -> bool {
        let rk = self.prm.radius;
        let p = &self.plates[pi];
        let q = p.q;
        let mut cc = [0.0; 3];
        let mut total_c = 0.0;
        for s in p.slots() {
            let r = p.cell[s] as usize;
            if !continental || p.cont[s] != 0 {
                cc = add(cc, scale(q.rotate(self.g.pos[r]), self.g.area[r]));
                total_c += self.g.area[r];
            }
        }
        if total_c <= 0.0 {
            return false;
        }
        let cc = normalize(cc);
        let mut plan = None;
        for _ in 0..8 {
            let nrm = normalize(tangent(self.rng.unit_vec(), cc));
            let off = scale(self.rng.unit_vec(), 7.0);
            let side = |w: V3| dot(w, nrm) + 0.15 * self.noise.fbm(add(w, off), 3.0, 4);
            let mut plus = 0.0;
            for s in p.slots() {
                let r = p.cell[s] as usize;
                if (!continental || p.cont[s] != 0) && side(q.rotate(self.g.pos[r])) > 0.0 {
                    plus += self.g.area[r];
                }
            }
            let frac = plus / total_c;
            if (0.25..=0.75).contains(&frac) {
                plan = Some((nrm, off));
                break;
            }
        }
        if std::env::var("TECTO_DEBUG").is_ok() {
            eprintln!("rift attempt plate {} continental {} plan {}", pi, continental, plan.is_some());
        }
        let Some((nrm, off)) = plan else { return false };
        let side = |w: V3| dot(w, nrm) + 0.15 * self.noise.fbm(add(w, off), 3.0, 4);
        let theta = self.rng.range(-0.8, 0.8);
        let axis = normalize(add(scale(cross(cc, nrm), theta.cos()), scale(cc, theta.sin())));
        let speed = if continental {
            self.rng.range(15.0, 35.0)
        } else if converge {
            -self.rng.range(20.0, 40.0)
        } else {
            self.rng.range(8.0, 25.0) * if self.rng.f() < 0.5 { -1.0 } else { 1.0 }
        };
        let k = speed / rk;
        let mut plus_slots = vec![];
        let thin_w = 350.0 / rk;
        let p = &mut self.plates[pi];
        for s in 0..p.cell.len() {
            if !p.alive[s] {
                continue;
            }
            let w = q.rotate(self.g.pos[p.cell[s] as usize]);
            let sd = side(w);
            if sd > 0.0 {
                plus_slots.push(s);
            }
            if continental && p.cont[s] != 0 && sd.abs() < thin_w && !flag("TECTO_NO_RIFTTHIN") {
                let x = sd.abs() * rk;
                // lithospheric stretching: β ≈ 2.5 on the rift axis, fading
                // over ~250 km — this is what leaves tapered passive margins
                p.thick[s] *= 1.0 - 0.6 * (-(x / 120.0).powi(2)).exp() as f32;
                if x < 150.0 {
                    p.oro[s] = oro::RIFT;
                    p.oro_age[s] = 0.0;
                }
            }
        }
        let w0 = p.omega;
        // The cut line wanders (noise), and far from the rift it can leave
        // islands of one side inside the other: both halves must be single
        // connected pieces, or each moves as a scattered rigid plate.
        let plus_slots = self.connected_side(pi, &plus_slots);
        let Some(ni) = self.split(pi, &plus_slots, add(w0, scale(axis, k))) else { return false };
        self.plates[pi].age_myr = 0.0;
        self.plates[ni].age_myr = 0.0;
        self.plates[pi].omega = sub(w0, scale(axis, k));
        if continental {
            // What breaks a continent keeps pushing: the upwelling under the
            // rift spreads sideways and carries the two halves apart for tens
            // of Myr. Without it the first push died in a few Myr and the
            // rift stalled as a long, narrow sea — and the next rift cut
            // another strip beside it.
            let kd = RIFT_DRIVE * self.vigour() / rk;
            for sgn in [1.0, -1.0] {
                self.mantle.push(MantleCell {
                    centre: normalize(add(cc, scale(nrm, sgn * 0.35))),
                    omega: scale(axis, sgn * kd),
                    radius: 0.45,
                    lasting: false,
                });
            }
        }
        true
    }

    /// Cleans a two-way cut of plate `pi` (`plus` = slots of one side) so
    /// both sides are connected: stray islands join the side around them.
    fn connected_side(&self, pi: usize, plus: &[usize]) -> Vec<usize> {
        let p = &self.plates[pi];
        let mut side = vec![false; p.cell.len()];
        for &s in plus {
            side[s] = true;
        }
        for _ in 0..2 {
            let (grp, areas) = self.slot_groups(pi, Some(&side));
            // the largest group on each side stays; every other group flips
            let mut best = [(-1.0f64, u32::MAX); 2];
            for s in p.slots() {
                let g = grp[s];
                let b = &mut best[side[s] as usize];
                if areas[g as usize] > b.0 || (areas[g as usize] == b.0 && g < b.1) {
                    *b = (areas[g as usize], g);
                }
            }
            let mut flipped = false;
            for s in 0..side.len() {
                if p.alive[s] && grp[s] != best[side[s] as usize].1 {
                    side[s] = !side[s];
                    flipped = true;
                }
            }
            if !flipped {
                break;
            }
        }
        p.slots().filter(|&s| side[s]).collect()
    }

    /// Moves `slots` of plate `pi` into a new plate with angular velocity `omega`.
    fn split(&mut self, pi: usize, slots: &[usize], omega: V3) -> Option<usize> {
        let p = &mut self.plates[pi];
        if slots.is_empty() || slots.len() >= p.live {
            return None;
        }
        if std::env::var("TECTO_DEBUG").is_ok() {
            eprintln!("t={:.0} split id {} → new id {} ({} of {} slots)", self.time, p.id, self.next_id, slots.len(), p.live);
        }
        let mut np = Plate::new(self.next_id, self.g.n, p.q, omega);
        for &s in slots {
            if !p.alive[s] {
                continue;
            }
            np.add(p.cell[s] as usize, p.world[s] as usize, p.thick[s], p.age[s], p.cont[s], p.oro[s], p.oro_age[s]);
            p.remove(s);
        }
        // (the parent keeps its age: shedding old sea floor must not reset
        // a continent's rifting clock — it used to, every 25 Myr, so
        // supercontinents never broke up)
        self.next_id += 1;
        self.plates.push(np);
        self.rebuild_ids();
        self.update_bounds();
        Some(self.plates.len() - 1)
    }

    /// Old ocean floor starts to sink: at an old passive margin the ocean
    /// breaks away and moves toward the continent (Atlantic → future
    /// Andes); very old crust in all-ocean plates founders on its own.
    fn subduction_initiation(&mut self) -> bool {
        let n = self.g.n;
        let rk = self.prm.radius;
        let np = self.plates.len();
        let start = self.rng.below(np);
        for k in 0..np {
            let pi = (start + k) % np;
            // one breakaway at a time: a plate that has just shed old floor
            // (or is that floor) is left alone while the new trench works
            if self.time < self.plates[pi].quiet_until {
                continue;
            }
            let mut oldest = (0.0f32, usize::MAX);
            let mut conts = vec![];
            for c in 0..n {
                if self.owner[c] != pi as i32 {
                    continue;
                }
                if self.cont_w[c] != 0 {
                    conts.push(c as u32);
                } else if self.age_w[c] > oldest.0 {
                    oldest = (self.age_w[c], c);
                }
            }
            if oldest.1 == usize::MAX {
                continue;
            }
            // Passive margins turn active only when old (the Atlantic's
            // 180 Myr-old edges are only now starting to), and only the old
            // stretch breaks away — turning whole coastlines active every few
            // tens of Myr ringed every continent with cordilleras.
            let margin = !conts.is_empty() && oldest.0 > 180.0;
            let lone = conts.is_empty() && oldest.0 > 180.0;
            if !margin && !lone {
                continue;
            }
            // breakaway region: the old floor itself (older than 140 Myr at a
            // margin, 110 Myr in an all-ocean plate); its largest connected stretch
            let min_age = if margin { 140.0 } else { 110.0 };
            let far: Vec<bool> = (0..n).map(|c| self.age_w[c] > min_age).collect();
            // breakaway: the largest connected stretch of old floor (the
            // single oldest cell is often an isolated survivor)
            self.stamp = self.stamp.wrapping_add(1).max(1);
            let st = self.stamp;
            let mut comp: Vec<u32> = vec![];
            let mut best_area = 0.0;
            let mut cur: Vec<u32> = vec![];
            for c0 in 0..n {
                if self.mark[c0] == st || self.owner[c0] != pi as i32 || self.cont_w[c0] != 0 || !far[c0] {
                    continue;
                }
                cur.clear();
                cur.push(c0 as u32);
                self.mark[c0] = st;
                let mut i = 0;
                let mut a = 0.0;
                while i < cur.len() {
                    let c = cur[i] as usize;
                    i += 1;
                    a += self.g.area[c];
                    for &d in self.g.nb(c) {
                        let d = d as usize;
                        if self.mark[d] != st && self.owner[d] == pi as i32 && self.cont_w[d] == 0 && far[d] {
                            self.mark[d] = st;
                            cur.push(d as u32);
                        }
                    }
                }
                if a > best_area {
                    best_area = a;
                    std::mem::swap(&mut comp, &mut cur);
                }
            }
            if comp.is_empty() {
                continue;
            }
            // re-mark only the chosen stretch
            self.stamp = self.stamp.wrapping_add(1).max(1);
            let st = self.stamp;
            for &c in &comp {
                self.mark[c as usize] = st;
            }
            let area: f64 = comp.iter().map(|&c| self.g.area[c as usize]).sum();
            let parea = self.plates[pi].area;
            if std::env::var("TECTO_DEBUG").is_ok() {
                eprintln!("t={:.0} init? plate {} margin {} oldest {:.0} comp {:.4} plate {:.4} conts {}", self.time, pi, margin, oldest.0, area, parea, conts.len());
            }
            if area < 0.0016 * TAU {
                continue;
            }
            let quiet = self.time + INIT_QUIET_MYR;
            if !margin && area > 0.85 * parea {
                // the whole plate is old: break it and let one half sink under the other
                if self.rift(pi, false, true) {
                    self.plates[pi].quiet_until = quiet;
                    self.plates.last_mut().unwrap().quiet_until = quiet;
                    return true;
                }
                continue;
            }
            // direction: toward the continent (margin) or the rest of the plate
            let mut co = [0.0; 3];
            for &c in &comp {
                co = add(co, scale(self.g.pos[c as usize], self.g.area[c as usize]));
            }
            let co = normalize(co);
            let mut tgt = [0.0; 3];
            for c in 0..n {
                if self.owner[c] == pi as i32 && self.mark[c] != st && (!margin || self.cont_w[c] != 0) {
                    tgt = add(tgt, scale(self.g.pos[c], self.g.area[c]));
                }
            }
            let t = normalize(tangent(sub(normalize(tgt), co), co));
            let axis = cross(co, t);
            let kk = self.rng.range(25.0, 45.0) / rk;
            let p = &self.plates[pi];
            let slots: Vec<usize> = p.slots().filter(|&s| self.mark[p.world[s] as usize] == st).collect();
            let omega = add(p.omega, scale(axis, kk));
            let Some(ni) = self.split(pi, &slots, omega) else { return false };
            // (a continent's plate may shed other old stretches meanwhile)
            if !margin {
                self.plates[pi].quiet_until = quiet;
            }
            self.plates[ni].quiet_until = quiet;
            return true;
        }
        false
    }

    // -----------------------------------------------------------------
    // output

    /// Hash of the full simulation state (plates, crust, clocks). Two runs
    /// that should be identical must give the same value.
    pub fn fingerprint(&self) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        let mut mix = |v: u64| {
            h ^= v;
            h = h.wrapping_mul(0x100_0000_01b3);
        };
        mix(self.time.to_bits());
        mix(self.sea_level.to_bits());
        for p in &self.plates {
            mix(p.id as u64);
            for v in [p.q.w, p.q.x, p.q.y, p.q.z, p.omega[0], p.omega[1], p.omega[2]] {
                mix(v.to_bits());
            }
            for s in p.slots() {
                mix(p.cell[s] as u64);
                mix(p.thick[s].to_bits() as u64);
                mix(p.age[s].to_bits() as u64);
                mix(p.cont[s] as u64);
            }
        }
        h
    }

    /// Rebuilds the resolved view without advancing time.
    pub fn refresh_view(&mut self) {
        self.dthick.fill(0.0);
        self.coverage(false);
        self.fill_gaps(0.0, false);
        self.gather_world();
    }

    pub fn output(&mut self) {
        self.refresh_view();
        let n = self.g.n;
        for c in 0..n {
            self.out_owner[c] = self.owner[c].max(0) as u32;
            let o = self.oro_w[c];
            self.out_oro[c] = if self.trench[c] > 1.0 && self.cont_w[c] == 0 {
                oro::TRENCH
            } else if o != 0 && self.oroage_w[c] < 40.0 {
                o
            } else if o != 0 && self.cont_w[c] != 0 && self.thick_w[c] > 40.0 {
                oro::ANCIENT
            } else {
                oro::NONE
            };
        }
        self.out_plates.clear();
        for p in &self.plates {
            self.out_plates.extend_from_slice(&[p.id as f64, p.omega[0], p.omega[1], p.omega[2], p.area, p.cont_area, p.age_myr, 0.0]);
        }
        let s = &self.stats;
        let o = &mut self.out_stats;
        o.fill(0.0);
        o[0] = self.time;
        o[1] = s.steps as f64;
        o[2] = s.rifts as f64;
        o[3] = s.merges as f64;
        o[4] = s.sub_inits as f64;
        o[5] = s.ocean_splits as f64;
        o[6] = s.removed as f64;
        o[7] = self.plates.len() as f64;
        o[8] = self.sea_level;
        o[9] = s.subducted_area;
        o[10] = s.created_area;
        o[11] = s.last_dt;
        o[12] = self.plates.iter().map(|p| p.cont_area).sum::<f64>() / TAU;
        o[13] = s.eroded;
        o[14] = (0..self.g.n).filter(|&c| self.cont_w[c] != 0).map(|c| self.g.area[c]).sum::<f64>() / TAU;
        o[15] = s.conv_arc;
        o[16] = s.conv_hot;
        o[17] = s.copy_cont;
        o[18] = s.cont_lost;
        for (i, b) in s.budget.iter().enumerate() {
            o[20 + i] = *b;
        }
        let (mut tv, mut ta) = (0.0, 0.0);
        for c in 0..self.g.n {
            if self.cont_w[c] != 0 {
                tv += self.thick_w[c] as f64 * self.g.area[c];
                ta += self.g.area[c];
            }
        }
        o[27] = tv / ta.max(1e-12);
    }
}

/// Debug switch (native builds only; always off in wasm).
fn flag(name: &str) -> bool {
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::env::var(name).is_ok()
    }
    #[cfg(target_arch = "wasm32")]
    {
        let _ = name;
        false
    }
}

fn hotspot_rate(r: &mut Rng) -> f64 {
    (0.8 * (0.9 * r.normal()).exp()).clamp(0.15, 8.0)
}

impl Sim {
    /// Connected-component areas (% of surface), largest first.
    pub fn components(&self, inside: impl Fn(usize) -> bool) -> Vec<f64> {
        let n = self.g.n;
        let mut seen = vec![false; n];
        let mut out = vec![];
        for s0 in 0..n {
            if seen[s0] || !inside(s0) {
                continue;
            }
            let mut a = 0.0;
            let mut st = vec![s0];
            seen[s0] = true;
            while let Some(c) = st.pop() {
                a += self.g.area[c];
                for &d in self.g.nb(c) {
                    let d = d as usize;
                    if !seen[d] && inside(d) {
                        seen[d] = true;
                        st.push(d);
                    }
                }
            }
            out.push(a / TAU * 100.0);
        }
        out.sort_by(|a, b| b.partial_cmp(a).unwrap());
        out
    }

    /// One-line landmass census (native debugging).
    pub fn census(&mut self) -> String {
        self.refresh_view();
        let n = self.g.n;
        let sea = self.sea_level as f32;
        let land = self.components(|c| self.elev[c] > sea);
        let cont = self.components(|c| self.cont_w[c] != 0);
        let f = |v: &[f64]| {
            let big: Vec<String> = v.iter().filter(|&&x| x >= 1.0).map(|x| format!("{:.1}", x)).collect();
            let mid = v.iter().filter(|&&x| (0.04..1.0).contains(&x)).count();
            format!("[{}] +{} mid", big.join(" "), mid)
        };
        let (mut ca, mut dr) = (0.0, 0.0);
        for c in 0..n {
            if self.cont_w[c] != 0 {
                ca += self.g.area[c];
                if self.elev[c] <= sea {
                    dr += self.g.area[c];
                }
            }
        }
        let (mut oa, mut ot, mut oage, mut ct) = (0.0, 0.0, 0.0, 0.0);
        for c in 0..n {
            if self.cont_w[c] == 0 {
                oa += self.g.area[c];
                ot += self.g.area[c] * self.thick_w[c] as f64;
                oage += self.g.area[c] * self.age_w[c] as f64;
            } else {
                ct += self.g.area[c] * self.thick_w[c] as f64;
            }
        }
        let mut th: Vec<f32> = (0..n).filter(|&c| self.cont_w[c] != 0).map(|c| self.thick_w[c]).collect();
        th.sort_by(|a, b| a.total_cmp(b));
        let q = |p: f64| if th.is_empty() { 0.0 } else { th[((th.len() - 1) as f64 * p) as usize] };
        // old sea floor: share of the ocean older than 200 Myr, and how much
        // of that sits on plates that carry a continent
        let (mut old, mut old_cp, mut amax) = (0.0, 0.0, 0.0f32);
        for c in 0..n {
            if self.cont_w[c] == 0 && self.owner[c] >= 0 {
                amax = amax.max(self.age_w[c]);
                if self.age_w[c] > 200.0 {
                    old += self.g.area[c];
                    let p = &self.plates[self.owner[c] as usize];
                    if p.cont_area > 0.0 {
                        old_cp += self.g.area[c];
                    }
                }
            }
        }
        // very old floor: how thick (sediment-laden) and deep is it?
        let (mut o3a, mut o3t, mut o3e) = (0.0, 0.0, 0.0);
        for c in 0..n {
            if self.cont_w[c] == 0 && self.age_w[c] > 300.0 {
                o3a += self.g.area[c];
                o3t += self.g.area[c] * self.thick_w[c] as f64;
                o3e += self.g.area[c] * (self.elev[c] - sea) as f64;
            }
        }
        let old300 = format!("old>300: {:.2}% of ocean, thick {:.1} km, depth {:.2} km", o3a / oa.max(1e-12) * 100.0, o3t / o3a.max(1e-12), o3e / o3a.max(1e-12));
        // fragmentation: surface share in plate pieces other than each
        // plate's main piece (a plate should be one connected region)
        let frag = {
            let mut comp = vec![u32::MAX; n];
            let mut main: BTreeMap<i32, f64> = BTreeMap::new();
            let mut total = 0.0;
            let mut k = 0u32;
            for s0 in 0..n {
                if comp[s0] != u32::MAX {
                    continue;
                }
                let o = self.owner[s0];
                let mut a = 0.0;
                let mut st = vec![s0];
                comp[s0] = k;
                while let Some(c) = st.pop() {
                    a += self.g.area[c];
                    for &d in self.g.nb(c) {
                        let d = d as usize;
                        if comp[d] == u32::MAX && self.owner[d] == o {
                            comp[d] = k;
                            st.push(d);
                        }
                    }
                }
                k += 1;
                total += a;
                let m = main.entry(o).or_insert(0.0);
                *m = m.max(a);
            }
            (total - main.values().sum::<f64>()) / TAU * 100.0
        };
        format!(
            "[thick p10 {:.1} p50 {:.1} p90 {:.1}] land {}  cont {}  cont {:.1}% drowned {:.0}%  sea {:.2} km  ocean: thick {:.1} age {:.0} (>200: {:.1}%, {:.0}% on cont plates, max {:.0})  cont thick {:.1}  plates {} frag {:.2}%  {}",
            q(0.1), q(0.5), q(0.9),
            f(&land), f(&cont), ca / TAU * 100.0, dr / ca.max(1e-12) * 100.0, sea, ot / oa.max(1e-12), oage / oa.max(1e-12),
            old / oa.max(1e-12) * 100.0, old_cp / old.max(1e-12) * 100.0, amax, ct / ca.max(1e-12), self.plates.len(), frag, old300
        )
    }

    /// Prints diagnostics about the current state (native debugging only).
    pub fn debug_report(&mut self) {
        self.refresh_view();
        let n = self.g.n;
        let mut isolated = 0;
        let mut multi = [0usize; 5];
        let mut iso_cont = 0;
        for c in 0..n {
            multi[self.cand_n[c] as usize] += 1;
            let o = self.owner[c];
            if self.g.nb(c).iter().all(|&d| self.owner[d as usize] != o) {
                isolated += 1;
                if self.cont_w[c] != 0 {
                    iso_cont += 1;
                }
            }
        }
        let live: usize = self.plates.iter().map(|p| p.live).sum();
        // old sea floor (>200 Myr) as connected patches of one plate
        self.stamp = self.stamp.wrapping_add(1).max(1);
        let st = self.stamp;
        let mut patches = vec![];
        for c0 in 0..n {
            if self.mark[c0] == st || self.cont_w[c0] != 0 || self.age_w[c0] <= 200.0 || self.owner[c0] < 0 {
                continue;
            }
            let o = self.owner[c0];
            let mut comp = vec![c0];
            self.mark[c0] = st;
            let (mut area, mut boundary, mut coast, mut amax) = (0.0, 0, 0, 0.0f32);
            let mut i = 0;
            while i < comp.len() {
                let c = comp[i];
                i += 1;
                area += self.g.area[c];
                amax = amax.max(self.age_w[c]);
                for &d in self.g.nb(c) {
                    let d = d as usize;
                    if self.owner[d] != o {
                        boundary += 1;
                    } else if self.cont_w[d] != 0 {
                        coast += 1;
                    } else if self.mark[d] != st && self.age_w[d] > 200.0 {
                        self.mark[d] = st;
                        comp.push(d);
                    }
                }
            }
            patches.push((area / TAU * 1000.0, o, boundary, coast, amax));
        }
        patches.sort_by(|a, b| b.0.total_cmp(&a.0));
        patches.truncate(6);
        let pv: Vec<String> = patches.iter().map(|p| format!("{:.1}‰ plate {} bnd {} coast {} max {:.0}", p.0, p.1, p.2, p.3, p.4)).collect();
        println!("   old>200 patches: {:?}", pv);
        let info: Vec<(i32, i32)> = self.plates.iter().map(|p| ((p.cont_area / TAU * 1000.0) as i32, p.age_myr as i32)).collect();
        println!("   plates (cont‰, age) {:?}", info);
        let mut pc: Vec<f64> = self.pair_coll.values().map(|v| v.recent).collect();
        pc.sort_by(|a, b| b.partial_cmp(a).unwrap());
        pc.truncate(3);
        let speeds: Vec<i32> = self.plates.iter().map(|p| (len(p.omega) * self.prm.radius) as i32).collect();
        println!("   pair_coll top {:?} speeds {:?} merges {} inits {} rifts {}", pc, speeds, self.stats.merges, self.stats.sub_inits, self.stats.rifts);
        println!(
            "t={:.0} plates={} isolated={} (cont {}) cand0..4={:?} slots/n={:.3} steps={}",
            self.time,
            self.plates.len(),
            isolated,
            iso_cont,
            multi,
            live as f64 / n as f64,
            self.stats.steps
        );
    }
}
