/**
 * CodeMirror 6 Autocompletion & Snippet Extension for EMEVD DarkScript3.
 *
 * Integrates deterministic ranking, snippets, enum members, and context values.
 */

import {
  autocompletion,
  snippetCompletion,
  type CompletionContext,
  type CompletionResult,
  type Completion
} from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';
import type { EmedfCompletionItem, EmedfEnumDef } from '@soulforge/core';
import { analyzeCursorContext, getCompletions } from '@soulforge/core/dist/emevd/language-service/index.js';

export function createEmevdCompletionSource(
  getCatalog: () => EmedfCompletionItem[],
  getEnums?: () => Record<string, EmedfEnumDef>,
  getKnownEventIds?: () => Array<{ eventId: number; title?: string }>
): (context: CompletionContext) => CompletionResult | null {
  return (context) => {
    const docText = context.state.doc.toString();
    const pos = context.pos;
    const cursorContext = analyzeCursorContext(docText, pos);

    if (cursorContext.isInComment || cursorContext.isInString) {
      return null;
    }

    const catalog = getCatalog();
    if (catalog.length === 0) return null;

    const enums = getEnums ? getEnums() : {};
    const knownEventIds = getKnownEventIds ? getKnownEventIds() : [];

    const candidates = getCompletions({
      context: cursorContext,
      catalog,
      enums,
      knownEventIds
    });

    if (candidates.length === 0) return null;

    const word = context.matchBefore(/[A-Za-z0-9_.]+/);
    const from = word ? word.from : pos;

    // Check if right after cursor there's already an open parenthesis `(`
    const nextChar = pos < docText.length ? docText[pos] : '';
    const hasNextParen = nextChar === '(';

    const options: Completion[] = candidates.map((cand) => {
      let apply: string | ((view: unknown, completion: Completion, from: number, to: number) => void) | undefined;

      if (cand.snippet) {
        let template = cand.snippet;
        if (hasNextParen && template.includes('(')) {
          // If followed by `(`, strip the snippet's `(...)` skeleton to avoid double parenthesis
          template = cand.label;
        }
        return snippetCompletion(template, {
          label: cand.label,
          type: cand.kind === 'function' ? 'function' : cand.kind === 'keyword' ? 'keyword' : 'variable',
          ...(cand.detail ? { detail: cand.detail } : {}),
          ...(cand.info ? { info: cand.info } : {}),
          ...(cand.boost !== undefined ? { boost: cand.boost } : {})
        });
      }

      const item: Completion = {
        label: cand.label,
        type: cand.kind === 'enum-member' ? 'property' : cand.kind === 'parameter' ? 'variable' : 'text',
        apply: cand.insertText ?? cand.label,
        ...(cand.detail ? { detail: cand.detail } : {}),
        ...(cand.info ? { info: cand.info } : {}),
        ...(cand.boost !== undefined ? { boost: cand.boost } : {})
      };
      return item;
    });

    return {
      from,
      options
    };
  };
}

export function emevdCompletionExtension(
  getCatalog: () => EmedfCompletionItem[],
  getEnums?: () => Record<string, EmedfEnumDef>,
  getKnownEventIds?: () => Array<{ eventId: number; title?: string }>
): Extension {
  return autocompletion({
    override: [createEmevdCompletionSource(getCatalog, getEnums, getKnownEventIds)],
    defaultKeymap: true,
    icons: true
  });
}
