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

/**
 * 模型服务设置：只展示 hasCredential，密钥仅在保存时一次性交给 main 加密。
 */
export function ModelServiceSettingsPanel(): ReactElement {
  const [rows, setRows] = useState<ModelServiceDto[]>([]);
  const [encryptionOk, setEncryptionOk] = useState(false);
  const [displayName, setDisplayName] = useState('本地兼容模型服务');
  const [protocol, setProtocol] = useState<'openai-compatible' | 'anthropic-compatible'>('openai-compatible');
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:11434');
  const [model, setModel] = useState('local-model');
  const [apiKey, setApiKey] = useState('');
  const [status, setStatus] = useState('');

  async function refresh(): Promise<void> {
    const [list, available] = await Promise.all([
      window.soulforge.listModelServices(),
      window.soulforge.modelServiceEncryptionAvailable()
    ]);
    setRows(list);
    setEncryptionOk(available);
  }

  useEffect(() => {
    void refresh().catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : '加载模型服务失败');
    });
  }, []);

  async function save(): Promise<void> {
    try {
      const saved = await window.soulforge.upsertModelService({
        displayName,
        protocol,
        baseUrl,
        model,
        ...(apiKey ? { apiKey } : {})
      });
      setApiKey('');
      setStatus(`已保存模型服务：${saved.displayName}（凭据=${saved.hasCredential ? '已加密' : '无'}）`);
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '保存失败');
    }
  }

  async function remove(id: string): Promise<void> {
    await window.soulforge.deleteModelService(id);
    await refresh();
    setStatus('已删除模型服务配置');
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
        <label>
          显示名称
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <label>
          协议
          <select
            value={protocol}
            onChange={(e) => setProtocol(e.target.value as 'openai-compatible' | 'anthropic-compatible')}
          >
            <option value="openai-compatible">OpenAI 兼容</option>
            <option value="anthropic-compatible">Anthropic 兼容</option>
          </select>
        </label>
        <label>
          服务地址
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
        <label>
          模型
          <input value={model} onChange={(e) => setModel(e.target.value)} />
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
        <button type="button" onClick={() => void save()}>保存模型服务</button>
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
            <button type="button" onClick={() => void remove(row.id)}>删除</button>
          </li>
        ))}
      </ul>
      <p className="muted">{status}</p>
    </section>
  );
}
