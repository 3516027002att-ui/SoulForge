export * from './textHash.js';
export * from './textFileValidator.js';
export * from './rawFileValidator.js';

import type { ValidatorContract } from '@soulforge/shared';
import { TextFileValidator } from './textFileValidator.js';
import { RawFileValidator } from './rawFileValidator.js';

export function createScaffoldValidators(): ValidatorContract[] {
  return [new TextFileValidator(), new RawFileValidator()];
}
