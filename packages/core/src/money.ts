export function inr(value: number): string {
  const numeric = Math.round(Math.abs(value));
  const sign = value < 0 ? '-' : '';
  const digits = String(numeric);

  if (digits.length <= 3) {
    return `${sign}₹${digits}`;
  }

  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const chunks: string[] = [];
  let remainder = rest;

  while (remainder.length > 2) {
    chunks.unshift(remainder.slice(-2));
    remainder = remainder.slice(0, -2);
  }

  if (remainder.length > 0) {
    chunks.unshift(remainder);
  }

  return `${sign}₹${chunks.join(',')},${last3}`;
}
