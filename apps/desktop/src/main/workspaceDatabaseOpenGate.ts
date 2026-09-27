/** Serializes the process-global SQLite workspace switch and coalesces same-workspace opens. */
export class WorkspaceDatabaseOpenGate {
  private inFlight: { workspaceId: string; owner?: object; promise: Promise<unknown> } | null = null;

  run<T>(workspaceId: string, open: () => Promise<T>, owner?: object): Promise<T> {
    const existing = this.inFlight;
    if (existing) {
      if (existing.workspaceId === workspaceId && existing.owner === owner) {
        return existing.promise as Promise<T>;
      }
      return existing.promise.catch(() => undefined).then(() => this.run(workspaceId, open, owner));
    }

    let promise!: Promise<T>;
    promise = Promise.resolve()
      .then(open)
      .finally(() => {
        if (this.inFlight?.promise === promise) this.inFlight = null;
      });
    this.inFlight = { workspaceId, ...(owner ? { owner } : {}), promise };
    return promise;
  }
}
