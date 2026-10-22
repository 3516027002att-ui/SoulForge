import type { SoulForgeApi } from '../../apps/desktop/src/ipc/publicApi.generated.js';

// The original handwritten `typeof api` allowed replacing a named method on
// a typed host/test port. The readonly catalog must not change that API shape.
declare const port: Pick<SoulForgeApi, 'setUpdateChannel'>;
const originalSetChannel = port.setUpdateChannel;
port.setUpdateChannel = request => originalSetChannel(request);

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type ReadonlyKeys<Value> = {
  [Name in keyof Value]-?: Equal<Pick<Value, Name>, { -readonly [Key in Name]: Value[Key] }> extends true
    ? never : Name;
}[keyof Value];
type RequireNever<Value extends never> = Value;
type AllPublicMethodPropertiesRemainAssignable = RequireNever<ReadonlyKeys<SoulForgeApi>>;

// Both subscription methods obey the same property mutability as invokes.
declare const api: SoulForgeApi;
api.onUpdateState = api.onUpdateState;
api.onAiAgentEvent = api.onAiAgentEvent;
export type { AllPublicMethodPropertiesRemainAssignable };
