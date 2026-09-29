//! Small vector / quaternion helpers on the unit sphere.

pub type V3 = [f64; 3];

#[inline]
pub fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
#[inline]
pub fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
#[inline]
pub fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
#[inline]
pub fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
#[inline]
pub fn scale(a: V3, s: f64) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
#[inline]
pub fn len(a: V3) -> f64 {
    dot(a, a).sqrt()
}
#[inline]
pub fn normalize(a: V3) -> V3 {
    let l = len(a);
    if l < 1e-300 { [0.0, 0.0, 1.0] } else { scale(a, 1.0 / l) }
}
/// Component of `v` tangent to the sphere at unit point `p`.
#[inline]
pub fn tangent(v: V3, p: V3) -> V3 {
    sub(v, scale(p, dot(v, p)))
}
/// Great-circle angle between unit vectors.
#[inline]
pub fn angle(a: V3, b: V3) -> f64 {
    // atan2 form is accurate for small and large angles alike
    len(cross(a, b)).atan2(dot(a, b))
}

/// Unit quaternion (w, x, y, z).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Quat {
    pub w: f64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Quat {
    pub const IDENTITY: Quat = Quat { w: 1.0, x: 0.0, y: 0.0, z: 0.0 };

    pub fn from_axis_angle(axis: V3, angle: f64) -> Quat {
        let a = normalize(axis);
        let (s, c) = (0.5 * angle).sin_cos();
        Quat { w: c, x: a[0] * s, y: a[1] * s, z: a[2] * s }
    }
    /// Rotation by the rotation vector `r` (axis · angle).
    pub fn from_rotvec(r: V3) -> Quat {
        let a = len(r);
        if a < 1e-15 { Quat::IDENTITY } else { Quat::from_axis_angle(r, a) }
    }
    /// Hamilton product: applying the result = applying `o` then `self`.
    pub fn mul(self, o: Quat) -> Quat {
        Quat {
            w: self.w * o.w - self.x * o.x - self.y * o.y - self.z * o.z,
            x: self.w * o.x + self.x * o.w + self.y * o.z - self.z * o.y,
            y: self.w * o.y - self.x * o.z + self.y * o.w + self.z * o.x,
            z: self.w * o.z + self.x * o.y - self.y * o.x + self.z * o.w,
        }
    }
    pub fn conj(self) -> Quat {
        Quat { w: self.w, x: -self.x, y: -self.y, z: -self.z }
    }
    pub fn normalized(self) -> Quat {
        let l = (self.w * self.w + self.x * self.x + self.y * self.y + self.z * self.z).sqrt();
        Quat { w: self.w / l, x: self.x / l, y: self.y / l, z: self.z / l }
    }
    #[inline]
    pub fn rotate(self, v: V3) -> V3 {
        let u = [self.x, self.y, self.z];
        let t = scale(cross(u, v), 2.0);
        add(add(v, scale(t, self.w)), cross(u, t))
    }
}

#[inline]
pub fn smoothstep(a: f64, b: f64, x: f64) -> f64 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Symmetric 3×3 solve (Cramer's rule). Returns None when singular.
pub fn solve3(m: [[f64; 3]; 3], b: V3) -> Option<V3> {
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if det.abs() < 1e-300 {
        return None;
    }
    let mut out = [0.0; 3];
    for (k, o) in out.iter_mut().enumerate() {
        let mut a = m;
        for r in 0..3 {
            a[r][k] = b[r];
        }
        let d = a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
            + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
        *o = d / det;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quat_rotates_and_inverts() {
        let q = Quat::from_axis_angle([0.0, 0.0, 1.0], std::f64::consts::FRAC_PI_2);
        let v = q.rotate([1.0, 0.0, 0.0]);
        assert!((v[0]).abs() < 1e-12 && (v[1] - 1.0).abs() < 1e-12);
        let back = q.conj().rotate(v);
        assert!((back[0] - 1.0).abs() < 1e-12);
        // composition: 4 quarter turns = identity
        let full = q.mul(q).mul(q).mul(q);
        let w = full.rotate([0.3, 0.4, 0.5]);
        assert!((w[0] - 0.3).abs() < 1e-12 && (w[2] - 0.5).abs() < 1e-12);
    }
    #[test]
    fn rotvec_matches_angular_velocity() {
        // rotating by ω·dt moves p by ω×p·dt for small dt
        let w = [0.1, -0.2, 0.3];
        let p = normalize([1.0, 2.0, 3.0]);
        let dt = 1e-4;
        let q = Quat::from_rotvec(scale(w, dt));
        let moved = sub(q.rotate(p), p);
        let expect = scale(cross(w, p), dt);
        for i in 0..3 {
            assert!((moved[i] - expect[i]).abs() < 1e-9);
        }
    }
    #[test]
    fn solve3_works() {
        let m = [[4.0, 1.0, 0.0], [1.0, 3.0, 1.0], [0.0, 1.0, 2.0]];
        let x = solve3(m, [1.0, 2.0, 3.0]).unwrap();
        let r = [4.0 * x[0] + x[1], x[0] + 3.0 * x[1] + x[2], x[1] + 2.0 * x[2]];
        for i in 0..3 {
            assert!((r[i] - [1.0, 2.0, 3.0][i]).abs() < 1e-12);
        }
    }
}
