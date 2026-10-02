/**
 * Stream Deck global settings are ONE object shared by everything in the plugin, and `setGlobalSettings` REPLACES it.
 * Every writer therefore goes through here: read the current object, merge only its own keys, write it back, one writer at a time.
 * If the read fails nothing is written (a failed read must never wipe the other keys).
 */
export interface GlobalIO {
  get(): Promise<Record<string, unknown>>;
  set(all: Record<string, unknown>): Promise<void>;
}

export class GlobalSettings {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    private io: GlobalIO,
    private timeoutMs = 5000,
  ) {}

  private guard<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("global settings did not answer")), this.timeoutMs);
      t.unref?.();
      p.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e) => {
          clearTimeout(t);
          reject(e);
        },
      );
    });
  }

  read(): Promise<Record<string, unknown>> {
    return this.guard(this.io.get()).then((g) => (g && typeof g === "object" ? g : {}));
  }

  /** Merge `patch` (top-level keys) into the stored object. Serialised with every other update. */
  update(patch: Record<string, unknown>): Promise<void> {
    const run = async (): Promise<void> => {
      const cur = await this.read();
      await this.guard(this.io.set({ ...cur, ...patch }));
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }
}
