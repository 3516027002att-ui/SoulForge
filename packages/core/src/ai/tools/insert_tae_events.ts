import type { RegisteredTool } from '../toolRegistry.js';
import type { TaeEventInsertion } from '../../editing/taeEdit.js';
import { asRecord } from '.././toolRegistrySupport.js';
import { asString } from '.././toolRegistrySupport.js';
import { fail } from '.././toolRegistrySupport.js';
import { finalizeCommittedToolResult } from '.././toolRegistrySupport.js';
import { insertTaeEvents } from '../../editing/taeEdit.js';
import { nativePathFromFileToken } from '.././toolRegistrySupport.js';
import { ok } from '.././toolRegistrySupport.js';
import { requireEditSession } from '.././toolRegistrySupport.js';
import { resolveIndexedResourceFile } from '.././toolRegistrySupport.js';

/** insert_tae_events: one domain tool declaration, schema and handler. */
export function createInsertTaeEventsTool():RegisteredTool {
 return {
    name: 'insert_tae_events',
    description: 'Append native TAE events through Patch Engine in one audited commit. Each event needs an action-level address, eventTypeId, startFrame/endFrame, and a template {file?, address} with an exact event address. Templates may come from another action, section or workspace file. Optional fields are typed first-party schema overrides applied atomically; unknown layouts fail closed. Returns exact new addresses, backup, operation and rollback information.',
    permission: 'commit', permissionLevel: 'commit',
    inputSchema: { file: 'string', events: 'array' },
    run: async (input, context) => {
      const value = asRecord(input);
      if (value.domain && value.domain !== 'tae') return fail('DOMAIN_CROSSOVER_REJECTED', 'TAE 新增工具仅接受动作词条。');
      const file = asString(value.file);
      if (!file || !Array.isArray(value.events)) return fail('INVALID_INPUT', 'insert_tae_events 需要 file 和 events 数组。');
      const edit = requireEditSession(context, 'write');
      if (!('session' in edit)) return edit;
      const resolved = resolveIndexedResourceFile(context, file, 'chr');
      if (!resolved.ok) return fail(resolved.code, resolved.message, resolved.details);
      for (const raw of value.events) {
        const template = asRecord(asRecord(raw).template);
        if (typeof template.file === 'string') {
          const resolvedTemplate = resolveIndexedResourceFile(context, template.file, 'chr');
          if (!resolvedTemplate.ok) return fail(resolvedTemplate.code, resolvedTemplate.message, resolvedTemplate.details);
        }
      }
      const events = value.events.map(raw => {
        const event = asRecord(raw); const template = asRecord(event.template);
        const templateFile = typeof template.file === 'string' ? resolveIndexedResourceFile(context, template.file, 'chr') : undefined;
        return { ...event, template: { ...template, ...(templateFile?.ok ? { file: nativePathFromFileToken(templateFile.path) } : {}) } };
      }) as unknown as TaeEventInsertion[];
      const result = await insertTaeEvents({ edit: edit.session, file: nativePathFromFileToken(resolved.path), events });
      if (!result.ok) return fail(result.error.code, result.error.message, result.diagnostics);
      return finalizeCommittedToolResult({ data: result, changedSources: [result.filePath], context,
        verifyNative: async () => result.nativeVerified ? { ok: true, details: { addresses: result.after.map(e => e.address) } }
          : { ok: false, code: 'TAE_INSERT_READBACK_FAILED', message: '提交后未完整回读新增词条。', details: result.diagnostics } });
    }
  };
}
