import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { probeStandaloneScriptFile } from './runWorkspaceCompletenessMatrixSmoke.js';

const hksMagic = Uint8Array.from([0x1b, 0x4c, 0x75, 0x61, 0x50, 0x01, 0x04, 0x08]);

describe('workspace completeness standalone script route', () => {
  it('uses the native HKS reader only for bytecode and requires complete source evidence', async () => {
    const commands: string[] = [];
    const input = {
      absolutePath: 'C:/fixture/action/script/c0000_transition.hks',
      allowedRoots: ['C:/fixture'],
      oodleRuntimeRoot: 'C:/game'
    };
    const result = await probeStandaloneScriptFile(input, {
      getFileSize: async () => hksMagic.length,
      readBytes: async () => hksMagic,
      runHksSource: async (options) => {
        commands.push(options.command);
        assert.equal(options.command, 'read-hks-source');
        assert.deepEqual(options.allowedRoots, input.allowedRoots);
        assert.equal(options.oodleRuntimeRoot, input.oodleRuntimeRoot);
        assert.deepEqual(options.commandOptions, {});
        return {
          parseStatus: 'ok',
          data: { sourceText: 'function action() end', sourceHash: 'a'.repeat(64), dialect: 'sekiro-hks' },
          diagnostics: []
        };
      }
    });

    assert.equal(result.status, 'opened');
    assert.deepEqual(commands, ['read-hks-source']);
  });

  it('opens confirmed plaintext without treating it as compiled HKS source', async () => {
    const bytes = Buffer.from('-- comment\nreturn true\n', 'utf8');
    let nativeReads = 0;
    const result = await probeStandaloneScriptFile({
      absolutePath: 'C:/fixture/script/goal_list.lua',
      allowedRoots: ['C:/fixture']
    }, {
      getFileSize: async () => bytes.length,
      readBytes: async () => bytes,
      runHksSource: async () => {
        nativeReads += 1;
        throw new Error('plaintext must not be sent to HKS reader');
      }
    });

    assert.equal(result.status, 'opened');
    assert.match(result.detail, /PLAINTEXT_CONFIRMED/);
    assert.equal(nativeReads, 0);
  });

  it('does not convert unsupported bytes or incomplete native results into success', async () => {
    const unsupportedReads: Uint8Array = Uint8Array.from([0, 1, 2, 3, 4]);
    let nativeReads = 0;
    const unsupported = await probeStandaloneScriptFile({
      absolutePath: 'C:/fixture/action/script/c0000.hks',
      allowedRoots: ['C:/fixture']
    }, {
      getFileSize: async () => unsupportedReads.length,
      readBytes: async () => unsupportedReads,
      runHksSource: async () => {
        nativeReads += 1;
        throw new Error('unrecognized bytecode must not be sent to HKS reader');
      }
    });
    assert.equal(unsupported.status, 'failed');
    assert.match(unsupported.detail, /SCRIPT_SOURCE_BYTECODE_UNSUPPORTED/);
    assert.equal(nativeReads, 0);

    const incomplete = await probeStandaloneScriptFile({
      absolutePath: 'C:/fixture/action/script/c0000_transition.hks',
      allowedRoots: ['C:/fixture']
    }, {
      getFileSize: async () => hksMagic.length,
      readBytes: async () => hksMagic,
      runHksSource: async () => ({
        parseStatus: 'ok',
        data: { sourceText: 'function action() end' },
        diagnostics: []
      })
    });
    assert.equal(incomplete.status, 'failed');
    assert.match(incomplete.detail, /SCRIPT_HKS_READ_FAILED/);
  });

  it('keeps native error diagnostics failed even when parseStatus says unsupported', async () => {
    const result = await probeStandaloneScriptFile({
      absolutePath: 'C:/fixture/action/script/c0000_transition.hks',
      allowedRoots: ['C:/fixture']
    }, {
      getFileSize: async () => hksMagic.length,
      readBytes: async () => hksMagic,
      runHksSource: async () => ({
        parseStatus: 'unsupported',
        diagnostics: [{ severity: 'error', code: 'NATIVE_CORRUPTION', message: 'reader rejected malformed payload' }]
      })
    });

    assert.equal(result.status, 'failed');
    assert.match(result.detail, /NATIVE_CORRUPTION/);
  });
});
