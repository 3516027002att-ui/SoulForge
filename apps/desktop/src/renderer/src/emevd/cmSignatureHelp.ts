/**
 * CodeMirror 6 Signature Help Extension for EMEVD DarkScript3.
 *
 * Shows real-time floating parameter info tooltips at the cursor:
 * - Active parameter highlighted in bold & styled
 * - Displays argument types, documentation, and enum values
 * - Ctrl+Shift+Space manual trigger
 */

import { StateField, StateEffect, type Extension } from '@codemirror/state';
import { showTooltip, type Tooltip, EditorView, keymap } from '@codemirror/view';
import type { EmedfCompletionItem, EmedfEnumDef } from '@soulforge/core';
import { analyzeCursorContext, getSignatureHelp, type EventSignatureHelp } from '@soulforge/core/dist/emevd/language-service/index.js';

export const setSignatureHelpCatalogEffect = StateEffect.define<{
  catalog: EmedfCompletionItem[];
  enums: Record<string, EmedfEnumDef>;
}>();

export const forceOpenSignatureHelpEffect = StateEffect.define<void>();

interface SignatureHelpState {
  catalog: EmedfCompletionItem[];
  enums: Record<string, EmedfEnumDef>;
  forceOpen: boolean;
}

const signatureHelpStateField = StateField.define<SignatureHelpState>({
  create() {
    return { catalog: [], enums: {}, forceOpen: false };
  },
  update(state, tr) {
    let nextState = state;
    for (const effect of tr.effects) {
      if (effect.is(setSignatureHelpCatalogEffect)) {
        nextState = { ...nextState, catalog: effect.value.catalog, enums: effect.value.enums };
      } else if (effect.is(forceOpenSignatureHelpEffect)) {
        nextState = { ...nextState, forceOpen: true };
      }
    }
    if (tr.selection || tr.docChanged) {
      nextState = { ...nextState, forceOpen: false };
    }
    return nextState;
  }
});

function createSignatureTooltip(view: EditorView): Tooltip | null {
  const { catalog, enums } = view.state.field(signatureHelpStateField);
  if (catalog.length === 0) return null;

  const pos = view.state.selection.main.head;
  const docText = view.state.doc.toString();
  const context = analyzeCursorContext(docText, pos);

  if (!context.activeCall || context.activeCall.isClosed) {
    return null;
  }

  const help = getSignatureHelp(context, catalog, enums);
  if (!help) return null;

  return {
    pos: context.activeCall.openParenPos,
    above: true,
    strictSide: true,
    arrow: true,
    create: () => {
      const dom = document.createElement('div');
      dom.className = 'cm-signature-help';

      // Header / Call Signature
      const title = document.createElement('div');
      title.className = 'cm-signature-help__label';

      const prefix = document.createElement('span');
      prefix.className = 'cm-signature-help__fn';
      prefix.textContent = `${help.instructionName}(`;
      title.appendChild(prefix);

      help.parameters.forEach((param, idx) => {
        if (idx > 0) {
          title.appendChild(document.createTextNode(', '));
        }
        const paramSpan = document.createElement('span');
        const isActive = idx === help.activeParameterIndex;
        paramSpan.className = isActive
          ? 'cm-signature-help__param is-active'
          : 'cm-signature-help__param';
        paramSpan.textContent = `${param.name}: ${param.type}${param.enumName ? ` (${param.enumName})` : ''}${param.vararg ? '…' : ''}`;
        title.appendChild(paramSpan);
      });

      title.appendChild(document.createTextNode(')'));
      dom.appendChild(title);

      // Active Parameter Details & Documentation
      if (help.activeParameter) {
        const active = help.activeParameter;
        const details = document.createElement('div');
        details.className = 'cm-signature-help__detail';

        const nameLabel = document.createElement('strong');
        nameLabel.textContent = `${active.name}: ${active.type}`;
        details.appendChild(nameLabel);

        if (active.enumName) {
          const enumTag = document.createElement('span');
          enumTag.className = 'cm-signature-help__enum-tag';
          enumTag.textContent = ` [Enum: ${active.enumName}]`;
          details.appendChild(enumTag);
        }

        if (active.description) {
          const desc = document.createElement('div');
          desc.className = 'cm-signature-help__doc';
          desc.textContent = active.description;
          details.appendChild(desc);
        }

        if (active.enumMembers && active.enumMembers.length > 0) {
          const enumList = document.createElement('div');
          enumList.className = 'cm-signature-help__enums';
          const memberPreview = active.enumMembers
            .slice(0, 5)
            .map((m) => `${m.name}(${m.value})`)
            .join(', ');
          enumList.textContent = `候选值: ${memberPreview}${active.enumMembers.length > 5 ? '…' : ''}`;
          details.appendChild(enumList);
        }

        dom.appendChild(details);
      }

      return { dom };
    }
  };
}

const signatureHelpTooltipField = StateField.define<Tooltip | null>({
  create(state) {
    return null;
  },
  update(tooltip, tr) {
    if (!tr.docChanged && !tr.selection && !tr.effects.some((e) => e.is(setSignatureHelpCatalogEffect) || e.is(forceOpenSignatureHelpEffect))) {
      return tooltip;
    }
    return null; // recreated on view update
  },
  provide: (f) => showTooltip.computeN(['doc', 'selection', signatureHelpStateField], (state) => {
    const { catalog, enums } = state.field(signatureHelpStateField);
    if (catalog.length === 0) return [];
    const pos = state.selection.main.head;
    const docText = state.doc.toString();
    const context = analyzeCursorContext(docText, pos);
    if (!context.activeCall || context.activeCall.isClosed) return [];

    const help = getSignatureHelp(context, catalog, enums);
    if (!help) return [];

    return [{
      pos: context.activeCall.nameFrom,
      above: true,
      create: () => {
        const dom = document.createElement('div');
        dom.className = 'cm-signature-help';
        dom.setAttribute('role', 'tooltip');
        dom.setAttribute('aria-label', `参数信息：${help.instructionName}`);

        const title = document.createElement('div');
        title.className = 'cm-signature-help__label';

        const prefix = document.createElement('span');
        prefix.className = 'cm-signature-help__fn';
        prefix.textContent = `${help.instructionName}(`;
        title.appendChild(prefix);

        help.parameters.forEach((param, idx) => {
          if (idx > 0) {
            title.appendChild(document.createTextNode(', '));
          }
          const paramSpan = document.createElement('span');
          const isActive = idx === help.activeParameterIndex;
          paramSpan.className = isActive
            ? 'cm-signature-help__param is-active'
            : 'cm-signature-help__param';
          paramSpan.textContent = `${param.name}: ${param.type}${param.enumName ? ` (${param.enumName})` : ''}${param.vararg ? '…' : ''}`;
          title.appendChild(paramSpan);
        });

        title.appendChild(document.createTextNode(')'));
        dom.appendChild(title);

        if (help.activeParameter) {
          const active = help.activeParameter;
          const details = document.createElement('div');
          details.className = 'cm-signature-help__detail';

          const nameLabel = document.createElement('strong');
          nameLabel.textContent = `${active.name}: ${active.type}`;
          details.appendChild(nameLabel);

          if (active.enumName) {
            const enumTag = document.createElement('span');
            enumTag.className = 'cm-signature-help__enum-tag';
            enumTag.textContent = ` [Enum: ${active.enumName}]`;
            details.appendChild(enumTag);
          }

          if (active.description) {
            const desc = document.createElement('div');
            desc.className = 'cm-signature-help__doc';
            desc.textContent = active.description;
            details.appendChild(desc);
          }

          if (active.enumMembers && active.enumMembers.length > 0) {
            const enumList = document.createElement('div');
            enumList.className = 'cm-signature-help__enums';
            const memberPreview = active.enumMembers
              .slice(0, 5)
              .map((m) => `${m.name}(${m.value})`)
              .join(', ');
            enumList.textContent = `可选值: ${memberPreview}${active.enumMembers.length > 5 ? '…' : ''}`;
            details.appendChild(enumList);
          }

          dom.appendChild(details);
        }

        return { dom };
      }
    }];
  })
});

export function signatureHelpExtension(
  getCatalog: () => EmedfCompletionItem[],
  getEnums?: () => Record<string, EmedfEnumDef>
): Extension {
  return [
    signatureHelpStateField,
    signatureHelpTooltipField,
    keymap.of([
      {
        key: 'Mod-Shift-Space',
        run: (view) => {
          const catalog = getCatalog();
          const enums = getEnums ? getEnums() : {};
          view.dispatch({
            effects: [
              setSignatureHelpCatalogEffect.of({ catalog, enums }),
              forceOpenSignatureHelpEffect.of()
            ]
          });
          return true;
        }
      }
    ]),
    EditorView.theme({
      '.cm-signature-help': {
        backgroundColor: 'var(--forge-1, #1e1e1e)',
        border: '1px solid var(--ember-border, #e06c75)',
        borderRadius: '4px',
        padding: '6px 10px',
        fontFamily: 'var(--font-mono, monospace)',
        fontSize: '11px',
        color: 'var(--ink-1, #d4d4d4)',
        boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        zIndex: '100',
        maxWidth: '480px'
      },
      '.cm-signature-help__label': {
        fontWeight: 'normal',
        marginBottom: '4px',
        color: 'var(--ink-2, #aaa)'
      },
      '.cm-signature-help__fn': {
        fontWeight: 'bold',
        color: 'var(--ink-0, #fff)'
      },
      '.cm-signature-help__param.is-active': {
        fontWeight: 'bold',
        color: 'var(--ember-text, #e5c07b)',
        textDecoration: 'underline'
      },
      '.cm-signature-help__detail': {
        borderTop: '1px solid var(--forge-2, #333)',
        paddingTop: '4px',
        marginTop: '4px',
        fontSize: '11px'
      },
      '.cm-signature-help__enum-tag': {
        color: 'var(--ok, #98c379)',
        fontSize: '10px'
      },
      '.cm-signature-help__doc': {
        color: 'var(--ink-2, #aaa)',
        marginTop: '2px'
      },
      '.cm-signature-help__enums': {
        color: 'var(--ink-3, #777)',
        fontSize: '10px',
        marginTop: '2px'
      }
    })
  ];
}
