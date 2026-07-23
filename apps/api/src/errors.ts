import type { ApiError, ApiErrorCode } from '@outtrace/contracts';

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }

  toResponse(): ApiError {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export function authenticationRequired(): HttpError {
  return new HttpError(
    401,
    'AUTHENTICATION_REQUIRED',
    'Both x-outtrace-key-id and x-outtrace-key headers are required.',
  );
}

export function authenticationInvalid(): HttpError {
  return new HttpError(401, 'AUTHENTICATION_INVALID', 'The ingestion credentials are invalid.');
}

export function databaseFailure(): HttpError {
  return new HttpError(
    503,
    'DATABASE_FAILURE',
    'The event could not be persisted. Please retry safely with the same eventId.',
  );
}
