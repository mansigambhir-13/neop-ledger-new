import type { Manifest } from '@neop/contracts';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';

const addFormats = addFormatsModule as unknown as (a: Ajv) => Ajv;

export class Validators {
  private input = new Map<string, ValidateFunction>();
  private output = new Map<string, ValidateFunction>();
  private ajv: Ajv;
  constructor(manifest: Manifest) {
    this.ajv = new Ajv({ allErrors: true, strict: false, useDefaults: false });
    addFormats(this.ajv);
    for (const a of manifest.abilities) {
      this.input.set(a.key, this.ajv.compile(a.input));
      this.output.set(a.key, this.ajv.compile(a.output));
    }
  }

  checkInput(key: string, value: unknown): string | null {
    const v = this.input.get(key);
    if (!v) return `unknown ability ${key}`;
    return v(value) ? null : this.ajv.errorsText(v.errors, { dataVar: 'args' });
  }

  /** Contract: every result matches its manifest schema before it leaves. */
  checkOutput(key: string, value: unknown): string | null {
    const v = this.output.get(key);
    if (!v) return `unknown ability ${key}`;
    return v(value) ? null : this.ajv.errorsText(v.errors, { dataVar: 'result' });
  }
}
