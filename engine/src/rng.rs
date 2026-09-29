//! Deterministic randomness and 3-D gradient noise.

use crate::math::V3;

pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Rng {
        let mut r = Rng(seed ^ 0x9E37_79B9_7F4A_7C15);
        r.next_u64();
        r
    }
    /// Independent stream for a named stage.
    pub fn stream(seed: u64, label: &str) -> Rng {
        let mut h = 0xcbf2_9ce4_8422_2325u64 ^ seed;
        for b in label.bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x100_0000_01b3);
        }
        Rng::new(h)
    }
    #[inline]
    pub fn next_u64(&mut self) -> u64 {
        // SplitMix64
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// Uniform in [0, 1).
    #[inline]
    pub fn f(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 * (1.0 / (1u64 << 53) as f64)
    }
    pub fn range(&mut self, a: f64, b: f64) -> f64 {
        a + (b - a) * self.f()
    }
    pub fn below(&mut self, n: usize) -> usize {
        ((self.f() * n as f64) as usize).min(n.saturating_sub(1))
    }
    pub fn normal(&mut self) -> f64 {
        let u = self.f().max(1e-300);
        let v = self.f();
        (-2.0 * u.ln()).sqrt() * (2.0 * std::f64::consts::PI * v).cos()
    }
    pub fn unit_vec(&mut self) -> V3 {
        let z = self.range(-1.0, 1.0);
        let t = self.range(0.0, 2.0 * std::f64::consts::PI);
        let r = (1.0 - z * z).sqrt();
        [r * t.cos(), r * t.sin(), z]
    }
}

/// Improved-Perlin gradient noise in 3-D (output roughly in [-1, 1]).
pub struct Noise {
    perm: [u8; 512],
}

const GRAD: [[f64; 3]; 12] = [
    [1., 1., 0.], [-1., 1., 0.], [1., -1., 0.], [-1., -1., 0.],
    [1., 0., 1.], [-1., 0., 1.], [1., 0., -1.], [-1., 0., -1.],
    [0., 1., 1.], [0., -1., 1.], [0., 1., -1.], [0., -1., -1.],
];

impl Noise {
    pub fn new(seed: u64, label: &str) -> Noise {
        let mut r = Rng::stream(seed, label);
        let mut p: [u8; 256] = [0; 256];
        for (i, v) in p.iter_mut().enumerate() {
            *v = i as u8;
        }
        for i in (1..256).rev() {
            let j = r.below(i + 1);
            p.swap(i, j);
        }
        let mut perm = [0u8; 512];
        for i in 0..512 {
            perm[i] = p[i & 255];
        }
        Noise { perm }
    }

    pub fn noise(&self, x: f64, y: f64, z: f64) -> f64 {
        let (xf, yf, zf) = (x.floor(), y.floor(), z.floor());
        let (xi, yi, zi) = ((xf as i64 & 255) as usize, (yf as i64 & 255) as usize, (zf as i64 & 255) as usize);
        let (x, y, z) = (x - xf, y - yf, z - zf);
        let fade = |t: f64| t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
        let (u, v, w) = (fade(x), fade(y), fade(z));
        let p = &self.perm;
        let g = |h: u8, dx: f64, dy: f64, dz: f64| {
            let gr = GRAD[(h % 12) as usize];
            gr[0] * dx + gr[1] * dy + gr[2] * dz
        };
        let a = p[xi] as usize + yi;
        let aa = p[a] as usize + zi;
        let ab = p[a + 1] as usize + zi;
        let b = p[xi + 1] as usize + yi;
        let ba = p[b] as usize + zi;
        let bb = p[b + 1] as usize + zi;
        let lerp = |t: f64, a: f64, b: f64| a + t * (b - a);
        lerp(
            w,
            lerp(
                v,
                lerp(u, g(p[aa], x, y, z), g(p[ba], x - 1.0, y, z)),
                lerp(u, g(p[ab], x, y - 1.0, z), g(p[bb], x - 1.0, y - 1.0, z)),
            ),
            lerp(
                v,
                lerp(u, g(p[aa + 1], x, y, z - 1.0), g(p[ba + 1], x - 1.0, y, z - 1.0)),
                lerp(u, g(p[ab + 1], x, y - 1.0, z - 1.0), g(p[bb + 1], x - 1.0, y - 1.0, z - 1.0)),
            ),
        )
    }

    /// Fractal sum on the unit sphere; `freq` ≈ features per radian.
    pub fn fbm(&self, p: V3, freq: f64, octaves: u32) -> f64 {
        let mut s = 0.0;
        let mut amp = 1.0;
        let mut f = freq;
        let mut norm = 0.0;
        for o in 0..octaves {
            let off = o as f64 * 17.13;
            s += amp * self.noise(p[0] * f + off, p[1] * f - off, p[2] * f + 0.5 * off);
            norm += amp;
            amp *= 0.5;
            f *= 2.0;
        }
        s / norm
    }
}
