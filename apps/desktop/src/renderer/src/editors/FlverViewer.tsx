import { useEffect, useRef, useState, type ReactElement } from 'react';

export interface FlverViewerProps {
  sourceUri?: string;
  meshIndex?: number;
  boundingBox?: { min: number[]; max: number[] } | undefined;
  boneCount?: number;
  meshCount?: number;
  bones?: Array<{ name: string; position: [number, number, number]; parentIndex: number }> | undefined;
  textureBase64?: string | undefined;
  boneWeightsBase64?: string | undefined;
  boneIndicesBase64?: string | undefined;
}

interface MeshData {
  positionsBase64: string;
  indicesBase64: string;
  uvsBase64?: string | undefined;
  normalsBase64?: string | undefined;
  boneWeightsBase64?: string | undefined;
  boneIndicesBase64?: string | undefined;
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
  const [skeletonBones, setSkeletonBones] = useState<
    Array<{ name: string; parentIndex: number; translation: [number, number, number]; rotation: [number, number, number] }> | null
  >(null);
  const [dummyPoints, setDummyPoints] = useState<
    Array<{ referenceId: number; position: [number, number, number] }> | null
  >(null);

  // Load dummy attachment points via IPC when sourceUri changes.
  useEffect(() => {
    if (!props.sourceUri || typeof window.soulforge.readFlverDummies !== 'function') return;
    setDummyPoints(null);
    void (async () => {
      try {
        const result = await window.soulforge.readFlverDummies(props.sourceUri!) as {
          ok: boolean;
          data?: { dummies?: Array<{ referenceId: number; position: number[] }> };
        };
        const raw = result.ok ? result.data?.dummies ?? [] : [];
        if (raw.length === 0) return;
        setDummyPoints(
          raw.map((d) => ({
            referenceId: d.referenceId,
            position: [d.position[0] ?? 0, d.position[1] ?? 0, d.position[2] ?? 0]
          }))
        );
      } catch {
        // Dummy load failed; leave markers hidden.
      }
    })();
  }, [props.sourceUri]);

  // Load skeleton hierarchy via IPC when sourceUri changes.
  // Stores raw parent-relative transforms; world transforms are computed in the
  // scene-building effect (where three.js matrices are available).
  useEffect(() => {
    if (!props.sourceUri || typeof window.soulforge.readFlverSkeleton !== 'function') return;
    setSkeletonBones(null);
    void (async () => {
      try {
        const result = await window.soulforge.readFlverSkeleton(props.sourceUri!) as {
          ok: boolean;
          data?: { bones?: Array<{ name: string; parentIndex: number; translation: number[]; rotation: number[] }> };
        };
        const raw = result.ok ? result.data?.bones ?? [] : [];
        if (raw.length === 0) return;
        setSkeletonBones(
          raw.map((b) => ({
            name: b.name,
            parentIndex: b.parentIndex,
            translation: [b.translation[0] ?? 0, b.translation[1] ?? 0, b.translation[2] ?? 0],
            rotation: [b.rotation[0] ?? 0, b.rotation[1] ?? 0, b.rotation[2] ?? 0]
          }))
        );
      } catch {
        // Skeleton load failed; leave hierarchy hidden.
      }
    })();
  }, [props.sourceUri]);

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
          data?: { positionsBase64?: string; indicesBase64?: string; uvsBase64?: string; normalsBase64?: string; boneWeightsBase64?: string; boneIndicesBase64?: string; vertexCount?: number };
          diagnostics?: Array<{ message: string }>;
        };
        if (result.ok && result.data?.positionsBase64) {
          setMeshData({
            positionsBase64: result.data.positionsBase64,
            indicesBase64: result.data.indicesBase64 ?? '',
            uvsBase64: result.data.uvsBase64 ?? undefined,
            normalsBase64: result.data.normalsBase64 ?? undefined,
            boneWeightsBase64: result.data.boneWeightsBase64 ?? undefined,
            boneIndicesBase64: result.data.boneIndicesBase64 ?? undefined,
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
      const ddsLoaderModule = await import('three/examples/jsm/loaders/DDSLoader.js');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const DDSLoader = (ddsLoaderModule as any).DDSLoader as { parse(buffer: ArrayBuffer, loadMipmaps: boolean): { mipmaps: Array<{ data: Uint8Array; width: number; height: number }>; width: number; height: number; format: number; mipmapCount: number } };
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

          // Try to load texture if available.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let texture: any;
          if (props.textureBase64) {
            try {
              const texBytes = Uint8Array.from(atob(props.textureBase64), (c) => c.charCodeAt(0));
              // Check for DDS magic "DDS " (0x20534444).
              const isDds = texBytes.length > 4 && texBytes[0] === 0x44 && texBytes[1] === 0x44 && texBytes[2] === 0x53 && texBytes[3] === 0x20;
              if (isDds && texBytes.length > 128) {
                // Decode DDS (DXT1/DXT5/BC4/BC5) via three.js DDSLoader into a CompressedTexture.
                try {
                  const dds = DDSLoader.parse(texBytes.buffer.slice(texBytes.byteOffset, texBytes.byteOffset + texBytes.byteLength), true);
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const compressedTexture = new three.CompressedTexture(dds.mipmaps as any, dds.width, dds.height, dds.format as any, three.UnsignedByteType);
                  compressedTexture.minFilter = dds.mipmapCount > 1 ? three.LinearMipmapLinearFilter : three.LinearFilter;
                  compressedTexture.magFilter = three.LinearFilter;
                  compressedTexture.generateMipmaps = false;
                  compressedTexture.flipY = false;
                  compressedTexture.needsUpdate = true;
                  texture = compressedTexture;
                } catch {
                  // DDS decode failed (unsupported fourCC); fall back to gradient placeholder.
                  const dv = new DataView(texBytes.buffer);
                  const height = dv.getUint32(12, true) ?? 256;
                  const width = dv.getUint32(16, true) ?? 256;
                  const fourCC = String.fromCharCode(texBytes[84] ?? 0, texBytes[85] ?? 0, texBytes[86] ?? 0, texBytes[87] ?? 0);
                  const size = Math.min(256, Math.max(1, Math.min(width, height)));
                  const data = new Uint8Array(size * size * 4);
                  for (let i = 0; i < data.length; i += 4) {
                    const x = (i / 4) % size;
                    const y = Math.floor((i / 4) / size);
                    data[i] = Math.floor((x / size) * 255);
                    data[i + 1] = Math.floor((y / size) * 255);
                    data[i + 2] = fourCC === 'DXT1' ? 128 : 200;
                    data[i + 3] = 255;
                  }
                  texture = new three.DataTexture(data, size, size, three.RGBAFormat);
                  texture.needsUpdate = true;
                }
              } else {
                // Non-DDS or too small: create a simple DataTexture.
                const size = Math.min(256, Math.floor(Math.sqrt(texBytes.length / 4)));
                if (size > 0) {
                  const data = new Uint8Array(size * size * 4);
                  data.set(texBytes.subarray(0, Math.min(texBytes.length, data.length)));
                  texture = new three.DataTexture(data, size, size, three.RGBAFormat);
                  texture.needsUpdate = true;
                }
              }
            } catch {
              // Texture decode failed; use solid color.
            }
          }

          const material = new three.MeshStandardMaterial({
            color: texture ? 0xffffff : color,
            ...(texture ? { map: texture } : {}),
            wireframe: false,
            side: three.DoubleSide,
            flatShading: !texture
          });
          const mesh = new three.Mesh(geometry, material);
          scene.add(mesh);

          // Add bone weight visualization if available.
          // Bone weights are stored as 4 bytes per vertex (4 bone influences, each 0-255 ≈ 0.0-1.0).
          // The 4 influences sum to ~255, so visualize the PRIMARY (first) bone weight:
          // red = vertex tightly bound to one bone, blue = weight spread across bones.
          if (meshData.boneWeightsBase64) {
            try {
              const weightBytes = Uint8Array.from(atob(meshData.boneWeightsBase64), (c) => c.charCodeAt(0));
              const vertexCount = positions.length / 3;
              const colors = new Float32Array(vertexCount * 3);
              for (let v = 0; v < vertexCount; v++) {
                const primaryWeight = (weightBytes[v * 4] ?? 0) / 255;
                colors[v * 3] = primaryWeight; // R
                colors[v * 3 + 1] = 0.2; // G
                colors[v * 3 + 2] = 1 - primaryWeight; // B
              }
              geometry.setAttribute('color', new three.BufferAttribute(colors, 3));
              material.vertexColors = true;
              material.needsUpdate = true;
            } catch {
              // Bone weight decode failed; skip visualization.
            }
          }

          // Add bone index visualization if available.
          // Bone indices are stored as 4 bytes per vertex (4 bone influences).
          // Visualize as vertex colors: different colors for different bone indices.
          if (meshData.boneIndicesBase64 && !meshData.boneWeightsBase64) {
            try {
              const indexBytes = Uint8Array.from(atob(meshData.boneIndicesBase64), (c) => c.charCodeAt(0));
              const vertexCount = positions.length / 3;
              const colors = new Float32Array(vertexCount * 3);
              // Color palette for bone indices (up to 256 bones).
              const boneColors = [
                [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 1.0, 0.0],
                [1.0, 0.0, 1.0], [0.0, 1.0, 1.0], [1.0, 0.5, 0.0], [0.5, 0.0, 1.0],
                [0.0, 1.0, 0.5], [0.5, 1.0, 0.0], [1.0, 0.0, 0.5], [0.0, 0.5, 1.0]
              ];
              for (let v = 0; v < vertexCount; v++) {
                // Use the first bone index for coloring.
                const boneIdx = (indexBytes[v * 4] ?? 0) % boneColors.length;
                const color = boneColors[boneIdx] ?? [1.0, 1.0, 1.0];
                colors[v * 3] = color[0] ?? 1.0;
                colors[v * 3 + 1] = color[1] ?? 1.0;
                colors[v * 3 + 2] = color[2] ?? 1.0;
              }
              geometry.setAttribute('color', new three.BufferAttribute(colors, 3));
              material.vertexColors = true;
              material.needsUpdate = true;
            } catch {
              // Bone index decode failed; skip visualization.
            }
          }

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

      // Draw bone hierarchy. Skeleton bones carry parent-relative transforms;
      // compute world positions by chaining local TRS matrices up the parent chain.
      if (skeletonBones && skeletonBones.length > 0) {
        const boneGroup = new three.Group();
        const boneMaterial = new three.LineBasicMaterial({ color: 0xffaa44, transparent: true, opacity: 0.6 });
        const jointMaterial = new three.MeshBasicMaterial({ color: 0xffcc66 });
        const jointGeometry = new three.SphereGeometry(0.15, 8, 8);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const worldMatrices: any[] = new Array(skeletonBones.length);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const computeWorld = (i: number, depth: number): any => {
          const cached = worldMatrices[i];
          if (cached) return cached;
          const b = skeletonBones[i];
          if (!b) return new three.Matrix4();
          const local = new three.Matrix4();
          local.makeRotationFromEuler(new three.Euler(b.rotation[0], b.rotation[1], b.rotation[2], 'XYZ'));
          local.setPosition(b.translation[0], b.translation[1], b.translation[2]);
          const parent = b.parentIndex;
          let world = local;
          if (parent >= 0 && parent < skeletonBones.length && parent !== i && depth < skeletonBones.length) {
            world = computeWorld(parent, depth + 1).clone().multiply(local);
          }
          worldMatrices[i] = world;
          return world;
        };
        for (let i = 0; i < skeletonBones.length; i++) computeWorld(i, 0);
        const worldPositions = worldMatrices.map(
          (m) => new three.Vector3().setFromMatrixPosition(m)
        );

        for (let i = 0; i < skeletonBones.length; i++) {
          const pos = worldPositions[i];
          const bone = skeletonBones[i];
          if (!pos || !bone) continue;
          const joint = new three.Mesh(jointGeometry, jointMaterial);
          joint.position.copy(pos);
          boneGroup.add(joint);

          const parent = bone.parentIndex;
          if (parent >= 0 && parent < skeletonBones.length) {
            const parentPos = worldPositions[parent];
            if (parentPos) {
              const lineGeometry = new three.BufferGeometry().setFromPoints([pos, parentPos]);
              boneGroup.add(new three.Line(lineGeometry, boneMaterial));
            }
          }
        }
        scene.add(boneGroup);
      } else if (props.bones && props.bones.length > 0) {
        // Fallback: bones passed directly via props already carry world positions.
        const boneGroup = new three.Group();
        const boneMaterial = new three.LineBasicMaterial({ color: 0xffaa44, transparent: true, opacity: 0.6 });
        const jointMaterial = new three.MeshBasicMaterial({ color: 0xffcc66 });
        const jointGeometry = new three.SphereGeometry(0.15, 8, 8);

        for (const bone of props.bones) {
          const joint = new three.Mesh(jointGeometry, jointMaterial);
          joint.position.set(bone.position[0], bone.position[1], bone.position[2]);
          boneGroup.add(joint);

          if (bone.parentIndex >= 0 && bone.parentIndex < props.bones.length) {
            const parent = props.bones[bone.parentIndex];
            if (parent) {
              const points = [
                new three.Vector3(bone.position[0], bone.position[1], bone.position[2]),
                new three.Vector3(parent.position[0], parent.position[1], parent.position[2])
              ];
              const lineGeometry = new three.BufferGeometry().setFromPoints(points);
              boneGroup.add(new three.Line(lineGeometry, boneMaterial));
            }
          }
        }
        scene.add(boneGroup);
      }

      // Draw dummy attachment points as octahedron markers colored by reference ID.
      if (dummyPoints && dummyPoints.length > 0) {
        const dummyGroup = new three.Group();
        const dummyGeometry = new three.OctahedronGeometry(0.06, 0);
        for (const dummy of dummyPoints) {
          const hue = ((dummy.referenceId * 47) % 360) / 360;
          const markerMaterial = new three.MeshBasicMaterial({
            color: new three.Color().setHSL(hue, 0.85, 0.55)
          });
          const marker = new three.Mesh(dummyGeometry, markerMaterial);
          marker.position.set(dummy.position[0], dummy.position[1], dummy.position[2]);
          dummyGroup.add(marker);
        }
        scene.add(dummyGroup);
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
  }, [props.boundingBox, props.boneCount, props.meshCount, meshData, skeletonBones, dummyPoints]);

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
