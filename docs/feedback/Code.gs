/* SoulForge feedback receiver — Google Apps Script Web App.
 *
 * Script Properties required:
 *   SOULFORGE_FEEDBACK_FOLDER_ID    Drive folder receiving JSON archives
 *   SOULFORGE_FEEDBACK_NOTIFY_EMAIL notification destination
 *
 * Deploy as a Web App that executes as the owner. The desktop client only
 * knows the resulting HTTPS endpoint; no Drive/Gmail credential is shipped.
 */

const MAX_REQUEST_BYTES = 6 * 1024 * 1024;
const ALLOWED_KINDS = new Set(['session-feedback', 'history-session', 'history-complete']);

function doPost(e) {
  try {
    const raw = e && e.postData && typeof e.postData.contents === 'string'
      ? e.postData.contents
      : '';
    if (!raw) return jsonResponse_(400, { ok: false, code: 'EMPTY_BODY' });
    if (Utilities.newBlob(raw).getBytes().length > MAX_REQUEST_BYTES) {
      return jsonResponse_(413, { ok: false, code: 'PAYLOAD_TOO_LARGE' });
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (_) {
      return jsonResponse_(400, { ok: false, code: 'INVALID_JSON' });
    }

    const validation = validatePayload_(payload);
    if (!validation.ok) return jsonResponse_(400, validation);

    const properties = PropertiesService.getScriptProperties();
    const folderId = properties.getProperty('SOULFORGE_FEEDBACK_FOLDER_ID');
    const notifyEmail = properties.getProperty('SOULFORGE_FEEDBACK_NOTIFY_EMAIL');
    if (!folderId) return jsonResponse_(500, { ok: false, code: 'FOLDER_NOT_CONFIGURED' });

    const folder = DriveApp.getFolderById(folderId);
    const safeKind = String(payload.kind).replace(/[^a-z0-9-]/gi, '_');
    const safeSubmission = String(payload.submissionId).replace(/[^a-z0-9-]/gi, '_').slice(0, 80);
    const sessionSuffix = payload.trace && payload.trace.sessionId
      ? '-' + String(payload.trace.sessionId).replace(/[^a-z0-9-]/gi, '_').slice(0, 80)
      : '';
    const fileName = `${new Date().toISOString().replace(/[:.]/g, '-')}-${safeKind}-${safeSubmission}${sessionSuffix}.json`;
    const file = folder.createFile(fileName, raw, MimeType.PLAIN_TEXT);

    if (payload.notify === true && notifyEmail) {
      MailApp.sendEmail({
        to: notifyEmail,
        subject: `[SoulForge] ${safeKind}`,
        body: buildNotification_(payload, file.getUrl())
      });
    }

    return jsonResponse_(200, { ok: true, fileId: file.getId() });
  } catch (error) {
    console.error(error);
    return jsonResponse_(500, { ok: false, code: 'INTERNAL_ERROR' });
  }
}

function validatePayload_(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, code: 'INVALID_PAYLOAD' };
  if (payload.schemaVersion !== 1) return { ok: false, code: 'UNSUPPORTED_SCHEMA' };
  if (!ALLOWED_KINDS.has(payload.kind)) return { ok: false, code: 'INVALID_KIND' };
  if (typeof payload.submissionId !== 'string' || payload.submissionId.length < 1 || payload.submissionId.length > 160) {
    return { ok: false, code: 'INVALID_SUBMISSION_ID' };
  }
  if (typeof payload.submittedAt !== 'string' || payload.submittedAt.length > 64) {
    return { ok: false, code: 'INVALID_TIMESTAMP' };
  }
  if (!payload.build || typeof payload.build.appVersion !== 'string' || payload.build.appVersion.length > 80) {
    return { ok: false, code: 'INVALID_BUILD' };
  }

  if (payload.kind === 'session-feedback') {
    if (!payload.feedback || !['positive', 'negative', 'incomplete'].includes(payload.feedback.rating)) {
      return { ok: false, code: 'INVALID_FEEDBACK' };
    }
    if (payload.feedback.comment && String(payload.feedback.comment).length > 2000) {
      return { ok: false, code: 'COMMENT_TOO_LONG' };
    }
  }

  if (payload.kind !== 'history-complete') {
    if (!payload.trace || payload.trace.encoding !== 'jsonl') return { ok: false, code: 'INVALID_TRACE' };
    if (typeof payload.trace.sessionId !== 'string' || payload.trace.sessionId.length > 160) {
      return { ok: false, code: 'INVALID_SESSION_ID' };
    }
    if (typeof payload.trace.content !== 'string') return { ok: false, code: 'INVALID_TRACE_CONTENT' };
  }

  return { ok: true };
}

function buildNotification_(payload, driveUrl) {
  const lines = [
    `kind: ${payload.kind}`,
    `submission: ${payload.submissionId}`,
    `SoulForge: ${payload.build && payload.build.appVersion ? payload.build.appVersion : 'unknown'}`
  ];
  if (payload.build && payload.build.commitSha) lines.push(`commit: ${payload.build.commitSha}`);

  const traceSummary = extractTraceSummary_(payload.trace && payload.trace.content);
  const model = payload.build && payload.build.model ? payload.build.model : traceSummary.model;
  const provider = payload.build && payload.build.provider ? payload.build.provider : traceSummary.protocol;
  if (model) lines.push(`model: ${model}`);
  if (provider) lines.push(`provider: ${provider}`);
  if (traceSummary.configId) lines.push(`config: ${traceSummary.configId}`);

  if (payload.feedback) {
    lines.push(`rating: ${payload.feedback.rating}`);
    if (payload.feedback.comment) lines.push(`comment: ${payload.feedback.comment}`);
  }
  if (payload.trace && payload.trace.sessionId) lines.push(`session: ${payload.trace.sessionId}`);
  if (traceSummary.steps !== null) lines.push(`steps: ${traceSummary.steps}`);
  if (traceSummary.taskStatus) lines.push(`taskStatus: ${traceSummary.taskStatus}`);
  if (traceSummary.finishReason) lines.push(`finishReason: ${traceSummary.finishReason}`);

  if (payload.kind === 'history-complete') {
    lines.push(`uploadedSessions: ${payload.uploadedSessions || 0}`);
    lines.push(`failedSessions: ${(payload.failedSessions || []).length}`);
  }
  lines.push(`Drive: ${driveUrl}`);
  return lines.join('\n');
}

/**
 * Rollout JSONL already is the local authority. Parse only the tiny pieces
 * needed for the notification; the archived Drive file remains byte-for-byte
 * the submitted feedback envelope and keeps the complete trace.
 */
function extractTraceSummary_(content) {
  const summary = {
    model: '',
    protocol: '',
    configId: '',
    steps: null,
    taskStatus: '',
    finishReason: ''
  };
  if (typeof content !== 'string' || !content) return summary;

  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (item && item.type === 'session-meta' && item.meta) {
      if (typeof item.meta.model === 'string') summary.model = item.meta.model;
      if (typeof item.meta.protocol === 'string') summary.protocol = item.meta.protocol;
      if (typeof item.meta.configId === 'string') summary.configId = item.meta.configId;
    }
    if (item && item.type === 'turn-complete') {
      if (typeof item.steps === 'number') summary.steps = item.steps;
      if (typeof item.taskStatus === 'string') summary.taskStatus = item.taskStatus;
      if (typeof item.finishReason === 'string') summary.finishReason = item.finishReason;
    }
  }
  return summary;
}

function jsonResponse_(status, body) {
  // Apps Script ContentService cannot set HTTP status directly. Keep the
  // semantic status in the JSON body; the desktop client explicitly honors it.
  return ContentService
    .createTextOutput(JSON.stringify({ status, ...body }))
    .setMimeType(ContentService.MimeType.JSON);
}
