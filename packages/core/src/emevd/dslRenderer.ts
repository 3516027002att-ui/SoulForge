import type { EmevdEditorDocument } from '@soulforge/shared';
import { decodeStrictBase64 } from '../util/base64.js';
import {
  decodeInstructionArgs,
  findInstructionDef,
  type EmedfRegistry
} from './emedfSchema.js';
import { fingerprintEmedfRegistry } from './dslCompiler.js';
import { formatEmevdAnchor } from './stableIdentity.js';

/**
 * Render an editable patch template bound to one opened document revision.
 * Unknown instructions remain comments, so parsing the untouched template is
 * a deterministic no-op and never implies deletion or binary reconstruction.
 */
export function renderEmevdPatchDsl(
  document: EmevdEditorDocument,
  registry: EmedfRegistry
): string {
  if (!document.documentInstanceId) {
    throw new Error('EMEVD_DSL_DOCUMENT_INSTANCE_REQUIRED');
  }

  const schemaFingerprint = fingerprintEmedfRegistry(registry);
  const lines = [
    `resource ${JSON.stringify(document.resourceUri)}`,
    `base revision ${document.revision} schema ${JSON.stringify(schemaFingerprint)}`,
    ''
  ];

  for (const event of document.events) {
    if (!event.anchor) throw new Error('EMEVD_DSL_EVENT_ANCHOR_REQUIRED');
    const eventAnchor = formatEmevdAnchor('event', event.anchor);
    lines.push(`event ${eventAnchor} {`);
    lines.push(`  set id = ${event.eventId}`);
    lines.push(`  set rest = ${event.restBehavior}`);
    if (event.layer !== -1) {
      lines.push(`  // layer=${event.layer} is read-only in DSL Slice A+B`);
    }

    for (const instruction of event.instructions) {
      if (!instruction.anchor) throw new Error('EMEVD_DSL_INSTRUCTION_ANCHOR_REQUIRED');
      const instructionAnchor = formatEmevdAnchor('instruction', instruction.anchor);
      const definition = instruction.unknown
        ? undefined
        : findInstructionDef(registry, instruction.bank, instruction.id);
      if (!definition) {
        lines.push(
          `  // read-only ${instructionAnchor} bank=${instruction.bank} id=${instruction.id}`
        );
        continue;
      }

      let rawArgs: Buffer;
      try {
        rawArgs = decodeStrictBase64(instruction.argsBase64, { allowEmpty: true });
      } catch {
        throw new Error(`EMEVD_DSL_RENDER_ARGS_BASE64_INVALID:${instructionAnchor}`);
      }
      const decoded = decodeInstructionArgs(registry, instruction.bank, instruction.id, rawArgs);
      if (!decoded.ok) {
        throw new Error(`EMEVD_DSL_RENDER_DECODE_FAILED:${instructionAnchor}:${decoded.code}`);
      }

      lines.push(`  instruction ${instructionAnchor} {`);
      lines.push(`    // ${definition.name} (${instruction.bank}:${instruction.id})`);
      for (const argument of decoded.args) {
        lines.push(`    set arg ${argument.name} = ${formatLiteral(argument.value)}`);
      }
      lines.push('  }');
    }
    lines.push('}', '');
  }

  return lines.join('\n').trimEnd();
}

function formatLiteral(value: number | boolean): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (!Number.isFinite(value)) throw new Error('EMEVD_DSL_RENDER_NON_FINITE_VALUE');
  return Object.is(value, -0) ? '-0' : String(value);
}
