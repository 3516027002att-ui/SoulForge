export * from './textFileWriter.js';
export * from './rawFileWriter.js';
export * from './containerChildReplaceWriter.js';
export * from './syntheticResourceWriter.js';
export * from './unsupportedResourceWriter.js';
export * from './inverseCapture.js';
export * from './emevdSemanticWriter.js';
export * from './fmgSemanticWriter.js';
export * from './paramSemanticWriter.js';
export * from './msbSemanticWriter.js';

import type { PatchIrOperation, WriterAdapterContract } from '@soulforge/shared';
import { TextFileWriter } from './textFileWriter.js';
import { RawFileWriter } from './rawFileWriter.js';
import { ContainerChildReplaceWriter } from './containerChildReplaceWriter.js';
import { SyntheticResourceWriter } from './syntheticResourceWriter.js';
import { UnsupportedResourceWriter } from './unsupportedResourceWriter.js';
import { EmevdSemanticWriter } from './emevdSemanticWriter.js';
import { FmgSemanticWriter } from './fmgSemanticWriter.js';
import { ParamSemanticWriter } from './paramSemanticWriter.js';
import { MsbSemanticWriter } from './msbSemanticWriter.js';

export function createScaffoldWriterAdapters(): WriterAdapterContract[] {
  return [
    new TextFileWriter(),
    new RawFileWriter(),
    new ContainerChildReplaceWriter(),
    new EmevdSemanticWriter(),
    new FmgSemanticWriter(),
    new ParamSemanticWriter(),
    new MsbSemanticWriter(),
    new SyntheticResourceWriter(),
    new UnsupportedResourceWriter()
  ];
}

/**
 * Resolve the first capable scaffold writer. Falls back to UnsupportedResourceWriter.
 */
export function resolveWriterForOperation(
  operation: PatchIrOperation,
  writers: readonly WriterAdapterContract[] = createScaffoldWriterAdapters()
): WriterAdapterContract {
  for (const writer of writers) {
    if (writer.writerId === 'writer:unsupported') continue;
    if (writer.canHandle(operation)) return writer;
  }
  return writers.find((writer) => writer.writerId === 'writer:unsupported')
    ?? new UnsupportedResourceWriter();
}
