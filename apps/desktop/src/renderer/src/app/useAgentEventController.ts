import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { AiAgentEventEnvelope } from '../../../main/ipc.js';
import type { RendererRuntime } from '../runtime/rendererRuntime.js';
import { BoundedAgentEventQueue, combineAgentReplayWindow, orderUnseenAgentEvents } from '../agent/agentEventReplay.js';
import { markAgentTaskCancelling, reduceAgentTaskEvent, type AgentTaskState } from '../agent/agentTaskState.js';

type AgentEventBridge = Pick<NonNullable<RendererRuntime['bridge']>, 'onAiAgentEvent' | 'getAiAgentEvents'>;
interface AgentEventOptions {
  bridge: AgentEventBridge | null;
  task: AgentTaskState;
  setTask: Dispatch<SetStateAction<AgentTaskState>>;
  onModeSwitched(mode: 'ask' | 'plan' | 'edit' | 'bypass'): void;
  setIdleNotice: Dispatch<SetStateAction<string | null>>;
}

/** Owns the receive/replay gate, not the native run or its transaction facts. */
export function useAgentEventController(options: AgentEventOptions) {
  const { bridge, task, setTask, onModeSwitched, setIdleNotice } = options;
  const expectedSessionRef = useRef<string | null>(null);
  const readySessionRef = useRef<string | null>(null);
  const replaySessionRef = useRef<string | null>(null);
  const seenSeqsRef = useRef(new Map<string, { seen: Set<number>; droppedThrough: number }>());
  const pendingEventsRef = useRef(new BoundedAgentEventQueue<AiAgentEventEnvelope>());
  const modeCallbackRef = useRef(onModeSwitched);
  modeCallbackRef.current = onModeSwitched;

  const resetAgentEvents = useCallback(() => {
    expectedSessionRef.current = null;
    readySessionRef.current = null;
    replaySessionRef.current = null;
    seenSeqsRef.current.clear();
    pendingEventsRef.current.clear();
  }, []);
  const acceptAgentSession = useCallback((sessionId: string) => {
    expectedSessionRef.current = sessionId;
    readySessionRef.current = null;
    replaySessionRef.current = null;
    seenSeqsRef.current.clear();
    pendingEventsRef.current.keepSession(sessionId);
  }, []);

  const applyEnvelopes = useCallback((envelopes: readonly AiAgentEventEnvelope[]) => {
    const sessionId = expectedSessionRef.current;
    if (!sessionId || readySessionRef.current !== sessionId) {
      for (const envelope of envelopes) pendingEventsRef.current.append(envelope);
      return;
    }
    const orderedResult = orderUnseenAgentEvents(
      envelopes, sessionId, seenSeqsRef.current.get(sessionId)?.seen ?? new Set<number>(),
      4096, seenSeqsRef.current.get(sessionId)?.droppedThrough ?? 0
    );
    seenSeqsRef.current.clear();
    seenSeqsRef.current.set(sessionId, { seen: orderedResult.seen, droppedThrough: orderedResult.droppedThrough });
    if (orderedResult.events.length === 0) return;
    // Mode updates share the session/sequence gate with task events, including replay.
    for (const envelope of orderedResult.events) {
      if (envelope.event.type === 'session-mode-switched') {
        const raw = (envelope.event as { mode?: string }).mode;
        modeCallbackRef.current(raw === 'fullPermission' || raw === 'full' ? 'bypass'
          : raw === 'normal' || raw === 'edit' ? 'edit' : 'plan');
      }
    }
    // Reserve seqs before the React queue: replay/live interleaving never doubles entries.
    setTask(current => {
      if (current.sessionId !== sessionId) return current;
      const next = orderedResult.events.reduce((state, envelope) => reduceAgentTaskEvent(state, envelope), current);
      // A delayed session-accepted replay is not acknowledgement that cancellation ended.
      return current.phase === 'cancelling' && (next.phase === 'accepted' || next.phase === 'running')
        ? markAgentTaskCancelling(next)
        : next;
    });
  }, [setTask]);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    replaySessionRef.current = null;
    readySessionRef.current = null;
    const unsubscribe = bridge.onAiAgentEvent(envelope => {
      if (cancelled || !Number.isSafeInteger(envelope.seq) || envelope.seq < 1) return;
      if (envelope.sessionId !== expectedSessionRef.current || envelope.sessionId !== readySessionRef.current) {
        pendingEventsRef.current.append(envelope);
        return;
      }
      applyEnvelopes([envelope]);
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [bridge, applyEnvelopes]);

  useEffect(() => {
    if (!bridge || !task.sessionId || task.sessionId.startsWith('optimistic-')) return;
    const sessionId = task.sessionId;
    // A restored previous-task snapshot is not fresh native acceptance.
    if (expectedSessionRef.current !== sessionId || replaySessionRef.current === sessionId) return;
    replaySessionRef.current = sessionId;
    let cancelled = false;
    const finishReplay = (result: Awaited<ReturnType<AgentEventBridge['getAiAgentEvents']>> | undefined) => {
      if (cancelled || expectedSessionRef.current !== sessionId) return;
      const queuedWindow = pendingEventsRef.current.take(sessionId);
      readySessionRef.current = sessionId;
      const replayWindow = combineAgentReplayWindow(result, queuedWindow);
      if (replayWindow.truncated) setIdleNotice('较早的运行信息已收起，可从会话记录查看');
      applyEnvelopes(replayWindow.events);
    };
    void bridge.getAiAgentEvents(sessionId, 0).then(finishReplay).catch(() => {
      // Replay compensates for early pushes; missing handlers must not block live events.
      finishReplay(undefined);
    });
    return () => { cancelled = true; };
  }, [task.sessionId, bridge, applyEnvelopes, setIdleNotice]);

  return { resetAgentEvents, acceptAgentSession };
}
