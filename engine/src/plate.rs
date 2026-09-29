//! A rigid plate: its crust lives on the shared grid in the plate's own
//! frame, and a quaternion places that frame on the globe. Moving a plate is
//! only a rotation, so coastlines and mountain belts are carried along
//! exactly — nothing is re-interpolated between steps.

use crate::math::{Quat, V3};

pub const EMPTY: i32 = -1;

pub struct Plate {
    /// Stable id (survives merges of other plates; used for colours).
    pub id: u32,
    /// Local frame → world.
    pub q: Quat,
    /// World angular velocity, rad/Myr.
    pub omega: V3,
    /// Local grid cell → slot, or EMPTY.
    pub slot_of: Vec<i32>,
    // per-slot crust columns
    pub cell: Vec<u32>,
    pub thick: Vec<f32>,
    pub age: Vec<f32>,
    pub cont: Vec<u8>,
    pub oro: Vec<u8>,
    pub oro_age: Vec<f32>,
    /// Nearest world cell of each slot (refreshed every step; lookup hint).
    pub world: Vec<u32>,
    pub alive: Vec<bool>,
    free: Vec<u32>,
    pub live: usize,
    // derived each step
    pub cen: V3,
    pub cos_r: f64,
    pub area: f64,
    pub cont_area: f64,
    pub torque: V3,
    /// Time since the plate was created or last reorganised (Myr).
    pub age_myr: f64,
}

impl Plate {
    pub fn new(id: u32, n: usize, q: Quat, omega: V3) -> Plate {
        Plate {
            id,
            q,
            omega,
            slot_of: vec![EMPTY; n],
            cell: vec![],
            thick: vec![],
            age: vec![],
            cont: vec![],
            oro: vec![],
            oro_age: vec![],
            world: vec![],
            alive: vec![],
            free: vec![],
            live: 0,
            cen: [0.0, 0.0, 1.0],
            cos_r: -1.0,
            area: 0.0,
            cont_area: 0.0,
            torque: [0.0; 3],
            age_myr: 0.0,
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn add(&mut self, cell: usize, world: usize, thick: f32, age: f32, cont: u8, oro: u8, oro_age: f32) -> usize {
        debug_assert!(self.slot_of[cell] == EMPTY);
        let s = if let Some(s) = self.free.pop() {
            let s = s as usize;
            self.cell[s] = cell as u32;
            self.thick[s] = thick;
            self.age[s] = age;
            self.cont[s] = cont;
            self.oro[s] = oro;
            self.oro_age[s] = oro_age;
            self.world[s] = world as u32;
            self.alive[s] = true;
            s
        } else {
            self.cell.push(cell as u32);
            self.thick.push(thick);
            self.age.push(age);
            self.cont.push(cont);
            self.oro.push(oro);
            self.oro_age.push(oro_age);
            self.world.push(world as u32);
            self.alive.push(true);
            self.cell.len() - 1
        };
        self.slot_of[cell] = s as i32;
        self.live += 1;
        s
    }

    pub fn remove(&mut self, s: usize) {
        if !self.alive[s] {
            return;
        }
        self.alive[s] = false;
        self.slot_of[self.cell[s] as usize] = EMPTY;
        self.free.push(s as u32);
        self.live -= 1;
    }

    /// Drops dead slots when they pile up.
    pub fn maybe_compact(&mut self) {
        if self.free.len() < 1024 || self.free.len() < self.live {
            return;
        }
        let mut w = 0;
        for s in 0..self.cell.len() {
            if !self.alive[s] {
                continue;
            }
            self.cell[w] = self.cell[s];
            self.thick[w] = self.thick[s];
            self.age[w] = self.age[s];
            self.cont[w] = self.cont[s];
            self.oro[w] = self.oro[s];
            self.oro_age[w] = self.oro_age[s];
            self.world[w] = self.world[s];
            self.alive[w] = true;
            self.slot_of[self.cell[w] as usize] = w as i32;
            w += 1;
        }
        for v in [&mut self.thick, &mut self.age, &mut self.oro_age] {
            v.truncate(w);
        }
        self.cell.truncate(w);
        self.cont.truncate(w);
        self.oro.truncate(w);
        self.world.truncate(w);
        self.alive.truncate(w);
        self.free.clear();
    }

    #[inline]
    pub fn slots(&self) -> impl Iterator<Item = usize> + '_ {
        (0..self.cell.len()).filter(move |&s| self.alive[s])
    }

    /// Moves the plate by its angular velocity for `dt` Myr.
    pub fn advance(&mut self, dt: f64) {
        let dq = Quat::from_rotvec(crate::math::scale(self.omega, dt));
        self.q = dq.mul(self.q).normalized();
    }
}
