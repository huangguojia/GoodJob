export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    message: string
  ) {
    super(message);
    this.name = "DomainError";
  }
}
