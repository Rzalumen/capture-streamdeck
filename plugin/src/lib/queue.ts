/** Thrown into the promise of a queued job that was dropped before it started. */
export class DroppedError extends Error {
  constructor(readonly tag: string) {
    super(`dropped (${tag})`);
    this.name = "DroppedError";
  }
}

export interface EnqueueOptions {
  /** Lower runs first (default 1). Presses use 0, polls 2, background reads 3. Equal levels run in arrival order. */
  level?: number;
  /** Legacy: true = level 0. */
  priority?: boolean;
  /** A waiting job with the same key is reused instead of queueing another. */
  coalesceKey?: string;
  /** Jobs with a tag can be dropped while they wait (`dropWaiting`). */
  tag?: string;
}

interface Job {
  run: () => Promise<void>;
  level: number;
  key?: string;
  tag?: string;
  promise: Promise<unknown>;
  reject: (e: unknown) => void;
}

/** One-at-a-time async queue with priority levels. A job that is already running is never interrupted. */
export class SerialQueue {
  private waiting: Job[] = [];
  private running = false;
  /** Set while a job runs (lets tests assert calls never overlap). */
  active = 0;
  maxActive = 0;

  get length(): number {
    return this.waiting.length + (this.running ? 1 : 0);
  }

  /** Number of jobs waiting (not running) that carry this tag. */
  waitingWithTag(tag: string): number {
    return this.waiting.filter((j) => j.tag === tag).length;
  }

  /** Reject and remove every waiting job with this tag (running jobs are left alone). Returns how many were dropped. */
  dropWaiting(tag: string): number {
    const keep: Job[] = [];
    let n = 0;
    for (const j of this.waiting) {
      if (j.tag === tag) {
        j.reject(new DroppedError(tag));
        n++;
      } else keep.push(j);
    }
    this.waiting = keep;
    return n;
  }

  enqueue<T>(task: () => Promise<T>, opts: EnqueueOptions = {}): Promise<T> {
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
    const job: Job = {
      level: opts.level ?? (opts.priority ? 0 : 1),
      key: opts.coalesceKey,
      tag: opts.tag,
      promise,
      reject,
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
    let i = this.waiting.length;
    while (i > 0 && this.waiting[i - 1].level > job.level) i--;
    this.waiting.splice(i, 0, job);
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
