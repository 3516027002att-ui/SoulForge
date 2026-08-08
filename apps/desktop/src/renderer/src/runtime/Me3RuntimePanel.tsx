import { useCallback, useState, type ReactElement } from 'react';
import { describeBridgeAbsence, getRendererBridge } from './rendererRuntime.js';
import { me3LaunchBlocker } from './me3LaunchGuard.js';

/**
 * me3 运行时面板：能力探测 → profile → 启动 → 终止。
 *
 * 接的是 SCOPE-RUNTIME（capabilityId H-RUNTIME / REL-H，targetRelease=V0.5，
 * decisionStatus=user-approved）的四条 IPC。它们后端齐全但 renderer 此前零引用，
 * 属 §11.8 那个失败模式：每段都实现了，用户摸不到。
 *
 * ── 三条不可放松的约束（scope.json 的 unsupportedOperations 明列）──
 *
 * ① `launch-with-missing-or-ambiguous-capability`：**能力探测缺失或含糊时不得启动。**
 *    所以启动按钮的禁用条件不是「我觉得应该禁」，而是直接读探测结论：
 *    capability.canLaunch !== true 就禁。探测没跑过（capability === null）同样禁。
 *    这不是防御性冗余——me3 会真实启动零售游戏，误启动的代价是用户存档与反作弊风险。
 *
 * ② `assume-compatible-from-version-or-exit-code`：不得从版本号或退出码推断兼容。
 *    所以界面只显示 detect 返回的 state/compatible/authority，不做任何二次推断。
 *
 * ③ `implement-mod-loader` / `write-original-game`：SoulForge 不自行实现 mod loader，
 *    运行能力通过可替换 GameRuntimeAdapter 集成（硬约束 19）。本面板只调 adapter。
 *
 * ── 为什么启动按钮还要一次显式确认 ──
 * 即便 canLaunch 为真，启动仍是**外向且不易撤销**的动作（起一个零售游戏进程）。
 * REL-H 至今 open、真实会话从未验证过（§9.6 BLOCK-3）。所以除了能力门槛，
 * 再加一道用户确认，且确认状态不跨资源保留。
 */

interface RuntimeDiag {
  severity?: unknown;
  code?: unknown;
  message?: unknown;
}

interface CapabilityView {
  state: string;
  detected: boolean;
  compatible: boolean;
  canPrepareProfile: boolean;
  canLaunch: boolean;
  discoverySource: string;
  detectedVersion: string | null;
  authority: string;
  diagnostics: RuntimeDiag[];
}

interface SessionView {
  sessionId: string;
  state: string;
  startedAt: string;
  exitCode: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asDiagnostics(value: unknown): RuntimeDiag[] {
  return Array.isArray(value) ? (value as RuntimeDiag[]) : [];
}

/**
 * 逐字段取值，不对 IPC 返回值用 `as` 整体断言。
 * 理由（本轮实测踩过）：IPC 边界上类型是断言出来的而非检查出来的，字段名对不上
 * 只表现为「功能不工作」而 typecheck 照过——readRawRange 接线时 core 字段叫
 * base64 而我写 bytesBase64，翻页恒静默失败。
 */
function toCapabilityView(raw: unknown): CapabilityView | null {
  const r = asRecord(raw);
  if (r === null) return null;
  return {
    state: String(r.state ?? 'unknown'),
    detected: r.detected === true,
    compatible: r.compatible === true,
    canPrepareProfile: r.canPrepareProfile === true,
    canLaunch: r.canLaunch === true,
    discoverySource: String(r.discoverySource ?? 'unknown'),
    detectedVersion: typeof r.detectedVersion === 'string' ? r.detectedVersion : null,
    authority: String(r.authority ?? 'unverified'),
    diagnostics: asDiagnostics(r.diagnostics)
  };
}

export function Me3RuntimePanel(): ReactElement {
  const [capability, setCapability] = useState<CapabilityView | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [session, setSession] = useState<SessionView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<RuntimeDiag[]>([]);
  // 启动确认不跨操作保留：每次探测/建 profile 后都要重新确认。
  const [launchConfirmed, setLaunchConfirmed] = useState(false);

  const runOp = useCallback(async (
    label: string,
    operation: string,
    fn: (bridge: NonNullable<ReturnType<typeof getRendererBridge>>) => Promise<unknown>
  ): Promise<Record<string, unknown> | null> => {
    const bridge = getRendererBridge();
    if (bridge === null) {
      setError(describeBridgeAbsence(operation));
      return null;
    }
    setBusy(label);
    setError(null);
    try {
      const raw = await fn(bridge);
      const rec = asRecord(raw);
      if (rec !== null && Array.isArray(rec.diagnostics)) {
        setDiagnostics(asDiagnostics(rec.diagnostics));
      }
      return rec;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      setBusy(null);
    }
  }, []);

  const detect = useCallback(async (): Promise<void> => {
    const rec = await runOp('detect', '探测 me3 运行时', (b) => b.detectMe3());
    const view = toCapabilityView(rec);
    setCapability(view);
    if (view !== null) setDiagnostics(view.diagnostics);
    // 探测结果变化后必须重新确认启动——旧确认可能基于不同的兼容结论。
    setLaunchConfirmed(false);
    setProfileId(null);
  }, [runOp]);

  const prepare = useCallback(async (): Promise<void> => {
    const rec = await runOp('prepare', '准备 me3 profile', (b) => b.prepareMe3Profile());
    const data = asRecord(rec?.data);
    setProfileId(typeof data?.profileId === 'string' ? data.profileId : null);
    setLaunchConfirmed(false);
  }, [runOp]);

  const launch = useCallback(async (): Promise<void> => {
    if (profileId === null) return;
    const rec = await runOp('launch', '启动 me3 会话', (b) => b.launchMe3(profileId));
    const data = asRecord(rec?.data);
    setSession(data === null ? null : {
      sessionId: String(data.sessionId ?? ''),
      state: String(data.state ?? 'unknown'),
      startedAt: String(data.startedAt ?? ''),
      exitCode: typeof data.exitCode === 'number' ? data.exitCode : null
    });
  }, [runOp, profileId]);

  const terminate = useCallback(async (): Promise<void> => {
    if (session === null) return;
    const rec = await runOp('terminate', '终止 me3 会话', (b) => b.terminateMe3(session.sessionId));
    const data = asRecord(rec?.data);
    setSession(data === null ? null : {
      sessionId: String(data.sessionId ?? session.sessionId),
      state: String(data.state ?? 'terminated'),
      startedAt: String(data.startedAt ?? session.startedAt),
      exitCode: typeof data.exitCode === 'number' ? data.exitCode : null
    });
  }, [runOp, session]);

  // 启动门槛走 me3LaunchGuard 的纯判定，不在这里内联一份——判定只能有一个决定点，
  // 两处并存时改一处会让「按钮禁用」与「禁用原因文案」说不同的话，而这条判定守的是
  // scope 明禁的 launch-with-missing-or-ambiguous-capability。
  const launchBlocker = me3LaunchBlocker({
    capability: capability === null
      ? null
      : { state: capability.state, canLaunch: capability.canLaunch },
    profileId,
    launchConfirmed,
    busy: busy !== null
  });

  return (
    <section className="panel me3-runtime" aria-label="me3 运行时">
      <header className="panel-header">
        <h3>me3 运行时</h3>
        <span className="muted">
          {capability === null
            ? '未探测'
            : `${capability.state} · authority ${capability.authority}`}
        </span>
      </header>

      <div className="row gap">
        <button type="button" className="btn btn--sm" disabled={busy !== null} onClick={() => void detect()}>
          探测运行时
        </button>
        <button
          type="button"
          className="btn btn--sm"
          disabled={busy !== null || capability === null || !capability.canPrepareProfile}
          onClick={() => void prepare()}
        >
          准备 profile
        </button>
        {busy !== null && <span className="muted">{busy} 进行中…</span>}
      </div>

      {capability !== null && (
        <div className="structured-preview-grid">
          <span>已检测到：{capability.detected ? '是' : '否'}</span>
          <span>兼容：{capability.compatible ? '是' : '否'}</span>
          <span>可建 profile：{capability.canPrepareProfile ? '是' : '否'}</span>
          <span>可启动：{capability.canLaunch ? '是' : '否'}</span>
          <span>发现来源：{capability.discoverySource}</span>
          <span>版本：{capability.detectedVersion ?? '未报告'}</span>
        </div>
      )}

      {profileId !== null && <p className="muted">profile：{profileId}</p>}

      {/*
        启动是外向且不易撤销的动作——它起一个零售游戏进程。REL-H 至今 open、
        真实会话从未验证过（§9.6 BLOCK-3，涉及存档与反作弊风险）。所以除了
        capability.canLaunch 这道能力门槛，再加一道显式确认；且确认不跨操作保留。
      */}
      <label className="row gap">
        <input
          type="checkbox"
          checked={launchConfirmed}
          disabled={capability === null || !capability.canLaunch}
          onChange={(event) => setLaunchConfirmed(event.currentTarget.checked)}
        />
        <span className="muted">
          我确认要通过 me3 启动零售游戏（会真实启动游戏进程；REL-H 尚未验证真实会话）
        </span>
      </label>

      <div className="row gap">
        <button
          type="button"
          className="btn btn--sm"
          disabled={launchBlocker !== null}
          title={launchBlocker ?? '启动 me3 会话'}
          onClick={() => void launch()}
        >
          启动会话
        </button>
        <button
          type="button"
          className="btn btn--sm"
          disabled={busy !== null || session === null || session.state === 'terminated'}
          onClick={() => void terminate()}
        >
          终止会话
        </button>
      </div>

      {/* 禁用原因必须可见：只把按钮变灰会让用户不知道差什么。 */}
      {launchBlocker !== null && <p className="muted">启动不可用：{launchBlocker}</p>}

      {session !== null && (
        <div className="structured-preview-grid">
          <span>会话：{session.sessionId || '—'}</span>
          <span>状态：{session.state}</span>
          <span>开始于：{session.startedAt || '—'}</span>
          <span>退出码：{session.exitCode ?? '—'}</span>
        </div>
      )}

      {error !== null && <p className="diag-error">{error}</p>}

      {diagnostics.length > 0 && (
        <ul className="muted me3-runtime__diags">
          {diagnostics.map((d, i) => (
            <li key={`${String(d.code ?? 'UNKNOWN')}-${i}`}>
              {String(d.code ?? 'UNKNOWN')} — {String(d.message ?? '')}
            </li>
          ))}
        </ul>
      )}

      <p className="muted">
        SoulForge 不自行实现 mod loader；运行能力通过可替换 GameRuntimeAdapter 集成。
        本面板不写入原版游戏目录。
      </p>
    </section>
  );
}
