import type { Diagnostic, EventSymbol, ReferenceEdge } from '@soulforge/shared';
import { collectEventEvidence, renderEventEvidenceMarkdown } from '../references/eventEvidence.js';

export interface AiContextBudget {
  maxInstructions?: number;
  maxReferences?: number;
  maxUnknownArguments?: number;
  maxMarkdownChars?: number;
}

export interface EventAiContext {
  kind: 'event_explanation_context';
  eventUri: string;
  eventId: number;
  name?: string;
  summary: {
    instructionCount: number;
    highConfidenceReferences: number;
    uncertainReferences: number;
    unknownNumericArguments: number;
  };
  instructions: Array<{
    uri: string;
    index: number;
    name?: string;
    args: Array<{ name?: string; value: string | number | boolean; role?: string }>;
  }>;
  references: Array<{
    toUri: string;
    kind: ReferenceEdge['kind'];
    confidence: ReferenceEdge['confidence'];
    reason: string;
    evidence: string[];
  }>;
  evidenceMarkdown: string;
  diagnostics: Diagnostic[];
}

export function buildEventAiContext(event: EventSymbol, references: readonly ReferenceEdge[], budget: AiContextBudget = {}): EventAiContext {
  const maxInstructions = budget.maxInstructions ?? 120;
  const maxReferences = budget.maxReferences ?? 80;
  const maxUnknownArguments = budget.maxUnknownArguments ?? 80;
  const maxMarkdownChars = budget.maxMarkdownChars ?? 24_000;

  const report = collectEventEvidence(event, [...references]);
  const markdown = truncate(renderEventEvidenceMarkdown({
    ...report,
    unknownArguments: report.unknownArguments.slice(0, maxUnknownArguments)
  }), maxMarkdownChars);

  const sortedReferences = [...references]
    .sort((a, b) => confidenceRank(b.confidence) - confidenceRank(a.confidence))
    .slice(0, maxReferences);

  const diagnostics: Diagnostic[] = [];
  if (event.instructions.length > maxInstructions) {
    diagnostics.push({
      severity: 'info',
      code: 'AI_CONTEXT_INSTRUCTIONS_TRUNCATED',
      message: `Event has ${event.instructions.length} instructions; only ${maxInstructions} are included in AI context.`,
      sourceUri: event.uri
    });
  }
  if (references.length > maxReferences) {
    diagnostics.push({
      severity: 'info',
      code: 'AI_CONTEXT_REFERENCES_TRUNCATED',
      message: `Event has ${references.length} references; only ${maxReferences} are included in AI context.`,
      sourceUri: event.uri
    });
  }

  return {
    kind: 'event_explanation_context',
    eventUri: event.uri,
    eventId: event.eventId,
    ...(event.name ? { name: event.name } : {}),
    summary: {
      instructionCount: event.instructions.length,
      highConfidenceReferences: references.filter((edge) => edge.confidence === 'high').length,
      uncertainReferences: references.filter((edge) => edge.confidence !== 'high').length,
      unknownNumericArguments: report.unknownArguments.length
    },
    instructions: event.instructions.slice(0, maxInstructions).map((instruction) => ({
      uri: instruction.uri,
      index: instruction.index,
      ...(instruction.name ? { name: instruction.name } : {}),
      args: instruction.args.map((arg) => ({
        ...(arg.name ? { name: arg.name } : {}),
        value: arg.value,
        ...(arg.role ? { role: arg.role } : {})
      }))
    })),
    references: sortedReferences.map((edge) => ({
      toUri: edge.toUri,
      kind: edge.kind,
      confidence: edge.confidence,
      reason: edge.reason,
      evidence: edge.evidence.map((item) => item.excerpt ?? `${item.sourceUri}:${String(item.value ?? '')}`)
    })),
    evidenceMarkdown: markdown,
    diagnostics
  };
}

export function renderEventAiPrompt(context: EventAiContext): string {
  const lines: string[] = [];
  lines.push('You are explaining a FromSoftware event from SoulForge evidence.');
  lines.push('Only state facts supported by the provided evidence. Label uncertain inferences as speculation.');
  lines.push('');
  lines.push(`Event URI: ${context.eventUri}`);
  lines.push(`Event ID: ${context.eventId}`);
  if (context.name) lines.push(`Event name: ${context.name}`);
  lines.push(`Instructions: ${context.summary.instructionCount}`);
  lines.push(`High-confidence references: ${context.summary.highConfidenceReferences}`);
  lines.push(`Uncertain references: ${context.summary.uncertainReferences}`);
  lines.push(`Unknown numeric arguments: ${context.summary.unknownNumericArguments}`);
  lines.push('');
  lines.push(context.evidenceMarkdown);
  return lines.join('\n');
}

function confidenceRank(value: ReferenceEdge['confidence']): number {
  if (value === 'high') return 3;
  if (value === 'medium') return 2;
  return 1;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated by SoulForge context budget]`;
}
