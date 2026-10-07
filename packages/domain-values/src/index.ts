// Pure value classes only: no database, I/O, model, identity or approval decisions.
export class DomainError extends Error {}
export const MAX_MINOR = 1_000_000_000_000;
export function integer(value: number, name: string, max = MAX_MINOR): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new DomainError(name + ' must be a bounded non-negative integer');
  return value;
}
export function currency(value: string): string {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) throw new DomainError('currency must be explicit ISO code');
  return value;
}
export function required(value: string, name: string, max=500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new DomainError(name + ' is required and bounded');
  return value.trim();
}
export function nullable(value: string | null, name: string, max=500): string | null {
  return value === null ? null : required(value,name,max);
}
export function oneOf<T extends string>(value: T, allowed: readonly T[], name: string): T {
  if (!allowed.includes(value)) throw new DomainError('unknown ' + name);
  return value;
}
export function limit(value: number | null): number | null { return value === null ? null : integer(value,'limit'); }
export function uuid(value: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) throw new DomainError('invalid UUID');
  return value.toLowerCase();
}
export function distinct(ids: string[]): void { if(new Set(ids).size!==ids.length) throw new DomainError('duplicate source ids'); }
