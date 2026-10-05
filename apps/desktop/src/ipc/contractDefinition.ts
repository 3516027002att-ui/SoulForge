/** Renderer-safe descriptions. This module has no Electron or main-process authority. */
export interface InvokeContract<Args extends unknown[], Result> {
  readonly kind: 'invoke';
  readonly channel: string;
  readonly arguments: (...args: Args) => readonly unknown[];
  readonly transform?: 'stripPathFields';
  /** Type-only result witness; never emitted or transmitted. */
  readonly result?: Result;
}

export interface SubscribeContract<Envelope, Value> {
  readonly kind: 'subscribe';
  readonly channel: string;
  readonly project: (envelope: Envelope) => Value;
  readonly unsubscribeResult: 'transport' | 'void';
}

export function invoke<Result>() {
  return <Args extends unknown[]>(
    channel: string,
    arguments_: (...args: Args) => readonly unknown[],
    transform?: 'stripPathFields'
  ): InvokeContract<Args, Result> => ({
    kind: 'invoke', channel, arguments: arguments_, ...(transform ? { transform } : {})
  });
}

export function subscribe<Envelope, Value>(
  channel: string,
  project: (envelope: Envelope) => Value,
  unsubscribeResult: 'transport' | 'void' = 'void'
): SubscribeContract<Envelope, Value> {
  return { kind: 'subscribe', channel, project, unsubscribeResult };
}

export type ContractApi<Contract> = {
  -readonly [Name in keyof Contract]: Contract[Name] extends InvokeContract<infer Args, infer Result>
    ? (...args: Args) => Promise<Result>
    : Contract[Name] extends SubscribeContract<infer _Envelope, infer Value>
      ? (callback: (value: Value) => void) => () => void
      : never;
};
