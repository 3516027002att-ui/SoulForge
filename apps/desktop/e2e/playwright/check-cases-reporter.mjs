import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVerificationSkipReason } from '../../../../scripts/verification-inputs.mjs';

export default class CheckCasesReporter {
  constructor(options = {}) {
    this.root = resolve(options.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)),'../../../..'));
    this.expected = new Map(); this.finished = new Map(); this.invalid = false; this.began = false; this.emitted = false;
  }
  printsToStdio() { return true; }
  id(test) {
    const file = relative(this.root,test.location.file).replaceAll('\\','/');
    if (file.startsWith('../') || isAbsolute(file)) this.invalid = true;
    return `${file}:${test.location.line}:${test.location.column}:${JSON.stringify(test.titlePath().map(part=>part.replaceAll('\\','/')))}`;
  }
  onBegin(_config,suite) {
    this.began = true;
    for (const test of suite.allTests()) {
      const id = this.id(test);
      if (this.expected.has(id)) this.invalid = true;
      this.expected.set(id,test);
    }
  }
  onError() { this.invalid = true; }
  onTestEnd(test,result) {
    const id = this.id(test);
    if (!this.expected.has(id) || this.finished.has(id)) this.invalid = true;
    const status = result.status === 'passed' ? 'passed' : result.status === 'skipped' ? 'skipped' : 'failed';
    const annotations = [...(test.annotations??[]),...(result.annotations??[])];
    const reasons = annotations.filter(a=>a.type==='skip').map(a=>parseVerificationSkipReason(a.description));
    const unique = [...new Map(reasons.filter(Boolean).map(r=>[JSON.stringify(r),r])).values()];
    const reason = status==='skipped'&&reasons.every(Boolean)&&unique.length===1 ? unique[0] : null;
    this.finished.set(id,{id,status,type:'test',reasonCode:status==='skipped'?(reason?.code??'UNKNOWN'):null,
      missingPrerequisites:reason?.missingPrerequisites??[]});
  }
  onEnd(result) {
    if (this.emitted) return;
    this.emitted = true;
    const cases = [...this.finished.values()].sort((a,b)=>a.id.localeCompare(b.id));
    const passed = cases.filter(c=>c.status==='passed').length;
    const failed = cases.filter(c=>c.status==='failed').length;
    const skipped = cases.filter(c=>c.status==='skipped').length;
    const complete = this.began && !this.invalid && this.expected.size > 0 && cases.length===this.expected.size
      && passed+failed+skipped===this.expected.size
      && (result.status==='passed'&&failed===0 || result.status==='failed'&&failed>0);
    console.log(JSON.stringify({soulforgeCheckCases:{schemaVersion:1,runner:'playwright',complete,
      total:this.expected.size,passed,failed,skipped,cases}}));
  }
}
