const EXPECTED_POLICY_INPUTS = [
  {
    kind: 'directory',
    source: 'apps/desktop/out',
    target: 'out',
    exclude: ['release-compliance.json']
  },
  { kind: 'file', source: 'apps/desktop/package.json', target: 'package.json' },
  {
    kind: 'file',
    source: 'apps/desktop/.native/better_sqlite3.node',
    target: 'native/better_sqlite3.node'
  },
  {
    kind: 'file',
    source: 'apps/desktop/.native/better_sqlite3.json',
    target: 'native/better_sqlite3.json'
  }
];

const EXPECTED_FILE_PATTERNS = [
  'out/**/*',
  '!out/release-compliance.json',
  'package.json',
  '!**/*.map',
  '!src/**/*',
  '!.native/**/*',
  '!mods/**/*',
  '!**/oo2core*.dll',
  '!**/*secret*',
  '!**/*api*key*'
];

const EXPECTED_OUTPUT_DIRECTORY = 'release';
const EXPECTED_BUILD_RESOURCES_DIRECTORY = 'build';
const EXPECTED_APP_ID = 'com.soulforge.app';
const EXPECTED_PRODUCT_NAME = 'SoulForge';
const EXPECTED_COPYRIGHT = 'Copyright (c) SoulForge contributors';
const EXPECTED_COMPRESSION = 'normal';
const EXPECTED_WIN_ARTIFACT_NAME = '${productName}-${version}-${arch}.${ext}';
const EXPECTED_NSIS = {
  oneClick: false,
  allowToChangeInstallationDirectory: true,
  createDesktopShortcut: true,
  createStartMenuShortcut: true,
  shortcutName: 'SoulForge'
};

const EXPECTED_TOP_LEVEL_CONFIG_FIELDS = [
  'appId',
  'productName',
  'copyright',
  'directories',
  'files',
  'extraResources',
  'win',
  'nsis',
  'asar',
  'compression'
];

export const EXECUTABLE_BUILDER_HOOK_FIELDS = [
  'beforePack',
  'afterExtract',
  'afterPack',
  'afterSign',
  'artifactBuildStarted',
  'artifactBuildCompleted',
  'afterAllArtifactBuild',
  'msiProjectCreated',
  'appxManifestCreated',
  'onNodeModuleFile',
  'beforeBuild',
  'electronDist'
];

export function validatePortableBuilderConfig(config, releasePolicy) {
  const filePatterns = Array.isArray(config?.files) ? config.files : [];
  const targets = Array.isArray(config?.win?.target)
    ? config.win.target.map((item) => typeof item === 'string' ? item : item?.target)
    : [];
  const targetArchitectures = Array.isArray(config?.win?.target)
    ? config.win.target.map((item) => typeof item === 'object' ? item?.arch : null)
    : [];
  const sqliteResource = Array.isArray(config?.extraResources)
    ? config.extraResources.find((item) => item?.from === '.native' && item?.to === 'native')
    : undefined;
  const sqliteFilters = Array.isArray(sqliteResource?.filter) ? sqliteResource.filter : [];
  const serialized = JSON.stringify(config);
  return [
    {
      name: 'config-schema-closed',
      ok: isPortableConfigSchemaClosed(config)
    },
    {
      name: 'identity-values-approved',
      ok: config?.appId === EXPECTED_APP_ID
        && config?.productName === EXPECTED_PRODUCT_NAME
        && config?.copyright === EXPECTED_COPYRIGHT
    },
    {
      name: 'win-x64-nsis-only',
      ok: sameStringSet(targets, ['nsis'])
        && targetArchitectures.every((arch) => sameStringSet(arch ?? [], ['x64']))
        && releasePolicy?.target === 'win-x64'
    },
    {
      name: 'package-inputs-closed',
      ok: sameStringArray(filePatterns, EXPECTED_FILE_PATTERNS)
        && !hasOwn(config, 'extraFiles')
        && Array.isArray(config?.extraResources)
        && config.extraResources.length === 1
    },
    {
      name: 'output-directory-approved',
      ok: config?.directories?.output === EXPECTED_OUTPUT_DIRECTORY
    },
    {
      name: 'build-resources-directory-approved',
      ok: config?.directories?.buildResources === EXPECTED_BUILD_RESOURCES_DIRECTORY
    },
    {
      name: 'win-artifact-name-approved',
      ok: config?.win?.artifactName === EXPECTED_WIN_ARTIFACT_NAME
    },
    {
      name: 'nsis-values-approved',
      ok: Object.entries(EXPECTED_NSIS).every(([key, value]) => config?.nsis?.[key] === value)
    },
    { name: 'excludes-compliance-manifest', ok: filePatterns.includes('!out/release-compliance.json') },
    { name: 'excludes-mods', ok: filePatterns.includes('!mods/**/*') },
    { name: 'excludes-oodle', ok: filePatterns.includes('!**/oo2core*.dll') },
    {
      name: 'no-publish-token',
      ok: config?.publish === undefined && !/GH_TOKEN|GITHUB_TOKEN|API_KEY/i.test(serialized)
    },
    {
      name: 'includes-only-final-sqlite-binding',
      ok: sqliteFilters.length === 2
        && sqliteFilters.includes('better_sqlite3.node')
        && sqliteFilters.includes('better_sqlite3.json')
    },
    { name: 'excludes-native-build-cache', ok: filePatterns.includes('!.native/**/*') },
    {
      name: 'signing-unset',
      ok: config?.win?.certificateFile === undefined
        && config?.win?.certificateSubjectName === undefined
        && config?.win?.sign === undefined
    },
    {
      name: 'executable-hooks-unset',
      ok: EXECUTABLE_BUILDER_HOOK_FIELDS.every((field) => !hasOwn(config, field))
    },
    {
      name: 'archive-values-approved',
      ok: config?.asar === true && config?.compression === EXPECTED_COMPRESSION
    },
    {
      name: 'compliance-policy-aligned',
      ok: releasePolicy === undefined
        || samePolicyInputs(releasePolicy?.artifactInputs, EXPECTED_POLICY_INPUTS)
    }
  ];
}

function sameStringSet(actual, expected) {
  return actual.length === expected.length
    && [...new Set(actual)].length === actual.length
    && actual.every((item) => expected.includes(item));
}

function sameStringArray(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((item, index) => typeof item === 'string' && item === expected[index]);
}

function samePolicyInputs(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  for (const item of actual) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return false;
    const expectedKeys = item.exclude === undefined
      ? ['kind', 'source', 'target']
      : ['exclude', 'kind', 'source', 'target'];
    if (!sameStringSet(Object.keys(item), expectedKeys)) return false;
  }
  const canonicalize = (items) => items
    .map((item) => ({
      kind: item?.kind,
      source: item?.source,
      target: item?.target,
      ...(item?.exclude === undefined
        ? {}
        : { exclude: Array.isArray(item.exclude) ? [...item.exclude].sort() : item.exclude })
    }))
    .sort((left, right) => `${left.kind}\0${left.source}\0${left.target}`.localeCompare(
      `${right.kind}\0${right.source}\0${right.target}`,
      'en'
    ));
  return JSON.stringify(canonicalize(actual)) === JSON.stringify(canonicalize(expected));
}

function hasOwn(value, key) {
  return value !== null
    && typeof value === 'object'
    && Object.prototype.hasOwnProperty.call(value, key);
}

function isPortableConfigSchemaClosed(config) {
  return hasExactKeys(config, EXPECTED_TOP_LEVEL_CONFIG_FIELDS)
    && hasExactKeys(config.directories, ['output', 'buildResources'])
    && Array.isArray(config.extraResources)
    && config.extraResources.every((item) => hasExactKeys(item, ['from', 'to', 'filter']))
    && hasExactKeys(config.win, ['target', 'artifactName'])
    && Array.isArray(config.win.target)
    && config.win.target.every((item) => hasExactKeys(item, ['target', 'arch']))
    && hasExactKeys(config.nsis, [
      'oneClick',
      'allowToChangeInstallationDirectory',
      'createDesktopShortcut',
      'createStartMenuShortcut',
      'shortcutName'
    ]);
}

function hasExactKeys(value, expectedKeys) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && sameStringSet(Object.keys(value), expectedKeys);
}
