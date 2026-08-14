/**
 * AGENT-60C §12.11 资源引用草稿的 renderer 侧纯逻辑。
 *
 * 职责（不依赖 DOM / IPC，可单测）：
 *  - AgentResourceReferenceDraftState：Composer 上方「资源引用」块的本地草稿；
 *  - reduceAgentResourceReferenceDraft：create-requested / create-succeeded /
 *    create-failed / remove 的状态迁移（token 去重、§12.11 上限 16）；
 *  - createResourceReferenceFlow：把「触发 → bridge.createAgentResourceReference
 *    (selection) → 把结果写进草稿」的编排做成纯 async，组件与测试共用同一入口。
 *
 * 安全边界（§19.5 / §12.11）：renderer 不伪造 token、不提交路径 —— 只把 §12.8
 * 语义选区交给 main；main 做 root 校验与白名单（绝对路径 / raw parser / Hex dump
 * 拒绝），签发的 opaque token 不携带路径。本模块只消费 main 返回的
 * AgentResourceReference，不触碰 token 内容。
 */
import type { AgentResourceReference, EditorSelectionContext } from '@soulforge/shared';
import type { SoulForgeApi } from '../../../preload/index.js';

/** §12.11：resources 最多 16 个（SubmitAgentRunRequest 的 decoder 上限）。 */
export const AGENT_RESOURCE_REFERENCE_MAX = 16;

export interface AgentResourceReferenceDraftState {
  /** 当前草稿已添加的 opaque 资源引用（token 不进入 DOM，只作 key / 去重依据）。 */
  readonly resources: readonly AgentResourceReference[];
  /** 正在向 main 申请 opaque token（防止重复提交）。 */
  readonly creating: boolean;
  /** 最近一次创建失败的结构化诊断（main 返回值；null = 无）。 */
  readonly error: string | null;
}

/** 初始草稿。initial 来自 props.resources（既有受控入口），其余字段为诚实空态。 */
export function createInitialResourceReferenceDraft(
  initial: readonly AgentResourceReference[] = []
): AgentResourceReferenceDraftState {
  return { resources: [...initial], creating: false, error: null };
}

export type AgentResourceReferenceDraftEvent =
  | { type: 'create-requested' }
  | { type: 'create-succeeded'; reference: AgentResourceReference }
  | { type: 'create-failed'; message: string }
  | { type: 'remove'; token: string };

export function reduceAgentResourceReferenceDraft(
  state: AgentResourceReferenceDraftState,
  event: AgentResourceReferenceDraftEvent
): AgentResourceReferenceDraftState {
  switch (event.type) {
    case 'create-requested':
      // 重试时清掉上一次的诊断，进入创建中（防止连点重复提交）。
      return { ...state, creating: true, error: null };
    case 'create-succeeded': {
      if (state.resources.some((ref) => ref.token === event.reference.token)) {
        // 同一选区重复引用：main 每次签发新 token，正常情况下不会撞；撞了也只去重不报错。
        return { ...state, creating: false, error: null };
      }
      if (state.resources.length >= AGENT_RESOURCE_REFERENCE_MAX) {
        return {
          ...state,
          creating: false,
          error: `资源引用最多 ${AGENT_RESOURCE_REFERENCE_MAX} 个（§12.11）。`
        };
      }
      return {
        resources: [...state.resources, event.reference],
        creating: false,
        error: null
      };
    }
    case 'create-failed':
      // 结构化诊断直接进草稿；组件把它渲染在资源引用块里，不吞异常。
      return { ...state, creating: false, error: event.message };
    case 'remove':
      return {
        ...state,
        resources: state.resources.filter((ref) => ref.token !== event.token)
      };
  }
}

/** 是否还能再添加一条资源引用（§12.11 上限 16）。 */
export function canAddResourceReference(state: AgentResourceReferenceDraftState): boolean {
  return state.resources.length < AGENT_RESOURCE_REFERENCE_MAX;
}

/** preload 的 createAgentResourceReference 签名（main 已做 root 校验与白名单）。 */
export type CreateResourceReference = SoulForgeApi['createAgentResourceReference'];

/**
 * 「触发 → 申请 → 写回草稿」的编排（组件与测试共用同一入口）。
 *
 * 先派 create-requested（防重复提交、清旧诊断），再调 bridge 向 main 申请 opaque
 * token；成功把引用写进草稿，失败（含 IPC 抛异常）写结构化诊断。renderer 永远
 * 不伪造 token、不提交路径 —— selection 原样交给 main。
 */
export async function createResourceReferenceFlow(
  create: CreateResourceReference,
  selection: EditorSelectionContext,
  dispatch: (event: AgentResourceReferenceDraftEvent) => void
): Promise<void> {
  dispatch({ type: 'create-requested' });
  let result: Awaited<ReturnType<CreateResourceReference>>;
  try {
    result = await create(selection);
  } catch (error) {
    dispatch({
      type: 'create-failed',
      message: error instanceof Error ? error.message : '创建资源引用失败。'
    });
    return;
  }
  dispatch(result.ok
    ? { type: 'create-succeeded', reference: result.reference }
    : { type: 'create-failed', message: `${result.error.code}：${result.error.message}` });
}
