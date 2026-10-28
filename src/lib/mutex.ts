/** Minimal async mutex so only one upload/replace can run at a time in this process. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  private held = false;

  get isLocked() {
    return this.held;
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    await prev;
    this.held = true;
    try {
      return await fn();
    } finally {
      this.held = false;
      release();
    }
  }
}
