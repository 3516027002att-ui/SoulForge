/** Bounded host RPC. A worker receives capabilities, never the workspace index or native documents. */
const error = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });
const size = value => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
export function runAgentHostTransport(child, params, callbacks, options = {}) {
    const maxBytes = options.maxBytes ?? 2097152, maxPending = options.maxPending ?? 16;
    if (size(params) > maxBytes)
        return Promise.reject(error('AGENT_START_BUDGET_EXCEEDED', 'Agent start request exceeds its budget.'));
    return new Promise((resolve, reject) => {
        let settled = false, abortingTimer;
        const pending = new Map(), seen = new Set();
        const unresolved = () => [...pending.values()].filter(value => value.method === 'executeTool').map(value => ({ callId: value.args[0]?.id, toolName: value.args[0]?.name, state: 'unknown', retryable: false }));
        const settle = (value, failed) => {
            if (settled)
                return;
            settled = true;
            for (const request of pending.values()) request.controller.abort();
            clearTimeout(timer);
            clearTimeout(abortingTimer);
            options.signal?.removeEventListener('abort', onAbort);
            child.removeListener('message', onMessage);
            child.removeListener('exit', onExit);
            child.removeListener('error', onError);
            child.kill?.();
            failed ? reject(value) : resolve(value);
        };
        const send = frame => { if (!settled)
            child.postMessage(frame); };
        const stopError = (code, message) => error(code, message, { retryable: false, requestState: 'unknown', unresolvedCalls: unresolved() });
        const onExit = code => settle(stopError('AGENT_PROCESS_EXITED', `Agent process exited (${code}); query unresolved operations before retrying.`), true);
        const onError = value => settle(stopError('AGENT_PROCESS_FAILED', value.message ?? String(value)), true);
        const onAbort = () => { for (const request of pending.values()) request.controller.abort(); send({ type: 'cancel' }); abortingTimer ??= setTimeout(() => settle(stopError('AGENT_PROCESS_CANCEL_TIMEOUT', 'Agent did not acknowledge cancellation; in-flight outcomes remain unknown.'), true), options.cancelGraceMs ?? 5000); };
        const onMessage = message => {
            if (settled)
                return;
            if (!message || typeof message !== 'object' || size(message) > maxBytes) {
                settle(stopError('AGENT_PROTOCOL_BUDGET_EXCEEDED', 'Agent message exceeded its bounded protocol budget.'), true);
                return;
            }
            if (message.type === 'event' || message.type === 'protocol-event') {
                try {
                    if (message.type === 'event') options.onEvent?.(message.event);
                    else options.onProtocolEvent?.(message.event);
                    if (Number.isSafeInteger(message.id)) send({type:'event-ack',id:message.id,ok:true});
                } catch (cause) {
                    if (Number.isSafeInteger(message.id)) send({type:'event-ack',id:message.id,ok:false});
                    settle(stopError('AGENT_EVENT_DELIVERY_FAILED',cause.message??String(cause)),true);
                }
                return;
            }
            if (message.type === 'result') {
                if (pending.size) {
                    settle(stopError('AGENT_PENDING_HOST_CALLS', 'Agent ended while host operations were still running.'), true);
                }
                else
                    settle(message.result, false);
                return;
            }
            if (message.type === 'error') {
                settle(error(message.error?.code ?? 'AGENT_PROCESS_FAILED', message.error?.message ?? 'Agent worker failed.', { retryable: false, unresolvedCalls: unresolved() }), true);
                return;
            }
            if (message.type === 'rpc-cancel') { pending.get(message.id)?.controller.abort(); return; }
            if (message.type !== 'rpc')
                return;
            const { id, method, args } = message;
            if (!Number.isSafeInteger(id) || id < 1 || seen.has(id) || seen.size >= 8192 || !Array.isArray(args)) {
                send({ type: 'rpc-result', id, ok: false, error: { code: 'AGENT_HOST_REQUEST_INVALID', message: 'Invalid or replayed host request.' } });
                return;
            }
            seen.add(id);
            if (!Object.hasOwn(callbacks, method) || typeof callbacks[method] !== 'function') {
                send({ type: 'rpc-result', id, ok: false, error: { code: 'AGENT_HOST_METHOD_DENIED', message: 'Host capability is not available.' } });
                return;
            }
            if (pending.size >= maxPending) {
                send({ type: 'rpc-result', id, ok: false, error: { code: 'AGENT_HOST_QUEUE_LIMIT', message: 'Host request queue is full.' } });
                return;
            }
            const controller = new AbortController();
            if (options.signal?.aborted) controller.abort();
            pending.set(id, { method, args, controller });
            // Host operations continue to their real result after worker cancellation or
            // death. Their durable Patch Engine receipts are never replaced by a retry.
            Promise.resolve().then(() => {
                const callArgs = method === 'executeTool' || method === 'assembleContext'
                    ? [args[0], {...(args[1] ?? {}), signal:controller.signal}] : args;
                return callbacks[method](...callArgs);
            }).then(result => {
                pending.delete(id);
                if (size(result) > maxBytes) {
                    send({ type: 'rpc-result', id, ok: false, error: { code: 'AGENT_HOST_RESULT_BUDGET_EXCEEDED', message: 'Host result requires a bounded page.' } });
                    return;
                }
                send({ type: 'rpc-result', id, ok: true, result });
            }, cause => { pending.delete(id); send({ type: 'rpc-result', id, ok: false, error: { code: cause.code ?? 'AGENT_HOST_CALL_FAILED', message: cause.message ?? String(cause) } }); });
        };
        const timer = setTimeout(() => settle(stopError('AGENT_PROCESS_TIMEOUT', 'Agent process exceeded its total runtime budget.'), true), options.timeoutMs ?? 1800000);
        child.on('message', onMessage);
        child.on('exit', onExit);
        child.on('error', onError);
        options.signal?.addEventListener('abort', onAbort, { once: true });
        send({ type: 'start', params, capabilities: Object.keys(callbacks) });
        if (options.signal?.aborted)
            onAbort();
    });
}
