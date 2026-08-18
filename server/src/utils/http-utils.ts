import type http from "node:http";

const MAX_PAYLOAD = 32 * 1024 * 1024; // 32MB

export class HttpError extends Error {
  // Declared and assigned explicitly rather than as a constructor parameter property: Node runs
  // TypeScript in strip-only mode, which removes types but cannot synthesise the field assignment
  // a parameter property implies, so CI fails to even load this module.
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * Reads the request body stream and parses it as JSON.
 * Throws HttpError on payload size exceeded or invalid JSON.
 */
export async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  let bodyText = "";
  try {
    for await (const chunk of req) {
      bodyText += chunk;
      if (bodyText.length > MAX_PAYLOAD) {
        throw new HttpError(413, "Payload Too Large");
      }
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "Request read error");
  }

  if (bodyText.trim()) {
    try {
      return JSON.parse(bodyText);
    } catch {
      throw new HttpError(400, "Invalid JSON");
    }
  }

  return null;
}
