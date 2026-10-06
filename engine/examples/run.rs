//! Native debug runner: cargo run --release --example run -- init.bin [myr]
//! (make init.bin with DRIFT_DUMP=init.bin npx tsx scripts/drift-try.ts …)
use tecto::grid::Grid;
use tecto::params::Params;
use tecto::sim::Sim;

fn take<'a>(b: &'a [u8], at: &mut usize, bytes: usize) -> &'a [u8] {
    let s = &b[*at..*at + bytes];
    *at += bytes.div_ceil(8) * 8;
    s
}
fn cast<T: Copy>(b: &[u8]) -> Vec<T> {
    let n = b.len() / std::mem::size_of::<T>();
    (0..n).map(|i| unsafe { std::ptr::read_unaligned(b.as_ptr().add(i * std::mem::size_of::<T>()) as *const T) }).collect()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let b = std::fs::read(&args[1]).unwrap();
    let myr: f64 = args.get(2).map(|s| s.parse().unwrap()).unwrap_or(100.0);
    let mut at = 0;
    let head: Vec<u32> = cast(take(&b, &mut at, 16));
    let (n, nn, np, npl) = (head[0] as usize, head[1] as usize, head[2] as usize, head[3] as usize);
    let pos: Vec<f64> = cast(take(&b, &mut at, 24 * n));
    let off: Vec<u32> = cast(take(&b, &mut at, 4 * (n + 1)));
    let nbrs: Vec<u32> = cast(take(&b, &mut at, 4 * nn));
    let area: Vec<f64> = cast(take(&b, &mut at, 8 * n));
    let mut prm: Vec<f64> = cast(take(&b, &mut at, 8 * np));
    // PRM=i:v,j:w overrides engine parameters (see params.rs indices)
    if let Ok(o) = std::env::var("PRM") {
        for kv in o.split(',') {
            let (k, v) = kv.split_once(':').unwrap();
            prm[k.parse::<usize>().unwrap()] = v.parse().unwrap();
        }
    }
    let plate: Vec<u32> = cast(take(&b, &mut at, 4 * n));
    let cont: Vec<u8> = cast(take(&b, &mut at, n));
    let thick: Vec<f32> = cast(take(&b, &mut at, 4 * n));
    let age: Vec<f32> = cast(take(&b, &mut at, 4 * n));
    let omega: Vec<f64> = cast(take(&b, &mut at, 24 * npl));
    let g = Grid::new(&pos, &off, &nbrs, &area);
    let mut sim = Sim::new(g, Params::from_slice(&prm));
    sim.init(&plate, &cont, &thick, &age, &omega);
    println!("init   {}", sim.census());
    let t0 = std::time::Instant::now();
    let mut t = 0.0;
    let chunk: f64 = std::env::var("CHUNK").ok().map(|v| v.parse().unwrap()).unwrap_or(10.0);
    let with_output = std::env::var("OUTPUT").is_ok();
    while t < myr - 1e-6 {
        t = sim.run(chunk.min(myr - t), 1_000_000);
        if with_output {
            sim.output();
        }
        if std::env::var("QUIET").is_err() {
            sim.debug_report();
        }
        if std::env::var("CENSUS").is_ok() && (t / 100.0).floor() > ((t - chunk) / 100.0).floor() {
            println!("t={:<4.0} {}", t, sim.census());
        }
    }
    eprintln!("{} Myr in {:.2}s", myr, t0.elapsed().as_secs_f64());
    println!("final  {}", sim.census());
    println!("fingerprint {:016x}", sim.fingerprint());
    let d = sim.stats.adv_hist;
    println!("active continental margin cell·Myr by upper-plate advance: <-10: {:.0}  -10..2: {:.0}  2..10: {:.0}  10..25: {:.0}  >25: {:.0}; mean conv {:.0}", d[0], d[1], d[2], d[3], d[4], d[5] / d[6].max(1e-9));
    println!(
        "area sr: arc/basin→continent {:.3}, hot spot→continent {:.3}, continent copied into holes {:.3}, continent stretched to ocean {:.3}",
        sim.stats.conv_arc, sim.stats.conv_hot, sim.stats.copy_cont, sim.stats.cont_lost
    );
    let b = sim.stats.budget;
    println!(
        "budget sr·km: cordillera {:.2} rift {:.2} hotspot {:.2} erosion {:.2} deposition {:.2} collision {:.2} flow {:.2}; merges {} rifts {} inits {}",
        b[0], b[1], b[2], b[3], b[4], b[5], b[6], sim.stats.merges, sim.stats.rifts, sim.stats.sub_inits
    );
    let names = ["coverage", "local", "gaps", "gather", "subduction", "coll+rift", "hotspots", "flow", "erosion", "apply", "bounds", "forces", "events"];
    for (n, t) in names.iter().zip(sim.prof.iter()) {
        eprintln!("  {:<11} {:6.2}s", n, t);
    }
}
