export const AUXILIARY_IPC_CHANNELS = {
  mutterNext: 'mutter.next',
  mutterStatus: 'mutter.status',
  feedbackStatus: 'feedback.status',
  feedbackSubmitSession: 'feedback.submitSession',
  feedbackSubmitAll: 'feedback.submitAllHistory'
} as const;

export type SessionFeedbackRating = 'positive' | 'negative' | 'incomplete';

export interface SessionFeedbackIpcRequest {
  sessionId: string;
  rating: SessionFeedbackRating;
  comment?: string;
}

export interface MutterNextIpcResult {
  text: string | null;
  count: number;
  revision: number;
}

export interface MutterStatusIpcResult {
  count: number;
  revision: number;
}

export interface FeedbackStatusIpcResult {
  configured: boolean;
  appVersion: string;
}
