import { useEffect, useRef, useState } from 'react';
import type { RagLocalModelStatus, UpdateChannel, UpdateCommandResult, UpdatePublicState } from '@soulforge/shared';
import type { RendererRuntime } from '../runtime/rendererRuntime.js';

export type RuntimeSettingsBridge = Pick<NonNullable<RendererRuntime['bridge']>,
  'getUpdateState' | 'onUpdateState' | 'getRagLocalModelStatus' | 'checkForUpdate'
  | 'downloadUpdate' | 'cancelUpdate' | 'installUpdate' | 'setUpdateChannel'>;
export interface RuntimeSettingsOptions {
  bridge: RuntimeSettingsBridge | null;
  setStatus(message: string): void;
  pushToast(message: string, kind: 'ok' | 'warn'): void;
  announceDesktopOnly(operation: string): void;
}

const INITIAL_UPDATE_STATE: UpdatePublicState = {
  status: 'idle',
  currentVersion: '读取中',
  channel: 'prerelease'
};

/** Main remains update/model authority; this owner holds only renderer state and request lifetimes. */
export function useRuntimeSettingsController(options: RuntimeSettingsOptions) {
  const { bridge, setStatus, pushToast, announceDesktopOnly } = options;
  const [updateState, setUpdateState] = useState<UpdatePublicState>(INITIAL_UPDATE_STATE);

  const [updateActionBusy, setUpdateActionBusy] = useState(false);

  const updateActionInFlightRef = useRef(false);

  const [ragModelStatus, setRagModelStatus] = useState<RagLocalModelStatus | null>(null);
  const commandLifetimeRef = useRef({ bridge, mounted: false, generation: 0 });
  useEffect(() => {
    const lifetime = commandLifetimeRef.current;
    lifetime.bridge = bridge;
    lifetime.mounted = true;
    lifetime.generation++;
    return () => { lifetime.mounted = false; lifetime.generation++; };
  }, [bridge]);

  useEffect(() => {
    if (!bridge || typeof bridge.getUpdateState !== 'function' || typeof bridge.onUpdateState !== 'function') return;
    let cancelled = false;
    const unsubscribe = bridge.onUpdateState((state) => {
      if (!cancelled) setUpdateState(state);
    });
    void bridge.getUpdateState().then((state) => {
      if (!cancelled) setUpdateState(state);
    }).catch((error: unknown) => {
      if (cancelled) return;
      setStatus(error instanceof Error ? error.message : '读取更新状态失败');
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [bridge]);

  useEffect(() => {
    if (!bridge || typeof bridge.getRagLocalModelStatus !== 'function') {
      setRagModelStatus(null);
      return;
    }
    let cancelled = false;
    void bridge.getRagLocalModelStatus().then((status) => {
      if (!cancelled) setRagModelStatus(status);
    }).catch(() => {
      if (!cancelled) setRagModelStatus(null);
    });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  async function runUpdateCommand(
    action: () => Promise<UpdateCommandResult>,
    successMessage?: string
  ): Promise<void> {
    if (!bridge) {
      announceDesktopOnly('检查 SoulForge 更新');
      return;
    }
    const lifetime = commandLifetimeRef.current;
    if (!lifetime.mounted || lifetime.bridge !== bridge) return;
    if (updateActionInFlightRef.current) return;
    const generation = lifetime.generation;
    const isCurrent = () => lifetime.mounted && lifetime.generation === generation && lifetime.bridge === bridge;
    updateActionInFlightRef.current = true;
    setUpdateActionBusy(true);
    try {
      const result = await action();
      if (!isCurrent()) return;
      setUpdateState(result.state);
      if (!result.ok && result.error) {
        setStatus(`更新未执行：${result.error.message}`);
        pushToast(result.error.message, 'warn');
      } else if (successMessage) {
        setStatus(successMessage);
      }
    } catch (error) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : '更新操作失败';
      setStatus(message);
      pushToast(message, 'warn');
    } finally {
      updateActionInFlightRef.current = false;
      if (lifetime.mounted) setUpdateActionBusy(false);
    }
  }

  function updateAction(): { label: string; run: (() => Promise<UpdateCommandResult>) | null } {
    switch (updateState.status) {
      case 'available':
        return { label: '下载更新', run: bridge ? bridge.downloadUpdate : null };
      case 'downloading':
        return { label: '取消下载', run: bridge ? bridge.cancelUpdate : null };
      case 'pending-install':
      case 'blocked':
        return { label: '安装并重启', run: bridge ? bridge.installUpdate : null };
      case 'installing':
        return { label: '安装器启动中…', run: null };
      default:
        return { label: '检查更新', run: bridge ? bridge.checkForUpdate : null };
    }
  }

  function changeUpdateChannel(channel: UpdateChannel): void {
    if (!bridge) {
      announceDesktopOnly('切换更新频道');
      return;
    }
    void runUpdateCommand(
      () => bridge.setUpdateChannel({ channel }),
      channel === 'prerelease' ? '已切换到预发布频道' : '已切换到稳定频道'
    );
  }
  return { updateState, updateActionBusy, ragModelStatus, runUpdateCommand, changeUpdateChannel, currentUpdateAction: updateAction() };
}
export type RuntimeSettingsController = ReturnType<typeof useRuntimeSettingsController>;
