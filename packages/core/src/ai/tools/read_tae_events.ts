import type { RegisteredTool } from '../toolRegistry.js';
import type { TaeAnimSymbol } from '@soulforge/shared';
import type { TaeEventSymbol } from '@soulforge/shared';
import { asNumber } from '.././toolRegistrySupport.js';
import { asRecord } from '.././toolRegistrySupport.js';
import { asString } from '.././toolRegistrySupport.js';
import { asStringList } from '.././toolRegistrySupport.js';
import { fail } from '.././toolRegistrySupport.js';
import { nativePathFromFileToken } from '.././toolRegistrySupport.js';
import { ok } from '.././toolRegistrySupport.js';
import { pathToFileURL } from 'node:url';
import { readTaeEvents } from '../../editing/taeEdit.js';
import { compactTaeEvent, TAE_COMPACT_PAGE_SIZE } from '../../editing/taeCompactEvent.js';
import { requireEditSession } from '.././toolRegistrySupport.js';
import { resolveIndexedResourceFile } from '.././toolRegistrySupport.js';

/** read_tae_events: one domain tool declaration, schema and handler. */
export function createReadTaeEventsTool():RegisteredTool {
 return {
    name: 'read_tae_events',
    description: 'Read a bounded native TAE animation preview when addresses are omitted; follow cursor for the next preview page. '
      + 'Use an action-level cXXXX#AXXXX or section-qualified action URI to read every event of that action. Event addresses select exact events. Follow cursor with the same addresses, or an action nextRead, for remaining native events. '
      + `projection "compact" (with addresses) returns compact events in fixed pages of ${TAE_COMPACT_PAGE_SIZE}, numbered like search_tae_events previews; its cursor stays compact. `
      + 'Compact omits field layout, padding that holds its asserted value, raw bytes of decoded events and info diagnostic details; omit projection for the full layout.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { file: 'string', addresses: 'array?', cursor: 'string?', offset: 'safe-integer?', pageSize: 'number?', projection: 'string?', expectedSourceHash: 'string?', expectedReaderSchemaRevision: 'safe-integer?' },
    run: async (input, context) => {
      const edit = requireEditSession(context, 'read');
      if (!('session' in edit)) return edit;
      const value = asRecord(input);
      const file = asString(value.file);
      if (!file) return fail('INVALID_INPUT', 'read_tae_events 需要 file。');
      const addresses = value.addresses === undefined ? [] : asStringList(value.addresses);
      const cursor = value.cursor === undefined ? undefined : asString(value.cursor).trim();
      if (value.cursor !== undefined && !cursor) return fail('INVALID_INPUT', 'read_tae_events 的 cursor 必须是非空 opaque token。');
      const pageSize = value.pageSize === undefined ? undefined : asNumber(value.pageSize, 32);
      if (value.projection !== undefined && value.projection !== 'compact') {
        return fail('INVALID_INPUT', 'read_tae_events 的 projection 只能是 "compact"。');
      }
      // search_resources returns the indexed source URI for ACTION containers
      // (for example file://chr/c7100.anibnd.dcx), while the TAE facade needs
      // the current workspace's physical overlay path.  Resolve only this
      // read path through the existing catalog boundary; mutation remains on
      // its legacy resolver and base/read permissions stay unchanged.
      const resolvedFile = resolveIndexedResourceFile(context, file, 'chr');
      if (!resolvedFile.ok) return fail(resolvedFile.code, resolvedFile.message, resolvedFile.details);
      const result = await readTaeEvents({
        edit: edit.session,
        file: nativePathFromFileToken(resolvedFile.path),
        ...(addresses.length > 0 ? { addresses } : {}),
        ...(cursor ? { cursor } : {}),
        ...(typeof value.offset === 'number' ? { offset: value.offset } : {}),
        ...(pageSize === undefined ? {} : { pageSize }),
        ...(value.projection === 'compact' ? { projection: 'compact' as const } : {}),
        ...(typeof value.expectedSourceHash === 'string' ? { expectedSourceHash: value.expectedSourceHash } : {}),
        ...(typeof value.expectedReaderSchemaRevision === 'number' ? { expectedReaderSchemaRevision: value.expectedReaderSchemaRevision } : {})
      });
      if (!result.ok) return fail(result.error.code, result.error.message, result.diagnostics);
      if (context.workspaceIndex) {
        // Keep the catalog identity returned by search_resources when the
        // resolver selected a canonical indexed file.  For legacy relative /
        // absolute / bare tokens that remain unindexed, preserve the previous
        // physical-path identity derived from the successful native read.
        const sourceUri = resolvedFile.canonical === true
          ? resolvedFile.sourceUri
          : pathToFileURL(result.filePath).href;
        const sourceFile = context.workspaceIndex.getFile(sourceUri);
        // Keep native logical identity and the captured physical file version
        // in separate domains, matching ordinary Bridge envelope ingestion.
        const exportSourceHash = result.sourceHash;
        const readSourceHash = result.sourceHash;
        const sourceRevision = sourceFile?.mtimeMs;
        // 同一 TAE source 内不同 section 可以复用 animId；不能按裸数字合并，
        // 否则 AI 看到的事件会跨 a00/a50 串线。
        const animations = new Map<string, TaeAnimSymbol>();
        for (const action of result.actions) {
          const key = `${action.taeEntryIndex ?? action.taeEntryId ?? action.taeEntryName ?? 'tae'}:${action.animId}`;
          animations.set(key, { ...action, eventCount: action.eventCount, eventsComplete: action.eventCount === 0, events: [] });
        }
        for (const event of result.events) {
          const animationKey = `${event.taeEntryIndex ?? event.taeEntryId ?? event.taeEntryName ?? 'tae'}:${event.animId}`;
          const animation = animations.get(animationKey) ?? {
            animId: event.animId,
            code: event.code,
            ...(event.taeEntryIndex === undefined ? {} : { taeEntryIndex: event.taeEntryIndex }),
            ...(event.taeEntryId === undefined ? {} : { taeEntryId: event.taeEntryId }),
            ...(event.taeEntryName === undefined ? {} : { taeEntryName: event.taeEntryName }),
            ...(event.taeGroup === undefined ? {} : { taeGroup: event.taeGroup }),
            events: [] as TaeEventSymbol[]
          };
          animation.events.push({
            uri: event.uri,
            index: event.eventIndex,
            eventTypeId: event.eventTypeId,
            ...(event.taeEntryIndex === undefined ? {} : { taeEntryIndex: event.taeEntryIndex }),
            ...(event.taeEntryId === undefined ? {} : { taeEntryId: event.taeEntryId }),
            ...(event.taeEntryName === undefined ? {} : { taeEntryName: event.taeEntryName }),
            ...(event.taeGroup === undefined ? {} : { taeGroup: event.taeGroup }),
            ...(event.typeName ? { typeName: event.typeName } : {}),
            startTime: event.startTime,
            endTime: event.endTime,
            startFrame: event.startFrame,
            endFrame: event.endFrame,
            ...(readSourceHash ? { sourceHash: readSourceHash } : {}),
            ...(sourceRevision !== undefined ? { sourceRevision } : {}),
            ...(event.fields ? { fields: event.fields } : {}),
            ...(event.parameterBytesHex ? { parameterBytesHex: event.parameterBytesHex } : {}),
            ...(event.decodeStatus ? { decodeStatus: event.decodeStatus } : {}),
            ...(event.raw ? { raw: event.raw } : {})
          });
          animations.set(animationKey, animation);
        }
        context.workspaceIndex.mergeTaeEvents({
          chrId: result.chrId,
          readerSchemaRevision: result.readerSchemaRevision,
          ...((result.outerFileHash ?? result.sourceHash) ? { outerFileHash: result.outerFileHash ?? result.sourceHash } : {}),
          sourceUri,
          ...(exportSourceHash ? { sourceHash: exportSourceHash } : {}),
          ...(sourceRevision !== undefined ? { sourceRevision } : {}),
          ...(result.taeEntryCount !== undefined ? { taeEntryCount: result.taeEntryCount } : {}),
          ...(result.taeEntries ? { taeEntries: result.taeEntries } : {}),
          animations: [...animations.values()]
        });
        context.workspaceIndex.rebuildReferences();
        await context.onSemanticEvidenceUpdated?.([sourceUri]);
      }
      if (result.projection !== 'compact') return ok(result);
      // The index above keeps the full events; only the returned page is compacted. Info diagnostics keep code and
      // message: their details (the container's TAE inventory, about 13 KB for c0000) would repeat on every page.
      return ok({ ...result, events: result.events.map(compactTaeEvent),
        diagnostics: result.diagnostics.map(diagnostic => {
          if (diagnostic.severity !== 'info' || diagnostic.details === undefined) return diagnostic;
          const { details: _omitted, ...rest } = diagnostic;
          return rest;
        }) });
    }
  };
}
