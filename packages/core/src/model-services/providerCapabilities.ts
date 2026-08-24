import type { ModelProviderCapabilities } from './types.js';

/** Optional request fields whose support is provider/model specific. */
export const MODEL_PROVIDER_CAPABILITY_KEYS = [
  'tools',
  'vision',
  'reasoningEffort',
  'topP',
  'topK',
  'temperature',
  'maxTokens'
] as const;

export type ModelProviderCapabilityKey = typeof MODEL_PROVIDER_CAPABILITY_KEYS[number];

/**
 * Direct adapter construction keeps historical protocol defaults for
 * compatibility tests. The configured production factory uses the strict
 * policy: only an explicit true from request/config is allowed through.
 */
export type ModelProviderCapabilityPolicy = 'legacy-defaults' | 'explicit-or-fail-closed';

export type ModelProviderCapabilitySource =
  | 'request'
  | 'explicit-config'
  | 'legacy-default'
  | 'fail-closed';

export interface ModelProviderCapabilityState {
  policy: ModelProviderCapabilityPolicy;
  /** Effective boolean decision for every optional capability key. */
  capabilities: Record<ModelProviderCapabilityKey, boolean>;
  /** Provenance for each effective decision; no automatic probe is implied. */
  sources: Record<ModelProviderCapabilityKey, ModelProviderCapabilitySource>;
}

/**
 * Resolve one request's effective capability set.
 *
 * Precedence is request declaration, then explicit service-config
 * declaration. Under explicit-or-fail-closed, an absent field is false. This
 * function deliberately has no network or provider inference path: a caller
 * that wants a negotiated value must persist it as an explicit config value.
 */
export function resolveModelProviderCapabilityState(input: {
  request?: ModelProviderCapabilities;
  configured?: ModelProviderCapabilities;
  policy: ModelProviderCapabilityPolicy;
}): ModelProviderCapabilityState {
  const capabilities = {} as Record<ModelProviderCapabilityKey, boolean>;
  const sources = {} as Record<ModelProviderCapabilityKey, ModelProviderCapabilitySource>;

  for (const key of MODEL_PROVIDER_CAPABILITY_KEYS) {
    const requestValue = input.request?.[key];
    if (requestValue !== undefined) {
      capabilities[key] = requestValue;
      sources[key] = 'request';
      continue;
    }
    const configuredValue = input.configured?.[key];
    if (configuredValue !== undefined) {
      capabilities[key] = configuredValue;
      sources[key] = 'explicit-config';
      continue;
    }
    capabilities[key] = input.policy === 'legacy-defaults';
    sources[key] = input.policy === 'legacy-defaults' ? 'legacy-default' : 'fail-closed';
  }

  return { policy: input.policy, capabilities, sources };
}

/** Baseline state exposed by an adapter before a request-level override. */
export function createModelProviderCapabilityState(input: {
  configured?: ModelProviderCapabilities;
  policy: ModelProviderCapabilityPolicy;
}): ModelProviderCapabilityState {
  return resolveModelProviderCapabilityState({
    ...(input.configured ? { configured: input.configured } : {}),
    policy: input.policy
  });
}
