import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BridgeDaemonClient,
  BridgeDaemonError,
  type BridgeCancellationTerminalReceipt
} from '../bridge/bridgeDaemonClient.js';
import { stageBridgeOutput } from '../editing/bridgeStaging.js';
import {
  BRIDGE_RECOVERY_FAULT_OPTION,
  BRIDGE_RECOVERY_PHASE_CODES,
  BRIDGE_RECOVERY_PHASES,
  type BridgeRecoveryHarnessEvent,
  type BridgeRecoveryHarnessFault
} from './bridgeRecoveryHarnessProtocol.js';
import { findPathLeak } from './assertNoPathLeak.js';

const FIXTURE_DAEMON = fileURLToPath(new URL('./bridgeRecoveryFixtureDaemon.js', import.meta.url));
type CancellationTerminalOutcome = BridgeCancellationTerminalReceipt['outcome'];
type FixtureCancellationTerminal = CancellationTerminalOutcome | 'hold';
type FixtureCancellationTerminalSession = 'valid' | 'missing' | 'wrong';

interface CancellationObserverInternals {
  cancellationTerminalObservers: Map<string, {
    timer?: { _idleTimeout?: unknown; _onTimeout?: () => void };
  }>;
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-bridge-recovery-harness-'));
  const eventLogPath = join(root, 'events.jsonl');
  const sourcePath = join(root, 'synthetic-protocol-only.bin');
  let client: BridgeDaemonClient | undefined;
  let replacement: BridgeDaemonClient | undefined;
  let backpressureClient: BridgeDaemonClient | undefined;
  let backpressureAbortClient: BridgeDaemonClient | undefined;
  let closeObserverClient: BridgeDaemonClient | undefined;
  try {
    client = await startFixtureClient(root, eventLogPath);
    const phaseResults: Array<{ phase: string; code: string }> = [];
    for (const phase of BRIDGE_RECOVERY_PHASES) {
      const error = await expectBridgeError(requestFault(client, sourcePath, phase, 2_000));
      const expectedCode = BRIDGE_RECOVERY_PHASE_CODES[phase];
      assertBridgeError(error, expectedCode, false);
      if (client.isClosed) throw new Error(`${phase} fixture failure closed a reusable client.`);
      phaseResults.push({ phase, code: error.code });
    }

    const stagingRoot = join(root, 'bridge-staging');
    const stagingFailure = await stageBridgeOutput({
      stagingRoot,
      prefix: 'deterministic-fixture',
      fileName: 'output.bin',
      allowedRoots: (rootPath) => [rootPath],
      write: async () => {
        await requestFault(client!, sourcePath, 'stage', 2_000);
        return { ok: true };
      }
    });
    if (stagingFailure.ok
      || !stagingFailure.diagnostics.some((item) => item.code === 'BRIDGE_STAGING_WRITE_FAILED'
        && item.details.phase === 'write')) {
      throw new Error(`Bridge staging failure did not fail closed: ${JSON.stringify(stagingFailure)}`);
    }
    // 见 assertNoPathLeak.ts：stringify 后的转义会让字面比较恒假。
    if (findPathLeak(stagingFailure.diagnostics, root) !== null) {
      throw new Error('Bridge staging failure leaked the temporary absolute root.');
    }
    if ((await readdir(stagingRoot)).length !== 0) {
      throw new Error('Bridge staging failure leaked its staging directory.');
    }

    const cancelCountBeforeOversizedFrame = (await readEvents(eventLogPath))
      .filter((event) => event.kind === 'cancel').length;
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    let oversizedFrameError: BridgeDaemonError;
    try {
      oversizedFrameError = await expectBridgeError(client.request({
        payload: {
          command: 'validate',
          filePath: sourcePath,
          options: { oversized: 'x'.repeat(300 * 1024) }
        },
        resourceUri: 'file://synthetic-protocol-only.bin',
        timeoutMs: 50
      }));
      assertBridgeError(oversizedFrameError, 'BRIDGE_FRAME_TOO_LARGE', false);
      await new Promise((resolve) => setTimeout(resolve, 150));
    } finally {
      process.removeListener('unhandledRejection', onUnhandledRejection);
    }
    if (unhandledRejections.length !== 0) {
      throw new Error(
        `Outbound frame failure left an unhandled rejection: ${String(unhandledRejections[0])}`
      );
    }
    const eventsAfterOversizedFrame = await readEvents(eventLogPath);
    const cancelCountAfterOversizedFrame = eventsAfterOversizedFrame
      .filter((event) => event.kind === 'cancel').length;
    if (cancelCountAfterOversizedFrame !== cancelCountBeforeOversizedFrame) {
      throw new Error('Outbound frame failure left a pending timeout that emitted cancel.');
    }
    if (client.isClosed || typeof (await client.health(2_000)).processId !== 'number') {
      throw new Error('Outbound frame failure made the reusable Bridge client unhealthy.');
    }

    const eventsBeforeRegistrationRace = await readEvents(eventLogPath);
    const requestCountBeforeRegistrationRace = eventsBeforeRegistrationRace
      .filter((event) => event.kind === 'request').length;
    const cancelCountBeforeRegistrationRace = eventsBeforeRegistrationRace
      .filter((event) => event.kind === 'cancel').length;
    let preAbortedReceiptCount = 0;
    const registrationRaceError = await expectBridgeError(requestFault(
      client,
      sourcePath,
      'stage',
      2_000,
      createRegistrationRaceSignal(),
      undefined,
      undefined,
      () => { preAbortedReceiptCount += 1; }
    ));
    assertBridgeError(registrationRaceError, 'BRIDGE_REQUEST_CANCELLED', true);
    await waitForCancelCount(eventLogPath, cancelCountBeforeRegistrationRace + 1);
    const requestCountAfterRegistrationRace = (await readEvents(eventLogPath))
      .filter((event) => event.kind === 'request').length;
    if (requestCountAfterRegistrationRace !== requestCountBeforeRegistrationRace) {
      throw new Error('Registration-race cancellation still emitted its request frame.');
    }
    if (preAbortedReceiptCount !== 0) {
      throw new Error('Pre-aborted request fabricated a cancellation terminal receipt.');
    }
    if (client.isClosed || typeof (await client.health(2_000)).processId !== 'number') {
      throw new Error('Registration-race cancellation closed the reusable Bridge client.');
    }

    const observedCancellationTerminalOutcomes: string[] = [];
    let resolveTimeoutReceipt!: (receipt: BridgeCancellationTerminalReceipt) => void;
    const timeoutReceiptPromise = new Promise<BridgeCancellationTerminalReceipt>((resolve) => {
      resolveTimeoutReceipt = resolve;
    });
    const timeoutError = await expectBridgeError(requestFault(
      client,
      sourcePath,
      'timeout',
      100,
      undefined,
      undefined,
      'cancelled',
      (receipt) => {
        observedCancellationTerminalOutcomes.push(
          `timeout:${receipt.outcome}:${String(receipt.cancelRequested)}`
        );
        resolveTimeoutReceipt(receipt);
      }
    ));
    assertBridgeError(timeoutError, 'BRIDGE_TIMEOUT', true);
    await waitForCancel(eventLogPath, 'timeout');
    assertCancellationReceipt(
      await settleWithin(timeoutReceiptPromise, 1_000, 'Timed-out cancellation terminal was not observed.'),
      'cancelled',
      true
    );
    if (client.isClosed) throw new Error('Timed-out request closed the Bridge client.');

    const controller = new AbortController();
    let cancelProgressFrames = 0;
    let resolveCancellationReceipt!: (receipt: BridgeCancellationTerminalReceipt) => void;
    const cancellationReceiptPromise = new Promise<BridgeCancellationTerminalReceipt>((resolve) => {
      resolveCancellationReceipt = resolve;
    });
    const cancellationError = await expectBridgeError(requestFault(
      client,
      sourcePath,
      'cancel',
      2_000,
      controller.signal,
      () => {
        cancelProgressFrames += 1;
        controller.abort('deterministic-recovery-harness');
      },
      'cancelled',
      (receipt) => {
        observedCancellationTerminalOutcomes.push(
          `cancel:${receipt.outcome}:${String(receipt.cancelRequested)}`
        );
        resolveCancellationReceipt(receipt);
      }
    ));
    assertBridgeError(cancellationError, 'BRIDGE_REQUEST_CANCELLED', true);
    if (cancelProgressFrames !== 1) {
      throw new Error(`Cancellation fixture observed ${cancelProgressFrames} progress frames.`);
    }
    await waitForCancel(eventLogPath, 'cancel');
    assertCancellationReceipt(
      await settleWithin(cancellationReceiptPromise, 1_000, 'Cancelled terminal was not observed.'),
      'cancelled',
      true
    );
    if (client.isClosed) throw new Error('Cancelled request closed the Bridge client.');

    for (const outcome of ['result', 'failed'] as const) {
      const lateController = new AbortController();
      let lateProgressFrames = 0;
      let resolveLateReceipt!: (receipt: BridgeCancellationTerminalReceipt) => void;
      const lateReceiptPromise = new Promise<BridgeCancellationTerminalReceipt>((resolve) => {
        resolveLateReceipt = resolve;
      });
      const lateError = await expectBridgeError(requestFault(
        client,
        sourcePath,
        'cancel',
        2_000,
        lateController.signal,
        () => {
          lateProgressFrames += 1;
          lateController.abort(`late-${outcome}`);
        },
        outcome,
        (receipt) => {
          observedCancellationTerminalOutcomes.push(
            `late-${outcome}:${receipt.outcome}:${String(receipt.cancelRequested)}`
          );
          resolveLateReceipt(receipt);
        }
      ));
      assertBridgeError(lateError, 'BRIDGE_REQUEST_CANCELLED', true);
      if (lateProgressFrames !== 1) {
        throw new Error(`Late ${outcome} fixture observed ${lateProgressFrames} progress frames.`);
      }
      assertCancellationReceipt(
        await settleWithin(lateReceiptPromise, 1_000, `Late ${outcome} terminal was not observed.`),
        outcome,
        true
      );
    }

    let duplicateTerminalCallbackCount = 0;
    let resolveDuplicateTerminalReceipt!: (receipt: BridgeCancellationTerminalReceipt) => void;
    const duplicateTerminalReceiptPromise = new Promise<BridgeCancellationTerminalReceipt>((resolve) => {
      resolveDuplicateTerminalReceipt = resolve;
    });
    const duplicateTerminalController = new AbortController();
    const duplicateTerminalError = await expectBridgeError(requestFault(
      client,
      sourcePath,
      'cancel',
      2_000,
      duplicateTerminalController.signal,
      () => duplicateTerminalController.abort('duplicate-terminal'),
      'cancelled',
      (receipt) => {
        duplicateTerminalCallbackCount += 1;
        resolveDuplicateTerminalReceipt(receipt);
      },
      undefined,
      true
    ));
    assertBridgeError(duplicateTerminalError, 'BRIDGE_REQUEST_CANCELLED', true);
    assertCancellationReceipt(
      await settleWithin(duplicateTerminalReceiptPromise, 1_000, 'Duplicate-terminal receipt was not observed.'),
      'cancelled',
      true
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (duplicateTerminalCallbackCount !== 1) {
      throw new Error(`Duplicate terminal invoked the observer ${duplicateTerminalCallbackCount} times.`);
    }

    let ttlObserverCallbackCount = 0;
    const ttlController = new AbortController();
    const ttlError = await expectBridgeError(requestFault(
      client,
      sourcePath,
      'cancel',
      2_000,
      ttlController.signal,
      () => ttlController.abort('observer-ttl'),
      'hold',
      () => { ttlObserverCallbackCount += 1; }
    ));
    assertBridgeError(ttlError, 'BRIDGE_REQUEST_CANCELLED', true);
    await waitForCancel(eventLogPath, 'cancel');
    const ttlObservers = cancellationObserverInternals(client).cancellationTerminalObservers;
    if (ttlObservers.size !== 1) {
      throw new Error(`Expected one bounded TTL observer, got ${ttlObservers.size}.`);
    }
    const ttlObserver = [...ttlObservers.values()][0];
    if (!ttlObserver) throw new Error('Bounded TTL observer entry disappeared.');
    const ttlMs = Number(ttlObserver.timer?._idleTimeout);
    if (ttlMs !== 30_000) {
      throw new Error(`Cancellation observer TTL drifted: ${String(ttlObserver.timer?._idleTimeout)}.`);
    }
    expireCancellationTerminalObservers(client);
    if (Number(ttlObservers.size) !== 0 || ttlObserverCallbackCount !== 0) {
      throw new Error('Expired cancellation observer was not cleaned without a callback.');
    }

    let capacityObserverCallbackCount = 0;
    const capacityCancelCountBefore = (await readEvents(eventLogPath))
      .filter((event) => event.kind === 'cancel').length;
    for (let index = 0; index < 65; index += 1) {
      const capacityController = new AbortController();
      const capacityError = await expectBridgeError(requestFault(
        client,
        sourcePath,
        'cancel',
        2_000,
        capacityController.signal,
        () => capacityController.abort(`observer-capacity-${index}`),
        'hold',
        () => { capacityObserverCallbackCount += 1; }
      ));
      assertBridgeError(capacityError, 'BRIDGE_REQUEST_CANCELLED', true);
    }
    await waitForCancelCount(eventLogPath, capacityCancelCountBefore + 65);
    const capacityObservers = cancellationObserverInternals(client).cancellationTerminalObservers;
    if (capacityObservers.size !== 64) {
      throw new Error(`Cancellation observer capacity was ${capacityObservers.size}, expected 64.`);
    }
    expireCancellationTerminalObservers(client);
    if (Number(capacityObservers.size) !== 0 || capacityObserverCallbackCount !== 0) {
      throw new Error('Bounded cancellation observer capacity leaked callbacks or entries.');
    }

    for (const session of ['missing', 'wrong'] as const) {
      let invalidSessionCallbackCount = 0;
      const invalidSessionController = new AbortController();
      const invalidSessionError = await expectBridgeError(requestFault(
        client,
        sourcePath,
        'cancel',
        2_000,
        invalidSessionController.signal,
        () => invalidSessionController.abort(`invalid-session-${session}`),
        'cancelled',
        () => { invalidSessionCallbackCount += 1; },
        session
      ));
      assertBridgeError(invalidSessionError, 'BRIDGE_REQUEST_CANCELLED', true);
      await waitForCancel(eventLogPath, 'cancel');
      await new Promise((resolve) => setTimeout(resolve, 50));
      const invalidSessionObservers = cancellationObserverInternals(client)
        .cancellationTerminalObservers;
      if (invalidSessionCallbackCount !== 0 || Number(invalidSessionObservers.size) !== 1) {
        throw new Error(`Invalid ${session} session was accepted as a cancellation receipt.`);
      }
      expireCancellationTerminalObservers(client);
      if (invalidSessionObservers.size !== 0) {
        throw new Error(`Invalid ${session} session observer was not bounded-cleaned.`);
      }
    }

    const observerUnhandledRejections: unknown[] = [];
    const onObserverUnhandledRejection = (reason: unknown): void => {
      observerUnhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onObserverUnhandledRejection);
    let observerCallbackCount = 0;
    let resolveObserverCallback!: () => void;
    const observerCallbackPromise = new Promise<void>((resolve) => {
      resolveObserverCallback = resolve;
    });
    try {
      const observerController = new AbortController();
      const observerError = await expectBridgeError(requestFault(
        client,
        sourcePath,
        'cancel',
        2_000,
        observerController.signal,
        () => observerController.abort('observer-sync-throw'),
        'cancelled',
        () => {
          observerCallbackCount += 1;
          resolveObserverCallback();
          throw new Error(`observer leaked ${root}`);
        }
      ));
      assertBridgeError(observerError, 'BRIDGE_REQUEST_CANCELLED', true);
      await settleWithin(observerCallbackPromise, 1_000, 'Synchronous receipt observer was not invoked.');
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.removeListener('unhandledRejection', onObserverUnhandledRejection);
    }
    if (observerCallbackCount !== 1 || observerUnhandledRejections.length !== 0) {
      throw new Error('Synchronous receipt observer was not isolated from the request promise.');
    }

    const asyncObserverUnhandledRejections: unknown[] = [];
    const onAsyncObserverUnhandledRejection = (reason: unknown): void => {
      asyncObserverUnhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onAsyncObserverUnhandledRejection);
    let asyncObserverCallbackCount = 0;
    let resolveAsyncObserverCallback!: () => void;
    const asyncObserverCallbackPromise = new Promise<void>((resolve) => {
      resolveAsyncObserverCallback = resolve;
    });
    try {
      const asyncObserverController = new AbortController();
      const asyncObserverError = await expectBridgeError(requestFault(
        client,
        sourcePath,
        'cancel',
        2_000,
        asyncObserverController.signal,
        () => asyncObserverController.abort('observer-async-reject'),
        'cancelled',
        async () => {
          asyncObserverCallbackCount += 1;
          resolveAsyncObserverCallback();
          throw new Error(`async observer leaked ${root}`);
        }
      ));
      assertBridgeError(asyncObserverError, 'BRIDGE_REQUEST_CANCELLED', true);
      await settleWithin(asyncObserverCallbackPromise, 1_000, 'Async receipt observer was not invoked.');
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.removeListener('unhandledRejection', onAsyncObserverUnhandledRejection);
    }
    if (asyncObserverCallbackCount !== 1 || asyncObserverUnhandledRejections.length !== 0) {
      throw new Error('Async receipt observer was not isolated from the request promise.');
    }

    let resolveTerminalRaceProgress!: () => void;
    const terminalRaceProgressStarted = new Promise<void>((resolve) => {
      resolveTerminalRaceProgress = resolve;
    });
    let releaseTerminalRaceProgress!: () => void;
    const terminalRaceProgressGate = new Promise<void>((resolve) => {
      releaseTerminalRaceProgress = resolve;
    });
    let resolveTerminalRaceReceipt!: (receipt: BridgeCancellationTerminalReceipt) => void;
    const terminalRaceReceiptPromise = new Promise<BridgeCancellationTerminalReceipt>((resolve) => {
      resolveTerminalRaceReceipt = resolve;
    });
    const terminalRaceController = new AbortController();
    const cancellationTerminalRaceRequest = requestFault(
      client,
      sourcePath,
      'progress-terminal-race',
      2_000,
      terminalRaceController.signal,
      async () => {
        resolveTerminalRaceProgress();
        await terminalRaceProgressGate;
      },
      'result',
      resolveTerminalRaceReceipt
    );
    await terminalRaceProgressStarted;
    await waitForEvent(eventLogPath, 'terminal', 'progress-terminal-race');
    terminalRaceController.abort('terminal-already-received');
    const cancellationTerminalRaceError = await expectBridgeError(cancellationTerminalRaceRequest);
    assertBridgeError(cancellationTerminalRaceError, 'BRIDGE_REQUEST_CANCELLED', true);
    assertCancellationReceipt(
      await settleWithin(
        terminalRaceReceiptPromise,
        1_000,
        'Already-received terminal was not delivered to the cancellation observer.'
      ),
      'result',
      true
    );
    releaseTerminalRaceProgress();

    const cancelCountBeforeProgressFailure = (await readEvents(eventLogPath))
      .filter((event) => event.kind === 'cancel').length;
    const progressHandlerError = await expectBridgeError(requestFault(
      client,
      sourcePath,
      'timeout',
      2_000,
      undefined,
      () => { throw new Error(`progress callback leaked ${root}`); }
    ));
    assertBridgeError(progressHandlerError, 'BRIDGE_PROGRESS_HANDLER_FAILED', false);
    if (progressHandlerError.message.includes(root)) {
      throw new Error('Progress handler failure leaked callback details.');
    }
    await waitForCancelCount(eventLogPath, cancelCountBeforeProgressFailure + 1);
    if (client.isClosed || typeof (await client.health(2_000)).processId !== 'number') {
      throw new Error('Progress handler failure closed the reusable Bridge client.');
    }

    const cancelCountBeforeAsyncProgressFailure = (await readEvents(eventLogPath))
      .filter((event) => event.kind === 'cancel').length;
    const asyncProgressHandlerError = await expectBridgeError(requestFault(
      client,
      sourcePath,
      'timeout',
      2_000,
      undefined,
      async () => { throw new Error(`async progress callback leaked ${root}`); }
    ));
    assertBridgeError(asyncProgressHandlerError, 'BRIDGE_PROGRESS_HANDLER_FAILED', false);
    if (asyncProgressHandlerError.message.includes(root)) {
      throw new Error('Async progress handler failure leaked callback details.');
    }
    await waitForCancelCount(eventLogPath, cancelCountBeforeAsyncProgressFailure + 1);
    if (client.isClosed || typeof (await client.health(2_000)).processId !== 'number') {
      throw new Error('Async progress handler failure closed the reusable Bridge client.');
    }

    let progressHandlerEntered!: () => void;
    const progressHandlerStarted = new Promise<void>((resolve) => {
      progressHandlerEntered = resolve;
    });
    let rejectProgressHandler!: (reason?: unknown) => void;
    const progressHandlerGate = new Promise<void>((_resolve, reject) => {
      rejectProgressHandler = reject;
    });
    const cancelCountBeforeTerminalRace = (await readEvents(eventLogPath))
      .filter((event) => event.kind === 'cancel').length;
    let terminalRaceSettled = false;
    const terminalRaceRequest = requestFault(
      client,
      sourcePath,
      'progress-terminal-race',
      2_000,
      undefined,
      async () => {
        progressHandlerEntered();
        await progressHandlerGate;
      }
    );
    void terminalRaceRequest.then(
      () => { terminalRaceSettled = true; },
      () => { terminalRaceSettled = true; }
    );
    await progressHandlerStarted;
    await waitForEvent(eventLogPath, 'terminal', 'progress-terminal-race');
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (terminalRaceSettled) {
      throw new Error('Bridge request settled before its asynchronous progress handler.');
    }
    rejectProgressHandler(new Error(`terminal race callback leaked ${root}`));
    const terminalRaceError = await expectBridgeError(terminalRaceRequest);
    assertBridgeError(terminalRaceError, 'BRIDGE_PROGRESS_HANDLER_FAILED', false);
    if (terminalRaceError.message.includes(root)) {
      throw new Error('Terminal-race progress failure leaked callback details.');
    }
    const cancelCountAfterTerminalRace = (await readEvents(eventLogPath))
      .filter((event) => event.kind === 'cancel').length;
    if (cancelCountAfterTerminalRace !== cancelCountBeforeTerminalRace) {
      throw new Error('Progress failure emitted a late cancel after the terminal frame arrived.');
    }
    if (client.isClosed || typeof (await client.health(2_000)).processId !== 'number') {
      throw new Error('Terminal-race progress failure closed the reusable Bridge client.');
    }

    backpressureClient = await startBackpressureFixtureClient(root, eventLogPath);
    const backpressureUnhandledRejections: unknown[] = [];
    const onBackpressureUnhandledRejection = (reason: unknown): void => {
      backpressureUnhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onBackpressureUnhandledRejection);
    let backpressureCloseError: BridgeDaemonError;
    try {
      backpressureCloseError = await settleWithin(
        expectBridgeError(backpressureClient.request({
          payload: {
            command: 'validate',
            filePath: sourcePath,
            options: { backpressure: 'x'.repeat(4 * 1024 * 1024) }
          },
          resourceUri: 'file://synthetic-protocol-only.bin',
          timeoutMs: 300
        })),
        2_000,
        'Backpressured Bridge write did not settle after child close.'
      );
      await new Promise((resolve) => setTimeout(resolve, 450));
    } finally {
      process.removeListener('unhandledRejection', onBackpressureUnhandledRejection);
    }
    if (!['BRIDGE_STDIN_FAILED', 'BRIDGE_WRITE_FAILED', 'BRIDGE_PROCESS_EXITED']
      .includes(backpressureCloseError.code)) {
      throw new Error(`Unexpected backpressure close error: ${backpressureCloseError.code}.`);
    }
    if (backpressureUnhandledRejections.length !== 0) {
      throw new Error(
        `Backpressured child close left an unhandled rejection: ${String(backpressureUnhandledRejections[0])}`
      );
    }
    if (!backpressureClient.isClosed) {
      throw new Error('Backpressured fixture client did not close after its child exited.');
    }

    backpressureAbortClient = await startBackpressureFixtureClient(
      root,
      eventLogPath,
      'pause-after-handshake-hold',
      'bridge-recovery-backpressure-abort-harness'
    );
    const backpressureAbortUnhandledRejections: unknown[] = [];
    const onBackpressureAbortUnhandledRejection = (reason: unknown): void => {
      backpressureAbortUnhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onBackpressureAbortUnhandledRejection);
    let backpressureTimeoutError: BridgeDaemonError;
    let backpressureCancelError: BridgeDaemonError;
    try {
      backpressureTimeoutError = await settleWithin(
        expectBridgeError(backpressureAbortClient.request({
          payload: {
            command: 'validate',
            filePath: sourcePath,
            options: { backpressureTimeout: 'x'.repeat(4 * 1024 * 1024) }
          },
          resourceUri: 'file://synthetic-protocol-only.bin',
          timeoutMs: 50
        })),
        500,
        'Backpressured Bridge write ignored its request timeout.'
      );
      assertBridgeError(backpressureTimeoutError, 'BRIDGE_TIMEOUT', true);

      const backpressureAbortController = new AbortController();
      let backpressureAbortReceiptCount = 0;
      const backpressureCancellation = backpressureAbortClient.request({
        payload: {
          command: 'validate',
          filePath: sourcePath,
          options: { backpressureCancel: 'x'.repeat(4 * 1024 * 1024) }
        },
        resourceUri: 'file://synthetic-protocol-only.bin',
        timeoutMs: 1_000,
        signal: backpressureAbortController.signal,
        onCancellationTerminal: () => { backpressureAbortReceiptCount += 1; }
      });
      backpressureAbortController.abort('backpressure-cancel-fixture');
      backpressureCancelError = await settleWithin(
        expectBridgeError(backpressureCancellation),
        500,
        'Backpressured Bridge write ignored external cancellation.'
      );
      assertBridgeError(backpressureCancelError, 'BRIDGE_REQUEST_CANCELLED', true);
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (backpressureAbortReceiptCount !== 0) {
        throw new Error('Backpressured pre-dispatch cancellation fabricated a terminal receipt.');
      }
    } finally {
      process.removeListener('unhandledRejection', onBackpressureAbortUnhandledRejection);
    }
    if (backpressureAbortUnhandledRejections.length !== 0) {
      throw new Error(
        `Backpressure timeout/cancel left an unhandled rejection: ${String(backpressureAbortUnhandledRejections[0])}`
      );
    }

    closeObserverClient = await startFixtureClient(root, eventLogPath, 'close-after-cancel');
    let closeObserverCallbackCount = 0;
    const closeObserverController = new AbortController();
    const closeObserverError = await expectBridgeError(requestFault(
      closeObserverClient,
      sourcePath,
      'cancel',
      2_000,
      closeObserverController.signal,
      () => closeObserverController.abort('observer-close'),
      'hold',
      () => { closeObserverCallbackCount += 1; }
    ));
    assertBridgeError(closeObserverError, 'BRIDGE_REQUEST_CANCELLED', true);
    await waitForCancel(eventLogPath, 'cancel');
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (!closeObserverClient.isClosed || closeObserverCallbackCount !== 0
      || cancellationObserverInternals(closeObserverClient).cancellationTerminalObservers.size !== 0) {
      throw new Error('Bridge child close did not clear the cancellation observer.');
    }

    const healthBeforeCrash = await client.health(2_000);
    if (typeof healthBeforeCrash.processId !== 'number') {
      throw new Error('Fixture health did not expose a process id.');
    }

    let crashProgressFrames = 0;
    const processExitError = await expectBridgeError(requestFault(
      client,
      sourcePath,
      'process-exit',
      2_000,
      undefined,
      () => { crashProgressFrames += 1; }
    ));
    assertBridgeError(processExitError, 'BRIDGE_PROCESS_EXITED', true);
    if (!client.isClosed || crashProgressFrames !== 1) {
      throw new Error('Process-exit fixture did not close the active client after progress.');
    }

    replacement = await startFixtureClient(root, eventLogPath);
    const replacementHealth = await replacement.health(2_000);
    if (typeof replacementHealth.processId !== 'number'
      || replacementHealth.processId === healthBeforeCrash.processId) {
      throw new Error('Explicit recovery did not start a distinct fixture process.');
    }

    let disposeObserverCallbackCount = 0;
    const disposeObserverController = new AbortController();
    const disposeObserverError = await expectBridgeError(requestFault(
      replacement,
      sourcePath,
      'cancel',
      2_000,
      disposeObserverController.signal,
      () => disposeObserverController.abort('observer-dispose'),
      'hold',
      () => { disposeObserverCallbackCount += 1; }
    ));
    assertBridgeError(disposeObserverError, 'BRIDGE_REQUEST_CANCELLED', true);
    await waitForCancel(eventLogPath, 'cancel');
    const disposeObservers = cancellationObserverInternals(replacement).cancellationTerminalObservers;
    if (disposeObservers.size !== 1) {
      throw new Error(`Expected one observer before dispose, got ${disposeObservers.size}.`);
    }
    await replacement.dispose();
    if (Number(disposeObservers.size) !== 0 || disposeObserverCallbackCount !== 0) {
      throw new Error('Bridge dispose did not clear the cancellation observer.');
    }

    console.log(JSON.stringify({
      ok: true,
      status: 'fixture-confirmed',
      authority: 'fixture-confirmed',
      syntheticFixture: true,
      nativeAssetsLoaded: false,
      nativeWriterAuthority: false,
      cases: {
        protocolPhaseFailures: phaseResults,
        stagingFailure: 'BRIDGE_STAGING_WRITE_FAILED',
        outboundFrameFailure: oversizedFrameError.code,
        outboundFramePendingCleaned: true,
        registrationRaceCancellation: registrationRaceError.code,
        registrationRaceRequestSuppressed: true,
        preAbortedReceiptSuppressed: true,
        timeout: timeoutError.code,
        cancellation: cancellationError.code,
        cancellationTerminalObserver: observedCancellationTerminalOutcomes,
        cancellationTerminalObserverSyncThrowIsolated: true,
        cancellationTerminalObserverAsyncRejectIsolated: true,
        cancellationTerminalObserverTerminalRace: true,
        cancellationTerminalObserverDuplicateSuppressed: true,
        cancellationTerminalObserverTtlBounded: true,
        cancellationTerminalObserverCapacity: 64,
        cancellationTerminalObserverInvalidSessionSuppressed: true,
        cancellationTerminalObserverCloseCleanup: true,
        cancellationTerminalObserverDisposeCleanup: true,
        progressHandlerFailure: progressHandlerError.code,
        asyncProgressHandlerFailure: asyncProgressHandlerError.code,
        terminalRaceProgressFailure: terminalRaceError.code,
        terminalWaitedForAsyncProgress: true,
        backpressureChildClose: backpressureCloseError.code,
        backpressureUnhandledRejections: 0,
        backpressureTimeout: backpressureTimeoutError.code,
        backpressureCancellation: backpressureCancelError.code,
        processExit: processExitError.code,
        explicitRestart: true
      },
      nonClaims: [
        'fake daemon 只验证 subprocess/Bridge client 故障编排与 staging 失败关闭。',
        '未运行 production Bridge parser、writer 或任何 native 资产。',
        'fixture-confirmed 不提升 native writer、A-RECOVERY 或 release Gate authority。'
      ]
    }, null, 2));
  } finally {
    await closeObserverClient?.dispose();
    await backpressureAbortClient?.dispose();
    await backpressureClient?.dispose();
    await replacement?.dispose();
    await client?.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

function startFixtureClient(
  root: string,
  eventLogPath: string,
  fixtureMode?: string
): Promise<BridgeDaemonClient> {
  return BridgeDaemonClient.start({
    executable: process.execPath,
    args: [FIXTURE_DAEMON, eventLogPath, ...(fixtureMode ? [fixtureMode] : [])],
    cwd: root,
    workspaceSessionId: 'bridge-recovery-harness',
    allowedRoots: [root],
    maxFrameBytes: 256 * 1024,
    maxConcurrency: 1,
    startupTimeoutMs: 2_000
  });
}

function startBackpressureFixtureClient(
  root: string,
  eventLogPath: string,
  mode = 'pause-after-handshake-close',
  workspaceSessionId = 'bridge-recovery-backpressure-harness'
): Promise<BridgeDaemonClient> {
  return BridgeDaemonClient.start({
    executable: process.execPath,
    args: [FIXTURE_DAEMON, eventLogPath, mode],
    cwd: root,
    workspaceSessionId,
    allowedRoots: [root],
    maxFrameBytes: 8 * 1024 * 1024,
    maxConcurrency: 1,
    startupTimeoutMs: 2_000
  });
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function requestFault(
  client: BridgeDaemonClient,
  sourcePath: string,
  fault: BridgeRecoveryHarnessFault,
  timeoutMs: number,
  signal?: AbortSignal,
  onProgress?: () => void | Promise<void>,
  cancellationTerminal?: FixtureCancellationTerminal,
  onCancellationTerminal?: (receipt: BridgeCancellationTerminalReceipt) => void | Promise<void>,
  cancellationTerminalSession?: FixtureCancellationTerminalSession,
  cancellationTerminalDuplicate = false
) {
  return client.request({
    payload: {
      command: 'validate',
      filePath: sourcePath,
      options: {
        [BRIDGE_RECOVERY_FAULT_OPTION]: fault,
        ...(cancellationTerminal ? { cancellationTerminal } : {}),
        ...(cancellationTerminalSession ? { cancellationTerminalSession } : {}),
        ...(cancellationTerminalDuplicate ? { cancellationTerminalDuplicate: true } : {})
      }
    },
    resourceUri: 'file://synthetic-protocol-only.bin',
    timeoutMs,
    ...(signal ? { signal } : {}),
    ...(onProgress ? { onProgress } : {}),
    ...(onCancellationTerminal ? { onCancellationTerminal } : {})
  });
}

function assertCancellationReceipt(
  receipt: BridgeCancellationTerminalReceipt,
  outcome: CancellationTerminalOutcome,
  cancelRequested: boolean
): void {
  if (receipt.outcome !== outcome
    || receipt.cancelRequested !== cancelRequested
    || !receipt.requestId
    || !Number.isFinite(Date.parse(receipt.receivedAt))) {
    throw new Error(`Unexpected cancellation terminal receipt: ${JSON.stringify(receipt)}`);
  }
}

function cancellationObserverInternals(client: BridgeDaemonClient): CancellationObserverInternals {
  return client as unknown as CancellationObserverInternals;
}

function expireCancellationTerminalObservers(client: BridgeDaemonClient): void {
  const observers = cancellationObserverInternals(client).cancellationTerminalObservers;
  for (const observer of [...observers.values()]) observer.timer?._onTimeout?.();
}

function createRegistrationRaceSignal(): AbortSignal {
  let aborted = false;
  return {
    get aborted() {
      return aborted;
    },
    addEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
      aborted = true;
      const event = new Event('abort');
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    },
    removeEventListener() {
      // The deterministic signal has no retained listeners.
    }
  } as unknown as AbortSignal;
}

async function expectBridgeError(promise: Promise<unknown>): Promise<BridgeDaemonError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BridgeDaemonError) return error;
    throw error;
  }
  throw new Error('Deterministic fault unexpectedly succeeded.');
}

function assertBridgeError(
  error: BridgeDaemonError,
  expectedCode: string,
  retryable: boolean
): void {
  if (error.code !== expectedCode || error.retryable !== retryable) {
    throw new Error(
      `Expected ${expectedCode}/retryable=${retryable}, got ${error.code}/${error.retryable}.`
    );
  }
}

async function waitForCancel(
  eventLogPath: string,
  fault: 'timeout' | 'cancel'
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const events = await readEvents(eventLogPath);
    const request = events.find((event) => event.kind === 'request' && event.fault === fault);
    if (request && events.some((event) => event.kind === 'cancel'
      && event.targetRequestId === request.requestId)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${fault} request did not emit a matching cancel frame.`);
}

async function waitForCancelCount(eventLogPath: string, expectedCount: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const events = await readEvents(eventLogPath);
    if (events.filter((event) => event.kind === 'cancel').length >= expectedCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Bridge recovery harness observed fewer than ${expectedCount} cancel frames.`);
}

async function waitForEvent(
  eventLogPath: string,
  kind: BridgeRecoveryHarnessEvent['kind'],
  fault: BridgeRecoveryHarnessFault
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const events = await readEvents(eventLogPath);
    if (events.some((event) => event.kind === kind && event.fault === fault)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Bridge recovery harness did not observe ${kind}/${fault}.`);
}

async function readEvents(eventLogPath: string): Promise<BridgeRecoveryHarnessEvent[]> {
  let text: string;
  try {
    text = await readFile(eventLogPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return text.split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as BridgeRecoveryHarnessEvent);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
