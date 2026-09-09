import { createHash } from 'node:crypto';
import type {
  EventHandle,
  InstructionHandle,
  ParameterBinding
} from '@soulforge/shared';
import {
  validateEventHandle,
  eventHandleKey,
  validateInstructionHandle,
  instructionHandleKey,
  validateParameterBinding
} from '@soulforge/shared';
import type { EmevdEditorDocument } from '@soulforge/shared';
import { decodeStrictBase64 } from '../util/base64.js';

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface SimulationInstruction {
  readonly handle: InstructionHandle;
  bank: number;
  id: number;
  args: Buffer;
  unknown: boolean;
  layerOffset?: number | undefined;
}

export interface SimulationParameter {
  readonly binding: ParameterBinding;
  targetInstructionHandleId: string;
  targetByteOffset: number;
  byteCount: number;
  sourceStartByte: number;
  unkId: number;
}

export interface SimulationEvent {
  readonly handle: EventHandle;
  currentId: string;
  restBehavior: number;
  instructions: SimulationInstruction[];
  parameters: SimulationParameter[];
}

export interface RelocationEntry {
  finalEventLocalOrdinal: number;
  finalGlobalOrdinal: number;
}

export interface ParameterRelocationEntry {
  finalInstructionIndex: number;
  targetByteOffset: number;
  byteCount: number;
  sourceStartByte: number;
  unkId: number;
}

export interface CompiledSimulationPlan {
  readonly events: Array<{
    eventId: number;
    restBehavior: number;
    instructions: Array<{ bank: number; id: number; args: Buffer; unknown: boolean; layerOffset?: number | undefined }>;
    parameters: Array<{ instructionIndex: number; targetStartByte: number; sourceStartByte: number; byteCount: number; unkId: number }>;
  }>;
  readonly eventIdMap: Map<string, number>;
  readonly instructionRelocationMap: Map<string, RelocationEntry>;
  readonly parameterRelocationMap: Map<string, ParameterRelocationEntry>;
  readonly bridgePatches: Array<Record<string, unknown>>;
  readonly stringBytes?: Buffer | undefined;
  readonly totalInstructions: number;
  readonly totalParameters: number;
}


export interface SimulationOracleSnapshot {
  eventCount: number;
  totalInstructions: number;
  totalParameters: number;
  events: Array<{
    id: number;
    restBehavior: number;
    instructionCount: number;
    parameterCount: number;
    instructionHashes: string[];
    parameters: Array<{ instructionIndex: number; targetStartByte: number; byteCount: number }>;
  }>;
}

/**
 * 纯模拟器 (EmevdMutationSimulator)
 * 依据 SF-09 §2.4.2 顺序模拟与符号重定位
 */
export class EmevdMutationSimulator {
  private readonly fileUri: string;
  private readonly sourceVersion: number | string;
  private readonly events: SimulationEvent[] = [];
  private stringBytes?: Buffer;
  private nextInstructionSeq = 1;
  private nextBindingSeq = 1;

  constructor(fileUri: string, sourceVersion: number | string = 1) {
    this.fileUri = fileUri;
    this.sourceVersion = sourceVersion;
  }

  public static fromDocument(doc: EmevdEditorDocument): EmevdMutationSimulator {
    const sim = new EmevdMutationSimulator(doc.resourceUri, doc.revision);
    for (let eIdx = 0; eIdx < doc.events.length; eIdx++) {
      const e = doc.events[eIdx]!;
      const eventHandle: EventHandle = {
        fileUri: doc.resourceUri,
        eventId: String(e.eventId),
        sourceVersion: doc.revision
      };
      validateEventHandle(eventHandle);

      const instructions: SimulationInstruction[] = [];
      for (let iIdx = 0; iIdx < e.instructions.length; iIdx++) {
        const instr = e.instructions[iIdx]!;
        let rawArgs: Buffer;
        try {
          rawArgs = decodeStrictBase64(instr.argsBase64, { allowEmpty: true });
        } catch {
          rawArgs = Buffer.alloc(0);
        }
        const instrHash = sha256Hex(Buffer.concat([
          Buffer.from(instr.bank + ':' + instr.id + ':'),
          rawArgs
        ]));
        const instrHandle: InstructionHandle = {
          eventHandleKey: eventHandleKey(eventHandle),
          localOrdinal: iIdx,
          instructionHash: instrHash,
          sourceVersion: doc.revision,
          id: eventHandleKey(eventHandle) + '::inst:' + iIdx + '::' + instrHash.slice(0, 16)
        };
        validateInstructionHandle(instrHandle);
        instructions.push({
          handle: instrHandle,
          bank: instr.bank,
          id: instr.id,
          args: rawArgs,
          unknown: instr.unknown ?? false
        });
      }

      sim.events.push({
        handle: eventHandle,
        currentId: String(e.eventId),
        restBehavior: e.restBehavior,
        instructions,
        parameters: []
      });
    }
    return sim;
  }

  public static fromEvents(
    fileUri: string,
    sourceVersion: number | string,
    rawEvents: Array<{
      id: number | string;
      restBehavior: number;
      instructions: Array<{ bank: number; id: number; args: Buffer; unknown?: boolean; layerOffset?: number }>;
      parameters?: Array<{ instructionIndex: number; targetStartByte: number; sourceStartByte: number; byteCount: number; unkId?: number }>;
    }>
  ): EmevdMutationSimulator {
    const sim = new EmevdMutationSimulator(fileUri, sourceVersion);
    for (let eIdx = 0; eIdx < rawEvents.length; eIdx++) {
      const e = rawEvents[eIdx]!;
      const eventHandle: EventHandle = {
        fileUri,
        eventId: String(e.id),
        sourceVersion
      };
      validateEventHandle(eventHandle);

      const instructions: SimulationInstruction[] = [];
      for (let iIdx = 0; iIdx < e.instructions.length; iIdx++) {
        const instr = e.instructions[iIdx]!;
        const instrHash = sha256Hex(Buffer.concat([
          Buffer.from(instr.bank + ':' + instr.id + ':'),
          instr.args
        ]));
        const instrHandle: InstructionHandle = {
          eventHandleKey: eventHandleKey(eventHandle),
          localOrdinal: iIdx,
          instructionHash: instrHash,
          sourceVersion,
          id: eventHandleKey(eventHandle) + '::inst:' + iIdx + '::' + instrHash.slice(0, 16)
        };
        validateInstructionHandle(instrHandle);
        instructions.push({
          handle: instrHandle,
          bank: instr.bank,
          id: instr.id,
          args: instr.args,
          unknown: instr.unknown ?? false,
          layerOffset: instr.layerOffset
        });
      }

      const parameters: SimulationParameter[] = [];
      for (let pIdx = 0; pIdx < (e.parameters?.length ?? 0); pIdx++) {
        const p = e.parameters![pIdx]!;
        const targetInstr = instructions[p.instructionIndex];
        if (!targetInstr) {
          throw new Error('EMEVD 参数[' + pIdx + ']引用的指令序号 ' + p.instructionIndex + ' 越界。');
        }
        const bindingId = 'param_' + (sim.nextBindingSeq++);
        const binding: ParameterBinding = {
          id: bindingId,
          eventHandleKey: eventHandleKey(eventHandle),
          targetInstructionHandleId: targetInstr.handle.id,
          targetByteOffset: p.targetStartByte,
          byteCount: p.byteCount,
          sourceStartByte: p.sourceStartByte,
          unkId: p.unkId ?? 0
        };
        validateParameterBinding(binding);
        parameters.push({
          binding,
          targetInstructionHandleId: targetInstr.handle.id,
          targetByteOffset: p.targetStartByte,
          byteCount: p.byteCount,
          sourceStartByte: p.sourceStartByte,
          unkId: p.unkId ?? 0
        });
      }

      sim.events.push({
        handle: eventHandle,
        currentId: String(e.id),
        restBehavior: e.restBehavior,
        instructions,
        parameters
      });
    }
    return sim;
  }

  public getEvents(): readonly SimulationEvent[] {
    return this.events;
  }

  public findEvent(eventHandleKeyOrId: string): SimulationEvent | undefined {
    return this.events.find(
      (e) => eventHandleKey(e.handle) === eventHandleKeyOrId || e.currentId === eventHandleKeyOrId
    );
  }

  /**
   * 顺序重命名单个事件
   * 规则：rename A→B，撞当前命名空间时直接拒绝（“普通顺序 rename 撞当前命名空间时拒绝”）
   */
  public renameEvent(eventHandleKeyOrId: string, newId: string | number): void {
    const idStr = String(newId);
    this.assertSafeEventId(idStr);

    const event = this.findEvent(eventHandleKeyOrId);
    if (!event) {
      throw new Error('EMEVD 事件 ' + eventHandleKeyOrId + ' 不存在。');
    }

    if (event.currentId === idStr) return;

    // 碰撞检测：当前活跃事件中若已有其他事件使用此 ID，则拒绝
    const collision = this.events.find((e) => e !== event && e.currentId === idStr);
    if (collision) {
      throw new Error('EMEVD 事件 ID 冲突：' + idStr + ' 已存在（命名空间碰撞）。');
    }

    event.currentId = idStr;
  }

  /**
   * 批次同时重命名 (batch rename)
   * 规则：具有“同时命名语义”，允许原子交换 A 和 B；验证最终命名映射唯一，不允许多个存活事件撞同 ID。
   */
  public batchRenameEvents(renames: Array<{ eventHandleKeyOrId: string; newId: string | number }>): void {
    if (renames.length === 0) return;

    const matchedEvents: Array<{ event: SimulationEvent; newIdStr: string }> = [];
    const seenEvents = new Set<SimulationEvent>();

    for (const item of renames) {
      const idStr = String(item.newId);
      this.assertSafeEventId(idStr);
      const ev = this.findEvent(item.eventHandleKeyOrId);
      if (!ev) {
        throw new Error('EMEVD 批重命名找不到事件：' + item.eventHandleKeyOrId + '。');
      }
      if (seenEvents.has(ev)) {
        throw new Error('EMEVD 批重命名在同批次中对同一事件重复命名：' + item.eventHandleKeyOrId + '。');
      }
      seenEvents.add(ev);
      matchedEvents.push({ event: ev, newIdStr: idStr });
    }

    // 验证同时重命名后全体事件的唯一性
    const targetIds = new Set<string>();
    for (const ev of this.events) {
      const override = matchedEvents.find((m) => m.event === ev);
      const finalId = override ? override.newIdStr : ev.currentId;
      if (targetIds.has(finalId)) {
        throw new Error('EMEVD 批重命名导致目标事件 ID 碰撞：' + finalId + '。');
      }
      targetIds.add(finalId);
    }

    // 原子同时应用
    for (const { event, newIdStr } of matchedEvents) {
      event.currentId = newIdStr;
    }
  }

  /**
   * 插入指令
   * 规则：在事件内指定位置插入新指令；有序 InstructionHandle 列表更新；
   * 参数绑定继续指向原有 InstructionHandle，其 targetByteOffset 严格不变！
   */
  public insertInstruction(
    eventHandleKeyOrId: string,
    atIndex: number,
    instruction: { bank: number; id: number; args: Buffer; unknown?: boolean; layerOffset?: number }
  ): InstructionHandle {
    const event = this.findEvent(eventHandleKeyOrId);
    if (!event) throw new Error('EMEVD 事件 ' + eventHandleKeyOrId + ' 不存在。');

    if (!Number.isSafeInteger(atIndex) || atIndex < 0 || atIndex > event.instructions.length) {
      throw new Error('EMEVD 插入指令位置越界：' + atIndex + ' (当前指令数: ' + event.instructions.length + ')。');
    }

    const instrHash = sha256Hex(Buffer.concat([
      Buffer.from(instruction.bank + ':' + instruction.id + ':'),
      instruction.args
    ]));
    const handleId = eventHandleKey(event.handle) + '::inst:new_' + (this.nextInstructionSeq++) + '::' + instrHash.slice(0, 16);
    const handle: InstructionHandle = {
      eventHandleKey: eventHandleKey(event.handle),
      localOrdinal: atIndex,
      instructionHash: instrHash,
      sourceVersion: this.sourceVersion,
      id: handleId
    };
    validateInstructionHandle(handle);

    const simInstr: SimulationInstruction = {
      handle,
      bank: instruction.bank,
      id: instruction.id,
      args: instruction.args,
      unknown: instruction.unknown ?? false,
      layerOffset: instruction.layerOffset
    };

    event.instructions.splice(atIndex, 0, simInstr);
    return handle;
  }

  /**
   * 删除指令
   * 规则：删除被参数绑定引用的指令默认拒绝，除非同计划包含明确的 binding 删除/重定向。
   */
  public deleteInstruction(
    eventHandleKeyOrId: string,
    instructionHandleId: string,
    options?: { allowReferenced?: boolean }
  ): void {
    const event = this.findEvent(eventHandleKeyOrId);
    if (!event) throw new Error('EMEVD 事件 ' + eventHandleKeyOrId + ' 不存在。');

    const idx = event.instructions.findIndex((i) => i.handle.id === instructionHandleId);
    if (idx < 0) {
      throw new Error('EMEVD 事件内找不到要删除的指令句柄：' + instructionHandleId + '。');
    }

    // 检查参数绑定引用
    if (!options?.allowReferenced) {
      const referenced = event.parameters.some((p) => p.targetInstructionHandleId === instructionHandleId);
      if (referenced) {
        throw new Error(
          'EMEVD_REFERENCED_INSTRUCTION_DELETE_REJECTED: 指令 ' + instructionHandleId + ' 仍被事件参数绑定引用，拒绝直接删除。'
        );
      }
    }

    event.instructions.splice(idx, 1);
  }

  /**
   * 修改指令参数
   * 规则：涉及 opaque / unknown 节点的参数修改，在无 profile 时拒绝。
   */
  public modifyInstructionArgs(instructionHandleId: string, newArgs: Buffer): void {
    let target: SimulationInstruction | undefined;
    for (const ev of this.events) {
      target = ev.instructions.find((i) => i.handle.id === instructionHandleId);
      if (target) break;
    }
    if (!target) {
      throw new Error('EMEVD 找不到指令句柄：' + instructionHandleId + '。');
    }

    if (target.unknown) {
      throw new Error(
        'EMEVD_UNKNOWN_INSTRUCTION_MODIFICATION_REJECTED: 指令为 unknown / opaque 节点，拒绝修改参数。'
      );
    }

    target.args = Buffer.from(newArgs);
  }

  /**
   * 添加参数绑定
   */
  public addParameterBinding(
    eventHandleKeyOrId: string,
    param: {
      targetInstructionHandleId: string;
      targetByteOffset: number;
      byteCount: number;
      sourceStartByte: number;
      unkId?: number;
    }
  ): ParameterBinding {
    const event = this.findEvent(eventHandleKeyOrId);
    if (!event) throw new Error('EMEVD 事件 ' + eventHandleKeyOrId + ' 不存在。');

    const targetExists = event.instructions.some((i) => i.handle.id === param.targetInstructionHandleId);
    if (!targetExists) {
      throw new Error('EMEVD 参数绑定指定的目标指令不存在：' + param.targetInstructionHandleId + '。');
    }

    const bindingId = 'param_' + (this.nextBindingSeq++);
    const binding: ParameterBinding = {
      id: bindingId,
      eventHandleKey: eventHandleKey(event.handle),
      targetInstructionHandleId: param.targetInstructionHandleId,
      targetByteOffset: param.targetByteOffset,
      byteCount: param.byteCount,
      sourceStartByte: param.sourceStartByte,
      unkId: param.unkId ?? 0
    };
    validateParameterBinding(binding);

    event.parameters.push({
      binding,
      targetInstructionHandleId: param.targetInstructionHandleId,
      targetByteOffset: param.targetByteOffset,
      byteCount: param.byteCount,
      sourceStartByte: param.sourceStartByte,
      unkId: param.unkId ?? 0
    });
    return binding;
  }

  /**
   * 删除参数绑定
   */
  public removeParameterBinding(eventHandleKeyOrId: string, bindingId: string): void {
    const event = this.findEvent(eventHandleKeyOrId);
    if (!event) throw new Error('EMEVD 事件 ' + eventHandleKeyOrId + ' 不存在。');
    const idx = event.parameters.findIndex((p) => p.binding.id === bindingId);
    if (idx < 0) throw new Error('EMEVD 找不到参数绑定：' + bindingId + '。');
    event.parameters.splice(idx, 1);
  }

  /**
   * 重设事件参数绑定
   */
  public setEventParameters(eventHandleKeyOrId: string, bindings: ParameterBinding[]): void {
    const event = this.findEvent(eventHandleKeyOrId);
    if (!event) throw new Error('EMEVD 事件 ' + eventHandleKeyOrId + ' 不存在。');
    for (const b of bindings) {
      validateParameterBinding(b);
      const exists = event.instructions.some((i) => i.handle.id === b.targetInstructionHandleId);
      if (!exists) {
        throw new Error('EMEVD 参数绑定目标指令句柄不存在：' + b.targetInstructionHandleId + '。');
      }
    }
    event.parameters = bindings.map((b) => ({
      binding: b,
      targetInstructionHandleId: b.targetInstructionHandleId,
      targetByteOffset: b.targetByteOffset,
      byteCount: b.byteCount,
      sourceStartByte: b.sourceStartByte,
      unkId: b.unkId
    }));
  }

  /**
   * 添加事件
   */
  public addEvent(
    eventId: string | number,
    restBehavior = 0,
    instructions: Array<{ bank: number; id: number; args: Buffer; unknown?: boolean; layerOffset?: number }> = []
  ): EventHandle {
    const idStr = String(eventId);
    this.assertSafeEventId(idStr);

    if (this.events.some((e) => e.currentId === idStr)) {
      throw new Error('EMEVD 事件 ID ' + idStr + ' 已存在。');
    }

    const eventHandle: EventHandle = {
      fileUri: this.fileUri,
      eventId: idStr,
      sourceVersion: this.sourceVersion
    };
    validateEventHandle(eventHandle);

    const simInstrs: SimulationInstruction[] = [];
    for (let i = 0; i < instructions.length; i++) {
      const instr = instructions[i]!;
      const instrHash = sha256Hex(Buffer.concat([
        Buffer.from(instr.bank + ':' + instr.id + ':'),
        instr.args
      ]));
      const handle: InstructionHandle = {
        eventHandleKey: eventHandleKey(eventHandle),
        localOrdinal: i,
        instructionHash: instrHash,
        sourceVersion: this.sourceVersion,
        id: eventHandleKey(eventHandle) + '::inst:new_' + (this.nextInstructionSeq++) + '::' + instrHash.slice(0, 16)
      };
      validateInstructionHandle(handle);
      simInstrs.push({
        handle,
        bank: instr.bank,
        id: instr.id,
        args: instr.args,
        unknown: instr.unknown ?? false,
        layerOffset: instr.layerOffset
      });
    }

    this.events.push({
      handle: eventHandle,
      currentId: idStr,
      restBehavior,
      instructions: simInstrs,
      parameters: []
    });
    return eventHandle;
  }

  /**
   * 删除事件
   */
  public deleteEvent(eventHandleKeyOrId: string): void {
    const idx = this.events.findIndex(
      (e) => eventHandleKey(e.handle) === eventHandleKeyOrId || e.currentId === eventHandleKeyOrId
    );
    if (idx < 0) throw new Error('EMEVD 事件 ' + eventHandleKeyOrId + ' 不存在。');
    if (this.events.length <= 1) {
      throw new Error('不能删除 EMEVD 中的最后一个事件。');
    }
    this.events.splice(idx, 1);
  }

  public setEventRestBehavior(eventHandleKeyOrId: string, restBehavior: number): void {
    if (!Number.isSafeInteger(restBehavior) || restBehavior < 0 || restBehavior > 255) {
      throw new Error('EMEVD restBehavior 必须在 uint32 / uint8 安全范围内，收到 ' + restBehavior + '。');
    }
    const event = this.findEvent(eventHandleKeyOrId);
    if (!event) throw new Error('EMEVD 事件 ' + eventHandleKeyOrId + ' 不存在。');
    event.restBehavior = restBehavior;
  }

  public setStrings(bytes: Buffer): void {
    this.stringBytes = Buffer.from(bytes);
  }

  /**
   * 编译模拟结果为最终 IR、重定位表及 Bridge 补丁
   * 严格按照最终事件与指令顺序计算：
   * - eventHandle → 最终 event ID
   * - instructionHandle → 最终 event-local ordinal
   * - instructionHandle → 文件全局 ordinal
   * - parameterBinding → 最终目标索引与字节范围
   */
  public compile(): CompiledSimulationPlan {
    const finalEventMap = new Map<string, number>();
    const instructionRelocationMap = new Map<string, RelocationEntry>();
    const parameterRelocationMap = new Map<string, ParameterRelocationEntry>();

    // 1. 验证事件 ID 唯一性
    const seenIds = new Set<number>();
    for (const ev of this.events) {
      const numId = Number(ev.currentId);
      if (!Number.isSafeInteger(numId) || numId < 0) {
        throw new Error('EMEVD 编译事件 ID 非法：' + ev.currentId + '。');
      }
      if (seenIds.has(numId)) {
        throw new Error('EMEVD 编译发现重复的事件 ID：' + numId + '。');
      }
      seenIds.add(numId);
      finalEventMap.set(eventHandleKey(ev.handle), numId);
    }

    // 2. 构建指令与参数重定位
    let globalOrdinal = 0;
    const compiledEvents: CompiledSimulationPlan['events'] = [];

    for (const ev of this.events) {
      const finalEventId = finalEventMap.get(eventHandleKey(ev.handle))!;
      const compiledInstrs: CompiledSimulationPlan['events'][number]['instructions'] = [];

      for (let localOrdinal = 0; localOrdinal < ev.instructions.length; localOrdinal++) {
        const instr = ev.instructions[localOrdinal]!;
        instructionRelocationMap.set(instr.handle.id, {
          finalEventLocalOrdinal: localOrdinal,
          finalGlobalOrdinal: globalOrdinal
        });
        compiledInstrs.push({
          bank: instr.bank,
          id: instr.id,
          args: instr.args,
          unknown: instr.unknown,
          layerOffset: instr.layerOffset
        });
        globalOrdinal++;
      }

      // 重定位参数
      const compiledParams: CompiledSimulationPlan['events'][number]['parameters'] = [];
      for (const p of ev.parameters) {
        const targetReloc = instructionRelocationMap.get(p.targetInstructionHandleId);
        if (!targetReloc) {
          throw new Error(
            'EMEVD 参数绑定目标指令丢失（可能被删除）：' + p.targetInstructionHandleId + '。'
          );
        }
        const targetLocalOrdinal = targetReloc.finalEventLocalOrdinal;
        const targetInstr = ev.instructions[targetLocalOrdinal]!;

        // 验证参数字节范围在目标指令内有效
        if (p.targetByteOffset + p.byteCount > targetInstr.args.length) {
          throw new Error(
            'EMEVD 参数绑定字节越界：offset ' + p.targetByteOffset + ' + width ' + p.byteCount + ' > target args length ' + targetInstr.args.length + '。'
          );
        }

        parameterRelocationMap.set(p.binding.id, {
          finalInstructionIndex: targetLocalOrdinal,
          targetByteOffset: p.targetByteOffset,
          byteCount: p.byteCount,
          sourceStartByte: p.sourceStartByte,
          unkId: p.unkId
        });

        compiledParams.push({
          instructionIndex: targetLocalOrdinal,
          targetStartByte: p.targetByteOffset,
          sourceStartByte: p.sourceStartByte,
          byteCount: p.byteCount,
          unkId: p.unkId
        });
      }

      compiledEvents.push({
        eventId: finalEventId,
        restBehavior: ev.restBehavior,
        instructions: compiledInstrs,
        parameters: compiledParams
      });
    }

    // 3. 构建 Bridge 补丁包
    const bridgePatches = this.buildBridgePatches(compiledEvents);

    const totalInstructions = globalOrdinal;
    const totalParameters = compiledEvents.reduce((acc, e) => acc + e.parameters.length, 0);

    return {
      events: compiledEvents,
      eventIdMap: finalEventMap,
      instructionRelocationMap,
      parameterRelocationMap,
      bridgePatches,
      stringBytes: this.stringBytes,
      totalInstructions,
      totalParameters
    };
  }

  /**
   * 生成独立的结构 / IR Oracle 快照，供单元与 native 测试对照
   */
  public captureOracleSnapshot(): SimulationOracleSnapshot {
    const compiled = this.compile();
    return {
      eventCount: compiled.events.length,
      totalInstructions: compiled.totalInstructions,
      totalParameters: compiled.totalParameters,
      events: compiled.events.map((e) => ({
        id: e.eventId,
        restBehavior: e.restBehavior,
        instructionCount: e.instructions.length,
        parameterCount: e.parameters.length,
        instructionHashes: e.instructions.map((i) =>
          sha256Hex(Buffer.concat([Buffer.from(i.bank + ':' + i.id + ':'), i.args]))
        ),
        parameters: e.parameters.map((p) => ({
          instructionIndex: p.instructionIndex,
          targetStartByte: p.targetStartByte,
          byteCount: p.byteCount
        }))
      }))
    };
  }

  private buildBridgePatches(
    compiledEvents: CompiledSimulationPlan['events']
  ): Array<Record<string, unknown>> {
    const patches: Array<Record<string, unknown>> = [];

    for (const ev of compiledEvents) {
      if (ev.parameters.length > 0) {
        patches.push({
          kind: 'set_event_parameters',
          eventId: ev.eventId,
          parameters: ev.parameters.map((p) => ({
            instructionIndex: p.instructionIndex,
            targetStartByte: p.targetStartByte,
            sourceStartByte: p.sourceStartByte,
            byteCount: p.byteCount,
            unkId: p.unkId
          }))
        });
      }
    }

    if (this.stringBytes) {
      patches.push({
        kind: 'set_strings',
        stringsBase64: this.stringBytes.toString('base64')
      });
    }

    return patches;
  }

  private assertSafeEventId(idStr: string): void {
    if (!/^\d{1,16}$/.test(idStr)) {
      throw new Error('EMEVD 事件 ID 格式非法（必须是安全数字字符串）：' + idStr + '。');
    }
    const num = Number(idStr);
    if (!Number.isSafeInteger(num) || num < 0) {
      throw new Error('EMEVD_INTEGER_OUT_OF_SAFE_RANGE: 事件 ID ' + idStr + ' 超出安全整数范围。');
    }
  }
}
