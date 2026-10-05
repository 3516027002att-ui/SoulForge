import type { PerspectiveCamera } from 'three';
type Bounds = { min: [number, number, number]; max: [number, number, number]; center: [number, number, number] };
type FrameOptions = { minSpan?: number; minDistance?: number; distanceScale?: number; azimuth?: number; elevation?: number };
/** Camera navigation is renderer-local and cannot mutate asset transforms. */
export class SceneCameraController {
  private readonly three: typeof import('three');
  private readonly camera: PerspectiveCamera;
  private readonly invalidate: () => void;
  private yaw = 0;
  private pitch = -0.25;
  private speed = 15;
  private readonly forward;
  private readonly right;
  private readonly direction;
  private readonly up;
  constructor(three: typeof import('three'), camera: PerspectiveCamera, invalidate: () => void) {
    this.three = three;
    this.camera = camera;
    this.invalidate = invalidate;
    this.forward = new three.Vector3();
    this.right = new three.Vector3();
    this.direction = new three.Vector3();
    this.up = new three.Vector3(0, 1, 0);
    this.orient();
  }
  private orient(): void {
    const forward = this.forward.set(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch)).normalize();
    this.camera.lookAt(this.camera.position.clone().add(forward));
    this.camera.updateMatrixWorld(true);
    this.invalidate();
  }
  frame(bounds: Bounds, options: FrameOptions = {}): void {
    const [cx, cy, cz] = bounds.center;
    const span = Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2], options.minSpan ?? 15);
    this.speed = Math.max(10, Math.min(span * 0.12, 120));
    const distance = Math.max(span * (options.distanceScale ?? 1), options.minDistance ?? 16);
    if (options.azimuth !== undefined || options.elevation !== undefined) {
      const azimuth = options.azimuth ?? Math.PI / 4;
      const elevation = options.elevation ?? Math.atan(0.75 / Math.sqrt(2));
      const horizontal = Math.cos(elevation) * distance;
      this.camera.position.set(cx + Math.sin(azimuth) * horizontal, cy + Math.sin(elevation) * distance, cz + Math.cos(azimuth) * horizontal);
    } else this.camera.position.set(cx + distance, cy + distance * 0.75, cz + distance);
    this.camera.lookAt(cx, cy, cz);
    this.camera.updateMatrixWorld(true);
    const direction = this.direction.set(cx - this.camera.position.x, cy - this.camera.position.y, cz - this.camera.position.z).normalize();
    this.pitch = Math.asin(Math.max(-0.999, Math.min(0.999, direction.y)));
    this.yaw = Math.atan2(direction.x, -direction.z);
    this.invalidate();
  }
  look(x: number, y: number): void {
    this.yaw -= x * 0.0028;
    this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch - y * 0.0028));
    this.orient();
  }
  pan(x: number, y: number): void {
    const amount = this.speed * 0.0018;
    this.camera.getWorldDirection(this.forward);
    this.right.crossVectors(this.forward, this.up).normalize();
    this.direction.crossVectors(this.right, this.forward).normalize();
    this.camera.position.addScaledVector(this.right, -x * amount);
    this.camera.position.addScaledVector(this.direction, y * amount);
    this.invalidate();
  }
  wheel(deltaY: number, adjustSpeed: boolean): void {
    if (adjustSpeed) this.speed = Math.max(1, Math.min(this.speed * (deltaY < 0 ? 1.2 : 0.83), 500));
    else { this.camera.getWorldDirection(this.forward); this.camera.position.addScaledVector(this.forward, (deltaY < 0 ? 1 : -1) * this.speed * 0.15); this.invalidate(); }
  }
  move(pressed: ReadonlySet<string>, delta: number): void {
    if (!pressed.size) return;
    this.camera.getWorldDirection(this.forward);
    this.right.crossVectors(this.forward, this.up).normalize();
    this.direction.set(0, 0, 0);
    if (pressed.has('w')) this.direction.add(this.forward);
    if (pressed.has('s')) this.direction.sub(this.forward);
    if (pressed.has('a')) this.direction.sub(this.right);
    if (pressed.has('d')) this.direction.add(this.right);
    if (pressed.has('q') || pressed.has('c')) this.direction.sub(this.up);
    if (pressed.has('e') || pressed.has('space')) this.direction.add(this.up);
    if (this.direction.lengthSq() > 0) { this.direction.normalize().multiplyScalar(this.speed * (pressed.has('shift') ? 3.5 : 1) * delta); this.camera.position.add(this.direction); this.invalidate(); }
  }
}
