export type ErrorCode = 'NOT_FOUND' | 'SOLD_OUT' | 'HOLD_EXPIRED' | 'FORBIDDEN' | 'INVALID';

export interface ErrorResult {
  isError: true;
  structuredContent: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
  };
  content: Array<{ type: 'text'; text: string }>;
}

export function makeError(code: ErrorCode, message: string, retryable = false): ErrorResult {
  return {
    isError: true,
    structuredContent: { code, message, retryable },
    content: [{ type: 'text', text: message }],
  };
}
