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
  return renderEmevdPatchDslBounded(document, registry, undefined).text;
}

export interface BoundedEmevdPatchDsl {
  text: string;
  truncated: boolean;
  totalLines: number;
  shownLines: number;
}

/**
 * Bounded template renderer (hard constraint 17): caps the line count so a
 * real corpus document (1,730 events / 33,266 instructions ≈ 70K+ lines) is
 * never transferred or materialized in one payload. Truncation happens only at
 * an event-block boundary so the visible text stays parseable; the trailing
 * marker is a comment, so compiling the truncated template is still a
 * deterministic no-op for anything the user did not edit (patch semantics only
 * express changes).
 */
export function renderEmevdPatchDslBounded(
  document: EmevdEditorDocument,
  registry: EmedfRegistry,
  templateLineLimit: number | undefined
): BoundedEmevdPatchDsl {
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

  const totalLines = lines.length;
  if (templateLineLimit === undefined || totalLines <= templateLineLimit) {
    return { text: lines.join('\n').trimEnd(), truncated: false, totalLines, shownLines: totalLines };
  }
  // Back up to the last completed event block at or below the limit so the
  // visible text never ends mid-block; if the cap lands inside the first event
  // block, extend forward to its closing brace instead.
  let safeBreak = -1;
  for (let i = 0; i < templateLineLimit; i += 1) {
    if (lines[i] === '}') safeBreak = i + 1;
  }
  if (safeBreak <= 0) {
    for (let i = templateLineLimit; i < lines.length; i += 1) {
      if (lines[i] === '}') {
        safeBreak = i + 1;
        break;
      }
    }
  }
  const shownLines = safeBreak > 0 ? safeBreak : lines.length;
  const shown = lines.slice(0, shownLines);
  shown.push(
    '',
    `// EMEVD_DSL_TEMPLATE_TRUNCATED: 完整模板共 ${totalLines} 行，已显示 ${shownLines} 行。`,
    '// 模板仅作为编辑起点；截断不影响编译（注释行），提交时只应用实际修改的增量 patch。'
  );
  return { text: shown.join('\n'), truncated: true, totalLines, shownLines };
}

function formatLiteral(value: number | boolean): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (!Number.isFinite(value)) throw new Error('EMEVD_DSL_RENDER_NON_FINITE_VALUE');
  return Object.is(value, -0) ? '-0' : String(value);
}
