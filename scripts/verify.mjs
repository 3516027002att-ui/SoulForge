#!/usr/bin/env node
// Compatibility entry: current checks and reports have one execution path.
// Retired slice/claim/seal metadata never participates in selection.
if (process.argv.slice(2).some(argument => argument === '--slice' || argument.startsWith('--slice='))) {
  console.error(JSON.stringify({
    ok: false,
    code: 'VERIFY_SLICE_PLAN_RETIRED',
    message: 'Legacy slice plans are retired. Select current checks with --suite or --tier; work is tracked in GitHub Issues.'
  }));
  process.exitCode = 2;
} else {
  await import('./check.mjs');
}
