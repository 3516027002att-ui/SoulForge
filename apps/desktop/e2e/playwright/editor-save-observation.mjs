/** Test-only bounded observation; every original call/byte/result is preserved. */
const channels = new Set(['resource.saveScriptSource', 'resource.applyContainerParamFieldMutation']);
const methods = new Set(['openAppDatabase', 'openWorkspace', 'record', 'get', 'list', 'updateStatus', 'history',
  'createTransaction', 'transitionTransaction', 'getTransactionForOperation', 'finalizeCommit', 'recordRecoveryPoint',
  'recordResourceEntryChange', 'appendAuditEvent', 'replaceFiles', 'getAllSemanticFileCache', 'setSemanticFileCache',
  'mergeRagChunkDelta', 'replaceRagChunks', 'loadRagChunks', 'loadKnowledgeSnapshot', 'health', 'close']);
const dbEvents = new Set(['enqueue', 'dispatch', 'start', 'finish', 'timeout', 'late-completion', 'workerfail', 'close']);
const outcomes = new Set(['ok', 'timeout', 'request-failed', 'workerfail', 'close', 'post-error', 'late-completion']);
const diagnosticCodes = new Set(['POSTCOMMIT_REFRESH_FAILED', 'RESOURCE_NOT_INDEXED', 'WORKSPACE_NOT_OPEN',
  'ORIGINAL_CHANGED_DURING_STAGING', 'HASH_PRECONDITION_FAILED', 'CONTAINER_CHILD_INVERSE_CAPTURE_FAILED',
  'BRIDGE_REQUEST_TIMEOUT', 'BRIDGE_WRITE_FAILED', 'BRIDGE_PROCESS_EXITED', 'BRIDGE_FAILED',
  'DATABASE_UTILITY_TIMEOUT', 'DATABASE_UTILITY_PROCESS_EXITED', 'DATABASE_UTILITY_SESSION_STALE',
  'DATABASE_UTILITY_REQUEST_FAILED', 'PARAM_FIELD_VALUE_INVALID', 'PARAM_ROW_IDENTITY_MISSING',
  'LUABND_CONTAINER_HASH_MISMATCH', 'LUABND_CHILD_HASH_MISMATCH', 'LUABND_SCRIPT_READ_FAILED',
  'LUABND_STAGING_PREPARE_FAILED', 'LUABND_READ_FAILED', 'BND4_STAGING_WRITE_FAILED', 'SCRIPT_SOURCE_READ_FAILED', 'PARAMDEF_ENCODE_FAILED']);

export function createEditorSaveObservation({ ipcMain, stdout, stderr, clock }) {
  const limit = 160; const inputLimit = 65_536;
  const events = []; const restores = [];
  let droppedEvents = 0, droppedInput = 0, droppedCodes = 0, observerErrors = 0;
  const safely = action => { try { return action(); } catch { observerErrors++; } };
  const record = event => safely(() => {
    const at = clock();
    if (!Number.isFinite(at) || at < 0) throw new Error('OBSERVER_CLOCK_INVALID');
    if (events.length === limit) { events.shift(); droppedEvents++; }
    events.push({ atMs: Math.round(at * 1000) / 1000, ...event });
    return at;
  });
  const codes = value => Array.isArray(value) ? value.slice(0, 8).flatMap(item => {
    // Diagnostic codes only; never their messages/details, SQL, paths or bodies.
    const code = item?.code;
    if (diagnosticCodes.has(code)) return [code];
    droppedCodes++; return [];
  }) : [];
  function lines(onLine) {
    let buffer = '';
    return chunk => safely(() => {
      if (!(typeof chunk === 'string' || Buffer.isBuffer(chunk)) || chunk.length > inputLimit
        || Buffer.byteLength(chunk) > inputLimit) {
        buffer = ''; droppedInput++; return;
      }
      buffer += chunk.toString();
      if (buffer.length > inputLimit || Buffer.byteLength(buffer) > inputLimit) { buffer = ''; droppedInput++; return; }
      let boundary;
      while ((boundary = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
        safely(() => onLine(line));
      }
    });
  }

  try {
    const originalHandle = ipcMain.handle;
    ipcMain.handle = function (channel, listener) {
      if (!channels.has(channel)) return originalHandle.call(this, channel, listener);
      return originalHandle.call(this, channel, async function (...args) {
        const start = record({ stage: 'ipc', method: channel, state: 'start' });
        try {
          const result = await listener.apply(this, args);
          safely(() => record({ stage: 'ipc', method: channel, state: 'finish', ok: result?.ok === true,
            ...(Number.isFinite(start) ? { elapsedMs: Math.max(0, clock() - start) } : {}),
            codes: codes(result?.diagnostics),
            ...(new Set(['converged', 'failed']).has(result?.knowledgeRefresh?.status) ? { refresh: result.knowledgeRefresh.status } : {}) }));
          return result;
        } catch (error) { record({ stage: 'ipc', method: channel, state: 'throw' }); throw error; }
      });
    };
    restores.push(() => { ipcMain.handle = originalHandle; });

    for (const stream of [stdout, stderr]) {
      const originalWrite = stream.write;
      const observe = lines(line => {
        const marker = '[SoulForge database utility trace] ';
        const offset = line.indexOf(marker);
        if (offset >= 0) {
          const trace = JSON.parse(line.slice(offset + marker.length));
          if (methods.has(trace.method) && dbEvents.has(trace.event)) record({ stage: 'database', method: trace.method, state: trace.event,
            ...(['client', 'worker'].includes(trace.side) ? { side: trace.side } : {}),
            ...(outcomes.has(trace.outcome) ? { outcome: trace.outcome } : {}),
            ...(Number.isFinite(trace.dbDurationMs) && trace.dbDurationMs >= 0 ? { elapsedMs: trace.dbDurationMs } : {}) });
        } else if (/^\[SoulForge native-refresh\] released \d+ idle Bridge client\(s\); active=\d+\.$/.test(line)) {
          record({ stage: 'postcommit', state: 'idle-readers-released' });
        }
      });
      stream.write = function (...args) { const returned = originalWrite.apply(this, args); observe(args[0]); return returned; };
      restores.push(() => { stream.write = originalWrite; });
    }
  } catch {
    observerErrors++;
    for (const restore of restores.reverse()) safely(restore);
    restores.length = 0;
  }
  return { stdout, stderr,
    snapshot: () => ({ limit, inputByteLimit: inputLimit, events: events.map(event => ({ ...event, ...(event.codes ? { codes: event.codes.slice() } : {}) })), droppedEvents, droppedInput, droppedCodes, observerErrors }),
    restore: () => { for (const restore of restores.reverse()) safely(restore); }
  };
}
