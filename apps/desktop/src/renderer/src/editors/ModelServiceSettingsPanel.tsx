import { useEffect, useState, type ReactElement } from 'react';
import type { ModelThinkingLevel } from '@soulforge/core';
import { describeBridgeAbsence, getRendererBridge } from '../runtime/rendererRuntime.js';
import {
  convergeThinkingLevel,
  thinkingLevelsForProtocol,
  thinkingLevelLabel
} from '../agent/agentThinking.js';

interface ModelServiceDto {
  id: string;
  displayName: string;
  protocol: 'openai-compatible' | 'anthropic-compatible';
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
  embeddingModel?: string;
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

/**
 * 模型服务设置：只展示 hasCredential，密钥仅在保存时一次性交给 main 加密。
 * 保存、删除与脱敏 DTO 契约不变；browser-preview 表面返回可见诊断。
 *
 * 高级选项（思考强度 / 上下文长度 / 输出长度 / temperature / topP / topK）
 * 默认收起，点击「高级选项」展开；未填写的项不随保存下发，运行时用
 * provider 默认值。模型名支持「获取模型列表」从服务 API 拉取（GET /v1/models），
 * 失败时仍可手动输入。
 */
export interface ModelServiceSettingsPanelProps {
  /** S25：页脚「取消」= 关闭设置视图（AgentSecondaryDrawer 传入）。 */
  onCancel?: () => void;
}

export function ModelServiceSettingsPanel({ onCancel }: ModelServiceSettingsPanelProps = {}): ReactElement {
  const bridge = getRendererBridge();
  const [rows, setRows] = useState<ModelServiceDto[]>([]);
  const [encryptionOk, setEncryptionOk] = useState(false);
  const [displayName, setDisplayName] = useState('模型服务');
  const [protocol, setProtocol] = useState<'openai-compatible' | 'anthropic-compatible'>('openai-compatible');
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
  const [embeddingModel, setEmbeddingModel] = useState('');
  const [embeddingBusy, setEmbeddingBusy] = useState(false);

  // 模型列表（GET /v1/models）。
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);

  async function refresh(): Promise<void> {
    if (!bridge) {
      setStatus(describeBridgeAbsence('模型服务管理'));
      return;
    }
    const [list, available] = await Promise.all([
      bridge.listModelServices(),
      bridge.modelServiceEncryptionAvailable()
    ]);
    setRows(list);
    setEncryptionOk(available);
  }

  useEffect(() => {
    void refresh().catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : '加载模型服务失败');
    });
  }, []);

  /** S25：重置 = 表单回到初值并从 main 重读已存服务（未保存的草稿丢弃）。 */
  function reset(): void {
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
    setEmbeddingModel('');
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

  async function save(): Promise<void> {
    if (!bridge) {
      setStatus(describeBridgeAbsence('保存模型服务'));
      return;
    }
    const parsedTemperature = parseOptionalNumber(temperature);
    if (parsedTemperature !== undefined && (parsedTemperature < 0 || parsedTemperature > 2)) {
      setStatus('temperature 需在 0–2 之间。');
      return;
    }
    const parsedTopP = parseOptionalNumber(topP);
    if (parsedTopP !== undefined && (parsedTopP < 0 || parsedTopP > 1)) {
      setStatus('topP 需在 0–1 之间。');
      return;
    }
    const parsedTopK = parseOptionalNumber(topK);
    if (parsedTopK !== undefined && parsedTopK < 1) {
      setStatus('topK 需 ≥ 1。');
      return;
    }
    const parsedMaxTokens = parseOptionalNumber(maxTokens);
    if (parsedMaxTokens !== undefined && parsedMaxTokens < 1) {
      setStatus('输出长度需 ≥ 1。');
      return;
    }
    const parsedContextWindow = parseOptionalNumber(contextWindowTokens);
    if (parsedContextWindow !== undefined && parsedContextWindow < 1) {
      setStatus('上下文长度需 ≥ 1。');
      return;
    }
    try {
      const saved = await bridge.upsertModelService({
        displayName,
        protocol,
        baseUrl,
        model,
        ...(apiKey ? { apiKey } : {}),
        ...(parsedTemperature !== undefined ? { temperature: parsedTemperature } : {}),
        ...(parsedTopP !== undefined ? { topP: parsedTopP } : {}),
        ...(parsedTopK !== undefined ? { topK: parsedTopK } : {}),
        ...(parsedMaxTokens !== undefined ? { maxTokens: parsedMaxTokens } : {}),
        ...(parsedContextWindow !== undefined ? { contextWindowTokens: parsedContextWindow } : {}),
        ...(thinkingLevel !== 'off' ? { thinkingLevel } : {}),
        ...(embeddingModel.trim() !== '' ? { embeddingModel: embeddingModel.trim() } : {})
      });
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

  async function embedCorpus(row: ModelServiceDto): Promise<void> {
    if (!bridge) {
      setStatus(describeBridgeAbsence('生成向量索引'));
      return;
    }
    setEmbeddingBusy(true);
    try {
      const result = await bridge.embedWorkspaceRag({ configId: row.id });
      if (result.ok) {
        setStatus(
          `向量索引完成：${result.embedded} 个块（失败 ${result.failed}），模型 ${result.model}，维度 ${result.dim}。`
        );
      } else {
        setStatus(`生成向量索引失败：${result.error.message}`);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '生成向量索引失败');
    } finally {
      setEmbeddingBusy(false);
    }
  }

  return (
    <section className="panel" aria-label="模型服务">
      <header className="panel-header">
        <h3>模型服务</h3>
        <span className="muted">
          加密存储：{encryptionOk ? '可用（safeStorage）' : '不可用'}
        </span>
      </header>
      <div className="stack gap">
        {/* S25：字段顺序照 010517 的信息结构——协议 → 地址 → 模型 → 名称 → 密钥 →
            高级 → 页脚。每个 label 独占一行（CSS 竖排），控件 100% 宽。 */}
        <label>
          协议（API 格式）
          <select
            value={protocol}
            onChange={(e) => {
              const next = e.target.value as 'openai-compatible' | 'anthropic-compatible';
              setProtocol(next);
              // 8-C：换协议时收敛非法档（如 Anthropic 的 extreme → OpenAI 的 High）。
              setThinkingLevel((level) => convergeThinkingLevel(level, next));
            }}
          >
            <option value="openai-compatible">OpenAI 兼容</option>
            <option value="anthropic-compatible">Anthropic 兼容</option>
          </select>
        </label>
        <label>
          服务地址
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://127.0.0.1:11434" />
        </label>
        <label>
          模型 ID
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
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
                  onClick={() => setModel(id)}
                >
                  {id}
                </button>
              </li>
            ))}
          </ul>
        )}
        <label>
          显示名称
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <label>
          API 密钥（仅写入，不回显）
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
          />
        </label>
        <details data-testid="model-service-advanced">
          <summary>高级选项</summary>
          <div className="stack gap">
            <label>
              思考强度（服务级默认）
              <select
                aria-label="思考强度"
                value={thinkingLevel}
                onChange={(e) => setThinkingLevel(e.target.value as ModelThinkingLevel)}
              >
                {thinkingLevelsForProtocol(protocol).map((level) => (
                  <option key={level} value={level}>{thinkingLevelLabel(level, protocol)}</option>
                ))}
              </select>
            </label>
            <p className="muted">
              {protocol === 'anthropic-compatible'
                ? 'Anthropic protocol: thinking budget_tokens = 2048 / 4096 / 8192 / 16384.'
                : 'OpenAI protocol: reasoning_effort = low / medium / high (deep/extreme both map to high).'}
              {' '}旧模型不支持 thinking 参数，请保持「关闭」（Off）。
            </p>
            <label>
              上下文长度（token）
              <input
                type="number"
                min={1}
                step={1}
                value={contextWindowTokens}
                onChange={(e) => setContextWindowTokens(e.target.value)}
                placeholder="不填则不限"
              />
            </label>
            <p className="muted">对话历史超过该长度时自动压缩后再请求模型。</p>
            <label>
              输出长度（token）
              <input
                type="number"
                min={1}
                step={1}
                value={maxTokens}
                onChange={(e) => setMaxTokens(e.target.value)}
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
                onChange={(e) => setTemperature(e.target.value)}
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
                onChange={(e) => setTopP(e.target.value)}
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
                onChange={(e) => setTopK(e.target.value)}
                placeholder="≥ 1"
              />
            </label>
            <p className="muted">topK 仅 Anthropic 协议生效（OpenAI 兼容协议无此参数）。</p>
            <label>
              Embedding 模型
              <input
                value={embeddingModel}
                onChange={(e) => setEmbeddingModel(e.target.value)}
                placeholder="不填则不启用语义检索"
              />
            </label>
            <p className="muted">
              仅 OpenAI 兼容协议支持（Anthropic 无 embedding API）。配置后可为工作区
              语料生成向量索引，检索自动升级为「词法 + 向量」RRF 混合。
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
            {row.embeddingModel && (
              <>
                {' · '}
                <span className="muted">embedding: {row.embeddingModel}</span>
                <button
                  type="button"
                  disabled={embeddingBusy || !row.hasCredential}
                  onClick={() => void embedCorpus(row)}
                >
                  {embeddingBusy ? '生成中…' : '生成向量索引'}
                </button>
              </>
            )}
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
