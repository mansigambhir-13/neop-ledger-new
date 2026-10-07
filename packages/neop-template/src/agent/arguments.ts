import { Ajv } from 'ajv';
import addFormatsModule from 'ajv-formats';

// Cache compiled contracts only, never job arguments or results. Constructing
// AJV and recompiling its meta-schema for every tool blocks session heartbeats.
const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false, useDefaults: false });
(addFormatsModule as unknown as (a: Ajv) => Ajv)(ajv);
const cache = new Map<string, {schema: Record<string, unknown>; prepare: (args: unknown) => unknown}>();
const MAX_SCHEMAS = 256;

/** Runs before the harness coerces tool arguments; the backend still validates independently. */
export function strictToolArguments(schema: Record<string, unknown>): (args: unknown) => unknown {
  const key=JSON.stringify(schema);
  const previous=cache.get(key);
  if(previous){cache.delete(key);cache.set(key,previous);return previous.prepare;}
  const copy=structuredClone(schema);
  const check = ajv.compile(copy);
  const prepare = (args: unknown) => {
    if (!check(args)) throw new Error(`Invalid tool arguments: ${ajv.errorsText(check.errors)}`);
    return structuredClone(args);
  };
  if(cache.size>=MAX_SCHEMAS){const oldest=cache.keys().next().value!;ajv.removeSchema(cache.get(oldest)!.schema);cache.delete(oldest);}
  cache.set(key,{schema:copy,prepare});
  return prepare;
}
