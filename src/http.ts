export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function json(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

export function jsonError(status: number, message: string, extraHeaders?: HeadersInit): Response {
  return json({ error: message }, status, extraHeaders);
}

const SESSION_COOKIE = "zoneboard_session";
const SESSION_MAX_AGE = 60 * 60 * 8;

export function readSessionToken(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const name = trimmed.slice(0, separator);
    if (name !== SESSION_COOKIE) continue;
    const raw = trimmed.slice(separator + 1);
    try {
      const token = decodeURIComponent(raw);
      return isAcceptableToken(token) ? token : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function sessionCookie(token: string, request: Request): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_MAX_AGE}${secureFlag(request)}`;
}

export function clearSessionCookie(request: Request): string {
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${secureFlag(request)}`;
}

export function isAcceptableToken(token: string): boolean {
  return token.length >= 20 && token.length <= 400 && /^[\x21-\x7E]+$/.test(token) && !/[;,\s]/.test(token);
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const expected = new URL(request.url).origin;
  if (origin !== expected) {
    throw new HttpError(403, "This action has to come from the Zoneboard page.");
  }
}

export async function readJson(request: Request, maxBytes = 20_000): Promise<unknown> {
  const text = await readLimitedText(request.body, maxBytes);
  if (!text) {
    throw new HttpError(400, "Request body must be JSON.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "Request body must be JSON.");
  }
}

export async function readLimitedText(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, "That response was too large to read.");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "The request body could not be read.");
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function secureFlag(request: Request): string {
  return new URL(request.url).protocol === "https:" ? "; Secure" : "";
}

export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-frame-options", "DENY");
  headers.set(
    "content-security-policy",
    "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  );
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
