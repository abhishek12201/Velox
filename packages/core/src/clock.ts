let current = new Date();

export function now(): string {
  return current.toISOString();
}

export function set(iso: string): string {
  current = new Date(iso);
  return current.toISOString();
}

export function plusHours(hours: number): string {
  current = new Date(current.getTime() + hours * 60 * 60 * 1000);
  return current.toISOString();
}

export function reset(): string {
  current = new Date();
  return current.toISOString();
}

export function nowDate(): Date {
  return new Date(current);
}
