/**
 * 变更控制状态机（纯逻辑，无 React/IPC 依赖，可单测）：
 *   draft（候选，待审查）→ staged（已批准，暂存）→ validating → writing → written
 *   任意非终态可 reject（已拒绝）；staged 可 undoToDraft（撤回到候选）；failed 可重新批准。
 * 写入经注入的 ChangeApplier 执行（App 提供 window.soulforge 实现），
 * hash 前置条件与重读由 applier 负责，状态机只保证转移合法。
 */

export type ChangeKind = 'text' | 'fmg' | 'param-row' | 'param-field';

export type ChangeStatus =
  | 'draft'
  | 'staged'
  | 'validating'
  | 'writing'
  | 'written'
  | 'failed'
  | 'rejected';

export interface ChangeDiagnostic {
  code: string;
  message: string;
}

export interface CandidateChange {
  /** 稳定标识：kind:sourceUri:target（同源同目标的候选会被最新编辑替换） */
  id: string;
  kind: ChangeKind;
  sourceUri: string;
  /** 人类可读目标：相对路径#记录/字段 */
  target: string;
  /** 一行摘要：字段：旧值 → 新值 */
  summary: string;
  oldValue: string;
  newValue: string;
  status: ChangeStatus;
  diagnostics: ChangeDiagnostic[];
  /** kind 专属写入载荷，由 applier 解释 */
  payload: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface ChangeControlState {
  items: CandidateChange[];
  committing: boolean;
}

export type ChangeApplier = (
  change: CandidateChange
) => Promise<{ ok: boolean; diagnostics?: ChangeDiagnostic[] }>;

export type ProposeInput = Omit<
  CandidateChange,
  'id' | 'status' | 'diagnostics' | 'createdAt' | 'updatedAt'
>;

/** 结构校验（validating 阶段）：只查状态机自身能判定的问题。 */
export function validateChange(change: CandidateChange): ChangeDiagnostic[] {
  const problems: ChangeDiagnostic[] = [];
  switch (change.kind) {
    case 'text':
      if (change.newValue.length === 0) {
        problems.push({ code: 'TEXT_EMPTY', message: '文本内容为空，拒绝写入。' });
      }
      break;
    case 'fmg': {
      const id = change.payload.id;
      if (typeof id !== 'number' || !Number.isFinite(id) || id < 0) {
        problems.push({ code: 'FMG_ID_INVALID', message: 'FMG 条目 ID 必须是非负整数。' });
      }
      const op = change.payload.op;
      if ((op === 'upsert' || op === 'add') && change.payload.text === undefined) {
        problems.push({ code: 'FMG_TEXT_MISSING', message: '新增或更新条目必须提供文本。' });
      }
      break;
    }
    case 'param-row': {
      const op = change.payload.op;
      if (op === 'upsert' && typeof change.payload.dataBase64 !== 'string') {
        problems.push({ code: 'PARAM_ROW_PAYLOAD_MISSING', message: '行更新缺少字节载荷。' });
      }
      break;
    }
    case 'param-field': {
      const value = change.payload.value;
      if (value === undefined || value === '') {
        problems.push({ code: 'PARAM_FIELD_EMPTY', message: '字段值为空。' });
      }
      const definition = change.payload.definition as
        | { displayType?: string; type?: string }
        | undefined;
      const typeHint = `${definition?.displayType ?? ''} ${definition?.type ?? ''}`.toLowerCase();
      const looksNumeric = /int|float|byte|short|long|u\d+|s\d+|f32/.test(typeHint);
      if (looksNumeric && typeof value === 'string' && !Number.isFinite(Number(value))) {
        problems.push({
          code: 'PARAM_FIELD_NOT_NUMERIC',
          message: `字段 ${change.payload.fieldId ?? ''} 定义为数值类型，值必须可解析为数字。`
        });
      }
      break;
    }
  }
  return problems;
}

const TRANSITIONS: Record<ChangeStatus, ChangeStatus[]> = {
  draft: ['staged', 'rejected'],
  staged: ['draft', 'validating', 'rejected'],
  validating: ['writing', 'failed'],
  writing: ['written', 'failed'],
  written: [],
  failed: ['staged', 'rejected', 'draft'],
  rejected: ['staged', 'draft']
};

export class ChangeControlStore {
  private state: ChangeControlState = { items: [], committing: false };
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): ChangeControlState => this.state;

  private emit(next: ChangeControlState): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  private patchItem(id: string, patch: Partial<CandidateChange>): void {
    this.emit({
      ...this.state,
      items: this.state.items.map((item) =>
        item.id === id ? { ...item, ...patch, updatedAt: Date.now() } : item
      )
    });
  }

  private transition(id: string, to: ChangeStatus, patch?: Partial<CandidateChange>): boolean {
    const item = this.state.items.find((candidate) => candidate.id === id);
    if (!item) return false;
    if (!TRANSITIONS[item.status].includes(to)) return false;
    this.patchItem(id, { status: to, ...(patch ?? {}) });
    return true;
  }

  /** 提出候选：同源同目标的 draft/staged/failed/rejected 被最新编辑替换。 */
  propose(input: ProposeInput): CandidateChange {
    const id = `${input.kind}:${input.sourceUri}:${input.target}`;
    const replaceable = new Set<ChangeStatus>(['draft', 'staged', 'failed', 'rejected']);
    const items = this.state.items.filter(
      (item) => !(item.id === id && replaceable.has(item.status))
    );
    const change: CandidateChange = {
      ...input,
      id,
      status: 'draft',
      diagnostics: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    this.emit({ ...this.state, items: [...items, change] });
    return change;
  }

  approve(id: string): boolean {
    return this.transition(id, 'staged', { diagnostics: [] });
  }

  reject(id: string): boolean {
    return this.transition(id, 'rejected');
  }

  undoToDraft(id: string): boolean {
    return this.transition(id, 'draft');
  }

  discard(id: string): void {
    this.emit({ ...this.state, items: this.state.items.filter((item) => item.id !== id) });
  }

  clearTerminal(): void {
    const terminal = new Set<ChangeStatus>(['written', 'rejected']);
    this.emit({ ...this.state, items: this.state.items.filter((item) => !terminal.has(item.status)) });
  }

  pendingDrafts(): number {
    return this.state.items.filter((item) => item.status === 'draft').length;
  }

  stagedCount(): number {
    return this.state.items.filter((item) => item.status === 'staged').length;
  }

  /** 顺序提交全部 staged：validate → apply，逐项落状态。 */
  async commitAll(apply: ChangeApplier): Promise<{ written: number; failed: number }> {
    if (this.state.committing) return { written: 0, failed: 0 };
    this.emit({ ...this.state, committing: true });
    let written = 0;
    let failed = 0;
    for (const snapshot of [...this.state.items]) {
      if (snapshot.status !== 'staged') continue;
      this.patchItem(snapshot.id, { status: 'validating', diagnostics: [] });
      const problems = validateChange(snapshot);
      if (problems.length > 0) {
        this.patchItem(snapshot.id, { status: 'failed', diagnostics: problems });
        failed += 1;
        continue;
      }
      this.patchItem(snapshot.id, { status: 'writing' });
      try {
        const result = await apply(snapshot);
        if (result.ok) {
          this.patchItem(snapshot.id, { status: 'written', diagnostics: result.diagnostics ?? [] });
          written += 1;
        } else {
          this.patchItem(snapshot.id, {
            status: 'failed',
            diagnostics: result.diagnostics?.length
              ? result.diagnostics
              : [{ code: 'APPLY_FAILED', message: '写入失败，未修改目标文件。' }]
          });
          failed += 1;
        }
      } catch (error) {
        this.patchItem(snapshot.id, {
          status: 'failed',
          diagnostics: [
            {
              code: 'APPLY_EXCEPTION',
              message: error instanceof Error ? error.message : String(error)
            }
          ]
        });
        failed += 1;
      }
    }
    this.emit({ ...this.state, committing: false });
    return { written, failed };
  }
}
