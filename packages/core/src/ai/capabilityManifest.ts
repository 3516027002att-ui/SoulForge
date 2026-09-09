import { createHash } from 'node:crypto';

export interface CapabilityManifest {
  schemaVersion: 1;
  workspaceId: string;
  mode: 'plan' | 'normal' | 'fullPermission';
  tools: string[];
  memoryAvailable: boolean;
  coverage: Record<string, 'complete' | 'partial' | 'not_indexed' | 'stale' | 'source_unavailable'>;
  nativeWriterProfiles: Record<string, 'unsupported' | 'candidate' | 'native-verified'>;
  oodleAvailable: boolean;
  confirmationRequired: boolean;
  toolSchemaHash: string;
}

export function createCapabilityManifest(input: Omit<CapabilityManifest, 'schemaVersion' | 'toolSchemaHash'> & { toolSchema?: unknown }): CapabilityManifest {
  if (!input.workspaceId || !Array.isArray(input.tools)) throw new Error('CAPABILITY_MANIFEST_INVALID');
  const tools = [...new Set(input.tools)].sort();
  const toolSchemaHash = createHash('sha256').update(JSON.stringify(input.toolSchema ?? tools), 'utf8').digest('hex');
  return { schemaVersion: 1, ...input, tools, toolSchemaHash };
}

export function canRequestOperation(manifest: CapabilityManifest, operation: string): boolean {
  return manifest.tools.includes(operation)
    && (manifest.mode !== 'plan' || manifest.nativeWriterProfiles[operation] !== 'native-verified');
}

export function capabilityManifestHash(manifest: CapabilityManifest): string {
  return createHash('sha256').update(JSON.stringify(manifest), 'utf8').digest('hex');
}
