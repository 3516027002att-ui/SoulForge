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
 */

import { useMemo, useState, type ReactElement } from 'react';
import {
  isEsdDocument,
  projectEsdDocumentPages,
  type EsdConditionSampleWire,
  type EsdDocument
} from '@soulforge/shared';
import { formatListTruncation } from '../format/uiText.js';
import { isRowTabEntry, selectableRowAttributes } from '../a11y/selectableRow.js';
import { WorkbenchLayout } from '../workbench/WorkbenchLayout.js';

/** 状态组表渲染上限（上游数据截断；列表本身由布局栏滚动承载）。 */
const STATE_GROUP_RENDER_LIMIT = 200;
/** 条件样本渲染上限。 */
const CONDITION_RENDER_LIMIT = 200;
/** 命令调用样本渲染上限。 */
const COMMAND_RENDER_LIMIT = 200;

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

  const document = useMemo(
    () => (props.data && isEsdDocument(props.data) ? props.data : null),
    [props.data]
  );
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

  const visibleStateGroups = stateGroups.slice(0, STATE_GROUP_RENDER_LIMIT);
  const stateGroupTruncation = formatListTruncation({
    total: stateGroups.length,
    shown: visibleStateGroups.length,
    noun: '个状态组'
  });

  const visibleConditions = conditionSamples
    .filter((sample) => activeMachine === null || sample.sourceGroupId === activeMachine)
    .slice(0, CONDITION_RENDER_LIMIT);
  const filteredConditionCount = conditionSamples
    .filter((sample) => activeMachine === null || sample.sourceGroupId === activeMachine)
    .length;
  const conditionsTruncation = formatListTruncation({
    total: filteredConditionCount,
    shown: visibleConditions.length,
    noun: '个条件'
  });

  const visibleCommands = commandSamples
    .map((sample, index) => ({ sample, index }))
    .filter(({ sample }) => activeMachine === null || sample.sourceGroupId === activeMachine)
    .slice(0, COMMAND_RENDER_LIMIT);
  const filteredCommandCount = commandSamples
    .filter((sample) => activeMachine === null || sample.sourceGroupId === activeMachine)
    .length;
  const commandsTruncation = formatListTruncation({
    total: filteredCommandCount,
    shown: visibleCommands.length,
    noun: '个命令调用'
  });

  const authority = document?.authority;
  const isPartial = authority === 'partial';
  const gapCount = document?.unparsedGaps.length ?? 0;
  const shortfallCount = document?.coverageShortfalls.length ?? 0;
  const graphClosed = transitions?.closed ?? false;
  const visibleGaps = (document?.unparsedGaps ?? []).slice(0, 8);
  const visibleShortfalls = (document?.coverageShortfalls ?? []).slice(0, 8);

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
                  {stateGroupTruncation && (
                    <p className="muted" data-testid="esd-truncation">{stateGroupTruncation}</p>
                  )}
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
                  {conditionsTruncation && (
                    <p className="muted" data-testid="esd-conditions-truncation">{conditionsTruncation}</p>
                  )}
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
                  {commandsTruncation && (
                    <p className="muted" data-testid="esd-commands-truncation">{commandsTruncation}</p>
                  )}
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
                  <div className="wb-list__group-label">写回</div>
                  <p className="wb-empty">
                    ESD 写回链尚未接通（BEHAVIOR-55C），当前为只读工作台；转移/条件/命令不可编辑。
                  </p>
                </>
              )}
            </div>
          )
        }
      ]}
      toolbar={
        <>
          <span className="crumb">Behavior · {fileLabel(props.resourceUri)}</span>
          {document && (
            <span className="muted" style={{ fontSize: 11 }}>
              {states?.stateCount ?? 0} states · {conditionSamples.length} conds · {authority}
            </span>
          )}
        </>
      }
    />
  );
}
