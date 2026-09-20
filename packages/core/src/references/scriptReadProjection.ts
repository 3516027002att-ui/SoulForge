import type { ScriptExport, ScriptSymbol } from '@soulforge/shared';
import type { LuabndScriptSnapshot } from '../editing/luabndEdit.js';

export interface ScriptReadProjectionInput {
  sourceUri: string;
  childPath: string;
  script: Pick<LuabndScriptSnapshot, 'sourceText' | 'sourceHash' | 'outerFileHash' | 'isBytecode' | 'warnings'>;
  sourceRevision?: number;
  existing?: ScriptExport;
}

/** Project one native LUABND child read into the indexed export. */
export function projectScriptReadExport(input: ScriptReadProjectionInput): ScriptExport {
  const childUri = `${input.sourceUri}!/${input.childPath}`;
  const nativeChild: ScriptSymbol = {
    uri: childUri,
    sourceUri: input.sourceUri,
    childChain: [input.childPath],
    entryName: input.childPath,
    contentKind: input.script.sourceText !== undefined
      ? (input.script.isBytecode ? 'decompiled-view' : 'source')
      : input.script.isBytecode ? 'bytecode' : 'catalog-only',
    ...(input.script.sourceText !== undefined ? { sourceText: input.script.sourceText } : {}),
    ...(input.script.warnings !== undefined
      ? { encodingDiagnostics: [...input.script.warnings] }
      : {}),
    ...(input.script.sourceHash ? { sourceHash: input.script.sourceHash } : {}),
    ...(input.script.outerFileHash ? { outerFileHash: input.script.outerFileHash } : {}),
    ...(input.sourceRevision !== undefined ? { sourceRevision: input.sourceRevision } : {})
  };

  const existingChild = input.existing?.scripts.find((item) => item.uri === childUri);
  const existingOuterFileHash = input.existing?.outerFileHash ?? existingChild?.outerFileHash;
  const sameOuterFile = Boolean(
    input.script.outerFileHash
      && existingOuterFileHash
      && input.script.outerFileHash === existingOuterFileHash
  );
  const sameChild = sameOuterFile
    && Boolean(existingChild?.sourceHash)
    && Boolean(input.script.sourceHash)
    && existingChild?.sourceHash === input.script.sourceHash;

  // A same-hash reread refreshes native fields while retaining metadata that
  // the read facade does not emit (entry index, calls, encoding diagnostics).
  // If the native read no longer supplies source text, remove an old text
  // projection instead of claiming that this read produced it.
  const child: ScriptSymbol = sameChild && existingChild
    ? { ...existingChild, ...nativeChild }
    : nativeChild;
  if (sameChild && input.script.sourceText === undefined) {
    delete child.sourceText;
    delete child.calls;
  } else if (sameChild && existingChild?.sourceText !== input.script.sourceText) {
    // Calls are derived from the exact source representation. A same child
    // hash can still be reread through a different decompiler/representation;
    // do not carry a derived call graph across that boundary.
    delete child.calls;
  }

  // The child replacement keeps its original array slot. A changed outer
  // container invalidates every sibling and cannot inherit catalogComplete.
  let scripts: ScriptSymbol[];
  if (sameOuterFile && input.existing) {
    let replaced = false;
    scripts = input.existing.scripts.map((item) => {
      if (item.uri !== childUri) return item;
      replaced = true;
      return child;
    });
    if (!replaced) scripts.push(child);
  } else {
    scripts = [child];
  }

  return {
    ...(sameOuterFile && input.existing ? input.existing : {}),
    sourceUri: input.sourceUri,
    containerKind: sameOuterFile && input.existing ? input.existing.containerKind : 'luabnd',
    ...(input.script.outerFileHash ? { outerFileHash: input.script.outerFileHash } : {}),
    ...(input.sourceRevision !== undefined ? { sourceRevision: input.sourceRevision } : {}),
    catalogComplete: sameOuterFile && input.existing ? input.existing.catalogComplete ?? false : false,
    scripts
  };
}
