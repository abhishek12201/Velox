import { timingSafeEqual, createHmac, randomBytes } from 'node:crypto';

export function signConfirm(secret: string, holdId: string, planId: string): string {
  const payload = `${holdId}:${planId}`;
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function verifyConfirm(secret: string, holdId: string, planId: string, candidate: string): boolean {
  const expected = signConfirm(secret, holdId, planId);
  if (candidate.length !== expected.length) {
    return false;
  }

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(candidate, 'hex');
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function newSecretToken(): string {
  return randomBytes(16).toString('hex');
}
