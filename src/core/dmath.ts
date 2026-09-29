/**
 * Deterministic maths for world generation.
 *
 * JavaScript engines may implement Math.sin, Math.exp, … differently (Node
 * 22 and Chrome 141 differ in the last bits), and the plate simulation is
 * chaotic enough to turn that into a different planet for the same seed.
 * Generation code therefore uses `M.*` instead of `Math.*` for anything
 * beyond + − × ÷ √: after `initDeterministicMath()` these run the Rust
 * (musl-derived) implementations compiled into the engine's WebAssembly,
 * which give identical results everywhere. Before init they fall back to
 * Math (fine for code that doesn't need cross-browser reproducibility).
 */
export interface DMath {
  exp(x: number): number;
  log(x: number): number;
  sin(x: number): number;
  cos(x: number): number;
  tan(x: number): number;
  acos(x: number): number;
  asin(x: number): number;
  atan(x: number): number;
  atan2(y: number, x: number): number;
  pow(x: number, y: number): number;
  cbrt(x: number): number;
  tanh(x: number): number;
  /** √(x² + y² [+ z²]) without Math.hypot's engine-specific scaling. */
  hypot(x: number, y: number, z?: number): number;
}

const fallback: DMath = {
  exp: Math.exp,
  log: Math.log,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  acos: Math.acos,
  asin: Math.asin,
  atan: Math.atan,
  atan2: Math.atan2,
  pow: Math.pow,
  cbrt: Math.cbrt,
  tanh: Math.tanh,
  hypot: (x, y, z = 0) => Math.sqrt(x * x + y * y + z * z),
};

/** The active implementation (mutated in place by init so imports stay live). */
export const M: DMath = { ...fallback };

export interface MathExports {
  m_exp(x: number): number;
  m_log(x: number): number;
  m_sin(x: number): number;
  m_cos(x: number): number;
  m_tan(x: number): number;
  m_acos(x: number): number;
  m_asin(x: number): number;
  m_atan(x: number): number;
  m_atan2(y: number, x: number): number;
  m_pow(x: number, y: number): number;
  m_cbrt(x: number): number;
  m_tanh(x: number): number;
}

export function useDeterministicMath(ex: MathExports): void {
  Object.assign(M, {
    exp: ex.m_exp,
    log: ex.m_log,
    sin: ex.m_sin,
    cos: ex.m_cos,
    tan: ex.m_tan,
    acos: ex.m_acos,
    asin: ex.m_asin,
    atan: ex.m_atan,
    atan2: ex.m_atan2,
    pow: ex.m_pow,
    cbrt: ex.m_cbrt,
    tanh: ex.m_tanh,
  });
}
