export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, msg: string, details?: unknown) => new AppError(400, code, msg, details);
export const unauthorized = (msg = 'Authentication required') => new AppError(401, 'unauthorized', msg);
export const forbidden = (msg = 'Not permitted') => new AppError(403, 'forbidden', msg);
export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (code: string, msg: string) => new AppError(409, code, msg);
export const unprocessable = (code: string, msg: string) => new AppError(422, code, msg);
export const notConfigured = (what: string) =>
  new AppError(503, 'provider_not_configured', `${what} is not configured on this deployment`);
