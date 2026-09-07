/**
 * SF-06: PARAM Physical Row Identity and Final State Simulator Smoke Runner.
 *
 * Dispatches to unit or native suites in runAuditParamFinalStateSmoke.ts.
 */

import {
  runParamFinalStateUnitTests,
  runParamFinalStateNativeTests
} from './runAuditParamFinalStateSmoke.js';

function parseArgs(): { layer: string | undefined } {
  const args = process.argv.slice(2);
  let layer: string | undefined = undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--layer' && i + 1 < args.length) {
      layer = args[++i];
    }
  }
  return { layer };
}

async function main(): Promise<void> {
  const { layer } = parseArgs();
  if (layer === 'unit') {
    await runParamFinalStateUnitTests();
  } else if (layer === 'native') {
    await runParamFinalStateNativeTests();
  } else {
    console.error(`Unknown or missing layer: "${layer}". Must specify --layer unit|native.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
