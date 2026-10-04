/** Serialize one complete RAG refresh per logical workspace generation. */
export class RagRefreshQueue {
  private readonly tails = new Map<string, Promise<void>>();

  /** Wait for real operations, not callers already released by cancellation.
   * The lifecycle owner must stop new producers before using this for shutdown.
   */
  async drain(): Promise<void> {
    while (this.tails.size > 0) {
      // A running owner may enqueue another tail while this snapshot settles.
      // run() makes these tails non-rejecting without hiding callers' failures.
      await Promise.all([...this.tails.values()]);
    }
  }

  run<T>(owner: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const abortError = (): Error => Object.assign(new Error('RAG refresh cancelled.'), { name: 'AbortError' });
    if (signal?.aborted) return Promise.reject(abortError());
    const previous = this.tails.get(owner) ?? Promise.resolve();
    const job = previous.then(() => {
      if (signal?.aborted) throw abortError();
      return operation();
    });
    // Rejection is delivered to this caller, but cannot poison the next job.
    const tail = job.then(() => {}, () => {});
    this.tails.set(owner, tail);
    void tail.then(() => { if (this.tails.get(owner) === tail) this.tails.delete(owner); });
    if (!signal) return job;
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => reject(abortError());
      signal.addEventListener('abort', abort, { once: true });
      job.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
}
