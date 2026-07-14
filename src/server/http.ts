export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

export function requiredString(
  value: unknown,
  code: string,
  message: string,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(code, message);
  }
  return value.trim();
}

export function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
