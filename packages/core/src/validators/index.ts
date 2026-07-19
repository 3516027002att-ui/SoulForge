export * from './textHash.js';
export * from './textFileValidator.js';
export * from './rawFileValidator.js';
export * from './fileRiskValidator.js';
export * from './containerRoundTripValidator.js';
export * from './emevdSemanticValidator.js';
export * from './fmgSemanticValidator.js';
export * from './paramSemanticValidator.js';
export * from './msbSemanticValidator.js';

import type { ValidatorContract } from '@soulforge/shared';
import { TextFileValidator } from './textFileValidator.js';
import { RawFileValidator } from './rawFileValidator.js';
import { ContainerRoundTripValidator } from './containerRoundTripValidator.js';
import { EmevdSemanticValidator } from './emevdSemanticValidator.js';
import { FmgSemanticValidator } from './fmgSemanticValidator.js';
import { ParamSemanticValidator } from './paramSemanticValidator.js';
import { MsbSemanticValidator } from './msbSemanticValidator.js';
import {
  FileRiskValidator,
  WholeFileReplaceValidator,
  WorkspaceBoundaryValidator
} from './fileRiskValidator.js';

export function createScaffoldValidators(): ValidatorContract[] {
  return [
    new TextFileValidator(),
    new RawFileValidator(),
    new WholeFileReplaceValidator(),
    new FileRiskValidator(),
    new WorkspaceBoundaryValidator(),
    new ContainerRoundTripValidator(),
    new EmevdSemanticValidator(),
    new FmgSemanticValidator(),
    new ParamSemanticValidator(),
    new MsbSemanticValidator()
  ];
}
