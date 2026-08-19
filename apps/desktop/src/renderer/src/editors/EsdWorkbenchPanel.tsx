/**
 * BEHAVIOR-55B：Behavior 工作台（§10.3）。
 *
 * 三栏：`Files / Machines / States | Conditions / Commands | Inspector`。
 *
 * ── 层级 ──
 *
 * 机器（状态组）→ 状态 → 转移/条件/动作。数据源是 BEHAVIOR-55A 的 read-esd-document
 * envelope（EsdDocument），经 projectEsdDocumentPages 投影出 states / conditions /
 * transitions 三页，renderer 不维护第二套 native parser。
 *
 * ── 不按 action 目录分类 ──
 *
 * 左栏列的是状态组（machine），不是磁盘 action 目录；右栏是 conditions/commands，
 * 不为凑四栏造 Tools 空栏（§10.3）。
 *
 * ── authority 语义 ──
 *
 * unknown layout 由 authority 表达：RPN 字节码不解码登记在 unparsedGaps、声明量与
 * 实解析量不符登记在 coverageShortfalls，任一非空都会把 authority 压到 partial。
 * partial 时 Inspector 必须把 coverageShortfalls / unparsedGaps / transitionGraph
 * 闭合性暴露给用户，不能把「读出来了」伪装成「完整解析」。
 *
 * ── 转移选择 ──
 *
 * 条件行就是转移载体（每条 condition 携带源状态/目标状态偏移）；选中条件行，
 * Inspector 显示该转移的明细。§10.3 的列名是 Conditions / Commands，不另开
 * Transitions 组。
 *
 * ── 55C 转移目标编辑 ──
 *
 * 选中条件后 Inspector 出现「重定向目标偏移」编辑入口，提交
 * behavior-transition-upsert 能力族下的 set-transition-target（字节级外科替换
 * 条件记录的 targetStateOffset；-1 清空转移）。RPN 参数体永久不解码，evaluator
 * 行只显示「未解码」只读标注，不给字节码假编辑。成功（ok=true）后面板自身经
 * read-esd-document 重读并覆盖 props.data 显示新 envelope；失败显示结构化诊断
 * + 回滚提示，不清空已读内容。提交期间禁用重复提交。
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  isEsdDocument,
  projectEsdDocumentPages,
  type EsdConditionSampleWire,
  type EsdDocument
} from '@soulforge/shared';
import { isRowTabEntry, selectableRowAttributes } from '../a11y/selectableRow.js';
import { WorkbenchLayout } from '../workbench/WorkbenchLayout.js';
import { getRendererBridge } from '../runtime/rendererRuntime.js';

/** 55C 写回所需的 bridge 表面（按用即取，测试可注入桩；不依赖完整 preload 类型）。 */
export interface EsdTransitionEditBridge {
  commitEsdTransition?: (
    sourceUri: string,
    expectedDocumentHash: string,
    mutations: Array<{
      mutation: string;
      stateRelOffset?: number;
      conditionRelOffset?: number;
      targetStateRelOffset?: number;
    }>
  ) => Promise<{ ok?: boolean; diagnostics?: Array<{ code?: string; message?: string }> }>;
  readEsdDocument?: (sourceUri: string) => Promise<unknown>;
}

/** 一条 set-transition-target 写回 mutation（wire 形状与 preload commitEsdTransition 一致）。 */
export interface EsdTransitionMutationWire {
  mutation: string;
  stateRelOffset: number;
  conditionRelOffset: number;
  targetStateRelOffset: number;
}

export interface EsdTransitionEditInput {
  bridge: EsdTransitionEditBridge | null;
  resourceUri: string;
  document: EsdDocument;
  sample: EsdConditionSampleWire;
  targetStateRelOffset: number;
}

export interface EsdTransitionEditOutcome {
  ok: boolean;
  mutation?: EsdTransitionMutationWire;
  diagnostics: Array<{ code?: string; message?: string }>;
  /** ok=true 且重读成功时携带新 envelope；失败/未重读时为 null。 */
  refreshed?: EsdDocument | null;
}

/** 解析用户输入的目标偏移：0x 前缀按十六进制，其余按十进制；-1 表示清空转移。 */
export function parseEsdTargetOffset(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = /^0x/i.test(trimmed)
    ? Number.parseInt(trimmed.slice(2), 16)
    : Number(trimmed);
  return Number.isInteger(value) ? value : null;
}

/**
 * 提交一条 ESD 状态转移重定向（behavior-transition-upsert 能力族下的
 * set-transition-target）。成功（ok=true）后立即经 read-esd-document 重读，
 * 让 Inspector 显示写回后的新 envelope；失败返回结构化诊断，不吞异常。
 *
 * relOffset 定位全部取自读信封：sourceStateRelOffset → stateRelOffset、
 * conditionRelOffset → conditionRelOffset，编辑后的目标偏移 → targetStateRelOffset；
 * expectedDocumentHash 取 document.sourceHash（读时快照，防并发漂移）。
 */
export async function submitEsdTransitionEdit(
  input: EsdTransitionEditInput
): Promise<EsdTransitionEditOutcome> {
  const { bridge, resourceUri, document, sample, targetStateRelOffset } = input;
  if (!bridge?.commitEsdTransition) {
    return {
      ok: false,
      diagnostics: [{ code: 'ESD_WRITE_UNAVAILABLE', message: '桌面桥接能力缺失，无法提交 ESD 状态转移。' }],
      refreshed: null
    };
  }
  const mutation: EsdTransitionMutationWire = {
    // C# EsdNativeWriter 只接受 set-transition-target（behavior-transition-upsert
    // 能力族里的转移重定向 mutation）；RPN 参数体相关的 set-command-arg 恒被
    // C# 侧 fail-closed 拒绝，这里从不构造。
    mutation: 'set-transition-target',
    stateRelOffset: sample.sourceStateRelOffset,
    conditionRelOffset: sample.conditionRelOffset,
    targetStateRelOffset
  };
  try {
    const raw = await bridge.commitEsdTransition(resourceUri, document.sourceHash, [mutation]);
    const result = raw as { ok?: boolean; diagnostics?: Array<{ code?: string; message?: string }> };
    if (!result.ok) {
      return { ok: false, mutation, diagnostics: result.diagnostics ?? [], refreshed: null };
    }
    // ok=true → 重读。面板是 props 驱动（App 传 data），写回经 Patch Engine 落盘后
    // 只有面板自己再发 read-esd-document 才能拿到新 envelope。
    let refreshed: EsdDocument | null = null;
    if (bridge.readEsdDocument) {
      const reread = await bridge.readEsdDocument(resourceUri) as { ok?: boolean; data?: unknown };
      if (reread.ok && isEsdDocument(reread.data)) refreshed = reread.data;
    }
    return { ok: true, mutation, diagnostics: result.diagnostics ?? [], refreshed };
  } catch (error) {
    return {
      ok: false,
      mutation,
      diagnostics: [{
        code: 'ESD_TRANSITION_WRITE_EXCEPTION',
        message: error instanceof Error ? error.message : 'ESD 状态转移写入异常。'
      }],
      refreshed: null
    };
  }
}

export interface EsdWorkbenchPanelProps {
  resourceUri: string;
  data: EsdDocument | null;
}

type EsdSelectionKind = 'file' | 'machine' | 'condition' | 'command';

interface EsdSelection {
  kind: EsdSelectionKind;
  id: string;
  label: string;
  /** 选中条件/命令所属的状态组（sourceGroupId），驱动中栏过滤。 */
  machineGroupId?: number;
  /** 选中条件的条件记录偏移（稳定 identity）。 */
  conditionOffset?: number;
  /** 选中命令在 commandCalls.samples 全数组里的索引。 */
  commandIndex?: number;
}

/** 文件显示名：取 sourceUri 的 basename。 */
function fileLabel(resourceUri: string): string {
  const base = resourceUri.split(/[/\\]/).pop() ?? resourceUri;
  return base || resourceUri;
}

export function EsdWorkbenchPanel(props: EsdWorkbenchPanelProps): ReactElement {
  const [selected, setSelected] = useState<EsdSelection | null>(null);

  // ── 55C 转移目标编辑状态 ──
  const [targetOffsetText, setTargetOffsetText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitNotice, setSubmitNotice] = useState<string | null>(null);
  // 写回成功后的重读结果：面板 props 驱动，重读只能由面板自身发 bridge 读，
  // 用 (refreshedUri, refreshedDocument) 按文件归位，避免跨文件串数据。
  const [refreshedDocument, setRefreshedDocument] = useState<EsdDocument | null>(null);
  const [refreshedUri, setRefreshedUri] = useState<string | null>(null);

  const document = useMemo(() => {
    const candidate = refreshedUri === props.resourceUri && refreshedDocument
      ? refreshedDocument
      : props.data;
    return candidate && isEsdDocument(candidate) ? candidate : null;
  }, [props.data, props.resourceUri, refreshedDocument, refreshedUri]);
  const pages = useMemo(
    () => (document ? projectEsdDocumentPages(document) : null),
    [document]
  );

  const states = pages?.states;
  const conditions = pages?.conditions;
  const transitions = pages?.transitions;
  const stateGroups = states?.stateGroups ?? [];
  const conditionSamples: EsdConditionSampleWire[] = conditions?.samples ?? [];
  const commandSamples = document?.commandCalls.samples ?? [];

  // 未选机器时条件/命令按全部展示；选中后按机器过滤（machine → state → condition）。
  const activeMachine = selected?.kind === 'machine' || selected?.kind === 'condition' || selected?.kind === 'command'
    ? (selected?.machineGroupId ?? null)
    : null;

  // 状态组 / 条件 / 命令全部渲染，栏本身 overflow-y:auto，不做条数上限。
  const visibleStateGroups = stateGroups;
  const visibleConditions = conditionSamples
    .filter((sample) => activeMachine === null || sample.sourceGroupId === activeMachine);
  const visibleCommands = commandSamples
    .map((sample, index) => ({ sample, index }))
    .filter(({ sample }) => activeMachine === null || sample.sourceGroupId === activeMachine);

  const authority = document?.authority;
  const isPartial = authority === 'partial';
  const gapCount = document?.unparsedGaps.length ?? 0;
  const shortfallCount = document?.coverageShortfalls.length ?? 0;
  const graphClosed = transitions?.closed ?? false;
  const visibleGaps = document?.unparsedGaps ?? [];
  const visibleShortfalls = document?.coverageShortfalls ?? [];

  // ── 55C 编辑状态：换文件/换选中条件时归位 ──
  // 换文件丢弃上一份文件的重读结果与提交状态（props 驱动，不改 App）。
  useEffect(() => {
    setRefreshedDocument(null);
    setRefreshedUri(null);
    setSubmitError(null);
    setSubmitNotice(null);
    setTargetOffsetText('');
  }, [props.resourceUri]);

  // 换选中条件时预填当前目标偏移（十六进制），并清掉上一轮提交状态。
  useEffect(() => {
    setSubmitError(null);
    setSubmitNotice(null);
    if (selected?.kind !== 'condition') {
      setTargetOffsetText('');
      return;
    }
    const sample = conditionSamples.find((item) => item.conditionRelOffset === selected.conditionOffset);
    if (!sample) return;
    setTargetOffsetText(
      sample.targetStateRelOffset >= 0
        ? `0x${sample.targetStateRelOffset.toString(16)}`
        : '-1'
    );
    // conditionRelOffset 是稳定 identity，document 重读后不随条件变化重填。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  const selectedConditionSample: EsdConditionSampleWire | null =
    selected?.kind === 'condition'
      ? conditionSamples.find((item) => item.conditionRelOffset === selected.conditionOffset) ?? null
      : null;
  const parsedTarget = selectedConditionSample && targetOffsetText.trim() !== ''
    ? parseEsdTargetOffset(targetOffsetText)
    : null;
  const targetOffsetError = selectedConditionSample && targetOffsetText.trim() !== ''
    ? (parsedTarget === null ? '目标偏移必须是整数（0x 前缀按十六进制；-1 清空转移）。' : null)
    : null;
  const canSubmit = selectedConditionSample !== null
    && parsedTarget !== null
    && targetOffsetError === null
    && !submitting;

  const handleSubmitTransition = useCallback(async () => {
    if (!document || !selectedConditionSample || parsedTarget === null) return;
    if (submitting) return; // 提交期间禁用重复提交。
    setSubmitting(true);
    setSubmitError(null);
    setSubmitNotice(null);
    try {
      const outcome = await submitEsdTransitionEdit({
        bridge: getRendererBridge(),
        resourceUri: props.resourceUri,
        document,
        sample: selectedConditionSample,
        targetStateRelOffset: parsedTarget
      });
      if (outcome.ok) {
        if (outcome.refreshed) {
          setRefreshedDocument(outcome.refreshed);
          setRefreshedUri(props.resourceUri);
        }
        setSubmitNotice(
          outcome.refreshed
            ? '已提交转移目标并重读验证。'
            : '已提交转移目标；重读未成功，界面仍显示写回前数据。'
        );
      } else {
        const detail = outcome.diagnostics.map((d) => d.message).filter(Boolean).join('；');
        setSubmitError(
          `${detail || 'ESD 状态转移写入被拒绝。'}（写回失败可经 History & Recovery 回滚，已读内容保留。）`
        );
      }
    } finally {
      setSubmitting(false);
    }
  }, [document, selectedConditionSample, parsedTarget, submitting, props.resourceUri]);

  function selectMachine(groupId: number): void {
    setSelected({
      kind: 'machine',
      id: `machine-${groupId}`,
      label: `状态组 ${groupId}`,
      machineGroupId: groupId
    });
  }

  function selectFile(): void {
    setSelected({ kind: 'file', id: 'file', label: fileLabel(props.resourceUri) });
  }

  function selectCondition(sample: EsdConditionSampleWire): void {
    setSelected({
      kind: 'condition',
      id: `cond-${sample.conditionRelOffset}`,
      label: `条件 @0x${sample.conditionRelOffset.toString(16)}`,
      machineGroupId: sample.sourceGroupId,
      conditionOffset: sample.conditionRelOffset
    });
  }

  function selectCommand(index: number): void {
    const sample = commandSamples[index];
    if (!sample) return;
    setSelected({
      kind: 'command',
      id: `cmd-${index}`,
      label: `命令 ${sample.commandId}`,
      machineGroupId: sample.sourceGroupId,
      commandIndex: index
    });
  }

  /** Inspector 内容（按选中项）。 */
  function inspectorRows(): Array<readonly [string, string]> {
    if (selected?.kind === 'condition') {
      const sample = conditionSamples.find(
        (item) => item.conditionRelOffset === selected.conditionOffset
      );
      if (!sample) return [['条件', '—']];
      return [
        ['条件偏移', `0x${sample.conditionRelOffset.toString(16)}`],
        ['源状态组', String(sample.sourceGroupId)],
        ['源状态偏移', `0x${sample.sourceStateRelOffset.toString(16)}`],
        ['目标状态偏移', sample.targetStateRelOffset >= 0
          ? `0x${sample.targetStateRelOffset.toString(16)}`
          : '—（不跳转）'],
        ['子条件数', String(sample.subConditionCount)],
        ['evaluator 长度', `${sample.evaluatorLength} 字节（未解码）`],
        ['pass 命令数', String(sample.passCommandCount)]
      ];
    }
    if (selected?.kind === 'command') {
      const sample = selected.commandIndex === undefined
        ? undefined
        : commandSamples[selected.commandIndex];
      if (!sample) return [['命令', '—']];
      return [
        ['命令 ID', String(sample.commandId)],
        ['槽位', sample.slot],
        ['bank', String(sample.bank)],
        ['参数数', String(sample.argCount)],
        ['源状态组', String(sample.sourceGroupId)]
      ];
    }
    if (selected?.kind === 'machine') {
      const group = stateGroups.find((item) => item.groupId === selected.machineGroupId);
      return [
        ['状态组 ID', String(group?.groupId ?? selected.machineGroupId ?? '—')],
        ['语义状态数', String(group?.stateCount ?? '—')],
        ['声明状态组数', String(document?.declaredStateGroupCount ?? '—')],
        ['已解析状态数', String(document?.parsedStateCount ?? '—')],
        ['转移边总数', String(transitions?.edgeCount ?? 0)],
        ['已解析转移', String(transitions?.resolved ?? 0)],
        ['不跳转', String(transitions?.none ?? 0)],
        ['哨兵目标', String(transitions?.sentinel ?? 0)],
        ['悬空目标', String(transitions?.dangling ?? 0)],
        ['跳转图闭合', transitions?.closed ? '是' : '否']
      ];
    }
    // file / 未选中：文件级统计。
    return [
      ['格式', document?.format ?? 'ESD'],
      ['版本', String(document?.version ?? '—')],
      ['状态组数', String(states?.stateGroupCount ?? 0)],
      ['语义状态数', String(states?.stateCount ?? 0)],
      ['物理状态记录', String(states?.stateRecordCount ?? 0)],
      ['声明条件数', String(conditions?.declaredConditionCount ?? 0)],
      ['已解析条件数', String(conditions?.parsedConditionCount ?? 0)],
      ['命令调用（声明）', String(document?.declaredCommandCallCount ?? 0)],
      ['命令调用（已解析）', String(document?.parsedCommandCallCount ?? 0)],
      ['coverageComplete', document?.coverageComplete ? '是' : '否'],
      ['authority', authority ?? '—']
    ];
  }

  const selectedMachineRow = selected?.kind === 'machine'
    ? stateGroups.find((item) => item.groupId === selected.machineGroupId)
    : null;

  return (
    <WorkbenchLayout
      label="Behavior 工作台"
      columns={[
        {
          id: 'files-machines-states',
          title: 'Files / Machines / States',
          hint: `${states?.stateGroupCount ?? 0} machines · ${states?.stateCount ?? 0} states`,
          initialFlex: 0.28,
          minWidth: 200,
          children: (
            <div className="wb-list">
              {document === null ? (
                <p className="wb-empty">选择 .esd 文件以查看状态机数据。</p>
              ) : (
                <>
                  <div className="wb-list__group-label">Files</div>
                  <div
                    className="wb-row"
                    {...selectableRowAttributes({
                      selected: selected?.kind === 'file',
                      isTabEntry: isRowTabEntry(0, selected !== null),
                      onSelect: selectFile
                    })}
                  >
                    <span className="wb-row__name">{fileLabel(props.resourceUri)}</span>
                  </div>
                  <div className="wb-list__group-label">Machines</div>
                  {visibleStateGroups.map((group) => (
                    <div
                      key={group.groupId}
                      className="wb-row"
                      {...selectableRowAttributes({
                        selected: selected?.kind === 'machine' && selected.machineGroupId === group.groupId,
                        isTabEntry: false,
                        onSelect: () => selectMachine(group.groupId)
                      })}
                    >
                      <span className="wb-row__name">状态组 {group.groupId}</span>
                      <span className="wb-row__meta">{group.stateCount} 状态</span>
                    </div>
                  ))}
                  <div className="wb-list__group-label">States</div>
                  {selectedMachineRow ? (
                    <div className="wb-row">
                      <span className="wb-row__name">状态组 {selectedMachineRow.groupId} 的状态</span>
                      <span className="wb-row__meta">{selectedMachineRow.stateCount} 语义状态</span>
                    </div>
                  ) : (
                    <>
                      <div className="wb-row">
                        <span className="wb-row__name">全部语义状态</span>
                        <span className="wb-row__meta">{states?.stateCount ?? 0}</span>
                      </div>
                      <div className="wb-row">
                        <span className="wb-row__name">物理状态记录</span>
                        <span className="wb-row__meta">{states?.stateRecordCount ?? 0}</span>
                      </div>
                      {states && states.stateSentinelModelConsistent === false && (
                        <p className="wb-empty diag-error" data-testid="esd-sentinel-divergence">
                          哨兵模型不一致：组 {states.stateSentinelDivergentGroupIds.join(', ') || '—'}
                        </p>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          )
        },
        {
          id: 'conditions-commands',
          title: 'Conditions / Commands',
          hint: `${conditionSamples.length} conds · ${commandSamples.length} cmds`,
          initialFlex: 0.32,
          minWidth: 220,
          children: (
            <div className="wb-list">
              {document === null && <p className="wb-empty">先选择 .esd 文件。</p>}
              {document !== null && (
                <>
                  <div className="wb-list__group-label">Conditions（转移载体）</div>
                  {activeMachine !== null && (
                    <p className="muted" style={{ fontSize: 11 }}>
                      已按状态组 {activeMachine} 过滤
                    </p>
                  )}
                  {visibleConditions.map((sample) => (
                    <div
                      key={sample.conditionRelOffset}
                      className="wb-row"
                      {...selectableRowAttributes({
                        selected: selected?.kind === 'condition' && selected.id === `cond-${sample.conditionRelOffset}`,
                        isTabEntry: false,
                        onSelect: () => selectCondition(sample)
                      })}
                    >
                      <span className="wb-row__name">条件 @0x{sample.conditionRelOffset.toString(16)}</span>
                      <span className="wb-row__meta">
                        {sample.targetStateRelOffset >= 0
                          ? `→ 0x${sample.targetStateRelOffset.toString(16)}`
                          : '不跳转'}
                      </span>
                    </div>
                  ))}
                  {visibleConditions.length === 0 && (
                    <p className="wb-empty">没有可显示的条件样本。</p>
                  )}
                  <div className="wb-list__group-label">Commands</div>
                  {visibleCommands.map(({ sample, index }) => (
                    <div
                      key={`${sample.sourceGroupId}-${sample.slot}-${sample.commandId}-${index}`}
                      className="wb-row"
                      {...selectableRowAttributes({
                        selected: selected?.kind === 'command' && selected.commandIndex === index,
                        isTabEntry: false,
                        onSelect: () => selectCommand(index)
                      })}
                    >
                      <span className="wb-row__name">命令 {sample.commandId}</span>
                      <span className="wb-row__meta">{sample.slot} · {sample.argCount} 参数</span>
                    </div>
                  ))}
                  {visibleCommands.length === 0 && (
                    <p className="wb-empty">没有可显示的命令调用。</p>
                  )}
                </>
              )}
            </div>
          )
        },
        {
          id: 'inspector',
          title: 'Inspector',
          ...(selected ? { hint: selected.label } : {}),
          initialFlex: 0.4,
          minWidth: 260,
          children: (
            <div className="wb-list">
              {document === null && <p className="wb-empty">选择 .esd 文件后查看详情。</p>}
              {document !== null && (
                <>
                  <div className="wb-list__group-label">
                    {selected ? selected.label : '文件统计'}
                  </div>
                  <div className="wb-props">
                    {inspectorRows().map(([name, value]) => (
                      <div key={name} className="wb-prop">
                        <span className="wb-prop__name">{name}</span>
                        <span className="wb-prop__value wb-prop__value--readonly">{value}</span>
                      </div>
                    ))}
                  </div>
                  {isPartial && (gapCount > 0 || shortfallCount > 0 || graphClosed === false) && (
                    <details className="esd-partial" data-testid="esd-partial-gaps">
                      <summary>
                        authority={authority}
                        {gapCount > 0 ? ` · 未解析区间 ${gapCount} 项` : ''}
                        {shortfallCount > 0 ? ` · 覆盖率缺口 ${shortfallCount} 项` : ''}
                        {graphClosed === false ? ' · 跳转图未闭合' : ''}
                      </summary>
                      <ul>
                        {visibleShortfalls.map((shortfall, index) => (
                          <li key={`sf-${index}`} className="muted">{shortfall}</li>
                        ))}
                        {visibleGaps.map((gap, index) => (
                          <li key={`gap-${index}`} className="muted">{gap}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                  <div className="wb-list__group-label">写回（transition upsert）</div>
                  {selectedConditionSample ? (
                    <div data-testid="esd-transition-edit">
                      <div className="wb-prop">
                        <span className="wb-prop__name">重定向目标偏移</span>
                        <span className="wb-prop__value">
                          <input
                            type="text"
                            inputMode="numeric"
                            aria-label="重定向目标偏移"
                            value={targetOffsetText}
                            disabled={submitting}
                            onChange={(e) => {
                              setTargetOffsetText(e.target.value);
                              setSubmitNotice(null);
                            }}
                          />
                        </span>
                      </div>
                      <p className="muted" style={{ fontSize: 11 }}>
                        修改该条件的跳转目标；0x 前缀按十六进制，-1 清空转移。RPN 参数体永久不解码，不做假编辑。
                      </p>
                      {targetOffsetError && (
                        <p className="wb-empty diag-error" data-testid="esd-transition-edit-error">{targetOffsetError}</p>
                      )}
                      {submitError && (
                        <p className="wb-empty diag-error" data-testid="esd-transition-submit-error">{submitError}</p>
                      )}
                      {submitNotice && (
                        <p className="wb-empty" data-testid="esd-transition-submit-notice">{submitNotice}</p>
                      )}
                      <button
                        type="button"
                        className="primary-action"
                        disabled={!canSubmit}
                        onClick={() => { void handleSubmitTransition(); }}
                      >
                        {submitting ? '提交中…' : '提交转移目标'}
                      </button>
                    </div>
                  ) : (
                    <p className="wb-empty">
                      选中一条条件后，此处出现「重定向目标偏移」编辑入口（BEHAVIOR-55C transition upsert）；RPN 参数体永久不解码，不做假编辑。
                    </p>
                  )}
                </>
              )}
            </div>
          )
        }
      ]}
    />
  );
}
