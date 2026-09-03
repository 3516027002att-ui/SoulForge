import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { ModelThinkingLevel } from '@soulforge/core';
import { describeBridgeAbsence, getRendererBridge } from '../runtime/rendererRuntime.js';
import type { SoulForgeApi } from '../../../preload/index.js';
import {
  convergeThinkingLevel,
  thinkingLevelsForProtocol,
  thinkingLevelLabel
} from '../agent/agentThinking.js';

interface ModelServiceDto {
  id: string;
  displayName: string;
  protocol: 'openai-compatible' | 'openai-responses' | 'anthropic-compatible';
  baseUrl: string;
  model: string;
  hasCredential: boolean;
  createdAt: string;
  updatedAt: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
  contextWindowTokens?: number;
  thinkingLevel?: ModelThinkingLevel;
}

/** 回环地址判据。地址串和已保存服务共用同一份，不许各写一遍正则。 */
function isLoopbackBaseUrl(baseUrl: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?([/?#]|$)/i.test(baseUrl.trim());
}

function isLoopbackService(row: ModelServiceDto): boolean {
  return isLoopbackBaseUrl(row.baseUrl);
}

/** 错误码 → 人话。原始响应体可能是整页 HTML，不能进单行状态栏。 */
const MODEL_LIST_ERROR_TEXT: Record<string, string> = {
  MODEL_SERVICE_AUTH_ERROR: 'API Key 无效或无权限（HTTP 401/403）。',
  MODEL_SERVICE_RATE_LIMITED: '被限流（HTTP 429），稍后重试。',
  MODEL_SERVICE_SERVER_ERROR: '服务端错误（HTTP 5xx）。',
  MODEL_SERVICE_HTTP_ERROR: '服务地址不对或该服务不提供模型列表（HTTP 4xx）。',
  MODEL_SERVICE_RESPONSE_PARSE_FAILED: '返回内容不是合法 JSON。',
  MODEL_SERVICE_TIMEOUT: '请求超时。',
  MODEL_SERVICE_NETWORK_ERROR: '网络不可达，检查地址与代理。',
  MODEL_SERVICE_CANCELLED: '已取消。',
  MODEL_SERVICE_REQUEST_FAILED: '请求失败。'
};

function describeModelListError(error: { code: string; message: string }): string {
  const friendly = MODEL_LIST_ERROR_TEXT[error.code] ?? '获取模型列表失败。';
  return `${friendly}（${error.code}）`;
}

/** 空串/非数字 → undefined（不随保存下发）；合法数字原样返回。 */
function parseOptionalNumber(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

/** upsertModelService 的输入类型（renderer 只走 bridge，不碰文件系统/凭据文件）。 */
type ModelServiceUpsertInput = Parameters<SoulForgeApi['upsertModelService']>[0];
type ProviderUsageSummaryDto = Awaited<ReturnType<SoulForgeApi['getProviderUsageSummary']>>;

function formatTokenCount(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}

/** 表单字段快照：debounce 触发时与卸载 flush 时从 ref 读，避免闭包抓到旧值。 */
interface FormSnapshot {
  displayName: string;
  protocol: 'openai-compatible' | 'openai-responses' | 'anthropic-compatible';
  baseUrl: string;
  model: string;
  apiKey: string;
  thinkingLevel: ModelThinkingLevel;
  contextWindowTokens: string;
  maxTokens: string;
  temperature: string;
  topP: string;
  topK: string;
}

/** 自动保存防抖间隔（输入停止后 400–600ms 再写，避免每个按键打 IPC）。 */
const AUTO_SAVE_DEBOUNCE_MS = 450;

/**
 * 模型服务设置：只展示 hasCredential，密钥仅在保存时一次性交给 main 加密。
 * 保存、删除与脱敏 DTO 契约不变；browser-preview 表面返回可见诊断。
 *
 * 2-A：思考强度锁官方 effort 表（OpenAI 全档 / Anthropic 官方表，无 budget 数字）。
 *
 * 2-E：会写入服务配置的字段（protocol/baseUrl/model/displayName/apiKey/数字/effort）
 * 做 400–600ms debounce 自动 save()：输入停止后再写，不每个按键打 IPC。
 * 硬约束：baseUrl 为空不 upsert；apiKey 为空不传（不得用 '' 覆盖已加密凭据）；
 * 校验失败（temperature 越界等）不写盘、保留 setStatus 错误；关抽屉/切走前 flush
 * 一次未写完的 debounce。成功后状态文案一行「已自动保存：<displayName>」，不模态、
 * 不 toast 刷屏。renderer 只走 bridge.upsertModelService，不碰真实绝对路径。
 */
export interface ModelServiceSettingsPanelProps {
  /** S25：页脚「取消」= 关闭设置视图（AgentSecondaryDrawer 传入）。 */
  onCancel?: () => void;
}

export function ModelServiceSettingsPanel({ onCancel }: ModelServiceSettingsPanelProps = {}): ReactElement {
  const bridge = getRendererBridge();
  const [rows, setRows] = useState<ModelServiceDto[]>([]);
  const [usageSummary, setUsageSummary] = useState<ProviderUsageSummaryDto | null>(null);
  const [encryptionOk, setEncryptionOk] = useState(false);
  const [displayName, setDisplayName] = useState('模型服务');
  const [protocol, setProtocol] = useState<'openai-compatible' | 'openai-responses' | 'anthropic-compatible'>('openai-compatible');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [status, setStatus] = useState('');

  // 高级选项（默认关闭思考强度：旧模型不支持 thinking 参数，开启会请求失败）。
  const [thinkingLevel, setThinkingLevel] = useState<ModelThinkingLevel>('off');
  const [contextWindowTokens, setContextWindowTokens] = useState('');
  const [maxTokens, setMaxTokens] = useState('');
  const [temperature, setTemperature] = useState('');
  const [topP, setTopP] = useState('');
  const [topK, setTopK] = useState('');

  // 模型列表（GET /v1/models）。
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);

  // 2-E：本表单会话已创建/更新的服务 id。自动保存与手动保存共用它，避免同一表单
  // 反复保存时在 vault 里堆出一串同内容的新配置（后续保存带 id = 更新而不是新建）。
  const savedIdRef = useRef<string | null>(null);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 最新表单值快照：debounce 触发与卸载 flush 时从这里读，闭包不抓旧 state。
  const formRef = useRef<FormSnapshot>({
    displayName: '模型服务',
    protocol: 'openai-compatible',
    baseUrl: '',
    model: '',
    apiKey: '',
    thinkingLevel: 'off',
    contextWindowTokens: '',
    maxTokens: '',
    temperature: '',
    topP: '',
    topK: ''
  });
  useEffect(() => {
    formRef.current = {
      displayName,
      protocol,
      baseUrl,
      model,
      apiKey,
      thinkingLevel,
      contextWindowTokens,
      maxTokens,
      temperature,
      topP,
      topK
    };
  });

  async function refresh(): Promise<void> {
    if (!bridge) {
      setStatus(describeBridgeAbsence('模型服务管理'));
      return;
    }
    const [list, available, usage] = await Promise.all([
      bridge.listModelServices(),
      bridge.modelServiceEncryptionAvailable(),
      bridge.getProviderUsageSummary()
    ]);
    setRows(list);
    setEncryptionOk(available);
    setUsageSummary(usage);
  }

  async function refreshUsage(): Promise<void> {
    if (!bridge) return;
    setUsageSummary(await bridge.getProviderUsageSummary());
  }

  useEffect(() => {
    void refresh().catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : '加载模型服务失败');
    });
  }, []);

  // 设置抽屉打开期间持续刷新，运行中的会话每完成一次 provider 请求后即可看到
  // 最新上下文长度；不会触发模型调用，也不读取会话正文。
  useEffect(() => {
    const timer = setInterval(() => {
      void refreshUsage().catch(() => undefined);
    }, 3_000);
    return () => clearInterval(timer);
  }, []);

  /**
   * 校验并构造 upsert 载荷。校验失败返回 null：已留下 setStatus 错误文案，不写盘。
   * apiKey 为空时不带 apiKey 字段（绝不把 '' 覆盖到已加密凭据上）。
   */
  function buildSavePayload(values: FormSnapshot): ModelServiceUpsertInput | null {
    const parsedTemperature = parseOptionalNumber(values.temperature);
    if (parsedTemperature !== undefined && (parsedTemperature < 0 || parsedTemperature > 2)) {
      setStatus('temperature 需在 0–2 之间。');
      return null;
    }
    const parsedTopP = parseOptionalNumber(values.topP);
    if (parsedTopP !== undefined && (parsedTopP < 0 || parsedTopP > 1)) {
      setStatus('topP 需在 0–1 之间。');
      return null;
    }
    const parsedTopK = parseOptionalNumber(values.topK);
    if (parsedTopK !== undefined && parsedTopK < 1) {
      setStatus('topK 需 ≥ 1。');
      return null;
    }
    const parsedMaxTokens = parseOptionalNumber(values.maxTokens);
    if (parsedMaxTokens !== undefined && parsedMaxTokens < 1) {
      setStatus('输出长度需 ≥ 1。');
      return null;
    }
    const parsedContextWindow = parseOptionalNumber(values.contextWindowTokens);
    if (parsedContextWindow !== undefined && parsedContextWindow < 1) {
      setStatus('上下文长度需 ≥ 1。');
      return null;
    }
    return {
      ...(savedIdRef.current !== null ? { id: savedIdRef.current } : {}),
      displayName: values.displayName,
      protocol: values.protocol,
      baseUrl: values.baseUrl,
      model: values.model,
      ...(values.apiKey ? { apiKey: values.apiKey } : {}),
      ...(parsedTemperature !== undefined ? { temperature: parsedTemperature } : {}),
      ...(parsedTopP !== undefined ? { topP: parsedTopP } : {}),
      ...(parsedTopK !== undefined ? { topK: parsedTopK } : {}),
      ...(parsedMaxTokens !== undefined ? { maxTokens: parsedMaxTokens } : {}),
      ...(parsedContextWindow !== undefined ? { contextWindowTokens: parsedContextWindow } : {}),
      ...(values.thinkingLevel !== 'off' ? { thinkingLevel: values.thinkingLevel } : {})
    };
  }

  async function runSave(payload: ModelServiceUpsertInput): Promise<void> {
    if (!bridge || !payload) return;
    try {
      const saved = await bridge.upsertModelService(payload);
      savedIdRef.current = saved.id;
      setStatus(`已自动保存：${saved.displayName}`);
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '自动保存失败');
    }
  }

  /** 2-E：立即 flush 一次未写完的 debounce（读最新表单快照，校验失败不写盘）。 */
  function flushAutoSave(): void {
    if (autoSaveTimerRef.current !== null) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    const values = formRef.current;
    if (values.baseUrl.trim() === '') return; // baseUrl 空不 upsert（避免存一堆空服务）。
    const payload = buildSavePayload(values);
    if (payload === null) return; // 校验失败：保留 setStatus 错误，不写盘。
    void runSave(payload);
  }

  /** 2-E：对写入配置的字段做 debounce 自动保存（输入停止 AUTO_SAVE_DEBOUNCE_MS 后再写）。 */
  function scheduleAutoSave(): void {
    if (autoSaveTimerRef.current !== null) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      autoSaveTimerRef.current = null;
      flushAutoSave();
    }, AUTO_SAVE_DEBOUNCE_MS);
  }

  // 2-E：卸载（取消 / 关抽屉 / 切视图）前 flush 一次未写完的 debounce，否则用户填完
  // 立刻关还会丢。依赖为空数组：只在这个 effect 卸载时跑，读 formRef 拿最新值。
  useEffect(() => {
    return () => {
      if (autoSaveTimerRef.current !== null) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
        const values = formRef.current;
        if (values.baseUrl.trim() === '') return;
        const payload = buildSavePayload(values);
        if (payload === null) return;
        void runSave(payload);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** S25：重置 = 表单回到初值并从 main 重读已存服务（未保存的草稿丢弃）。 */
  function reset(): void {
    if (autoSaveTimerRef.current !== null) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    savedIdRef.current = null;
    setDisplayName('模型服务');
    setProtocol('openai-compatible');
    setBaseUrl('');
    setModel('');
    setApiKey('');
    setThinkingLevel('off');
    setContextWindowTokens('');
    setMaxTokens('');
    setTemperature('');
    setTopP('');
    setTopK('');
    setModelOptions([]);
    setStatus('表单已重置。');
    void refresh().catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : '重读模型服务失败');
    });
  }

  async function fetchModels(): Promise<void> {
    if (!bridge) {
      setStatus(describeBridgeAbsence('获取模型列表'));
      return;
    }
    if (baseUrl.trim() === '') {
      setStatus('请先填写服务地址再获取模型列表。');
      return;
    }
    setFetchingModels(true);
    try {
      const result = await bridge.listModelModels({
        protocol,
        baseUrl,
        ...(apiKey ? { apiKey } : {})
      });
      if (result.ok) {
        setModelOptions(result.models.map((entry) => entry.id));
        setStatus(`找到 ${result.models.length} 个可用模型，点击列表选择，或手动输入。`);
      } else {
        setModelOptions([]);
        setStatus(`获取模型列表失败：${describeModelListError(result.error)}`);
      }
    } catch (error) {
      setModelOptions([]);
      setStatus(error instanceof Error ? error.message : '获取模型列表失败');
    } finally {
      setFetchingModels(false);
    }
  }

  /** 手动「保存」= 立即 flush（自动保存的另一触发点是防抖内的每字段改动）。 */
  async function save(): Promise<void> {
    if (!bridge) {
      setStatus(describeBridgeAbsence('保存模型服务'));
      return;
    }
    if (autoSaveTimerRef.current !== null) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    const payload = buildSavePayload(formRef.current);
    if (payload === null) return;
    try {
      const saved = await bridge.upsertModelService(payload);
      savedIdRef.current = saved.id;
      setApiKey('');
      setStatus(`已保存模型服务：${saved.displayName}（凭据=${saved.hasCredential ? '已加密' : '无'}）`);
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '保存失败');
    }
  }

  async function remove(id: string): Promise<void> {
    if (!bridge) {
      setStatus(describeBridgeAbsence('删除模型服务'));
      return;
    }
    await bridge.deleteModelService(id);
    await refresh();
    setStatus('已删除模型服务配置');
  }

  function editRow(row: ModelServiceDto): void {
    // API 密钥永不从 main 回传；编辑已有服务时保留原凭据，空密钥不会覆盖它。
    savedIdRef.current = row.id;
    setDisplayName(row.displayName);
    setProtocol(row.protocol);
    setBaseUrl(row.baseUrl);
    setModel(row.model);
    setApiKey('');
    setThinkingLevel(row.thinkingLevel ?? 'off');
    setContextWindowTokens(row.contextWindowTokens === undefined ? '' : String(row.contextWindowTokens));
    setMaxTokens(row.maxTokens === undefined ? '' : String(row.maxTokens));
    setTemperature(row.temperature === undefined ? '' : String(row.temperature));
    setTopP(row.topP === undefined ? '' : String(row.topP));
    setTopK(row.topK === undefined ? '' : String(row.topK));
    setModelOptions([]);
    setStatus(`正在编辑模型服务：${row.displayName}`);
  }

  return (
    <section className="panel" aria-label="模型服务">
      <header className="panel-header">
        <h3>模型服务</h3>
        <span className="muted">
          加密存储：{encryptionOk ? '可用（safeStorage）' : '不可用'}
        </span>
      </header>
      <section className="stack gap" aria-label="模型 token 用量">
        <div className="row gap">
          <strong>历史总用量</strong>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void refreshUsage()}>
            刷新用量
          </button>
        </div>
        {usageSummary ? (
          <>
            <p className="muted">
              provider 已报告输入 {formatTokenCount(usageSummary.totalInputTokens)} token，
              输出 {formatTokenCount(usageSummary.totalOutputTokens)} token，
              合计 {formatTokenCount(usageSummary.totalInputTokens + usageSummary.totalOutputTokens)} token；
              请求 {formatTokenCount(usageSummary.calls)} 次（返回 usage {formatTokenCount(usageSummary.reportedCalls)} 次）。
            </p>
            {usageSummary.latestSession && (
              <p className="muted">
                {usageSummary.latestSession.active ? '当前会话' : '最近会话'}上下文：
                {formatTokenCount(usageSummary.latestSession.currentContextTokens)} token
                （{usageSummary.latestSession.contextSource === 'provider' ? 'provider 报告' : '本地估算'}），
                本会话输入 {formatTokenCount(usageSummary.latestSession.totalInputTokens)} / 输出 {formatTokenCount(usageSummary.latestSession.totalOutputTokens)} token。
              </p>
            )}
          </>
        ) : (
          <p className="muted">正在读取 provider usage…</p>
        )}
      </section>
      <div className="stack gap">
        {/* S25：字段顺序照 010517 的信息结构——协议 → 地址 → 模型 → 名称 → 密钥 →
            高级 → 页脚。每个 label 独占一行（CSS 竖排），控件 100% 宽。 */}
        <label>
          协议（API 格式）
          <select
            value={protocol}
            onChange={(e) => {
              const next = e.target.value as 'openai-compatible' | 'openai-responses' | 'anthropic-compatible';
              setProtocol(next);
              // 2-A：换协议时收敛非法档（如 Anthropic 没有的 none/minimal → medium）。
              setThinkingLevel((level) => convergeThinkingLevel(level, next));
              scheduleAutoSave();
            }}
          >
            <option value="openai-compatible">Chat Completions (/chat/completions)</option>
            <option value="openai-responses">Responses (/responses)</option>
            <option value="anthropic-compatible">Anthropic Messages (/v1/messages)</option>
          </select>
        </label>
        <label>
          服务地址
          <input
            value={baseUrl}
            onChange={(e) => {
              setBaseUrl(e.target.value);
              scheduleAutoSave();
            }}
            placeholder="http://127.0.0.1:11434"
          />
        </label>
        <label>
          模型 ID
          <input
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              scheduleAutoSave();
            }}
            placeholder="gpt-4.1"
          />
        </label>
        <div className="row gap">
          <button type="button" onClick={() => void fetchModels()} disabled={fetchingModels}>
            {fetchingModels ? '获取中…' : '获取模型列表'}
          </button>
          <span className="muted">从服务 API 拉取（GET /v1/models）</span>
        </div>
        {modelOptions.length > 0 && (
          <ul className="model-pick-list" aria-label="可用模型">
            {modelOptions.map((id) => (
              <li key={id}>
                <button
                  type="button"
                  className={id === model ? 'is-selected' : undefined}
                  onClick={() => {
                    setModel(id);
                    scheduleAutoSave();
                  }}
                >
                  {id}
                </button>
              </li>
            ))}
          </ul>
        )}
        <label>
          显示名称
          <input
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value);
              scheduleAutoSave();
            }}
          />
        </label>
        <label>
          API 密钥（仅写入，不回显）
          <input
            type="password"
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              scheduleAutoSave();
            }}
            autoComplete="off"
          />
        </label>
        <details data-testid="model-service-advanced">
          <summary>高级选项</summary>
          <div className="stack gap">
            <label>
              effort（服务级默认）
              <select
                aria-label="effort"
                value={thinkingLevel}
                onChange={(e) => {
                  setThinkingLevel(e.target.value as ModelThinkingLevel);
                  scheduleAutoSave();
                }}
              >
                {thinkingLevelsForProtocol(protocol).map((level) => (
                  <option key={level} value={level}>{thinkingLevelLabel(level, protocol)}</option>
                ))}
              </select>
            </label>
            <p className="muted">
              {protocol === 'anthropic-compatible'
                ? 'Anthropic Messages: output_config.effort = low / medium / high / xhigh / max.'
                : protocol === 'openai-responses'
                  ? 'Responses: reasoning.effort = none / minimal / low / medium / high / xhigh / max（/v1/responses）。'
                  : 'Chat Completions: reasoning_effort = none / minimal / low / medium / high / xhigh / max（/v1/chat/completions）。'}
              {' '}型号是否支持某一档由服务端决定；「off」= 字段不下发。
            </p>
            <label>
              上下文长度（token）
              <input
                type="number"
                min={1}
                step={1}
                value={contextWindowTokens}
                onChange={(e) => {
                  setContextWindowTokens(e.target.value);
                  scheduleAutoSave();
                }}
                placeholder="默认 500000（500K）"
              />
            </label>
            <p className="muted">建议填写模型的实际上下文长度（如 128000、200000 或 1000000）。不填默认 500K，达到设定长度的 80% 时会自动执行上下文摘要压缩。</p>
            <label>
              输出长度（token）
              <input
                type="number"
                min={1}
                step={1}
                value={maxTokens}
                onChange={(e) => {
                  setMaxTokens(e.target.value);
                  scheduleAutoSave();
                }}
                placeholder="不填用 provider 默认"
              />
            </label>
            <label>
              temperature
              <input
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={temperature}
                onChange={(e) => {
                  setTemperature(e.target.value);
                  scheduleAutoSave();
                }}
                placeholder="0 – 2"
              />
            </label>
            <label>
              topP
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={topP}
                onChange={(e) => {
                  setTopP(e.target.value);
                  scheduleAutoSave();
                }}
                placeholder="0 – 1"
              />
            </label>
            <label>
              topK
              <input
                type="number"
                min={1}
                step={1}
                value={topK}
                onChange={(e) => {
                  setTopK(e.target.value);
                  scheduleAutoSave();
                }}
                placeholder="≥ 1"
              />
            </label>
            <p className="muted">topK 仅 Anthropic 协议生效（OpenAI 兼容协议无此参数）。</p>
            <p className="muted">
              Embedding 由 SoulForge 内部自动管理：工作区分析完成后后台增量生成向量，
              用户无需选择模型、配置 endpoint 或手工生成索引；内置模型暂不可用时自动保留词法检索。
            </p>
          </div>
        </details>
        <div className="row gap model-service-footer">
          {onCancel !== undefined && (
            <button type="button" onClick={onCancel}>取消</button>
          )}
          <button type="button" onClick={reset}>重置</button>
          <button type="button" className="btn btn--primary" onClick={() => void save()}>保存</button>
        </div>
      </div>
      <ul className="list">
        {rows.map((row) => (
          <li key={row.id}>
            <strong>{row.displayName}</strong>
            {' · '}
            {row.protocol}
            {' · '}
            {row.model}
            {' · '}
            凭据：{row.hasCredential ? '已配置' : '未配置'}
            {usageSummary?.byService.find((usage) => usage.serviceId === row.id) && (() => {
              const usage = usageSummary.byService.find((entry) => entry.serviceId === row.id)!;
              return (
                <>
                  {' · '}
                  <span className="muted">
                    历史输入 {formatTokenCount(usage.totalInputTokens)} / 输出 {formatTokenCount(usage.totalOutputTokens)} token
                  </span>
                </>
              );
            })()}
            <button type="button" onClick={() => editRow(row)}>编辑</button>
            <button type="button" onClick={() => void remove(row.id)}>删除</button>
          </li>
        ))}
      </ul>
      {/* 只在「当前填的就是回环地址、却还没存过任何回环服务」时提示。
          不能只看 rows：用户配远程服务时这句话跟他无关。 */}
      {isLoopbackBaseUrl(baseUrl) && !rows.some(isLoopbackService) && (
        <p className="muted">当前地址是本机回环，保存后即成为可用的本地模型服务。</p>
      )}
      <p className="muted">{status}</p>
    </section>
  );
}
