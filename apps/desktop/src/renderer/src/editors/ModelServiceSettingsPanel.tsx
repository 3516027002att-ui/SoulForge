import { useEffect, useState, type ReactElement } from 'react';

interface ModelServiceDto {
  id: string;
  displayName: string;
  protocol: 'openai-compatible' | 'anthropic-compatible';
  baseUrl: string;
  model: string;
  hasCredential: boolean;
  createdAt: string;
  updatedAt: string;
}

type PermissionMode = 'plan' | 'normal' | 'fullPermission';

interface ResolvedPermissionMode {
  serviceId: string;
  permissionMode: PermissionMode;
  grantId: string;
}

function modeLabel(mode: PermissionMode): string {
  if (mode === 'fullPermission') return '完全权限';
  if (mode === 'normal') return '普通模式';
  return '计划模式';
}

/**
 * 模型服务设置：只展示 hasCredential，密钥仅在保存时一次性交给 main 加密。
 * 权限提权/撤销由 main 原生对话框确认；renderer 不铸造权威 mode。
 */
export function ModelServiceSettingsPanel(): ReactElement {
  const [rows, setRows] = useState<ModelServiceDto[]>([]);
  const [modeByService, setModeByService] = useState<Record<string, ResolvedPermissionMode>>({});
  const [encryptionOk, setEncryptionOk] = useState(false);
  const [displayName, setDisplayName] = useState('本地兼容模型服务');
  const [protocol, setProtocol] = useState<'openai-compatible' | 'anthropic-compatible'>('openai-compatible');
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:11434');
  const [model, setModel] = useState('local-model');
  const [apiKey, setApiKey] = useState('');
  const [prompt, setPrompt] = useState('分析当前工作区并列出需要优先检查的资源。');
  const [runOutput, setRunOutput] = useState('');
  const [status, setStatus] = useState('');

  async function refreshModes(list: ModelServiceDto[]): Promise<void> {
    const entries = await Promise.all(list.map(async (row) => {
      try {
        const resolved = await window.soulforge.getResolvedPermissionMode({ serviceId: row.id });
        return [row.id, resolved] as const;
      } catch {
        return [row.id, {
          serviceId: row.id,
          permissionMode: 'plan' as const,
          grantId: ''
        }] as const;
      }
    }));
    setModeByService(Object.fromEntries(entries));
  }

  async function refresh(): Promise<void> {
    const [list, available] = await Promise.all([
      window.soulforge.listModelServices(),
      window.soulforge.modelServiceEncryptionAvailable()
    ]);
    setRows(list);
    setEncryptionOk(available);
    await refreshModes(list);
  }

  useEffect(() => {
    void refresh().catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : String(error));
    });
  }, []);

  async function save(): Promise<void> {
    setStatus('正在保存模型服务…');
    try {
      await window.soulforge.upsertModelService({
        displayName: displayName.trim(),
        protocol,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {})
      });
      setApiKey('');
      await refresh();
      setStatus('模型服务已保存（凭据仅存 main 加密库）。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function remove(id: string): Promise<void> {
    setStatus('正在删除模型服务…');
    try {
      await window.soulforge.deleteModelService(id);
      await refresh();
      setStatus('模型服务已删除。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function elevate(serviceId: string, permissionMode: PermissionMode): Promise<void> {
    setStatus(`正在申请${modeLabel(permissionMode)}…`);
    try {
      await window.soulforge.replacePermissionGrant({
        serviceId,
        permissionMode
      });
      await refreshModes(rows);
      setStatus(`${modeLabel(permissionMode)}已生效（由 main 确认并写入 app.db）。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function revoke(serviceId: string): Promise<void> {
    const current = modeByService[serviceId];
    if (!current?.grantId) {
      setStatus('当前无可撤销授权。');
      return;
    }
    setStatus('正在撤销授权…');
    try {
      await window.soulforge.revokePermissionGrant({ grantId: current.grantId });
      await refreshModes(rows);
      setStatus('授权已撤销；将回落到仍有效的较低模式。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function run(configId: string): Promise<void> {
    setStatus('正在调用模型服务（权限模式由 app.db grant 决定）…');
    setRunOutput('');
    try {
      const result = await window.soulforge.runModelService({
        configId,
        userPrompt: prompt.trim()
      });
      setRunOutput(JSON.stringify(result, null, 2));
      const mode = typeof result?.audit?.permissionMode === 'string'
        ? result.audit.permissionMode
        : 'unknown';
      setStatus(`调用完成：finishReason=${String(result.finishReason)} · 生效模式=${mode}`);
      await refreshModes(rows);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <section className="panel model-service-panel">
      <header>
        <h2>模型服务</h2>
        <p className="muted">
          密钥只在保存时交给 main，使用 Electron safeStorage 加密。renderer 只能看到 hasCredential。
          权限模式由 app.db grant 决定；normal / 完全权限提权与撤销均需 main 原生确认。
        </p>
        <p className="muted">
          本机加密可用：
          {encryptionOk ? '是' : '否（不可用时拒绝持久保存凭据）'}
        </p>
      </header>

      <div className="form-grid">
        <label>
          显示名
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
        </label>
        <label>
          协议
          <select
            value={protocol}
            onChange={(event) => setProtocol(event.target.value as ModelServiceDto['protocol'])}
          >
            <option value="openai-compatible">OpenAI-compatible</option>
            <option value="anthropic-compatible">Anthropic-compatible</option>
          </select>
        </label>
        <label>
          Base URL
          <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
        </label>
        <label>
          模型名
          <input value={model} onChange={(event) => setModel(event.target.value)} />
        </label>
        <label>
          API Key（仅写入，不回显）
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            autoComplete="off"
          />
        </label>
        <label>
          调用提示
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={3} />
        </label>
      </div>

      <div className="button-row">
        <button type="button" onClick={() => void save()} disabled={!displayName.trim() || !baseUrl.trim() || !model.trim()}>
          保存服务
        </button>
        <button type="button" onClick={() => void refresh()}>刷新</button>
      </div>

      <ul className="model-service-list">
        {rows.map((row) => {
          const resolved = modeByService[row.id];
          const currentMode = resolved?.permissionMode ?? 'plan';
          return (
            <li key={row.id}>
              <strong>{row.displayName}</strong>
              {' · '}
              {row.protocol}
              {' · '}
              {row.model}
              {' · '}
              凭据：{row.hasCredential ? '已配置' : '未配置'}
              {' · '}
              当前权限：{modeLabel(currentMode)}
              <div className="button-row">
                <button
                  type="button"
                  disabled={!row.hasCredential || !prompt.trim()}
                  onClick={() => void run(row.id)}
                >
                  按当前授权调用
                </button>
                <button
                  type="button"
                  disabled={currentMode === 'plan'}
                  onClick={() => void elevate(row.id, 'plan')}
                >
                  切到计划模式
                </button>
                <button
                  type="button"
                  disabled={currentMode === 'normal'}
                  onClick={() => void elevate(row.id, 'normal')}
                >
                  申请普通模式
                </button>
                <button
                  type="button"
                  disabled={currentMode === 'fullPermission'}
                  onClick={() => void elevate(row.id, 'fullPermission')}
                >
                  申请完全权限
                </button>
                <button
                  type="button"
                  disabled={!resolved?.grantId}
                  onClick={() => void revoke(row.id)}
                >
                  撤销当前授权
                </button>
                <button type="button" onClick={() => void remove(row.id)}>删除服务</button>
              </div>
            </li>
          );
        })}
      </ul>
      {runOutput && <pre className="tool-output">{runOutput}</pre>}
      <p className="muted">{status}</p>
    </section>
  );
}
