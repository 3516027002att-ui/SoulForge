export * from './textHash.js';
export * from './textFileValidator.js';
export * from './rawFileValidator.js';
export * from './fileRiskValidator.js';
export * from './containerRoundTripValidator.js';

import type { ValidatorContract } from '@soulforge/shared';
import { TextFileValidator } from './textFileValidator.js';
import { RawFileValidator } from './rawFileValidator.js';
import { ContainerRoundTripValidator } from './containerRoundTripValidator.js';
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
    new ContainerRoundTripValidator()
  ];
}
