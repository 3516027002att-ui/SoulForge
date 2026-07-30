import { useEffect, useRef, type ReactElement } from 'react';

export interface FlverViewerProps {
  boundingBox?: { min: number[]; max: number[] } | undefined;
  boneCount?: number;
  meshCount?: number;
}

/**
 * FLVER 3D 预览器：显示包围盒和坐标轴。
 * 使用 Three.js WebGL2 渲染（WebGPU 回退由 threeSceneController 处理）。
 */
export function FlverViewer(props: FlverViewerProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<{ dispose: () => void } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;

    void (async () => {
      const three = await import('three');
      const canvas = document.createElement('canvas');
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.display = 'block';
      container.replaceChildren(canvas);

      const renderer = new three.WebGLRenderer({ canvas, antialias: true, alpha: false });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      const scene = new three.Scene();
      scene.background = new three.Color(0x1a1d23);

      const camera = new three.PerspectiveCamera(55, 1, 0.1, 50_000);
      scene.add(new three.AmbientLight(0xffffff, 0.55));
      const key = new three.DirectionalLight(0xffffff, 0.85);
      key.position.set(40, 80, 20);
      scene.add(key);
      scene.add(new three.GridHelper(200, 20, 0x3a4150, 0x2a303c));
      scene.add(new three.AxesHelper(10));

      // Draw bounding box if available.
      if (props.boundingBox) {
        const { min, max } = props.boundingBox;
        const box = new three.Box3(
          new three.Vector3(min[0], min[1], min[2]),
          new three.Vector3(max[0], max[1], max[2])
        );
        const helper = new three.Box3Helper(box, 0x44aaff);
        scene.add(helper);

        // Center camera on bounding box.
        const center = box.getCenter(new three.Vector3());
        const size = box.getSize(new three.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        camera.position.set(center.x + maxDim, center.y + maxDim * 0.5, center.z + maxDim);
        camera.lookAt(center);
      } else {
        camera.position.set(50, 30, 50);
        camera.lookAt(0, 0, 0);
      }

      const setSize = (): void => {
        const width = Math.max(container.clientWidth, 1);
        const height = Math.max(container.clientHeight, 1);
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      };
      setSize();
      window.addEventListener('resize', setSize);

      let raf = 0;
      const tick = (): void => {
        if (disposed) return;
        renderer.render(scene, camera);
        raf = requestAnimationFrame(tick);
      };
      tick();

      handleRef.current = {
        dispose: () => {
          disposed = true;
          cancelAnimationFrame(raf);
          window.removeEventListener('resize', setSize);
          renderer.dispose();
          canvas.remove();
        }
      };
    })();

    return () => {
      handleRef.current?.dispose();
      handleRef.current = null;
    };
  }, [props.boundingBox, props.boneCount, props.meshCount]);

  return (
    <div style={{ position: 'relative', width: '100%', height: 300, background: '#1a1d23', borderRadius: 4 }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      <div style={{
        position: 'absolute', top: 8, left: 8, color: '#8899aa', fontSize: 12,
        background: 'rgba(0,0,0,0.5)', padding: '4px 8px', borderRadius: 4
      }}>
        FLVER 3D 预览 · {props.boneCount ?? 0} bones · {props.meshCount ?? 0} meshes
      </div>
    </div>
  );
}
