import type { Diagnostic, EventSymbol, ReferenceEdge, TextEntrySymbol } from '@soulforge/shared';
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

export interface TextAiContext {
  kind: 'text_explanation_context';
  textUri: string;
  textId: number;
  category?: string;
  text: string;
  summary: {
    inboundReferences: number;
    highConfidenceReferences: number;
    uncertainReferences: number;
  };
  inboundReferences: Array<{
    fromUri: string;
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
      evidence: edge.evidence.map(renderEvidenceItem)
    })),
    evidenceMarkdown: markdown,
    diagnostics
  };
}

export function buildTextAiContext(entry: TextEntrySymbol, references: readonly ReferenceEdge[], budget: AiContextBudget = {}): TextAiContext {
  const maxReferences = budget.maxReferences ?? 80;
  const maxMarkdownChars = budget.maxMarkdownChars ?? 24_000;
  const sortedReferences = [...references]
    .sort((a, b) => confidenceRank(b.confidence) - confidenceRank(a.confidence))
    .slice(0, maxReferences);

  const diagnostics: Diagnostic[] = [];
  if (references.length > maxReferences) {
    diagnostics.push({
      severity: 'info',
      code: 'AI_CONTEXT_TEXT_REFERENCES_TRUNCATED',
      message: `Text entry has ${references.length} inbound references; only ${maxReferences} are included in AI context.`,
      sourceUri: entry.uri
    });
  }

  const context: TextAiContext = {
    kind: 'text_explanation_context',
    textUri: entry.uri,
    textId: entry.textId,
    ...(entry.category ? { category: entry.category } : {}),
    text: entry.text,
    summary: {
      inboundReferences: references.length,
      highConfidenceReferences: references.filter((edge) => edge.confidence === 'high').length,
      uncertainReferences: references.filter((edge) => edge.confidence !== 'high').length
    },
    inboundReferences: sortedReferences.map((edge) => ({
      fromUri: edge.fromUri,
      kind: edge.kind,
      confidence: edge.confidence,
      reason: edge.reason,
      evidence: edge.evidence.map(renderEvidenceItem)
    })),
    evidenceMarkdown: '',
    diagnostics
  };

  return { ...context, evidenceMarkdown: truncate(renderTextEvidenceMarkdown(context), maxMarkdownChars) };
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

export function renderTextAiPrompt(context: TextAiContext): string {
  const lines: string[] = [];
  lines.push('You are explaining a FromSoftware text entry from SoulForge evidence.');
  lines.push('Only state facts supported by the provided evidence. Label uncertain inferences as speculation.');
  lines.push('');
  lines.push(`Text URI: ${context.textUri}`);
  lines.push(`Text ID: ${context.textId}`);
  if (context.category) lines.push(`Category: ${context.category}`);
  lines.push(`Inbound references: ${context.summary.inboundReferences}`);
  lines.push(`High-confidence references: ${context.summary.highConfidenceReferences}`);
  lines.push(`Uncertain references: ${context.summary.uncertainReferences}`);
  lines.push('');
  lines.push(context.evidenceMarkdown);
  return lines.join('\n');
}

function renderTextEvidenceMarkdown(context: TextAiContext): string {
  const lines: string[] = [];
  lines.push(`# Text ${context.textId}`);
  lines.push('');
  if (context.category) lines.push(`Category: ${context.category}`);
  lines.push(`URI: ${context.textUri}`);
  lines.push('');
  lines.push('## Text');
  lines.push('');
  lines.push(context.text.length > 0 ? context.text : '[empty text]');
  lines.push('');
  lines.push('## Inbound references');
  if (context.inboundReferences.length === 0) {
    lines.push('No inbound references were found in the current evidence graph.');
  } else {
    for (const reference of context.inboundReferences) {
      lines.push(`- ${reference.confidence.toUpperCase()} ${reference.kind} from ${reference.fromUri}: ${reference.reason}`);
      for (const evidence of reference.evidence.slice(0, 3)) {
        lines.push(`  - ${evidence}`);
      }
    }
  }
  return lines.join('\n');
}

function renderEvidenceItem(item: ReferenceEdge['evidence'][number]): string {
  return item.excerpt ?? `${item.sourceUri}:${String(item.value ?? '')}`;
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
