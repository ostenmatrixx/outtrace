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

export function operatorAuthenticationRequired(): HttpError {
  return new HttpError(
    401,
    'AUTHENTICATION_REQUIRED',
    'Both x-outtrace-operator-key-id and x-outtrace-operator-key headers are required.',
  );
}

export function operatorAuthenticationInvalid(): HttpError {
  return new HttpError(401, 'AUTHENTICATION_INVALID', 'The operator credentials are invalid.');
}

export function databaseFailure(): HttpError {
  return new HttpError(
    503,
    'DATABASE_FAILURE',
    'The database operation failed. Please retry safely.',
  );
}

export function authorizationForbidden(): HttpError {
  return new HttpError(403, 'AUTHORIZATION_FORBIDDEN', 'This operator cannot perform that action.');
}

export function resourceNotFound(
  code: 'CLIENT_NOT_FOUND' | 'MEMBER_NOT_FOUND' | 'PROCESS_NOT_FOUND',
  label: string,
): HttpError {
  return new HttpError(404, code, `The ${label} does not exist.`);
}

export function resourceConflict(message: string): HttpError {
  return new HttpError(409, 'RESOURCE_CONFLICT', message);
}
