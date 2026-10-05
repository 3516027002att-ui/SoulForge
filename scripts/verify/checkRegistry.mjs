import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { analyzeEntry } from './classify.mjs';
import { resolveScriptEntries } from './scriptGraph.mjs';
import { operationKey, planScript } from './commandPlan.mjs';

// These desktop smokes already have source bundlers because desktop is noEmit.
// Discovery must execute the same operation as their existing npm entry points.
const desktopSmokeRunners = new Map([
  ['apps/desktop/src/main/runMapMeshGeometrySmoke.ts', 'scripts/run-map-mesh-geometry-smoke.mjs'],
  ['apps/desktop/src/renderer/src/scene/runThreeSceneFunctionalSmoke.ts', 'scripts/run-three-scene-functional-smoke.mjs']
]);

/** Labels describe actual execution inputs, never a required registration row. */
export function selectCheckTier(name, sources, requirements) {
  const paths = sources.map(path => path.replaceAll('\\','/'));
  if (paths.some(path => path.includes('/e2e/')) || /(?:renderer-(?:e2e|playwright)|test:e2e|playwright)/u.test(name)) return 'e2e';
  if (/^(?:test:)?(?:release|installer|portable-packaging|cross-machine)/u.test(name)
    || paths.some(path => /\/(?:verify-(?:release|installer|portable-packaging|cross-machine)|run(?:Release|Installer))[^/]*\./u.test(path))) return 'release';
  if (paths.some(path => /\/scripts\/(?:check\.fixture|verify-(?:verify-entrypoint|scheduling|ci-change-scope)-fixtures)\.mjs$/u.test(path))) return 'governance';
  if (requirements.includes('packaged-app')) return 'release';
  if (requirements.includes('native-env')) return 'native';
  if (requirements.includes('dotnet')) return 'synthetic';
  return 'unit';
}

function testFiles(root) {
  const files = [];
  const walk = (directory) => {
    if (!existsSync(directory)) return;
    for (const item of readdirSync(directory,{withFileTypes:true})) {
      if (['node_modules','dist','.git','output','bin','obj','.local-validation'].includes(item.name)) continue;
      const path = resolve(directory,item.name);
      if (item.isDirectory()) walk(path);
      else if (/\.(?:fixture|test)\.(?:mjs|tsx?)$/u.test(item.name) || /^verify-.*fixtures\.mjs$/u.test(item.name)
        || /^run.*Smoke\.ts$/u.test(item.name)) files.push(path);
    }
  };
  for (const dir of ['scripts','packages','apps']) walk(resolve(root,dir));
  return files.sort();
}

/** Keep explicit non-test operations; discover new convention-based tests. */
export function discoverChecks(repoRoot, workspaces) {
  const suites = new Map();
  const analyze = file => {let result = workspaces.analysisCache.get(file); if (!result) {result = analyzeEntry(file);workspaces.analysisCache.set(file,result);} return result;};
  const covered = new Set();
  for (const [name,command] of Object.entries(workspaces.rootScripts)) {
    if (name !== 'typecheck' && !name.startsWith('test') && !name.startsWith('bridge:verify:')) continue;
    const entries = resolveScriptEntries(repoRoot,workspaces,name);
    // Aggregate reachability is not execution evidence: a failing && prefix can
    // leave every later check unexecuted. Only a single independently runnable
    // test can suppress convention discovery.
    const steps = planScript(repoRoot,workspaces,name);
    if (entries.entryFiles.length === 1 && steps.filter(step => step.kind === 'test').length === 1) {
      entries.entryFiles.forEach(file => covered.add(file));
    }
    const requirements = new Set(entries.entryFiles.flatMap(file => analyze(file).requirements));
    suites.set(name,{scriptName:name,tier:selectCheckTier(name,entries.entryFiles,[...requirements]),
      requirements:[...requirements],steps,origin:'npm',command});
  }
  // Workspace aliases are independently selectable, even when a root
  // aggregate statically reaches them. Operation-key caching prevents reruns
  // only after that exact operation actually completed.
  for (const [workspaceName, workspace] of workspaces.byName) {
    for (const name of Object.keys(workspace.scripts).filter(name => name.startsWith('test'))) {
      const scriptName = `workspace:${workspaceName}:${name}`;
      const virtual = {...workspaces,rootScripts:{...workspaces.rootScripts,[scriptName]:`npm run ${name} -w ${workspaceName}`}};
      const entries = resolveScriptEntries(repoRoot,virtual,scriptName);
      const steps = planScript(repoRoot,workspaces,name,{workspace:workspaceName});
      const requirements = new Set(entries.entryFiles.flatMap(file => analyze(file).requirements));
      suites.set(scriptName,{scriptName,tier:selectCheckTier(name,entries.entryFiles,[...requirements]),requirements:[...requirements],steps,origin:'workspace',command:workspace.scripts[name]});
      if (entries.entryFiles.length === 1 && steps.filter(step => step.kind === 'test').length === 1) entries.entryFiles.forEach(file => covered.add(file));
    }
  }
  for (const file of testFiles(repoRoot)) {
    if (covered.has(file)) continue;
    const path = relative(repoRoot,file).replaceAll('\\','/');
    const analysis = analyze(file);
    const name = `file:${path}`;
    const smokeRunner = desktopSmokeRunners.get(path);
    if (smokeRunner && existsSync(resolve(repoRoot, smokeRunner))) {
      const operation = {cwd:repoRoot,command:'node',args:[smokeRunner],kind:'test',env:{},owner:name};
      suites.set(name,{scriptName:name,tier:selectCheckTier(name,[file],analysis.requirements),
        requirements:analysis.requirements,steps:[{...operation,key:operationKey(operation)}],origin:'file',source:path});
      continue;
    }
    // Desktop TypeScript is noEmit. Its source runner bundles every main and
    // renderer test (including TSX) and reports the actual assertions. Keep
    // each file selectable while reusing that identical completed operation.
    if (/^apps\/desktop\/src\/(?:main\/|renderer\/src\/).*\.test\.tsx?$/u.test(path)
      && existsSync(resolve(repoRoot, 'scripts/run-renderer-unit-tests.mjs'))) {
      const operation = {cwd:resolve(repoRoot),command:'node',args:['scripts/run-renderer-unit-tests.mjs'],kind:'test',validation:true,env:{},owner:name};
      suites.set(name,{scriptName:name,tier:selectCheckTier(name,[file],analysis.requirements),
        requirements:analysis.requirements,steps:[{...operation,key:operationKey(operation)}],origin:'file',source:path});
      continue;
    }
    const workspaceDir = file.endsWith('.ts') ? [...workspaces.byDir.keys()].find(dir => path.startsWith(`${dir}/src/`)) : undefined;
    const executionPath = workspaceDir ? path.replace(`${workspaceDir}/src/`,`${workspaceDir}/dist/`).replace(/\.ts$/u,'.js') : path;
    const isNodeTest = /\.(?:fixture|test)\./u.test(path);
    const args = [...(file.endsWith('.ts') && !workspaceDir ? ['--experimental-strip-types']:[]),...(isNodeTest ? ['--test']:[]),executionPath];
    const operation = {cwd:repoRoot,command:'node',args,kind:'test',env:{},owner:name};
    suites.set(name,{scriptName:name,tier:selectCheckTier(name,[file],analysis.requirements),
      requirements:analysis.requirements,steps:[{...operation,key:operationKey(operation)}],origin:'file',source:path,
      ...(workspaceDir ? {buildInput:workspaceDir}: {})});
  }
  return suites;
}
