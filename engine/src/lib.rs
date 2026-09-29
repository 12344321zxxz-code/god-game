//! God Game tectonics engine. Built to WebAssembly and driven from
//! TypeScript through the small C ABI in `ffi.rs`.

pub mod ffi;
pub mod grid;
pub mod math;
pub mod params;
pub mod plate;
pub mod rng;
pub mod sim;
