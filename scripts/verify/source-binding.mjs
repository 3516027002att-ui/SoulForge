import {execFileSync} from 'node:child_process';

export function captureSourceBinding(root){
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  try{
    const head=git('rev-parse','HEAD'),tree=git('rev-parse','HEAD^{tree}');
    let clean=true;try{git('diff','--quiet','HEAD');}catch{clean=false;}
    const unknown=git('ls-files','--others','--exclude-standard','--','scripts','packages','apps','bridge','prompt','.github','package.json','package-lock.json','global.json','mutter.md');
    return {head,tree,clean:clean&&!unknown,available:true};
  }catch{return {head:null,tree:null,clean:false,available:false};}
}

export function verifiedSourceBinding(before,after){
  return before.available&&after.available&&before.clean&&after.clean&&before.head===after.head&&before.tree===after.tree;
}
