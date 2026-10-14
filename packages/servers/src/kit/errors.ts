export type ErrorCode = 'NOT_FOUND' | 'SOLD_OUT' | 'HOLD_EXPIRED' | 'FORBIDDEN' | 'INVALID';

export interface ErrorResult {
  isError: true;
  content: Array<{ type: 'text'; text: string }>;
}

export function makeError(code: ErrorCode, message: string, retryable = false): ErrorResult {
  const details = { isError: true, code, message, retryable };
  return {
    content: [{ type: 'text', text: JSON.stringify(details) }],
    isError: true,
  };
}

export function makeStructuredToolError(code: ErrorCode, message: string, retryable = false) {
  const structuredContent = { isError: true as const, code, message, retryable };
  return {
    content: [{ type: 'text' as const, text: message }],
    structuredContent,
  };
}
