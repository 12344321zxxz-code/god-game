//! Simulation parameters, passed from TypeScript as a flat f64 array.

pub struct Params {
    pub radius: f64,
    pub gravity: f64,
    pub seed: u64,
    /// Area-weighted RMS plate speed the mantle maintains, mm/yr (= km/Myr).
    pub mean_speed: f64,
    pub min_plates: usize,
    pub max_plates: usize,
    pub hotspots: usize,
    /// Multiplier on continental rifting frequency.
    pub rift_rate: f64,
    /// Multiplier on erosion.
    pub erosion: f64,
    pub max_dt: f64,
    pub land_fraction: f64,
}

pub const P_RADIUS: usize = 0;
pub const P_GRAVITY: usize = 1;
pub const P_SEED: usize = 2;
pub const P_MEAN_SPEED: usize = 3;
pub const P_MIN_PLATES: usize = 4;
pub const P_MAX_PLATES: usize = 5;
pub const P_HOTSPOTS: usize = 6;
pub const P_RIFT_RATE: usize = 7;
pub const P_EROSION: usize = 8;
pub const P_MAX_DT: usize = 9;
pub const P_LAND: usize = 10;

impl Params {
    pub fn from_slice(a: &[f64]) -> Params {
        let get = |i: usize, d: f64| a.get(i).copied().filter(|v| v.is_finite()).unwrap_or(d);
        Params {
            radius: get(P_RADIUS, 6371.0).max(100.0),
            gravity: get(P_GRAVITY, 1.0).max(0.01),
            seed: get(P_SEED, 1.0) as u64,
            mean_speed: get(P_MEAN_SPEED, 45.0).clamp(1.0, 200.0),
            min_plates: get(P_MIN_PLATES, 3.0).max(2.0) as usize,
            max_plates: get(P_MAX_PLATES, 24.0).max(3.0) as usize,
            hotspots: get(P_HOTSPOTS, 40.0).max(0.0) as usize,
            rift_rate: get(P_RIFT_RATE, 1.0).max(0.0),
            erosion: get(P_EROSION, 1.0).max(0.0),
            max_dt: get(P_MAX_DT, 2.0).clamp(0.05, 10.0),
            land_fraction: get(P_LAND, 0.29).clamp(0.0, 1.0),
        }
    }
    /// Relief multiplier g⊕/g, capped at 3 (same as the TS side).
    pub fn relief(&self) -> f64 {
        (1.0 / self.gravity).min(3.0)
    }
}
