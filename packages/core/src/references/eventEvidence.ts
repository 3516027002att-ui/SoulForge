import type { EventSymbol, ReferenceEdge } from '@soulforge/shared';

export interface EventEvidenceReport {
  eventUri: string;
  eventId: number;
  name?: string;
  confirmed: EvidenceLine[];
  possible: EvidenceLine[];
  unknownArguments: UnknownArgument[];
  diagnostics: string[];
}

export interface EvidenceLine {
  targetUri: string;
  kind: ReferenceEdge['kind'];
  confidence: ReferenceEdge['confidence'];
  reason: string;
  evidence: string[];
}

export interface UnknownArgument {
  instructionUri: string;
  instructionName?: string;
  argName?: string;
  value: string | number | boolean;
}

export function collectEventEvidence(event: EventSymbol, edges: ReferenceEdge[]): EventEvidenceReport {
  const eventEdges = edges.filter((edge) => edge.fromUri === event.uri);
  const confirmed = eventEdges
    .filter((edge) => edge.confidence === 'high')
    .map(edgeToEvidenceLine);
  const possible = eventEdges
    .filter((edge) => edge.confidence === 'medium' || edge.confidence === 'low')
    .map(edgeToEvidenceLine);

  const knownEvidenceValues = new Set(
    eventEdges.flatMap((edge) => edge.evidence.map((evidence) => `${evidence.instructionUri ?? evidence.sourceUri}:${String(evidence.value ?? '')}`))
  );

  const unknownArguments: UnknownArgument[] = [];

  for (const instruction of event.instructions) {
    for (const arg of instruction.args) {
      const isNumeric = typeof arg.value === 'number' || (typeof arg.value === 'string' && /^-?\d+$/.test(arg.value.trim()));
      if (!isNumeric) continue;
      const evidenceKey = `${instruction.uri}:${String(arg.value)}`;
      if (knownEvidenceValues.has(evidenceKey)) continue;
      unknownArguments.push({
        instructionUri: instruction.uri,
        ...(instruction.name ? { instructionName: instruction.name } : {}),
        ...(arg.name ? { argName: arg.name } : {}),
        value: arg.value
      });
    }
  }

  return {
    eventUri: event.uri,
    eventId: event.eventId,
    ...(event.name ? { name: event.name } : {}),
    confirmed,
    possible,
    unknownArguments,
    diagnostics: buildDiagnostics(confirmed, possible, unknownArguments)
  };
}

export function renderEventEvidenceMarkdown(report: EventEvidenceReport): string {
  const lines: string[] = [];
  lines.push(`# Event ${report.eventId}${report.name ? ` — ${report.name}` : ''}`);
  lines.push('');

  lines.push('## Confirmed facts');
  if (report.confirmed.length === 0) {
    lines.push('- No high-confidence references were found.');
  } else {
    for (const item of report.confirmed) {
      lines.push(`- ${item.kind}: ${item.targetUri}`);
      lines.push(`  - reason: ${item.reason}`);
      for (const evidence of item.evidence) lines.push(`  - evidence: ${evidence}`);
    }
  }
  lines.push('');

  lines.push('## Possible references');
  if (report.possible.length === 0) {
    lines.push('- No medium/low-confidence references were found.');
  } else {
    for (const item of report.possible) {
      lines.push(`- [${item.confidence}] ${item.kind}: ${item.targetUri}`);
      lines.push(`  - reason: ${item.reason}`);
    }
  }
  lines.push('');

  lines.push('## Unknown numeric arguments');
  if (report.unknownArguments.length === 0) {
    lines.push('- No unknown numeric arguments remain.');
  } else {
    for (const arg of report.unknownArguments.slice(0, 80)) {
      const label = arg.argName ? `${arg.argName}=` : '';
      lines.push(`- ${arg.instructionName ?? 'instruction'} (${arg.instructionUri}): ${label}${String(arg.value)}`);
    }
    if (report.unknownArguments.length > 80) {
      lines.push(`- ... ${report.unknownArguments.length - 80} more omitted`);
    }
  }

  return lines.join('\n');
}

function edgeToEvidenceLine(edge: ReferenceEdge): EvidenceLine {
  return {
    targetUri: edge.toUri,
    kind: edge.kind,
    confidence: edge.confidence,
    reason: edge.reason,
    evidence: edge.evidence.map((item) => item.excerpt ?? `${item.sourceUri}:${String(item.value ?? '')}`)
  };
}

function buildDiagnostics(confirmed: EvidenceLine[], possible: EvidenceLine[], unknownArguments: UnknownArgument[]): string[] {
  const diagnostics: string[] = [];
  if (confirmed.length === 0) diagnostics.push('No high-confidence references. Event explanation must be conservative.');
  if (possible.length > confirmed.length * 3 && possible.length > 10) diagnostics.push('Many uncertain references. Numeric fallback may be noisy.');
  if (unknownArguments.length > 0) diagnostics.push(`${unknownArguments.length} numeric arguments remain unresolved.`);
  return diagnostics;
}
