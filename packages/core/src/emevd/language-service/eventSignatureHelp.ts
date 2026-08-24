/**
 * Deterministic Signature Help & Parameter Info Model for EMEVD DarkScript3.
 *
 * Consumes the cursor context and EMEDF catalog to produce structured signature assistance:
 * - Active argument index & active parameter doc/type/enum
 * - Formatted signature label
 * - Enum values for active parameter
 * - Vararg support
 */

import type { EmedfCompletionItem } from '../emedfCompletionCatalog.js';
import type { EmedfEnumDef } from '../emedfSchema.js';
import type { EventCursorContext } from './eventCursorContext.js';

export interface SignatureParameterHelp {
  name: string;
  type: string;
  enumName?: string;
  description?: string;
  default?: number;
  min?: number;
  max?: number;
  vararg?: boolean;
  enumMembers?: Array<{ value: number; name: string; label?: string }>;
}

export interface EventSignatureHelp {
  instructionName: string;
  bank?: number;
  id?: number;
  signatureLabel: string;
  parameters: SignatureParameterHelp[];
  activeParameterIndex: number;
  activeParameter: SignatureParameterHelp | null;
  docs?: string;
}

export function getSignatureHelp(
  context: EventCursorContext,
  items: readonly EmedfCompletionItem[],
  enums?: Record<string, EmedfEnumDef>
): EventSignatureHelp | null {
  if (context.isInComment || context.isInString || !context.activeCall) {
    return null;
  }

  const callName = context.activeCall.name;
  if (!callName) return null;

  // Handle special built-in $Event
  if (callName === '$Event') {
    const params: SignatureParameterHelp[] = [
      { name: 'eventId', type: 's32', description: 'Unique 32-bit Event ID (e.g. 0, 10000)' },
      {
        name: 'restBehavior',
        type: 'RestBehavior',
        description: 'Event restart mode upon player rest/death',
        enumMembers: [
          { value: 0, name: 'Default', label: 'Default' },
          { value: 1, name: 'Restart', label: 'Restart' }
        ]
      },
      { name: 'body', type: 'function', description: 'Event instruction block function() { ... }' }
    ];
    const activeIndex = Math.min(context.activeCall.activeArgumentIndex, params.length - 1);
    return {
      instructionName: '$Event',
      signatureLabel: '$Event(eventId: s32, restBehavior: Default | Restart, function() { ... })',
      parameters: params,
      activeParameterIndex: activeIndex,
      activeParameter: params[activeIndex] ?? null
    };
  }

  // Handle special built-in WaitFor
  if (callName === 'WaitFor') {
    const params: SignatureParameterHelp[] = [
      { name: 'conditions', type: 'boolean', description: 'Logical condition predicates joined with && or ||' }
    ];
    return {
      instructionName: 'WaitFor',
      signatureLabel: 'WaitFor(condition1 && condition2 ...)',
      parameters: params,
      activeParameterIndex: 0,
      activeParameter: params[0]!
    };
  }

  // Look up instruction in EMEDF items
  const matched = items.find((item) => item.name === callName)
    ?? items.find((item) => item.name.toLowerCase() === callName.toLowerCase());

  if (!matched) {
    return {
      instructionName: callName,
      signatureLabel: `${callName}(...)`,
      parameters: [],
      activeParameterIndex: context.activeCall.activeArgumentIndex,
      activeParameter: null,
      docs: '未在当前 EMEDF 目录中找到该指令定义。'
    };
  }

  const parameters: SignatureParameterHelp[] = matched.args.map((arg) => {
    let enumMembers: Array<{ value: number; name: string; label?: string }> | undefined;
    if (arg.enumName && enums) {
      const enumDef = enums[arg.enumName];
      if (enumDef) {
        enumMembers = enumDef.members;
      }
    }
    return {
      name: arg.name,
      type: arg.type,
      ...(arg.enumName ? { enumName: arg.enumName } : {}),
      ...(arg.description ? { description: arg.description } : {}),
      ...(arg.default !== undefined ? { default: arg.default } : {}),
      ...(arg.min !== undefined ? { min: arg.min } : {}),
      ...(arg.max !== undefined ? { max: arg.max } : {}),
      ...(arg.vararg === true ? { vararg: true } : {}),
      ...(enumMembers ? { enumMembers } : {})
    };
  });

  const activeIndex = context.activeCall.activeArgumentIndex;
  let activeParam: SignatureParameterHelp | null = null;
  if (activeIndex < parameters.length) {
    activeParam = parameters[activeIndex]!;
  } else if (parameters.length > 0 && parameters[parameters.length - 1]!.vararg) {
    activeParam = parameters[parameters.length - 1]!;
  }

  const paramLabels = parameters.map((p) => {
    const enumSuffix = p.enumName ? ` (${p.enumName})` : '';
    const varargSuffix = p.vararg ? '...' : '';
    return `${p.name}: ${p.type}${enumSuffix}${varargSuffix}`;
  });

  const signatureLabel = `${matched.name}(${paramLabels.join(', ')})`;

  return {
    instructionName: matched.name,
    bank: matched.bank,
    id: matched.id,
    signatureLabel,
    parameters,
    activeParameterIndex: activeIndex,
    activeParameter: activeParam,
    ...(matched.description ? { docs: matched.description } : {})
  };
}
