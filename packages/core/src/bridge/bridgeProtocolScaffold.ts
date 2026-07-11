/**
 * TEST-ONLY synthetic protocol helpers used by architecture smoke tests.
 * This module is intentionally not exported from @soulforge/core; production
 * Bridge traffic must use BridgeDaemonClient and the C# daemon.
 */

import type {
  BridgeCapabilityMatrix,
  BridgeCommandDescriptor,
  BridgeProtocolEnvelope,
  BridgeTypedFailure
} from '@soulforge/shared';
import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_SCHEMA_VERSION,
  createBridgeEnvelope,
  createSyntheticBridgeFailure,
  syntheticFixtureConfidence
} from '@soulforge/shared';
import { createSyntheticFixtureProvenance } from '@soulforge/shared';

export const SCAFFOLD_BRIDGE_COMMANDS: BridgeCommandDescriptor[] = [
  {
    name: 'health',
    description: 'Bridge process health check.',
    inputSchemaVersion: '1',
    outputSchemaVersion: '1',
    supportsCancellation: false,
    supportsProgress: false,
    resourceKinds: ['*']
  },
  {
    name: 'capabilities',
    description: 'Return capability matrix for protocol negotiation.',
    inputSchemaVersion: '1',
    outputSchemaVersion: '1',
    supportsCancellation: false,
    supportsProgress: false,
    resourceKinds: ['*']
  },
  {
    name: 'inspect',
    description: 'Evidence-first inspect (scaffold capability declaration only).',
    inputSchemaVersion: '1',
    outputSchemaVersion: '1',
    supportsCancellation: true,
    supportsProgress: true,
    resourceKinds: ['event', 'map', 'param', 'msg', 'other', 'unknown']
  },
  {
    name: 'export-event',
    description: 'Export event symbols when supported.',
    inputSchemaVersion: '1',
    outputSchemaVersion: '1',
    supportsCancellation: true,
    supportsProgress: true,
    resourceKinds: ['event']
  },
  {
    name: 'export-map',
    description: 'Export map symbols when supported.',
    inputSchemaVersion: '1',
    outputSchemaVersion: '1',
    supportsCancellation: true,
    supportsProgress: true,
    resourceKinds: ['map']
  },
  {
    name: 'export-param',
    description: 'Export param rows when supported.',
    inputSchemaVersion: '1',
    outputSchemaVersion: '1',
    supportsCancellation: true,
    supportsProgress: true,
    resourceKinds: ['param']
  },
  {
    name: 'export-msg',
    description: 'Export msg/FMG entries when supported.',
    inputSchemaVersion: '1',
    outputSchemaVersion: '1',
    supportsCancellation: true,
    supportsProgress: true,
    resourceKinds: ['msg']
  },
  {
    name: 'validate',
    description: 'Validate resource using registered validators.',
    inputSchemaVersion: '1',
    outputSchemaVersion: '1',
    supportsCancellation: true,
    supportsProgress: false,
    resourceKinds: ['*']
  }
];

export function buildScaffoldCapabilityMatrix(bridgeId = 'SoulForge.Bridge.test-helper'): BridgeCapabilityMatrix {
  const cells = SCAFFOLD_BRIDGE_COMMANDS.flatMap((command) => {
    const kinds = command.resourceKinds[0] === '*'
      ? (['event', 'map', 'param', 'msg', 'other'] as const)
      : command.resourceKinds;
    return kinds.map((resourceKind) => ({
      resourceKind,
      command: command.name,
      supported: command.name === 'health' || command.name === 'capabilities' || command.name === 'inspect',
      nativeFormatAuthority: false,
      syntheticFixtureOnly: command.name.startsWith('export-'),
      notes: command.name.startsWith('export-')
        ? 'Export may return synthetic fixture confirmed data only; not native authority.'
        : 'Scaffold capability declaration.'
    }));
  });

  return {
    schemaVersion: BRIDGE_SCHEMA_VERSION,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    bridgeId,
    commands: SCAFFOLD_BRIDGE_COMMANDS,
    cells,
    generatedAt: new Date().toISOString()
  };
}

export function createSyntheticInspectEnvelope(filePath: string): BridgeProtocolEnvelope<{
  filePath: string;
  note: string;
}> {
  return createBridgeEnvelope({
    command: 'inspect',
    ok: true,
    partial: true,
    data: {
      filePath,
      note: 'Scaffold inspect envelope — synthetic/non-authoritative.'
    },
    diagnostics: [],
    nativeFormatAuthority: false,
    syntheticFixture: true,
    confidence: syntheticFixtureConfidence('Bridge scaffold inspect'),
    provenance: [createSyntheticFixtureProvenance('bridge-protocol-scaffold')],
    capabilityHints: ['inspect']
  });
}

export function createTypedFailureEnvelope(
  command: BridgeProtocolEnvelope['command'],
  failure: BridgeTypedFailure
): BridgeProtocolEnvelope {
  return createBridgeEnvelope({
    command,
    ok: false,
    partial: failure.kind === 'partial',
    failure,
    diagnostics: failure.diagnostics,
    nativeFormatAuthority: false,
    syntheticFixture: false
  });
}

export function unsupportedNativeWriterFailure(): BridgeTypedFailure {
  return createSyntheticBridgeFailure(
    'NATIVE_WRITER_UNSUPPORTED',
    'Native FromSoftware writer is not implemented in the protocol scaffold.',
    'unsupported'
  );
}

export function schemaMismatchFailure(expected: string, actual: string): BridgeTypedFailure {
  return {
    kind: 'schemaMismatch',
    code: 'SCHEMA_MISMATCH',
    message: `Bridge schema mismatch: expected ${expected}, got ${actual}.`,
    retryable: false,
    diagnostics: [{
      severity: 'error',
      code: 'SCHEMA_MISMATCH',
      message: `Expected schema ${expected}, received ${actual}.`,
      recordedAt: new Date().toISOString()
    }],
    details: { expected, actual }
  };
}
