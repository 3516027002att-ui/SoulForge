import type { ReactElement } from 'react';
import type { BoneTransformData, CharacterPreviewBundle } from '@soulforge/shared';
import { FlverViewer } from '../FlverViewer.js';

export interface ActionPreviewModuleProps {
  bundle: CharacterPreviewBundle | null | undefined;
  loading: boolean;
  error: string | null | undefined;
  playbackTime: number;
  skeletonPoses?: Readonly<Record<string, BoneTransformData[]>> | undefined;
}

/**
 * 动作编辑器的完整只读预览模块。
 *
 * 预览只消费上游已经完成 native FLVER/贴图/骨骼装配的 bundle；它不在
 * renderer 内重新解析二进制，也不把 viewer 的调试 HUD 泄漏到动作工作台。
 */
export function ActionPreviewModule(props: ActionPreviewModuleProps): ReactElement {
  if (props.loading) {
    return <p className="wb-empty">加载中…</p>;
  }

  if (props.error !== null && props.error !== undefined) {
    return (
      <>
        <p className="wb-empty" data-testid="tae-preview-unavailable">预览不可用</p>
        <p className="muted" style={{ fontSize: 11 }} data-testid="tae-preview-error">
          {props.error}
        </p>
      </>
    );
  }

  const bundle = props.bundle;
  const hasPreviewData = bundle !== null
    && bundle !== undefined
    && (bundle.meshCount > 0 || bundle.boneCount > 0);
  if (!hasPreviewData || !bundle) {
    return <p className="wb-empty" data-testid="tae-preview-empty">当前资源没有可预览的骨骼或网格。</p>;
  }

  return (
    <div className="tae-preview-host tae-preview__viewport" data-testid="tae-preview-viewport">
      <FlverViewer
        externalBundle={bundle}
        playbackTime={props.playbackTime}
        externalSkeletonPoses={props.skeletonPoses}
        showViewerHud={false}
        showSceneGuides={false}
      />
    </div>
  );
}
