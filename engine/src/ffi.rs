//! Raw C ABI for the wasm build (no wasm-bindgen). JS allocates input
//! buffers with `alloc`, fills them, and reads outputs through pointers
//! into linear memory. All pointers stay valid until the next call that
//! may allocate, so JS re-creates its typed-array views after every call.

use crate::grid::Grid;
use crate::params::Params;
use crate::sim::{PLATE_FIELDS, STAT_FIELDS, Sim};
use std::slice::from_raw_parts;

/// 8-byte aligned allocation (so f64 arrays can live in it).
#[unsafe(no_mangle)]
pub extern "C" fn alloc(bytes: usize) -> *mut u8 {
    let words = bytes.div_ceil(8).max(1);
    let mut v: Vec<u64> = Vec::with_capacity(words);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p as *mut u8
}

/// # Safety
/// `p` must come from `alloc(bytes)` with the same `bytes`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(p: *mut u8, bytes: usize) {
    let words = bytes.div_ceil(8).max(1);
    unsafe { drop(Vec::from_raw_parts(p as *mut u64, 0, words)) };
}

/// # Safety
/// Pointers must reference arrays of the stated lengths.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_new(
    n: usize,
    pos: *const f64,
    off: *const u32,
    nbrs: *const u32,
    nnbrs: usize,
    area: *const f64,
    params: *const f64,
    nparams: usize,
) -> *mut Sim {
    let g = unsafe { Grid::new(from_raw_parts(pos, 3 * n), from_raw_parts(off, n + 1), from_raw_parts(nbrs, nnbrs), from_raw_parts(area, n)) };
    let prm = Params::from_slice(unsafe { from_raw_parts(params, nparams) });
    Box::into_raw(Box::new(Sim::new(g, prm)))
}

/// # Safety
/// `sim` from `sim_new`; arrays of length n (omega: 3·nplates).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_init(
    sim: *mut Sim,
    plate: *const u32,
    cont: *const u8,
    thick: *const f32,
    age: *const f32,
    omega: *const f64,
    nplates: usize,
) {
    let s = unsafe { &mut *sim };
    let n = s.g.n;
    unsafe {
        s.init(
            from_raw_parts(plate, n),
            from_raw_parts(cont, n),
            from_raw_parts(thick, n),
            from_raw_parts(age, n),
            from_raw_parts(omega, 3 * nplates),
        )
    };
}

/// Advances by `myr` (at most `max_steps` steps); returns the sim time.
/// # Safety
/// `sim` from `sim_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_run(sim: *mut Sim, myr: f64, max_steps: u32) -> f64 {
    unsafe { &mut *sim }.run(myr, max_steps)
}

/// Refreshes the output buffers.
/// # Safety
/// `sim` from `sim_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_output(sim: *mut Sim) {
    unsafe { &mut *sim }.output();
}

/// Output buffer pointers: 0 owner u32, 1 crust type u8, 2 thickness f32 km,
/// 3 crust age f32 Myr, 4 orogeny u8, 5 elevation f32 km, 6 plates f64
/// (PLATE_FIELDS each), 7 stats f64 (STAT_FIELDS).
/// # Safety
/// `sim` from `sim_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_out(sim: *mut Sim, which: u32) -> *const u8 {
    let s = unsafe { &*sim };
    match which {
        0 => s.out_owner.as_ptr() as *const u8,
        1 => s.cont_w.as_ptr(),
        2 => s.thick_w.as_ptr() as *const u8,
        3 => s.age_w.as_ptr() as *const u8,
        4 => s.out_oro.as_ptr(),
        5 => s.elev.as_ptr() as *const u8,
        6 => s.out_plates.as_ptr() as *const u8,
        7 => s.out_stats.as_ptr() as *const u8,
        _ => std::ptr::null(),
    }
}

/// # Safety
/// `sim` from `sim_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_plate_count(sim: *mut Sim) -> u32 {
    unsafe { &*sim }.out_plates.len() as u32 / PLATE_FIELDS as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn sim_layout(which: u32) -> u32 {
    match which {
        0 => PLATE_FIELDS as u32,
        _ => STAT_FIELDS as u32,
    }
}

/// # Safety
/// `sim` from `sim_new`, not used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_free(sim: *mut Sim) {
    drop(unsafe { Box::from_raw(sim) });
}
