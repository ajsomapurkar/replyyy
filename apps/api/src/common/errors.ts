export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
export const notFound = (what: string) => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const forbidden = (msg = 'You are not allowed to do that') => new AppError(403, 'FORBIDDEN', msg);
export const conflict = (code: string, msg: string, details?: unknown) => new AppError(409, code, msg, details);
export const badRequest = (msg: string, details?: unknown) => new AppError(400, 'VALIDATION_FAILED', msg, details);
