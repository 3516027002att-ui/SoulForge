import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import test from 'node:test';
import { createDefaultToolRegistry } from '../packages/core/dist/index.js';
test('domain tool modules own unique complete declarations projected by the default registry',async()=>{
 const root='packages/core/src/ai/tools';assert.equal(existsSync(root),true);
 const expected=createDefaultToolRegistry().list();
 const declarations=[];
 for(const name of readdirSync(root).filter(name=>name.endsWith('.ts') && !name.endsWith('.test.ts'))){
  const module=await import(pathToFileURL(resolve('packages/core/dist/ai/tools',name.replace(/\.ts$/u,'.js'))).href);
  const factories=Object.values(module).filter(value=>typeof value==='function');assert.equal(factories.length,1);
  const descriptor=factories[0]();assert.equal(typeof descriptor.run,'function');declarations.push(descriptor);
 }
 assert.deepEqual(declarations.map(tool=>tool.name).sort(),expected.map(tool=>tool.name).sort());
 for(const declaration of declarations){const projected=expected.find(tool=>tool.name===declaration.name);assert.deepEqual(projected.inputSchema,declaration.inputSchema && Object.keys(declaration.inputSchema).length?declaration.inputSchema:undefined);assert.equal(projected.permissionLevel,declaration.permissionLevel);}
});
