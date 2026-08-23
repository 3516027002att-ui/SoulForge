/**
 * Model and Scene Resource Pool (aligned with Smithbox ResourceManager pattern).
 *
 * Ensures identical models (e.g. m000010 terrain, repetitive architectural pillars, trees)
 * share a single BufferGeometry, GPU material, and textures across multiple Part instances.
 */

import type {
  BufferGeometry,
  Material,
  MeshStandardMaterial,
  Object3D
} from 'three';
import { decodeBase64ToUint8Array } from '../utils/binary.js';

type ThreeModule = typeof import('three');

export interface MeshGeometryWire {
  positionsBase64: string;
  indicesBase64?: string | undefined;
  indexSize?: 16 | 32 | undefined;
  uvsBase64?: string | undefined;
  normalsBase64?: string | undefined;
  vertexCount: number;
  boundingBoxMin?: [number, number, number] | undefined;
  boundingBoxMax?: [number, number, number] | undefined;
}

/** base64 → Float32Array */
function decodeBase64F32(base64: string, expectedCount: number): Float32Array {
  const bytes = decodeBase64ToUint8Array(base64);
  const view = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 4));
  return view.length >= expectedCount ? view : new Float32Array(expectedCount);
}

export type TrackFunction = <T extends { dispose(): void }>(resource: T) => T;

export class ModelResourcePool {
  private geometries = new Map<string, BufferGeometry>();
  private materials = new Map<string, Material>();
  private primitiveBox: BufferGeometry | null = null;
  private primitiveSphere: BufferGeometry | null = null;
  private wireframeMaterial: Material | null = null;
  private defaultRealMaterial: Material | null = null;

  /**
   * 获取或创建共享 BufferGeometry。
   */
  public getOrCreateGeometry(
    three: ThreeModule,
    track: TrackFunction,
    key: string,
    data: MeshGeometryWire
  ): BufferGeometry {
    const existing = this.geometries.get(key);
    if (existing) return existing;

    const geometry = track(new three.BufferGeometry());
    geometry.setAttribute(
      'position',
      new three.BufferAttribute(decodeBase64F32(data.positionsBase64, data.vertexCount * 3), 3)
    );

    if (data.indicesBase64) {
      const indexBytes = decodeBase64ToUint8Array(data.indicesBase64);
      // 严格根据权威 indexSize 属性确定 16 位还是 32 位索引，杜绝脆弱启发式
      const is32 = data.indexSize === 32;
      if (is32) {
        const view = new Uint32Array(indexBytes.buffer, indexBytes.byteOffset, Math.floor(indexBytes.length / 4));
        geometry.setIndex(new three.Uint32BufferAttribute(view, 1));
      } else {
        const view = new Uint16Array(indexBytes.buffer, indexBytes.byteOffset, Math.floor(indexBytes.length / 2));
        geometry.setIndex(new three.Uint16BufferAttribute(view, 1));
      }
    }

    if (data.uvsBase64) {
      geometry.setAttribute(
        'uv',
        new three.BufferAttribute(decodeBase64F32(data.uvsBase64, data.vertexCount * 2), 2)
      );
    }

    if (data.normalsBase64) {
      geometry.setAttribute(
        'normal',
        new three.BufferAttribute(decodeBase64F32(data.normalsBase64, data.vertexCount * 3), 3)
      );
    } else {
      geometry.computeVertexNormals();
    }

    this.geometries.set(key, geometry);
    return geometry;
  }

  /**
   * 获取共享的原型几何体（Proxy 盒子或球体）。
   */
  public getPrimitiveGeometry(
    three: ThreeModule,
    track: TrackFunction,
    primitive: 'box' | 'sphere'
  ): BufferGeometry {
    if (primitive === 'sphere') {
      if (!this.primitiveSphere) {
        this.primitiveSphere = track(new three.SphereGeometry(0.5, 12, 10));
      }
      return this.primitiveSphere;
    }
    if (!this.primitiveBox) {
      this.primitiveBox = track(new three.BoxGeometry(1, 1, 1));
    }
    return this.primitiveBox;
  }

  /**
   * 获取真实模型的共享基础材质（中性 PBR 材质，严禁通过前缀猜颜色）。
   */
  public getDefaultRealMaterial(
    three: ThreeModule,
    track: TrackFunction
  ): Material {
    if (!this.defaultRealMaterial) {
      this.defaultRealMaterial = track(
        new three.MeshStandardMaterial({
          color: new three.Color(0x8e97a3),
          roughness: 0.55,
          metalness: 0.12,
          side: three.DoubleSide,
          wireframe: false
        })
      );
    }
    return this.defaultRealMaterial;
  }

  /**
   * 注册并更新特定 modelName 的共享几何体与材质。
   */
  public updateModelGeometry(
    three: ThreeModule,
    track: TrackFunction,
    modelName: string,
    geometryData: MeshGeometryWire
  ): { geometry: BufferGeometry; material: Material } {
    const key = modelName.toLowerCase().replace(/\.mapbnd(\.dcx)?$/i, '');
    const geometry = this.getOrCreateGeometry(three, track, key, geometryData);
    const material = this.getDefaultRealMaterial(three, track);
    return { geometry, material };
  }

  public clear(): void {
    this.geometries.clear();
    this.materials.clear();
    this.primitiveBox = null;
    this.primitiveSphere = null;
    this.wireframeMaterial = null;
    this.defaultRealMaterial = null;
  }
}
