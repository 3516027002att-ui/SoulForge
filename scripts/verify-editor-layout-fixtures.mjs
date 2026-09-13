#!/usr/bin/env node
import assert from 'node:assert/strict';

import { verifyEditorLayoutSource } from './verify-editor-layout-gate.mjs';

const tick = String.fromCharCode(96);
const interpolationStart = '$' + '{';

function appSource(body, prefix = '') {
  return [
    prefix,
    'export function App() {',
    '  return (',
    '    <div className="app-root">',
    '      <main className="editor-area">',
    body,
    '      </main>',
    '    </div>',
    '  );',
    '}'
  ].filter(Boolean).join('\n');
}

function expectPass(name, source) {
  const result = verifyEditorLayoutSource(source, { fileName: name + '.tsx' });
  assert.equal(result.ok, true, name + ': ' + JSON.stringify(result));
}

function expectFinding(name, source, findingCode) {
  const result = verifyEditorLayoutSource(source, { fileName: name + '.tsx' });
  assert.equal(result.ok, false, name + ': expected failure');
  assert.equal(result.code, 'EDITOR_SHELL_VIOLATION', name + ': ' + JSON.stringify(result));
  assert.ok(
    result.findings.some((finding) => finding.code === findingCode),
    name + ': missing ' + findingCode + ' in ' + JSON.stringify(result)
  );
}

function expectFailure(name, source, code) {
  const result = verifyEditorLayoutSource(source, { fileName: name + '.tsx' });
  assert.equal(result.ok, false, name + ': expected failure');
  assert.equal(result.code, code, name + ': ' + JSON.stringify(result));
}

const validCommentsAndStrings = appSource(
  [
    '        {/* <DiagnosticsLog /> <details className="resource-evidence-details" /> */}',
    '        <div data-copy="status-bar resource-evidence-details">DiagnosticsLog</div>',
    '        <div className="status-bar-label">safe class prefix</div>',
    '        <div>{\'status-bar\'}</div>',
    '        <div className={getClassName(\'status-bar\')} />',
    '        <div className={enabled ? \'toolbar\' : \'toolbar--active\'} />'
  ].join('\n'),
  [
    '// <StructuredPreviewCard />',
    'const unrelatedText = \'<footer className="status-bar">DiagnosticsLog</footer>\';'
  ].join('\n')
);
expectPass('comments-and-unrelated-strings', validCommentsAndStrings);

const safeTemplate = '        <div className={' + tick + 'toolbar ' + interpolationStart + 'enabled ? \'toolbar--active\' : \'\'' + '}' + tick + '} />';
expectPass(
  'safe-static-variants',
  appSource([
    '        <div className={\'toolbar \' + \'toolbar--active\'} />',
    safeTemplate,
    '        <div className={cn(\'toolbar\', enabled && \'toolbar--active\')} />',
    '        <div className={[\'toolbar\', \'toolbar--active\'].join(\' \')} />'
  ].join('\n'))
);

expectFinding(
  'status-direct-attribute',
  appSource('        <footer className="status-bar" />'),
  'STATUS_BAR_PRESENT'
);
expectFinding(
  'status-jsx-expression',
  appSource('        <footer className={\'status-bar\'} />'),
  'STATUS_BAR_PRESENT'
);
expectFinding(
  'status-template-no-substitution',
  appSource('        <footer className={' + tick + 'status-bar' + tick + '} />'),
  'STATUS_BAR_PRESENT'
);
expectFinding(
  'status-static-concatenation',
  appSource('        <footer className={\'shell \' + \'status-bar\'} />'),
  'STATUS_BAR_PRESENT'
);
expectFinding(
  'status-template-static-interpolation',
  appSource('        <footer className={' + tick + 'shell ' + interpolationStart + '\'status-bar\'' + '}' + tick + '} />'),
  'STATUS_BAR_PRESENT'
);
expectFinding(
  'status-template-static-tail',
  appSource('        <footer className={' + tick + 'shell ' + interpolationStart + 'dynamic' + '} status-bar' + tick + '} />'),
  'STATUS_BAR_PRESENT'
);
expectFinding(
  'status-conditional-expression',
  appSource('        <footer className={enabled ? \'status-bar\' : \'toolbar\'} />'),
  'STATUS_BAR_PRESENT'
);
expectFinding(
  'status-class-composer',
  appSource('        <footer className={cn(\'shell\', enabled && \'status-bar\')} />'),
  'STATUS_BAR_PRESENT'
);
expectFinding(
  'status-class-map-composer',
  appSource('        <footer className={classnames({ \'status-bar\': enabled, toolbar: always })} />'),
  'STATUS_BAR_PRESENT'
);
expectFinding(
  'status-static-identifier',
  appSource(
    '        <footer className={statusClass} />',
    'const statusClass = \'status-bar\';'
  ),
  'STATUS_BAR_PRESENT'
);
expectFinding(
  'evidence-details-expression',
  appSource('        <details className={\'resource-evidence-details\'} />'),
  'EVIDENCE_DETAILS_PRESENT'
);
expectFinding(
  'diagnostics-component',
  appSource('        <DiagnosticsLog />'),
  'DIAGNOSTICS_LOG_PRESENT'
);

for (const card of ['StructuredPreviewCard', 'NativeInspectionCard', 'HexEditorPanel']) {
  expectFinding(
    'evidence-card-' + card,
    appSource('        <' + card + ' />'),
    'EVIDENCE_CARD_PRESENT'
  );
}

expectFailure(
  'missing-editor-shell',
  [
    'const marker = \'<main className="editor-area">\';',
    'export function App() { return <div>{marker}</div>; }'
  ].join('\n'),
  'APP_SHELL_UNPARSEABLE'
);
expectFailure(
  'malformed-tsx',
  'export function App() { return (<main className="editor-area">; }',
  'APP_PARSE_FAILED'
);

console.log('[verify-editor-layout-fixtures] PASS: AST JSX, className variants, comments/strings, cards, and fail-closed extraction');
