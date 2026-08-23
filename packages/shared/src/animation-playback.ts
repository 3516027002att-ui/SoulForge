/**
 * Authoritative Animation Playback Clock and Timeline Block State Models.
 *
 * Ensures 3D Viewport animation preview, Timeline playhead, and Inspector
 * share a single authoritative playback clock and timeline block mapping.
 */

import {
  TAE_INVALID_TIME_RANGE,
  type TaeDiagnostic,
  type TaeTemplateFieldValue,
  type TaeTimelineEventRow
} from './animation-editor.js';

export const DEFAULT_FRAME_RATE = 30;

export interface AnimationPlaybackState {
  isPlaying: boolean;
  currentTime: number; // in seconds
  currentFrame: number; // in frames (integer)
  duration: number; // in seconds
  totalFrames: number; // in frames (integer)
  fps: number; // frame rate, default 30
  playbackRate: number; // 0.25, 0.5, 1.0, 2.0
  loop: boolean;
}

export type PlaybackStateListener = (state: AnimationPlaybackState) => void;

/**
 * Authoritative animation playback clock controller.
 */
export class AnimationPlaybackClock {
  private state: AnimationPlaybackState;
  private listeners = new Set<PlaybackStateListener>();

  constructor(options?: {
    duration?: number | undefined;
    fps?: number | undefined;
    loop?: boolean | undefined;
    playbackRate?: number | undefined;
  }) {
    const fps = options?.fps ?? DEFAULT_FRAME_RATE;
    const duration = options?.duration ?? 0;
    const totalFrames = Math.max(0, Math.round(duration * fps));

    this.state = {
      isPlaying: false,
      currentTime: 0,
      currentFrame: 0,
      duration,
      totalFrames,
      fps,
      playbackRate: options?.playbackRate ?? 1.0,
      loop: options?.loop ?? true
    };
  }

  public getState(): Readonly<AnimationPlaybackState> {
    return this.state;
  }

  public subscribe(listener: PlaybackStateListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }

  public play(): void {
    if (this.state.isPlaying) return;
    this.state = { ...this.state, isPlaying: true };
    this.notify();
  }

  public pause(): void {
    if (!this.state.isPlaying) return;
    this.state = { ...this.state, isPlaying: false };
    this.notify();
  }

  public togglePlay(): void {
    if (this.state.isPlaying) this.pause();
    else this.play();
  }

  public stop(): void {
    this.state = {
      ...this.state,
      isPlaying: false,
      currentTime: 0,
      currentFrame: 0
    };
    this.notify();
  }

  public seek(seconds: number): void {
    const clamped = Math.max(0, Math.min(seconds, this.state.duration > 0 ? this.state.duration : seconds));
    const frame = Math.round(clamped * this.state.fps);
    this.state = {
      ...this.state,
      currentTime: clamped,
      currentFrame: frame
    };
    this.notify();
  }

  public seekFrame(frame: number): void {
    const maxFrame = this.state.totalFrames > 0 ? this.state.totalFrames : frame;
    const clampedFrame = Math.max(0, Math.min(frame, maxFrame));
    const seconds = clampedFrame / this.state.fps;
    this.state = {
      ...this.state,
      currentTime: seconds,
      currentFrame: clampedFrame
    };
    this.notify();
  }

  public stepFrame(deltaFrames: number): void {
    this.seekFrame(this.state.currentFrame + deltaFrames);
  }

  public setPlaybackRate(rate: number): void {
    if (rate <= 0 || !Number.isFinite(rate)) return;
    this.state = { ...this.state, playbackRate: rate };
    this.notify();
  }

  public setLoop(loop: boolean): void {
    this.state = { ...this.state, loop };
    this.notify();
  }

  public setDuration(duration: number): void {
    const validDuration = Math.max(0, Number.isFinite(duration) ? duration : 0);
    const totalFrames = Math.max(0, Math.round(validDuration * this.state.fps));
    const currentTime = Math.min(this.state.currentTime, validDuration);
    const currentFrame = Math.min(this.state.currentFrame, totalFrames);

    this.state = {
      ...this.state,
      duration: validDuration,
      totalFrames,
      currentTime,
      currentFrame
    };
    this.notify();
  }

  public tick(deltaSeconds: number): void {
    if (!this.state.isPlaying || deltaSeconds <= 0) return;

    let nextTime = this.state.currentTime + deltaSeconds * this.state.playbackRate;

    if (this.state.duration > 0 && nextTime >= this.state.duration) {
      if (this.state.loop) {
        nextTime = nextTime % this.state.duration;
      } else {
        nextTime = this.state.duration;
        this.state = {
          ...this.state,
          isPlaying: false,
          currentTime: nextTime,
          currentFrame: this.state.totalFrames
        };
        this.notify();
        return;
      }
    }

    const nextFrame = Math.round(nextTime * this.state.fps);
    this.state = {
      ...this.state,
      currentTime: nextTime,
      currentFrame: nextFrame
    };
    this.notify();
  }
}

/**
 * Structured Timeline Event Block for visual representation and interaction.
 */
export interface TaeTimelineBlock {
  id: string; // e.g. "tae-block-3013-0"
  animId: number;
  eventIndex: number;
  eventTypeId: number;
  startTime: number;
  endTime: number;
  startFrame: number;
  endFrame: number;
  durationFrames: number;
  trackIndex: number;
  parameterDecoded?: boolean | undefined;
  templateFields?: TaeTemplateFieldValue[] | undefined;
  parameterBytesHex?: string | undefined;
  hasError: boolean;
  errorMessage: string | null;
}

export interface TaeTimelineTrack {
  trackIndex: number;
  blocks: TaeTimelineBlock[];
}

/**
 * Packs flat TAE events into non-overlapping timeline tracks and maps validation errors.
 */
export function buildTaeTimelineTracks(
  events: readonly TaeTimelineEventRow[],
  diagnostics?: readonly TaeDiagnostic[] | undefined,
  options?: { fps?: number | undefined } | undefined
): TaeTimelineTrack[] {
  const fps = options?.fps ?? DEFAULT_FRAME_RATE;
  const tracks: TaeTimelineTrack[] = [];

  for (let idx = 0; idx < events.length; idx++) {
    const ev = events[idx]!;
    const isInvalid = !Number.isFinite(ev.startTime) ||
      !Number.isFinite(ev.endTime) ||
      ev.startTime > ev.endTime ||
      ev.endTime > 3600;

    const startFrame = Number.isFinite(ev.startTime) ? Math.max(0, Math.round(ev.startTime * fps)) : 0;
    const endFrame = Number.isFinite(ev.endTime) ? Math.max(startFrame, Math.round(ev.endTime * fps)) : startFrame;
    const durationFrames = Math.max(1, endFrame - startFrame);

    const block: TaeTimelineBlock = {
      id: `tae-block-${ev.animId}-${idx}`,
      animId: ev.animId,
      eventIndex: idx,
      eventTypeId: ev.eventTypeId,
      startTime: ev.startTime,
      endTime: ev.endTime,
      startFrame,
      endFrame,
      durationFrames,
      trackIndex: 0,
      ...(ev.parameterDecoded !== undefined ? { parameterDecoded: ev.parameterDecoded } : {}),
      ...(ev.templateFields !== undefined ? { templateFields: ev.templateFields } : {}),
      ...(ev.parameterBytesHex !== undefined ? { parameterBytesHex: ev.parameterBytesHex } : {}),
      hasError: isInvalid,
      errorMessage: isInvalid
        ? (ev.startTime > ev.endTime ? '起始时间大于结束时间' : '时间范围异常')
        : null
    };

    // Find first track where this block does not overlap
    let placed = false;
    for (const track of tracks) {
      const overlap = track.blocks.some(
        (b) => !(block.endFrame <= b.startFrame || block.startFrame >= b.endFrame)
      );
      if (!overlap) {
        block.trackIndex = track.trackIndex;
        track.blocks.push(block);
        placed = true;
        break;
      }
    }

    if (!placed) {
      const newTrackIndex = tracks.length;
      block.trackIndex = newTrackIndex;
      tracks.push({
        trackIndex: newTrackIndex,
        blocks: [block]
      });
    }
  }

  return tracks;
}

/**
 * Authoritative Bone Transform structure decoded from Havok HKX animation.
 */
export interface AuthoritativeBoneTransform {
  p: [number, number, number];
  q: [number, number, number, number];
  s: [number, number, number];
}

/**
 * Authoritative Animation Clip payload returned from Bridge / HKX decoder.
 */
export interface AuthoritativeAnimationClip {
  animId: number;
  animName: string;
  sourceFile: string;
  duration: number;
  frameCount: number;
  frameDuration: number;
  trackCount: number;
  boneCount: number;
  poses: AuthoritativeBoneTransform[][];
}

/**
 * Deterministically samples bone poses at a given continuous time.
 */
export function sampleAuthoritativePose(
  clip: AuthoritativeAnimationClip,
  time: number,
  loop = true
): AuthoritativeBoneTransform[] | null {
  if (!clip || clip.frameCount <= 0 || !clip.poses || clip.poses.length === 0) {
    return null;
  }
  const frameDur = clip.frameDuration > 0 ? clip.frameDuration : 1 / 30;
  let frame = time / frameDur;
  if (frame < 0) frame = 0;

  let clampedFrameIndex: number;
  if (loop && clip.frameCount > 1) {
    clampedFrameIndex = Math.floor(frame) % (clip.frameCount - 1);
  } else {
    clampedFrameIndex = Math.min(Math.floor(frame), clip.frameCount - 1);
  }

  return clip.poses[clampedFrameIndex] ?? null;
}

