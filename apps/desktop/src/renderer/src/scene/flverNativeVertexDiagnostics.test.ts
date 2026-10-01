import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as three from 'three';
import {
  attachFlverNativeVertexDiagnostics,
  decodeFlverNativeVertexDiagnostics,
  type FlverNativeVertexDiagnosticSource
} from './flverNativeVertexDiagnostics.js';

function float32Base64(values: readonly number[]): string {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  return bytes.toString('base64');
}

const metadata = {
  memberOrdinal: 0, memberIndex: 3, layoutType: 3, layoutTypeName: 'Float4' as const,
  vertexBufferIndex: 2, bufferLayoutIndex: 4, structOffset: 20
};

function source(): FlverNativeVertexDiagnosticSource {
  return {
    vertexColorStatus: 'decoded',
    vertexColorDiagnostics: [
      { ...metadata, rgbaBase64: float32Base64([-2, 3, 0.25, 1.5, 0, 1, 0.5, -0.25]) },
      { ...metadata, memberOrdinal: 1, memberIndex: 7, layoutType: 16, layoutTypeName: 'Color', rgbaBase64: float32Base64([1, 0, 0, 0.25, 0, 1, 1, 0.5]) }
    ],
    tangentStatus: 'decoded',
    tangentDiagnostics: [
      { ...metadata, xyzwBase64: float32Base64([1, 0, 0, -1, 0, 1, 0, 1]) },
      { ...metadata, memberOrdinal: 2, memberIndex: 8, xyzwBase64: float32Base64([0, 0, 1, -1, -1, 0, 0, 1]) }
    ],
    bitangentStatus: 'decoded',
    bitangentDiagnostics: [{ ...metadata, xyzwBase64: float32Base64([0, -1, 0, 1, 1, 0, 0, -1]) }]
  };
}

describe('native FLVER vertex diagnostics on real Three geometry', () => {
  it('retains all four components, set identities and metadata in private attributes', () => {
    const geometry = new three.BufferGeometry();
    const evidence = decodeFlverNativeVertexDiagnostics(source(), 2, 'mesh');
    attachFlverNativeVertexDiagnostics(three, geometry, evidence, 2, 'mesh');
    const names = ['soulforgeVertexColor0', 'soulforgeVertexColor1', 'soulforgeTangent0', 'soulforgeTangent2', 'soulforgeBitangent0'];
    assert.deepEqual(Object.keys(geometry.attributes), names);
    for (const name of names) {
      const attribute = geometry.getAttribute(name);
      assert.equal(attribute.itemSize, 4);
      assert.equal(attribute.count, 2);
      assert.equal(attribute.normalized, false);
    }
    assert.deepEqual([...geometry.getAttribute('soulforgeVertexColor0').array], [-2, 3, 0.25, 1.5, 0, 1, 0.5, -0.25]);
    assert.deepEqual([...geometry.getAttribute('soulforgeTangent0').array], [1, 0, 0, -1, 0, 1, 0, 1]);
    assert.equal(geometry.getAttribute('color'), undefined);
    assert.equal(geometry.getAttribute('tangent'), undefined);
    assert.deepEqual(geometry.userData.vertexColorDiagnostics[0], { ...metadata, attributeName: 'soulforgeVertexColor0' });
    assert.equal(geometry.userData.vertexColorStatus, 'decoded');
    assert.equal(geometry.userData.tangentDiagnostics[1].memberIndex, 8);
    assert.equal(geometry.userData.bitangentDiagnostics[0].structOffset, 20);
    assert.equal(Object.hasOwn(geometry.userData.vertexColorDiagnostics[0], 'rgbaBase64'), false);
    assert.equal(Object.hasOwn(geometry.userData.vertexColorDiagnostics[0], 'rgba'), false);
    geometry.dispose();
  });

  it('retains absent, unsupported and truncated statuses without inventing attributes', () => {
    const geometry = new three.BufferGeometry();
    const evidence = decodeFlverNativeVertexDiagnostics({
      vertexColorStatus: 'unsupported', vertexColorFailure: 'unsupported native layout', vertexColorDiagnostics: [],
      tangentStatus: 'truncated', tangentFailure: 'native buffer short', tangentDiagnostics: [],
      bitangentStatus: 'absent', bitangentDiagnostics: []
    }, 2, 'mesh');
    attachFlverNativeVertexDiagnostics(three, geometry, evidence, 2, 'mesh');
    assert.deepEqual(Object.keys(geometry.attributes), []);
    assert.equal(geometry.userData.vertexColorStatus, 'unsupported');
    assert.equal(geometry.userData.vertexColorFailure, 'unsupported native layout');
    assert.equal(geometry.userData.tangentStatus, 'truncated');
    assert.equal(geometry.userData.tangentFailure, 'native buffer short');
    assert.equal(geometry.userData.bitangentStatus, 'absent');
    const legacyGeometry = new three.BufferGeometry();
    attachFlverNativeVertexDiagnostics(three, legacyGeometry, decodeFlverNativeVertexDiagnostics({}, 2, 'legacy'), 2, 'legacy');
    assert.deepEqual(legacyGeometry.userData, {});
    geometry.dispose();
    legacyGeometry.dispose();
  });

  it('rejects short, oversized, byte-misaligned and nonfinite source sets', () => {
    for (const channel of ['vertexColor', 'tangent', 'bitangent'] as const) {
      for (const payload of [float32Base64([0, 0, 0]), float32Base64([0, 0, 0, 1, 0]), float32Base64([0, NaN, 0, 1]), float32Base64([0, 0, Infinity, 1]), Buffer.from([0, 1, 2]).toString('base64')]) {
        const diagnostic = { ...metadata, [channel === 'vertexColor' ? 'rgbaBase64' : 'xyzwBase64']: payload };
        const input = { [`${channel}Status`]: 'decoded', [`${channel}Diagnostics`]: [diagnostic] } as FlverNativeVertexDiagnosticSource;
        assert.throws(() => decodeFlverNativeVertexDiagnostics(input, 1, 'mesh'), /FLVER_ATTRIBUTE_(LENGTH_MISMATCH|NONFINITE)/);
      }
    }
  });

  it('fails before attaching partial evidence if a semantic set is malformed or aliases an ordinal', () => {
    for (const mutate of [
      (evidence: ReturnType<typeof decodeFlverNativeVertexDiagnostics>) => { evidence.bitangentDiagnostics![0]!.xyzw = new Float32Array(7); },
      (evidence: ReturnType<typeof decodeFlverNativeVertexDiagnostics>) => { evidence.tangentDiagnostics![1]!.xyzw[7] = NaN; },
      (evidence: ReturnType<typeof decodeFlverNativeVertexDiagnostics>) => { evidence.vertexColorDiagnostics![1]!.memberOrdinal = 0; }
    ]) {
      const geometry = new three.BufferGeometry();
      const evidence = decodeFlverNativeVertexDiagnostics(source(), 2, 'mesh');
      mutate(evidence);
      assert.throws(() => attachFlverNativeVertexDiagnostics(three, geometry, evidence, 2, 'mesh'), /FLVER_(ATTRIBUTE|DIAGNOSTIC_MEMBER)/);
      assert.deepEqual(Object.keys(geometry.attributes), []);
      assert.deepEqual(geometry.userData, {});
      geometry.dispose();
    }
  });
});
