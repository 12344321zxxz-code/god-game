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
const ARC_TO_CONT: f32 = 22.0;
/// Thickest crust the lithosphere can hold up at 1 g (km); weaker gravity
/// supports more (∝ √(g⊕/g), so Mars-size worlds reach ~130 km).
const MAX_THICK_EARTH: f32 = 95.0;

// ---- force constants (relative; overall speed is normalised) ----
const K_SLAB: f64 = 1.0;
const K_GPE: f64 = 0.012;
const K_COLL: f64 = 30.0;
/// Basal drag weight of continental lithosphere relative to oceanic (deep keels).
const DRAG_CONT: f64 = 3.0;
/// Sea floor older than this (Myr) starts to founder at plate edges.
const FOUNDER_AGE: f32 = 120.0;
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
pub fn crust_elev(thick: f32, age: f32, cont: u8) -> f64 {
    if cont != 0 {
        // Airy slope (1 − ρc/ρm) ≈ 0.1515, offset calibrated on Earth
        // (cratons ~38 km at ~+0.7 km, Tibet ~70 km at ~5.6 km). Below water the
        // column sinks further (water load): ×ρm/(ρm − ρw) ≈ 1.45.
        let e = 0.1515 * thick as f64 - 5.3;
        if e < 0.0 { e * 1.45 } else { e }
    } else {
        -ocean_depth_fast(age) as f64 / 1000.0 + (thick as f64 - OCEAN_THICK as f64) * 0.3
    }
}

/// A patch of mantle flow that drags the plates above it (convection cell).
struct MantleCell {
    centre: V3,
    /// Rotation (rad/Myr) of the flow under this patch.
    omega: V3,
}

/// Typical speed of the mantle flow under the plates, mm/yr.
const MANTLE_FLOW: f64 = 18.0;
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
    /// Debug: edge-gated removals, deep removals, ridge creations, donorless creations (sr).
    pub diag: [f64; 4],
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
    slab: Vec<f32>,
    slab_pid: Vec<u32>,
    sz: Vec<f32>,
    sz_low: Vec<u32>,
    cz: Vec<f32>,
    cz_low: Vec<u32>,
    cz_top: Vec<u32>,
    hotspots: Vec<Hotspot>,
    mantle: Vec<MantleCell>,
    pair_coll: BTreeMap<(u32, u32), f64>,

    dij: Dijkstra,
    order: Vec<u32>,
    carry: Vec<f32>,
    work: Vec<f32>,
    pub sea_level: f64,
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
        let k = MANTLE_FLOW / self.prm.radius;
        self.mantle = (0..6).map(|_| MantleCell { centre: r.unit_vec(), omega: scale(r.unit_vec(), k) }).collect();
        self.update_bounds();
        self.refresh_view();
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
        let end = self.time + myr;
        let mut steps = 0;
        while self.time < end - 1e-9 && steps < max_steps {
            let dt = self.choose_dt().min(end - self.time).max(1e-3);
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
        timed!(0, self.coverage());
        timed!(1, self.local_pass(dt));
        timed!(2, self.fill_gaps(dt));
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
            *v *= kp;
            *v > 1e-6
        });
    }

    /// Recomputes each plate's bounding cap (local frame), area and continental area.
    fn update_bounds(&mut self) {
        let g = &self.g;
        let margin = 2.5 * g.spacing;
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
            let cl = normalize(sum);
            let mut md: f64 = 1.0;
            for s in 0..p.cell.len() {
                if p.alive[s] {
                    md = md.min(dot(g.pos[p.cell[s] as usize], cl));
                }
            }
            let ang = md.clamp(-1.0, 1.0).acos() + margin;
            p.cen = cl;
            p.cos_r = if ang >= std::f64::consts::PI { -1.1 } else { ang.cos() };
            p.area = a;
            p.cont_area = ca;
            p.maybe_compact();
        }
    }

    // -----------------------------------------------------------------
    // coverage and overlap resolution

    fn coverage(&mut self) {
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
        let mut transfers: Vec<(usize, u32, f32)> = vec![];
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
                if o < 0 || o as usize == pi || self.zone[c] == 0 {
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
                if edge {
                    let rel = scale(cross(sub(omegas[pi], omegas[o as usize]), pc), rk);
                    let conv = -dot(rel, normalize(tangent(toward_p, pc)));
                    // Rounding makes edge overlaps every step whatever the speed;
                    // consume them only as fast as the plates really converge
                    // (unconsumed ones sink deeper next step and go then).
                    if conv >= MIN_RATE && self.rng.f() > conv * dt / cell_km {
                        continue;
                    }
                    if conv < MIN_RATE {
                        continue; // not converging: stays hidden (rounding overlap)
                    }
                    self.stats.diag[0] += g.area[c];
                } else {
                    self.stats.diag[1] += g.area[c];
                }
                if p.cont[s] != 0 {
                    if self.cont_w[c] == 0 {
                        continue; // a continent never goes under ocean (edge jitter)
                    }
                    transfers.push((o as usize, self.oslot[c], p.thick[s]));
                    self.cz[c] = 1.0;
                    self.cz_low[c] = pid;
                    self.cz_top[c] = self.owner_id[c];
                    let key = if pid < self.owner_id[c] { (pid, self.owner_id[c]) } else { (self.owner_id[c], pid) };
                    *self.pair_coll.entry(key).or_insert(0.0) += g.area[c];
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
        for (o, ts, add) in transfers {
            let p = &mut self.plates[o];
            let ts = ts as usize;
            if p.alive[ts] {
                let before = p.thick[ts];
                p.thick[ts] = (p.thick[ts] + add).min(self.max_thick);
                self.stats.budget[5] += (p.thick[ts] - before) as f64 * self.g.area[p.cell[ts] as usize];
                p.oro[ts] = oro::HIMALAYAN;
                p.oro_age[ts] = 0.0;
            }
        }
    }

    /// Uncovered cells get fresh ocean crust from a neighbouring plate
    /// (preferring the plate that was there before).
    fn fill_gaps(&mut self, dt: f64) {
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
                // rounding opens edge gaps every step: only a share matching the
                // real opening rate becomes new sea floor, the rest copies the edge
                let rate = self.diverging(c, pi);
                let ridge = rate > MIN_RATE && self.rng.f() < rate * dt / cell_km;
                // a neighbouring column of the same plate to copy from when this
                // hole is only nearest-cell rounding, not sea-floor spreading
                let donor = self.g.nb(c).iter().map(|&d| d as usize).find(|&d| self.owner[d] == pi as i32);
                // enclosed by this plate alone → a hole in its crust (nearest-cell
                // sampling of freshly made or merged crust skips ~1 cell in 10)
                let enclosed = self.g.nb(c).iter().all(|&d| self.owner[d as usize] == pi as i32);
                let p = &mut self.plates[pi];
                let r = self.g.nearest(p.q.conj().rotate(self.g.pos[c]));
                let s = if p.slot_of[r] != EMPTY {
                    p.slot_of[r] as usize
                } else if ridge || donor.is_none() {
                    self.stats.created_area += self.g.area[c];
                    self.stats.diag[if ridge { 2 } else { 3 }] += self.g.area[c];
                    p.add(r, c, OCEAN_THICK, 0.0, 0, oro::NONE, 1000.0)
                } else if enclosed {
                    let ds = self.oslot[donor.unwrap()] as usize;
                    let (t, a, k, o, oa) = (p.thick[ds], p.age[ds], p.cont[ds], p.oro[ds], p.oro_age[ds]);
                    self.stats.copy_cont += self.g.area[c];
                    p.add(r, c, t, a, k, o, oa)
                } else {
                    // rounding gap at an edge: show the neighbouring column, change nothing
                    self.oslot[donor.unwrap()] as usize
                };
                self.set_owner(c, pi, s);
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
        for c in 0..self.g.n {
            let h = self.thick_w[c] + self.dthick[c];
            self.elev[c] = (crust_elev(h, self.age_w[c], self.cont_w[c]) + self.swell[c] as f64 - self.trench[c] as f64) as f32;
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
            let depth = ((1.5 + 2.5 * (conv / 60.0).min(1.0)) * relief.min(1.5)) as f32;
            for &d in &lows[..m] {
                trench_src.push(d);
                trench_depth.push(depth);
            }
        }
        if !sources.is_empty() {
            let owner = &self.owner;
            let src_owner: Vec<i32> = sources.iter().map(|&c| owner[c as usize]).collect();
            self.dij.run(&self.g, rk, &sources, 1150.0, |d, si| owner[d] == src_owner[si]);
            let tmax = 35.0 + 40.0 * relief.sqrt();
            // Cordillera growth is mostly shortening: crust is moved toward the
            // arc from the back-arc / foreland, so that share is taken from a
            // band 450–1100 km inland (foreland basins) — only the magmatic
            // share (~30 %) is new crust.
            let mut shortened = 0.0;
            let mut band = 0.0;
            for &d in &self.dij.touched {
                let d = d as usize;
                let x = self.dij.dist[d] as f64;
                if self.cont_w[d] != 0 && x > 450.0 {
                    let h = (self.thick_w[d] + self.dthick[d]) as f64;
                    band += smoothstep(450.0, 600.0, x) * (1.0 - smoothstep(900.0, 1100.0, x)) * (h - 34.0).max(0.0) * self.g.area[d];
                }
            }
            for &d in &self.dij.touched {
                let d = d as usize;
                let x = self.dij.dist[d] as f64;
                if x > 750.0 {
                    continue;
                }
                let si = self.dij.src[d] as usize;
                let k = conv_of[si] as f64 * dt / 50.0;
                let h = (self.thick_w[d] + self.dthick[d]) as f64;
                let amount = if self.cont_w[d] != 0 {
                    let shape = smoothstep(60.0, 180.0, x) * (1.0 - smoothstep(380.0, 650.0, x));
                    // subduction erosion scrapes the forearc (≈ as much as arcs add)
                    let scrape = 0.5 * (-(x / 60.0).powi(2)).exp();
                    let grow = 1.2 * shape * ((tmax - h) / 40.0).clamp(0.0, 1.0) * k;
                    shortened += 0.7 * grow * self.g.area[d];
                    grow - scrape * k
                } else {
                    let shape = (-((x - 140.0) / 60.0).powi(2)).exp();
                    // arc magmatism ≈ 40 km³ per km of arc per Myr (Reymer & Schubert)
                    0.4 * shape * ((tmax * 0.6 - h) / 20.0).clamp(0.0, 1.0) * k
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
            if band > 0.0 && shortened > 0.0 {
                // never strip the back-arc below normal thickness in one go
                let f = (shortened / band).min(0.15);
                let mut taken = 0.0;
                for &d in &self.dij.touched {
                    let d = d as usize;
                    let x = self.dij.dist[d] as f64;
                    if self.cont_w[d] == 0 || x <= 450.0 {
                        continue;
                    }
                    let h = (self.thick_w[d] + self.dthick[d]) as f64;
                    let w = smoothstep(450.0, 600.0, x) * (1.0 - smoothstep(900.0, 1100.0, x)) * (h - 34.0).max(0.0);
                    self.dthick[d] -= (f * w) as f32;
                    taken += f * w * self.g.area[d];
                }
                self.stats.budget[0] -= taken;
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

    /// Marks collision belts (the thickening itself came from stacked crust).
    fn collision_marks(&mut self) {
        let n = self.g.n;
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
        let src: Vec<u32> = (0..self.g.n as u32).filter(|&c| self.newcrust[c as usize] != 0).collect();
        if src.is_empty() {
            return;
        }
        let cont = &self.cont_w;
        self.dij.run(&self.g, self.prm.radius, &src, 220.0, |d, _| cont[d] != 0);
        for &d in &self.dij.touched {
            let d = d as usize;
            if self.cont_w[d] == 0 {
                continue;
            }
            let x = self.dij.dist[d] as f64;
            let h = (self.thick_w[d] + self.dthick[d]) as f64;
            let thin = 0.12 * (h - 15.0).max(0.0) * (-x / 70.0).exp();
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
                self.swell[c] += (swell_amp * (-(x / 450.0).powi(2)).exp()) as f32;
                if x < 3.0 * r_eff {
                    let add = rate * mult * dt * (-(x / r_eff).powi(2)).exp();
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
        let n = self.g.n;
        let rk = self.prm.radius;
        let l = self.spacing_km();
        let w0 = 4.0 / (6.0 * l * l); // hex-grid Laplacian weight per neighbour
        // background: one explicit step (stable while dt·κ·w0·6 < 1)
        // cold continental crust barely flows; a little keeps single-cell spikes in check
        let k_bg = 25.0 * self.prm.gravity.min(1.0);
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
        let k_ch = 6000.0 * self.prm.gravity.min(2.0);
        let phi = |x: f32| (((x - 42.0) / 25.0).clamp(0.0, 1.6) as f64).powi(2);
        let active: Vec<u32> = (0..n as u32)
            .filter(|&c| {
                let c = c as usize;
                self.cont_w[c] != 0 && (h[c] > 42.0 || self.g.nb(c).iter().any(|&d| h[d as usize] > 42.0))
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
        let _ = rk;
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
        // sea level: the land-fraction quantile (the TS finish uses the same rule)
        // descending elevation; the order barely changes step to step, so an
        // adaptive stable sort over last step's order is nearly linear
        let elev = &self.elev;
        let key = |c: u32| {
            let b = elev[c as usize].to_bits();
            let k = if b & 0x8000_0000 != 0 { !b } else { b | 0x8000_0000 };
            !k
        };
        self.order.sort_by_key(|&c| key(c));
        let goal = self.prm.land_fraction * TAU;
        let mut acc = 0.0;
        let mut sea = elev[self.order[n - 1] as usize] as f64;
        for &c in &self.order {
            acc += self.g.area[c as usize];
            if acc >= goal {
                sea = elev[c as usize] as f64;
                break;
            }
        }
        self.sea_level = sea;
        let k = 0.1535 * self.prm.erosion;
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
                let relief = (0.08 * e + 40.0 * slope).min(e);
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
            // deposit: ocean cells fill toward just below sea level, pits fill fully
            if e < -0.15 || rcv == usize::MAX {
                let fac = if self.cont_w[c] != 0 { 0.1515 * 1.45 } else { 0.3 };
                let room = if rcv == usize::MAX { f64::INFINITY } else { ((-0.15 - e) / fac).max(0.0) };
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

    /// Writes the world-frame thickness changes back into every plate column
    /// (including columns hidden under another plate's nearest-cell mapping).
    fn apply_deltas(&mut self, dt: f64) {
        let dtf = dt as f32;
        for pi in 0..self.plates.len() {
            let p = &mut self.plates[pi];
            for s in 0..p.cell.len() {
                if !p.alive[s] {
                    continue;
                }
                let c = p.world[s] as usize;
                if self.owner[c] == pi as i32 {
                    p.thick[s] += self.dthick[c];
                    let o = self.oro_set[c];
                    if o != 0 {
                        p.oro[s] = o;
                        p.oro_age[s] = 0.0;
                    }
                }
                p.age[s] += dtf;
                p.oro_age[s] += dtf;
                if p.cont[s] != 0 && p.thick[s] < CONT_MIN {
                    self.stats.cont_lost += self.g.area[p.cell[s] as usize];
                    p.cont[s] = 0;
                    p.age[s] = 0.0;
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
            let k = MANTLE_FLOW / self.prm.radius;
            let a = (-dt / 150.0).exp();
            let b = (1.0 - a * a).sqrt();
            for mc in &mut self.mantle {
                let kick = scale(self.rng.unit_vec(), k * self.rng.normal().abs());
                mc.omega = add(scale(mc.omega, a), scale(kick, b));
                mc.centre = normalize(add(mc.centre, scale(self.rng.unit_vec(), 0.05 * dt.sqrt())));
            }
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
                let g = (-d2 / (MANTLE_CELL_RADIUS * MANTLE_CELL_RADIUS)).exp();
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
            let rel = sub(self.vel(lo, c), self.vel(top, c));
            let mag = len(rel).max(10.0);
            let f = scale(rel, -K_COLL * self.cz[c] as f64 * self.g.area[c] / mag);
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
            self.next_check = self.time + 25.0;
            for _ in 0..1 {
                // physical need beats the plate budget: cleanup merges the
                // smallest plate away if this pushes the count over the limit
                if self.subduction_initiation() {
                    self.stats.sub_inits += 1;
                    // the view is stale after a split: refresh before looking again
                    self.coverage();
                    self.fill_gaps(0.0);
                    self.gather_world();
                }
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
                // Earth: ~10 major rifts in the last 200 Myr; big (insulating)
                // continents break up much more readily
                let lambda = (self.prm.rift_rate / 120.0 * (f / 0.06).powf(1.5)).min(0.1);
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
        for (&(a, b), &v) in &self.pair_coll {
            let (Some(ia), Some(ib)) = (self.idx(a), self.idx(b)) else { continue };
            // suture once a good share of the smaller continent has been driven in
            let thr = (0.3 * self.plates[ia].cont_area.min(self.plates[ib].cont_area)).clamp(0.003, 0.08);
            if v > thr {
                merge = Some((ia, ib, a, b));
                break;
            }
        }
        if let Some((ia, ib, a, b)) = merge {
            let (keep, gone) = if self.plates[ia].area >= self.plates[ib].area { (ia, ib) } else { (ib, ia) };
            self.pair_coll.remove(&(a, b));
            self.merge(keep, gone);
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
        loop {
            let np = self.plates.len();
            if np <= 2 {
                break;
            }
            let over = np > self.prm.max_plates;
            let cand = (0..np)
                .filter(|&i| over || self.plates[i].area < min_area)
                .min_by(|&a, &b| self.plates[a].area.partial_cmp(&self.plates[b].area).unwrap());
            let Some(small) = cand else { break };
            let Some(into) = self.main_neighbour(small) else { break };
            self.merge(into, small);
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

    /// Moves all crust of plate `gone` into plate `keep` (momentum-weighted motion).
    fn merge(&mut self, keep: usize, gone: usize) {
        if keep == gone {
            return;
        }
        if std::env::var("TECTO_DEBUG").is_ok() {
            eprintln!("t={:.0} merge id {} (area {:.3}) into id {} (area {:.3})", self.time, self.plates[gone].id, self.plates[gone].area, self.plates[keep].id, self.plates[keep].area);
        }
        let b = self.plates.remove(gone);
        let keep = if gone < keep { keep - 1 } else { keep };
        let g = &self.g;
        let a = &mut self.plates[keep];
        let (wa, wb) = (a.area.max(1e-12), b.area.max(0.0));
        a.omega = scale(add(scale(a.omega, wa), scale(b.omega, wb)), 1.0 / (wa + wb));
        let qa_inv = a.q.conj();
        for s in 0..b.cell.len() {
            if !b.alive[s] {
                continue;
            }
            let w = b.q.rotate(g.pos[b.cell[s] as usize]);
            let r = g.nearest(qa_inv.rotate(w));
            let ts = a.slot_of[r];
            if ts == EMPTY {
                a.add(r, b.world[s] as usize, b.thick[s], b.age[s], b.cont[s], b.oro[s], b.oro_age[s]);
            } else {
                let ts = ts as usize;
                if b.cont[s] != 0 && a.cont[ts] != 0 {
                    a.thick[ts] = (a.thick[ts] + 0.5 * b.thick[s]).min(self.max_thick);
                } else if b.cont[s] != 0 {
                    a.thick[ts] = b.thick[s];
                    a.cont[ts] = 1;
                    a.oro[ts] = b.oro[s];
                    a.oro_age[ts] = b.oro_age[s];
                }
            }
        }
        a.age_myr = 0.0;
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
            if continental && p.cont[s] != 0 && sd.abs() < thin_w {
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
        if self.split(pi, &plus_slots, add(w0, scale(axis, k))).is_none() {
            return false;
        }
        self.plates[pi].omega = sub(w0, scale(axis, k));
        true
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
        p.age_myr = 0.0;
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
            let pid = self.plates[pi].id;
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
            let margin = !conts.is_empty() && oldest.0 > 200.0;
            let lone = conts.is_empty() && oldest.0 > 220.0;
            if !margin && !lone {
                continue;
            }
            // membership test for the breakaway region
            let owner = &self.owner;
            let far: Vec<bool> = if margin {
                self.dij.run(&self.g, rk, &conts, 5000.0, |d, _| owner[d] == pi as i32);
                (0..n).map(|c| self.dij.dist[c] > 150.0).collect()
            } else {
                (0..n).map(|c| self.age_w[c] > 120.0).collect()
            };
            // seed: the oldest floor that qualifies (not the sliver by the coast)
            let mut seed = (0.0f32, usize::MAX);
            for c in 0..n {
                if self.owner[c] == pi as i32 && self.cont_w[c] == 0 && far[c] && self.age_w[c] > seed.0 {
                    seed = (self.age_w[c], c);
                }
            }
            if seed.1 == usize::MAX || seed.0 < 150.0 {
                continue;
            }
            self.stamp = self.stamp.wrapping_add(1).max(1);
            let st = self.stamp;
            let mut comp = vec![seed.1 as u32];
            self.mark[seed.1] = st;
            let mut i = 0;
            while i < comp.len() {
                let c = comp[i] as usize;
                i += 1;
                for &d in self.g.nb(c) {
                    let d = d as usize;
                    // at a margin the whole connected ocean breaks away, so the
                    // new boundary runs along the old continental edge
                    if self.mark[d] != st && self.owner[d] == pi as i32 && self.cont_w[d] == 0 && (margin || far[d]) {
                        self.mark[d] = st;
                        comp.push(d as u32);
                    }
                }
            }
            let area: f64 = comp.iter().map(|&c| self.g.area[c as usize]).sum();
            let parea = self.plates[pi].area;
            if std::env::var("TECTO_DEBUG").is_ok() {
                eprintln!("t={:.0} init? plate {} margin {} oldest {:.0} comp {:.4} plate {:.4} conts {}", self.time, pi, margin, oldest.0, area, parea, conts.len());
            }
            if area < 0.005 * TAU {
                continue;
            }
            if !margin && area > 0.85 * parea {
                // the whole plate is old: break it and let one half sink under the other
                if self.rift(pi, false, true) {
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
            let _ = pid;
            return self.split(pi, &slots, omega).is_some();
        }
        false
    }

    // -----------------------------------------------------------------
    // output

    /// Rebuilds the resolved view without advancing time.
    pub fn refresh_view(&mut self) {
        self.dthick.fill(0.0);
        self.update_bounds();
        self.coverage();
        self.fill_gaps(0.0);
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

fn hotspot_rate(r: &mut Rng) -> f64 {
    (0.8 * (0.9 * r.normal()).exp()).clamp(0.15, 8.0)
}

impl Sim {
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
        let mut old = std::collections::BTreeMap::new();
        for c in 0..n {
            if self.cont_w[c] == 0 && self.age_w[c] > 300.0 {
                let enclosed_by_cont = self.g.nb(c).iter().any(|&d| self.cont_w[d as usize] != 0);
                *old.entry((self.owner[c], enclosed_by_cont)).or_insert(0) += 1;
            }
        }
        println!("   old>300 by (plate, touches cont): {:?}", old);
        let mut per: std::collections::BTreeMap<i32, usize> = std::collections::BTreeMap::new();
        for (&(pl, _), &k) in &old {
            *per.entry(pl).or_insert(0) += k;
        }
        for (&pl, &k) in &per {
            if k < 100 || pl < 0 {
                continue;
            }
            let pi = pl as usize;
            let (mut conv, mut div, mut tr, mut edge_age, mut ne, mut slabs) = (0, 0, 0, 0.0, 0, 0.0);
            for c in 0..n {
                if self.owner[c] != pl {
                    continue;
                }
                if self.slab_pid[c] == self.plates[pi].id {
                    slabs += self.slab[c] as f64;
                }
                for &d in self.g.nb(c) {
                    let d = d as usize;
                    let o = self.owner[d];
                    if o < 0 || o == pl {
                        continue;
                    }
                    let dir = normalize(tangent(sub(self.g.pos[d], self.g.pos[c]), self.g.pos[c]));
                    let rel = sub(self.vel(o as usize, c), self.vel(pi, c));
                    let r = -dot(rel, dir);
                    if r > 3.0 { conv += 1 } else if r < -3.0 { div += 1 } else { tr += 1 }
                    edge_age += self.age_w[c] as f64;
                    ne += 1;
                    break;
                }
            }
            println!("     plate {} id {} old {} speed {:.0} area {:.3} cont {:.3} edges conv/div/tr {}/{}/{} mean edge age {:.0} slab {:.4} age_myr {:.0}",
                pl, self.plates[pi].id, k, len(self.plates[pi].omega) * self.prm.radius, self.plates[pi].area, self.plates[pi].cont_area, conv, div, tr, edge_age / ne.max(1) as f64, slabs, self.plates[pi].age_myr);
        }
        let info: Vec<(i32, i32)> = self.plates.iter().map(|p| ((p.cont_area / TAU * 1000.0) as i32, p.age_myr as i32)).collect();
        println!("   plates (cont‰, age) {:?}", info);
        let mut pc: Vec<f64> = self.pair_coll.values().copied().collect();
        pc.sort_by(|a, b| b.partial_cmp(a).unwrap());
        pc.truncate(3);
        let speeds: Vec<i32> = self.plates.iter().map(|p| (len(p.omega) * self.prm.radius) as i32).collect();
        println!("   diag edge/deep/ridge/nodonor {:?}", self.stats.diag.map(|v| (v * 10.0).round() / 10.0));
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
