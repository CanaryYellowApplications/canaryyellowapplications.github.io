export class ServiceError extends Error {
  constructor(code, status = 400, message = "The request could not be completed.") {
    super(message);
    this.name = "ServiceError";
    this.code = code;
    this.status = status;
  }
}

export function isServiceError(error) {
  return error instanceof ServiceError;
}
