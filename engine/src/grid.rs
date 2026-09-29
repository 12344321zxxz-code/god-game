//! The hex-sphere grid, received from TypeScript as flat arrays.
//!
//! Every plate stores its crust on this same grid in its own rotated frame,
//! so the one operation that has to be fast is "which cell is nearest to this
//! direction?". A cube-map of buckets gives a starting cell next to the
//! answer and a greedy walk over neighbours finishes the job (the grid is a
//! Delaunay-like triangulation, so a local maximum of p·d is the nearest).

use crate::math::{V3, dot};

pub struct Grid {
    pub n: usize,
    pub pos: Vec<V3>,
    pub off: Vec<u32>,
    pub nbrs: Vec<u32>,
    /// Cell areas in steradians.
    pub area: Vec<f64>,
    /// Great-circle length (radians) of each CSR neighbour entry.
    pub elen: Vec<f32>,
    /// Mean neighbour spacing in radians.
    pub spacing: f64,
    cube_res: usize,
    cube: Vec<u32>,
}

impl Grid {
    pub fn new(pos: &[f64], off: &[u32], nbrs: &[u32], area: &[f64]) -> Grid {
        let n = area.len();
        let p: Vec<V3> = (0..n).map(|i| [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]]).collect();
        let mut elen = vec![0f32; nbrs.len()];
        let mut sum = 0.0;
        for c in 0..n {
            for k in off[c] as usize..off[c + 1] as usize {
                let a = crate::math::angle(p[c], p[nbrs[k] as usize]);
                elen[k] = a as f32;
                sum += a;
            }
        }
        let spacing = sum / nbrs.len().max(1) as f64;
        let cube_res = ((n as f64 / 6.0).sqrt().ceil() as usize).max(2);
        let mut g = Grid {
            n,
            pos: p,
            off: off.to_vec(),
            nbrs: nbrs.to_vec(),
            area: area.to_vec(),
            elen,
            spacing,
            cube_res,
            cube: vec![0; 6 * cube_res * cube_res],
        };
        let mut hint = 0usize;
        for f in 0..6 {
            for j in 0..cube_res {
                // snake order keeps consecutive buckets adjacent → short walks
                for ii in 0..cube_res {
                    let i = if j % 2 == 0 { ii } else { cube_res - 1 - ii };
                    let u = (i as f64 + 0.5) / cube_res as f64 * 2.0 - 1.0;
                    let v = (j as f64 + 0.5) / cube_res as f64 * 2.0 - 1.0;
                    let d = face_dir(f, u, v);
                    hint = g.nearest_from(d, hint);
                    g.cube[(f * cube_res + j) * cube_res + i] = hint as u32;
                }
            }
        }
        g
    }

    #[inline]
    pub fn nb(&self, c: usize) -> &[u32] {
        &self.nbrs[self.off[c] as usize..self.off[c + 1] as usize]
    }

    /// Nearest cell to (unit-ish) direction `d`, walking from `start`.
    #[inline]
    pub fn nearest_from(&self, d: V3, start: usize) -> usize {
        let mut cur = start;
        let mut best = dot(self.pos[cur], d);
        loop {
            let mut next = cur;
            for &k in self.nb(cur) {
                let s = dot(self.pos[k as usize], d);
                if s > best {
                    best = s;
                    next = k as usize;
                }
            }
            if next == cur {
                return cur;
            }
            cur = next;
        }
    }

    /// Nearest cell to direction `d` (need not be normalised).
    #[inline]
    pub fn nearest(&self, d: V3) -> usize {
        self.nearest_from(d, self.bucket(d))
    }

    fn bucket(&self, d: V3) -> usize {
        let ax = [d[0].abs(), d[1].abs(), d[2].abs()];
        let a = if ax[0] >= ax[1] && ax[0] >= ax[2] { 0 } else if ax[1] >= ax[2] { 1 } else { 2 };
        let m = ax[a].max(1e-300);
        let f = 2 * a + if d[a] < 0.0 { 1 } else { 0 };
        let u = d[(a + 1) % 3] / m;
        let v = d[(a + 2) % 3] / m;
        let r = self.cube_res;
        let i = (((u + 1.0) * 0.5 * r as f64) as usize).min(r - 1);
        let j = (((v + 1.0) * 0.5 * r as f64) as usize).min(r - 1);
        self.cube[(f * r + j) * r + i] as usize
    }
}

fn face_dir(f: usize, u: f64, v: f64) -> V3 {
    let a = f / 2;
    let s = if f % 2 == 0 { 1.0 } else { -1.0 };
    let mut d = [0.0; 3];
    d[a] = s;
    d[(a + 1) % 3] = u;
    d[(a + 2) % 3] = v;
    crate::math::normalize(d)
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// Fibonacci-sphere test grid with brute-force k-nearest neighbours
    /// (good enough to exercise lookups without the TS builder).
    pub fn test_grid(n: usize) -> Grid {
        let mut pos = Vec::with_capacity(3 * n);
        let ga = std::f64::consts::PI * (3.0 - 5f64.sqrt());
        for i in 0..n {
            let y = 1.0 - 2.0 * (i as f64 + 0.5) / n as f64;
            let r = (1.0 - y * y).sqrt();
            let t = ga * i as f64;
            pos.extend_from_slice(&[r * t.cos(), y, r * t.sin()]);
        }
        let p = |i: usize| [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]];
        let mut off = vec![0u32];
        let mut nbrs = vec![];
        for i in 0..n {
            let mut d: Vec<(f64, usize)> = (0..n).filter(|&j| j != i).map(|j| (-dot(p(i), p(j)), j)).collect();
            d.sort_by(|a, b| a.partial_cmp(b).unwrap());
            for &(_, j) in d.iter().take(6) {
                nbrs.push(j as u32);
            }
            off.push(nbrs.len() as u32);
        }
        // symmetrise
        let mut adj: Vec<Vec<u32>> = (0..n).map(|i| nbrs[off[i] as usize..off[i + 1] as usize].to_vec()).collect();
        for i in 0..n {
            for &j in adj[i].clone().iter() {
                if !adj[j as usize].contains(&(i as u32)) {
                    adj[j as usize].push(i as u32);
                }
            }
        }
        let mut off2 = vec![0u32];
        let mut nb2 = vec![];
        for a in adj {
            nb2.extend(a);
            off2.push(nb2.len() as u32);
        }
        let area = vec![4.0 * std::f64::consts::PI / n as f64; n];
        Grid::new(&pos, &off2, &nb2, &area)
    }

    #[test]
    fn nearest_matches_brute_force() {
        let g = test_grid(3000);
        let mut rng = crate::rng::Rng::new(7);
        for _ in 0..2000 {
            let d = rng.unit_vec();
            let fast = g.nearest(d);
            let mut best = 0;
            for c in 0..g.n {
                if dot(g.pos[c], d) > dot(g.pos[best], d) {
                    best = c;
                }
            }
            assert!(dot(g.pos[fast], d) >= dot(g.pos[best], d) - 1e-12, "lookup missed");
        }
    }
}
