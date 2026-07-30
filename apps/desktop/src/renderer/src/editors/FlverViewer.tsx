import { useEffect, useRef, useState, type ReactElement } from 'react';

export interface FlverViewerProps {
  sourceUri?: string;
  meshIndex?: number;
  boundingBox?: { min: number[]; max: number[] } | undefined;
  boneCount?: number;
  meshCount?: number;
}

interface MeshData {
  positionsBase64: string;
  indicesBase64: string;
  uvsBase64?: string | undefined;
  normalsBase64?: string | undefined;
  vertexCount: number;
}

/**
 * FLVER 3D 预览器：显示包围盒、坐标轴和第一个网格的线框。
 * 使用 Three.js WebGL2 渲染（WebGPU 回退由 threeSceneController 处理）。
 */
export function FlverViewer(props: FlverViewerProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<{ dispose: () => void } | null>(null);
  const [meshData, setMeshData] = useState<MeshData | null>(null);
  const [meshError, setMeshError] = useState<string | null>(null);

  // Load mesh data via IPC when sourceUri or meshIndex changes.
  useEffect(() => {
    if (!props.sourceUri || typeof window.soulforge.readFlverMesh !== 'function') return;
    setMeshData(null);
    setMeshError(null);
    const idx = props.meshIndex ?? 0;
    void (async () => {
      try {
        const result = await window.soulforge.readFlverMesh(props.sourceUri!, idx) as {
          ok: boolean;
          data?: { positionsBase64?: string; indicesBase64?: string; uvsBase64?: string; normalsBase64?: string; vertexCount?: number };
          diagnostics?: Array<{ message: string }>;
        };
        if (result.ok && result.data?.positionsBase64) {
          setMeshData({
            positionsBase64: result.data.positionsBase64,
            indicesBase64: result.data.indicesBase64 ?? '',
            uvsBase64: result.data.uvsBase64 ?? undefined,
            normalsBase64: result.data.normalsBase64 ?? undefined,
            vertexCount: result.data.vertexCount ?? 0
          });
        } else {
          setMeshError(result.diagnostics?.[0]?.message ?? '网格数据不可用');
        }
      } catch (error) {
        setMeshError(error instanceof Error ? error.message : '网格加载失败');
      }
    })();
  }, [props.sourceUri, props.meshIndex]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;

    void (async () => {
      const three = await import('three');
      const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js') as {
        OrbitControls: new (camera: unknown, domElement: HTMLElement) => {
          enableDamping: boolean; dampingFactor: number; update: () => void; dispose: () => void;
        };
      };
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

      // Render mesh geometry if available.
      if (meshData) {
        try {
          const posBytes = Uint8Array.from(atob(meshData.positionsBase64), (c) => c.charCodeAt(0));
          const positions = new Float32Array(posBytes.buffer);
          const geometry = new three.BufferGeometry();
          geometry.setAttribute('position', new three.BufferAttribute(positions, 3));

          // Add UV coordinates if available.
          if (meshData.uvsBase64) {
            const uvBytes = Uint8Array.from(atob(meshData.uvsBase64), (c) => c.charCodeAt(0));
            const uvs = new Float32Array(uvBytes.buffer);
            geometry.setAttribute('uv', new three.BufferAttribute(uvs, 2));
          }

          // Add normals: use FLVER normals if available, otherwise compute from positions.
          if (meshData.normalsBase64) {
            const normBytes = Uint8Array.from(atob(meshData.normalsBase64), (c) => c.charCodeAt(0));
            const normals = new Float32Array(normBytes.buffer);
            geometry.setAttribute('normal', new three.BufferAttribute(normals, 3));
          } else {
            geometry.computeVertexNormals();
          }

          if (meshData.indicesBase64) {
            const idxBytes = Uint8Array.from(atob(meshData.indicesBase64), (c) => c.charCodeAt(0));
            const indices = new Uint16Array(idxBytes.buffer);
            geometry.setIndex(new three.BufferAttribute(indices, 1));
          }

          geometry.computeVertexNormals();

          // Assign color based on mesh index for visual distinction.
          const hue = ((props.meshIndex ?? 0) * 137.508) % 360; // Golden angle for distinct colors
          const color = new three.Color().setHSL(hue / 360, 0.5, 0.55);
          const material = new three.MeshStandardMaterial({
            color,
            wireframe: false,
            side: three.DoubleSide,
            flatShading: true
          });
          const mesh = new three.Mesh(geometry, material);
          scene.add(mesh);

          // Also add wireframe overlay.
          const wireMaterial = new three.MeshBasicMaterial({
            color: 0x88bbee,
            wireframe: true,
            transparent: true,
            opacity: 0.15
          });
          const wireMesh = new three.Mesh(geometry, wireMaterial);
          scene.add(wireMesh);
        } catch {
          // Mesh data decode failed; show bounding box only.
        }
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

      // Orbit controls for rotate/zoom/pan.
      const controls = new OrbitControls(camera, canvas);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;

      let raf = 0;
      const tick = (): void => {
        if (disposed) return;
        controls.update();
        renderer.render(scene, camera);
        raf = requestAnimationFrame(tick);
      };
      tick();

      handleRef.current = {
        dispose: () => {
          disposed = true;
          cancelAnimationFrame(raf);
          window.removeEventListener('resize', setSize);
          controls.dispose();
          renderer.dispose();
          canvas.remove();
        }
      };
    })();

    return () => {
      handleRef.current?.dispose();
      handleRef.current = null;
    };
  }, [props.boundingBox, props.boneCount, props.meshCount, meshData]);

  return (
    <div style={{ position: 'relative', width: '100%', height: 300, background: '#1a1d23', borderRadius: 4 }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      <div style={{
        position: 'absolute', top: 8, left: 8, color: '#8899aa', fontSize: 12,
        background: 'rgba(0,0,0,0.5)', padding: '4px 8px', borderRadius: 4
      }}>
        FLVER 3D 预览 · {props.boneCount ?? 0} bones · {props.meshCount ?? 0} meshes
        {meshData ? ` · mesh[0] ${meshData.vertexCount} verts` : meshError ? ` · ${meshError}` : ''}
      </div>
    </div>
  );
}
