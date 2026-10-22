import {existsSync} from 'node:fs';
import {dirname} from 'node:path';

/** Child-only cleanup: cmd drops an overlong PATH instead of searching it. */
export function windowsCommandEnvironment(environment,nodeExecutable=process.execPath,exists=existsSync) {
  const result={...environment};
  const keys=Object.keys(result).filter(key=>key.toUpperCase()==='PATH');
  const paths=keys.flatMap(key=>String(result[key]??'').split(';'));
  for(const key of keys)delete result[key];
  const seen=new Set(),kept=[];
  for(const item of [dirname(nodeExecutable),...paths]){
    const value=item.trim().replace(/^"(.*)"$/,'$1'),identity=value.toLowerCase().replace(/[\\/]+$/,'');
    if(!value||seen.has(identity)||!exists(value))continue;
    kept.push(value);seen.add(identity);
  }
  const path=kept.join(';');
  // Leave headroom for npm's workspace .bin entries rather than letting cmd
  // silently drop all tools on a nested invocation. Never mutate global PATH.
  if(path.length>7000)throw Object.assign(new Error('The build PATH still exceeds the safe nested-command budget after removing duplicates and absent entries.'),{code:'WINDOWS_BUILD_PATH_TOO_LONG'});
  result.PATH=path;
  return result;
}
