export class IntegrationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = "IntegrationError";
  }
}

export function connectionStateConflict(message = "连接状态已变化，请刷新后重试") {
  return new IntegrationError("INTEGRATION_CONNECTION_STATE_CONFLICT", message, 409);
}

export function integrationNotFound(message = "集成对象不存在或无权访问") {
  return new IntegrationError("INTEGRATION_NOT_FOUND", message, 404);
}
