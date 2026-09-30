/** A window of latency samples (ms) with median / p95. */
export class Samples {
  private xs: number[] = [];
  constructor(private cap = 1000) {}
  add(ms: number): void {
    this.xs.push(ms);
    if (this.xs.length > this.cap) this.xs.shift();
  }
  get count(): number {
    return this.xs.length;
  }
  reset(): void {
    this.xs = [];
  }
  private pick(q: number): number {
    const s = [...this.xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
  }
  /** Median (mean of the two middle values for even counts). */
  get median(): number {
    if (!this.xs.length) return NaN;
    const s = [...this.xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  get p95(): number {
    return this.xs.length ? this.pick(0.95) : NaN;
  }
  get max(): number {
    return this.xs.length ? Math.max(...this.xs) : NaN;
  }
  /** "n=12 median 9 ms p95 15 ms" */
  describe(): string {
    return this.xs.length ? `n=${this.count} median ${Math.round(this.median)} ms p95 ${Math.round(this.p95)} ms` : "n=0";
  }
}
