/** One-at-a-time async queue. Priority jobs go ahead of waiting (not running) normal jobs. */
export class SerialQueue {
  private waiting: { run: () => Promise<void>; priority: boolean; key?: string; promise: Promise<unknown> }[] = [];
  private running = false;
  /** Set while a job runs (lets tests assert calls never overlap). */
  active = 0;
  maxActive = 0;

  get length(): number {
    return this.waiting.length + (this.running ? 1 : 0);
  }

  enqueue<T>(task: () => Promise<T>, opts: { priority?: boolean; coalesceKey?: string } = {}): Promise<T> {
    if (opts.coalesceKey) {
      const dup = this.waiting.find((w) => w.key === opts.coalesceKey);
      if (dup) return dup.promise as Promise<T>;
    }
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const job = {
      priority: !!opts.priority,
      key: opts.coalesceKey,
      promise,
      run: async () => {
        this.active++;
        this.maxActive = Math.max(this.maxActive, this.active);
        try {
          resolve(await task());
        } catch (e) {
          reject(e);
        } finally {
          this.active--;
        }
      },
    };
    if (job.priority) {
      let i = 0;
      while (i < this.waiting.length && this.waiting[i].priority) i++;
      this.waiting.splice(i, 0, job);
    } else this.waiting.push(job);
    void this.pump();
    return promise;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let job;
      while ((job = this.waiting.shift())) await job.run();
    } finally {
      this.running = false;
    }
  }
}
