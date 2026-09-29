/** Minimal binary min-heap of (key, value) pairs backed by typed arrays. */
export class MinHeap {
  private keys: Float64Array;
  private vals: Int32Array;
  size = 0;

  constructor(capacity = 1024) {
    this.keys = new Float64Array(capacity);
    this.vals = new Int32Array(capacity);
  }

  push(key: number, val: number): void {
    if (this.size === this.keys.length) {
      const k = new Float64Array(this.size * 2);
      const v = new Int32Array(this.size * 2);
      k.set(this.keys);
      v.set(this.vals);
      this.keys = k;
      this.vals = v;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= key) break;
      this.keys[i] = this.keys[p];
      this.vals[i] = this.vals[p];
      i = p;
    }
    this.keys[i] = key;
    this.vals[i] = val;
  }

  /** Key of the top element (call only when size > 0). */
  peekKey(): number {
    return this.keys[0];
  }

  /** Removes the top element and returns its value. */
  pop(): number {
    const top = this.vals[0];
    const n = --this.size;
    if (n > 0) {
      const key = this.keys[n];
      const val = this.vals[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && this.keys[c + 1] < this.keys[c]) c++;
        if (this.keys[c] >= key) break;
        this.keys[i] = this.keys[c];
        this.vals[i] = this.vals[c];
        i = c;
      }
      this.keys[i] = key;
      this.vals[i] = val;
    }
    return top;
  }
}
