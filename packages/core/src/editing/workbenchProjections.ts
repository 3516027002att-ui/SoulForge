/**
 * Renderer-safe projections for patch impact, jobs, history and diagnostics.
 * Core-only — no DOM, no absolute path leakage into labels.
 */

import type { PatchIR, PatchHistoryEntry, StructuredDiagnostic } from '@soulforge/shared';
import type { PatchImpactGraph } from '../patch/patchImpactGraph.js';
import { buildPatchImpactGraph } from '../patch/patchImpactGraph.js';
import type { QueuedTask, TaskStatus } from '../jobs/taskQueue.js';
import type { MemoryResourceGraph } from '../resource-graph/memoryResourceGraph.js';

export interface JobListItem {
  id: string;
  title: string;
  status: TaskStatus;
  progressCurrent: number;
  progressTotal?: number;
  progressMessage?: string;
  createdAt: number;
  error?: string;
}

export interface HistoryListItem {
  opId: string;
  status: string;
  mode: string;
  summary: string;
  createdAt: string;
  fileCount: number;
  canRollback: boolean;
}

export interface DiagnosticsListItem {
  severity: string;
  code: string;
  message: string;
  resourceUri?: string;
}

export interface PatchImpactView {
  patchId: string;
  changedResources: string[];
  directReferenceImpact: string[];
  reverseReferenceImpact: string[];
  validatorsToRun: string[];
  candidateRiskCount: number;
  confirmedEdgeCount: number;
  reindexTargets: string[];
  diagnostics: DiagnosticsListItem[];
}

export function projectJobs(tasks: Array<QueuedTask<unknown>>): JobListItem[] {
  return tasks.map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    progressCurrent: task.progress.current,
    ...(task.progress.total !== undefined ? { progressTotal: task.progress.total } : {}),
    ...(task.progress.message ? { progressMessage: task.progress.message } : {}),
    createdAt: task.createdAt,
    ...(task.error ? { error: task.error } : {})
  }));
}

export function projectHistory(
  entries: PatchHistoryEntry[],
  options?: { limit?: number }
): HistoryListItem[] {
  const limit = options?.limit ?? 50;
  return entries.slice(0, limit).map((entry) => ({
    opId: entry.opId,
    status: entry.status,
    mode: entry.mode,
    summary: entry.title || entry.graphSummary?.title || '（无摘要）',
    createdAt: entry.createdAt,
    fileCount: entry.fileCount ?? entry.changedPaths?.length ?? 0,
    canRollback: entry.status === 'committed'
  }));
}

export function projectPatchImpact(
  patch: PatchIR,
  graph?: MemoryResourceGraph
): PatchImpactView {
  const impact: PatchImpactGraph = buildPatchImpactGraph(patch, graph);
  return {
    patchId: impact.patchId,
    changedResources: impact.changedResources,
    directReferenceImpact: impact.directReferenceImpact,
    reverseReferenceImpact: impact.reverseReferenceImpact,
    validatorsToRun: impact.validatorsToRun,
    candidateRiskCount: impact.candidateRiskEdges.length,
    confirmedEdgeCount: impact.confirmedEdges.length,
    reindexTargets: impact.reindexTargets,
    diagnostics: impact.diagnostics.map(projectDiagnostic)
  };
}

export function projectDiagnostics(
  diagnostics: StructuredDiagnostic[],
  options?: { limit?: number }
): DiagnosticsListItem[] {
  const limit = options?.limit ?? 100;
  return diagnostics.slice(0, limit).map(projectDiagnostic);
}

function projectDiagnostic(d: StructuredDiagnostic): DiagnosticsListItem {
  return {
    severity: d.severity,
    code: String(d.code),
    message: d.message,
    ...(d.targetUri
      ? { resourceUri: d.targetUri }
      : d.sourceUri
        ? { resourceUri: d.sourceUri }
        : {})
  };
}
