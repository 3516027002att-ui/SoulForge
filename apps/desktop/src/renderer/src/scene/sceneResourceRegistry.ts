type Disposable = { dispose(): void };
/** Per-mount resource ownership. No document data or cross-context GPU sharing. */
export class SceneResourceRegistry {
  readonly resources: Disposable[] = [];
  private readonly staticResources = new Set<Disposable>();
  private disposed = false;
  track<T extends Disposable>(resource: T): T {
    if (this.disposed) throw new Error('SCENE_RESOURCES_DISPOSED');
    if (!this.resources.includes(resource)) this.resources.push(resource);
    return resource;
  }
  trackStatic<T extends Disposable>(resource: T): T {
    if (this.disposed) throw new Error('SCENE_RESOURCES_DISPOSED');
    this.staticResources.add(resource);
    return resource;
  }
  releaseWhere(predicate: (resource: Disposable) => boolean): void {
    for (let index = this.resources.length - 1; index >= 0; index--) {
      const resource = this.resources[index]!;
      if (predicate(resource)) { this.resources.splice(index, 1); resource.dispose(); }
    }
  }
  clearContent(): void {
    const resources = new Set(this.resources.splice(0));
    for (const resource of resources) resource.dispose();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearContent();
    for (const resource of this.staticResources) resource.dispose();
    this.staticResources.clear();
  }
}
