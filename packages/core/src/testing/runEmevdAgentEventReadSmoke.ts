import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEmevdEditorDocument } from '../editing/emevdFourViewController.js';
import { applyEmevdDsl, readEmevdEvent } from '../editing/emevdEdit.js';
import { compileEmevdDarkScript } from '../emevd/darkScriptCompiler.js';
import { fingerprintEmedfRegistry } from '../emevd/dslCompiler.js';
import { renderEmevdDarkScript } from '../emevd/darkScriptRenderer.js';
import { createSyntheticImportedEmedf, createSyntheticDs3EmedfJson, importedRegistrySyntheticEmevd } from './syntheticEmevdBytes.js';
import { disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { openNativeEditSession } from '../editing/nativeEditSession.js';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';

function fail(message: string): never {
  throw new Error(message);
}

function assertDiagnostic(result: { diagnostics: Array<{ code: string }> }, code: string): void {
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === code), `missing diagnostic ${code}`);
}

async function run(): Promise<void> {
  const previousEmedfPath = process.env.SOULFORGE_EMEDF_PATH;
  try {
    await withSmokeWorkspace('emevd-agent-event-read', async (workspace) => {
      const eventDir = join(workspace.root, 'event');
      await mkdir(eventDir, { recursive: true });
      const file = join(eventDir, 'common.emevd');
      const emedfPath = join(workspace.root, 'synthetic.emedf.json');
      await writeFile(file, importedRegistrySyntheticEmevd());
      await writeFile(emedfPath, createSyntheticDs3EmedfJson(), 'utf8');
      process.env.SOULFORGE_EMEDF_PATH = emedfPath;

      const edit = await openNativeEditSession({ overlayRoot: workspace.root, game: 'sekiro' });
      const read = await readEmevdEvent({ edit, file, eventId: 50 });
      assert.equal(read.ok, true, JSON.stringify(read));
      if (!read.ok) return;
      assert.equal(read.eventId, 50);
      assert.equal(read.sourcePath, file);
      assert.equal(read.game, 'sekiro');
      assert.equal(read.resourceKind, 'event');
      assert.equal(read.instructionCount, 3);
      assert.equal(read.registryOrigin, 'imported');
      assert.equal(read.registryFingerprint, fingerprintEmedfRegistry(createSyntheticImportedEmedf()));
      assert.equal(read.instructions[0]?.index, 0);
      assert.equal(read.instructions[0]?.emedfName, 'IFConditionGroup');
      assert.equal(read.instructions[0]?.unknown, false);
      assert.equal(read.instructions[0]?.typedArgs?.[0]?.value, 1);
      assert.equal(read.instructions[2]?.unknown, true);
      assert.ok(
        read.instructions[2]!.diagnostics.some((diagnostic) =>
          diagnostic.code === 'EMEDF_UNKNOWN_INSTRUCTION' || diagnostic.code === 'EMEVD_INSTRUCTION_MARKED_UNKNOWN'
        ),
        'unknown instruction must carry an honest diagnostic'
      );
      assert.ok(read.darkScript?.includes('$Event(50, Default, function() {'));
      assert.ok(!read.darkScript?.includes('$Event(100'));
      assert.equal(read.darkScriptComplete, true);
      assert.equal(read.total, 3);
      assert.equal(read.offset, 0);
      assert.equal(read.returned, 3);

      const page = await readEmevdEvent({ edit, file, eventId: 50, instructionLimit: 2 });
      assert.equal(page.ok, true, JSON.stringify(page));
      if (!page.ok) return;
      assert.equal(page.total, 3);
      assert.equal(page.offset, 0);
      assert.equal(page.limit, 2);
      assert.equal(page.returned, 2);
      assert.equal(page.truncated, true);
      assert.equal(page.darkScriptComplete, false);
      assert.ok(page.diagnostics.some((diagnostic) => diagnostic.code === 'EMEVD_EVENT_INSTRUCTIONS_PAGED'));

      const tail = await readEmevdEvent({ edit, file, eventId: 50, instructionOffset: 2, instructionLimit: 2, format: 'json' });
      assert.equal(tail.ok, true, JSON.stringify(tail));
      if (!tail.ok) return;
      assert.equal(tail.offset, 2);
      assert.equal(tail.returned, 1);
      assert.equal(tail.truncated, false);

      const jsonRead = await readEmevdEvent({ edit, file, eventId: 50, format: 'json' });
      assert.equal(jsonRead.ok, true, JSON.stringify(jsonRead));
      if (!jsonRead.ok) return;
      assert.equal(jsonRead.darkScript, undefined);
      assert.equal(jsonRead.instructions.length, 3);

      // Exercise the production Agent facade end-to-end on the temporary
      // overlay: read DarkScript, scope it to one event, commit through the
      // existing four-view/Patch Engine path, and verify the changed arg.
      const sourceForWrite = read.darkScript?.replace('IfConditionGroup(1, 0, 2)', 'IfConditionGroup(1, 1, 2)');
      assert.ok(sourceForWrite);
      const applied = await applyEmevdDsl({
        edit,
        file,
        dsl: sourceForWrite,
        mode: 'dark-script',
        scope: { eventId: 50 },
        ...(read.sourceHash ? { sourceHash: read.sourceHash } : {}),
        ...(read.outerFileHash ? { outerFileHash: read.outerFileHash } : {}),
        ...(read.sourceRevision !== undefined ? { sourceRevision: read.sourceRevision } : {}),
        darkScriptComplete: read.darkScriptComplete
      });
      assert.equal(applied.ok, true, JSON.stringify(applied));
      assert.ok((applied.mutationCount ?? 0) > 0);
      const reread = await readEmevdEvent({ edit, file, eventId: 50, format: 'json' });
      assert.equal(reread.ok, true, JSON.stringify(reread));
      if (!reread.ok) return;
      assert.equal(reread.instructions[0]?.typedArgs?.[1]?.value, 1);

      // The first read receipt must no longer authorize a second write after
      // the native document changed; this is the event-scope CAS boundary.
      if (read.sourceHash) {
        const stale = await applyEmevdDsl({
          edit,
          file,
          dsl: sourceForWrite,
          mode: 'dark-script',
          scope: { eventId: 50 },
          sourceHash: read.sourceHash,
          ...(read.outerFileHash ? { outerFileHash: read.outerFileHash } : {}),
          ...(read.sourceRevision !== undefined ? { sourceRevision: read.sourceRevision } : {}),
          darkScriptComplete: true
        });
        assert.equal(stale.ok, false, JSON.stringify(stale));
        assert.equal(stale.error?.code, 'EMEVD_DSL_SOURCE_STALE');
      }

      const registry = createSyntheticImportedEmedf();
      const document = createEmevdEditorDocument({
        resourceUri: 'file://event/common.emevd',
        documentInstanceId: 'emevd-agent-event-read-scope',
        events: [
          {
            eventId: 50,
            restBehavior: 0,
            instructions: [
              { bank: 0, id: 0, argsBase64: Buffer.from([1, 0, 2, 0]).toString('base64'), unknown: false }
            ]
          },
          { eventId: 100, restBehavior: 0, instructions: [] }
        ]
      });
      const event = document.events[0]!;
      const source = renderEmevdDarkScript({ ...document, events: [event] }, registry);
      const request = {
        schemaVersion: 1 as const,
        resourceUri: document.resourceUri,
        documentInstanceId: document.documentInstanceId!,
        baseRevision: document.revision,
        emedfSchemaFingerprint: fingerprintEmedfRegistry(registry),
        sourceText: source.replace('IfConditionGroup(1, 0, 2)', 'IfConditionGroup(1, 1, 2)'),
        mode: 'dark-script' as const,
        scopeEventId: 50
      };
      const scoped = compileEmevdDarkScript(request, document, registry);
      assert.equal(scoped.ok, true, JSON.stringify(scoped));
      if (!scoped.ok) return;
      assert.ok(scoped.plan.operations.length > 0);
      assert.equal(scoped.plan.operations.some((operation) => operation.kind === 'delete_event'), false);
      assert.equal(scoped.plan.operations.some((operation) => operation.kind === 'insert_event'), false);
      assert.ok(scoped.plan.operations.every((operation) =>
        operation.kind === 'insert_event' || operation.kind === 'set_event_parameters'
          ? operation.eventId === undefined || operation.eventId === 50
          : operation.eventAnchor.includes(event.anchor!.localNodeId)
      ));

      const multiple = compileEmevdDarkScript(
        { ...request, sourceText: `${source}\n\n$Event(100, Default, function() {\n});` },
        document,
        registry
      );
      assert.equal(multiple.ok, false);
      assertDiagnostic(multiple, 'EMEVD_DSL_SCOPE_REQUIRES_SINGLE_EVENT');

      const missing = compileEmevdDarkScript({ ...request, scopeEventId: 999 }, document, registry);
      assert.equal(missing.ok, false);
      assertDiagnostic(missing, 'EMEVD_DSL_SCOPE_EVENT_NOT_FOUND');
    });
  } finally {
    if (previousEmedfPath === undefined) delete process.env.SOULFORGE_EMEDF_PATH;
    else process.env.SOULFORGE_EMEDF_PATH = previousEmedfPath;
    await disposeBridgeDaemonPool();
  }
}

run().then(
  () => console.log('runEmevdAgentEventReadSmoke: PASS'),
  (error) => {
    console.error(`runEmevdAgentEventReadSmoke: FAIL\n${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  }
);
