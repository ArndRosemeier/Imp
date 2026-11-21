/** An in-place radix-2 FFT, for spectral work such as noise reduction. */
export class Fft {
  readonly #cos: Float64Array;
  readonly #sin: Float64Array;
  readonly #reverse: Uint32Array;

  constructor(readonly size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`An FFT size must be a power of two, not ${String(size)}.`);
    }
    this.#cos = new Float64Array(size / 2);
    this.#sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.#cos[i] = Math.cos((2 * Math.PI * i) / size);
      this.#sin[i] = Math.sin((2 * Math.PI * i) / size);
    }
    this.#reverse = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let reversed = 0;
      for (let b = 0; b < bits; b++) reversed |= ((i >> b) & 1) << (bits - 1 - b);
      this.#reverse[i] = reversed;
    }
  }

  /** Transforms in place; `inverse` runs the inverse transform, scaled by 1/size. */
  transform(re: Float64Array, im: Float64Array, inverse = false): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const j = this.#reverse[i] ?? i;
      if (j > i) {
        const tr = re[i] ?? 0;
        re[i] = re[j] ?? 0;
        re[j] = tr;
        const ti = im[i] ?? 0;
        im[i] = im[j] ?? 0;
        im[j] = ti;
      }
    }
    const sign = inverse ? 1 : -1;
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = this.#cos[k * step] ?? 1;
          const wi = sign * (this.#sin[k * step] ?? 0);
          const a = start + k;
          const b = a + half;
          const br = re[b] ?? 0;
          const bi = im[b] ?? 0;
          const xr = br * wr - bi * wi;
          const xi = br * wi + bi * wr;
          re[b] = (re[a] ?? 0) - xr;
          im[b] = (im[a] ?? 0) - xi;
          re[a] = (re[a] ?? 0) + xr;
          im[a] = (im[a] ?? 0) + xi;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i++) {
        re[i] = (re[i] ?? 0) / n;
        im[i] = (im[i] ?? 0) / n;
      }
    }
  }
}
