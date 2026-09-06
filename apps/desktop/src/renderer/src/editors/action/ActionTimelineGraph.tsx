import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { ACTION_EDITOR_FRAME_RATE, type TaeTimelineTrack } from '@soulforge/shared';

export interface ActionTimelineGraphProps {
  tracks: readonly TaeTimelineTrack[];
  totalFrames: number;
  playbackTime: number;
  frameRate?: number | undefined;
  selectedEventIndex?: number | undefined;
  onSelectEvent: (eventIndex: number) => void;
}

const DEFAULT_PIXELS_PER_FRAME = 4;
const MIN_PIXELS_PER_FRAME = 1;
const MAX_PIXELS_PER_FRAME = 32;

/**
 * 可复用的 TAE 事件图。参考 TAE-DX 的“事件盒 + 播放游标”模型，
 * 但写回仍由上层 typed mutation 负责；拖动事件不会绕过 Patch Engine。
 */
export function ActionTimelineGraph(props: ActionTimelineGraphProps): ReactElement | null {
  const [pixelsPerFrame, setPixelsPerFrame] = useState(DEFAULT_PIXELS_PER_FRAME);
  useEffect(() => {
    setPixelsPerFrame(DEFAULT_PIXELS_PER_FRAME);
  }, [props.tracks]);

  const timelineWidth = useMemo(
    () => Math.max(240, props.totalFrames * pixelsPerFrame),
    [pixelsPerFrame, props.totalFrames]
  );
  if (props.tracks.length === 0) return null;

  const frameRate = props.frameRate ?? ACTION_EDITOR_FRAME_RATE;
  const cursorPercent = props.totalFrames > 0
    ? Math.max(0, Math.min(100, (props.playbackTime * frameRate / props.totalFrames) * 100))
    : 0;

  return (
    <div className="tae-tracks-shell" data-testid="tae-tracks-container">
      <div className="tae-tracks-toolbar">
        <span className="muted">事件图</span>
        <button
          type="button"
          aria-label="缩小时间轴"
          title="缩小时间轴"
          disabled={pixelsPerFrame <= MIN_PIXELS_PER_FRAME}
          onClick={() => setPixelsPerFrame((value) => Math.max(MIN_PIXELS_PER_FRAME, value / 2))}
        >
          −
        </button>
        <span className="tae-tracks-zoom" aria-live="polite">{pixelsPerFrame} px/帧</span>
        <button
          type="button"
          aria-label="放大时间轴"
          title="放大时间轴"
          disabled={pixelsPerFrame >= MAX_PIXELS_PER_FRAME}
          onClick={() => setPixelsPerFrame((value) => Math.min(MAX_PIXELS_PER_FRAME, value * 2))}
        >
          +
        </button>
        <button
          type="button"
          aria-label="重置时间轴"
          title="重置时间轴"
          onClick={() => setPixelsPerFrame(DEFAULT_PIXELS_PER_FRAME)}
        >
          复位
        </button>
      </div>
      <div className="tae-tracks-container">
        <div className="tae-tracks-canvas" style={{ width: `${timelineWidth}px` }}>
          <div className="tae-tracks-cursor" style={{ left: `${cursorPercent}%` }} aria-hidden="true" />
          {props.tracks.map((track) => (
            <div key={`track-${track.trackIndex}`} className="tae-track-row">
              {track.blocks.map((block) => {
                const left = props.totalFrames > 0 ? (block.startFrame / props.totalFrames) * 100 : 0;
                const width = props.totalFrames > 0
                  ? Math.max(1, (block.durationFrames / props.totalFrames) * 100)
                  : 10;
                const isSelected = props.selectedEventIndex === block.eventIndex;
                const isTriggering = !block.hasError
                  && block.startTime <= props.playbackTime
                  && props.playbackTime <= block.endTime;
                const blockClass = [
                  'tae-track-block',
                  isSelected ? 'is-selected' : '',
                  isTriggering ? 'is-triggering' : '',
                  block.hasError ? 'has-error' : ''
                ].filter(Boolean).join(' ');
                return (
                  <button
                    key={block.id}
                    type="button"
                    className={blockClass}
                    onClick={() => props.onSelectEvent(block.eventIndex)}
                    title={`${block.eventTypeId} (${block.startFrame}F - ${block.endFrame}F)${block.hasError ? `: ${block.errorMessage}` : ''}`}
                    style={{ left: `${left}%`, width: `${width}%` }}
                  >
                    {block.eventTypeId}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
