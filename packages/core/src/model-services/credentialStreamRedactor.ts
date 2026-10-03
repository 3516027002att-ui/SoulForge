/** Retain only a possible credential prefix within one displayed stream channel. */
export interface CredentialDelta { type: 'text-delta' | 'thinking-delta'; text: string }

export class CredentialStreamRedactor {
  private pending = '';
  private spans: CredentialDelta[] = [];

  constructor(private readonly credential: string, private readonly redact: (text: string) => string) {
    if (Buffer.byteLength(credential, 'utf8') > 4096) {
      throw Object.assign(new Error('Credential exceeds the bounded streaming redaction budget.'), {code:'AGENT_CREDENTIAL_REDACTION_BUDGET_EXCEEDED'});
    }
  }

  get retainedCharacters(): number { return this.pending.length; }

  private take(count: number, output: CredentialDelta[], discard = false): void {
    this.pending = this.pending.slice(count);
    while (count > 0) {
      const span = this.spans[0]!;
      const size = Math.min(count, span.text.length);
      if (!discard) this.append(output, span.type, span.text.slice(0, size));
      if (size === span.text.length) this.spans.shift();
      else span.text = span.text.slice(size);
      count -= size;
    }
  }

  private append(output: CredentialDelta[], type: CredentialDelta['type'], text: string): void {
    if (!text) return;
    const safe = this.redact(text);
    const last = output.at(-1);
    if (last?.type === type) last.text += safe;
    else output.push({type, text:safe});
  }

  push(delta: CredentialDelta): CredentialDelta[] {
    if (!delta.text) return [];
    if (!this.credential) return [{...delta, text:this.redact(delta.text)}];
    this.pending += delta.text;
    this.spans.push({...delta});
    const output: CredentialDelta[] = [];
    let match: number;
    while ((match = this.pending.indexOf(this.credential)) >= 0) {
      this.take(match, output);
      const type = this.spans[0]!.type;
      this.take(this.credential.length, output, true);
      this.append(output, type, '[REDACTED]');
    }
    let retained = Math.min(this.pending.length, this.credential.length - 1);
    while (retained > 0 && !this.pending.endsWith(this.credential.slice(0, retained))) retained--;
    this.take(this.pending.length - retained, output);
    return output;
  }

  flush(): CredentialDelta[] {
    // An interrupted/truncated credential prefix also stays private.
    const output: CredentialDelta[] = [];
    if (this.spans.length) this.append(output, this.spans[0]!.type, '[REDACTED]');
    this.pending = '';
    this.spans = [];
    return output;
  }
}
