import { CloudflareApiError, createCloudflareClient } from "./cloudflare";
import {
  HttpError,
  assertSameOrigin,
  clearSessionCookie,
  isAcceptableToken,
  json,
  jsonError,
  readJson,
  readSessionToken,
  sessionCookie,
  withSecurityHeaders,
} from "./http";
import { RecordValidationError, buildRecordBody, type RecordInput } from "./records";

const ZONE_ID = /^[a-f0-9]{32}$/i;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname.startsWith("/api/")) {
      return await routeApi(request, env, url);
    }
    const asset = await env.ASSETS.fetch(request);
    return withSecurityHeaders(asset);
  } catch (error) {
    if (error instanceof HttpError) return jsonError(error.status, error.message);
    if (error instanceof RecordValidationError) return jsonError(400, error.message);
    if (error instanceof CloudflareApiError) {
      const status = error.status === 401 || error.status === 403 ? 401 : error.status >= 400 && error.status < 500 ? error.status : 502;
      return jsonError(status, error.message);
    }
    console.error(JSON.stringify({ message: "request failed" }));
    return jsonError(500, "Zoneboard hit an unexpected error. Try again.");
  }
}

async function routeApi(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/api/health" && request.method === "GET") {
    return json({ ok: true });
  }

  if (url.pathname === "/api/session" && request.method === "GET") {
    return json({ connected: readSessionToken(request) !== null });
  }

  if (url.pathname === "/api/session" && request.method === "POST") {
    assertSameOrigin(request);
    const body = await readJson(request);
    const token = isRecord(body) && typeof body.token === "string" ? body.token.trim() : "";
    if (!isAcceptableToken(token)) {
      throw new HttpError(400, "Paste the API token from Cloudflare. It should be the long value shown once when the token is created.");
    }
    const client = createCloudflareClient({ baseUrl: env.API_BASE_URL, token });
    await client.verify();
    return json({ connected: true }, 200, { "set-cookie": sessionCookie(token, request) });
  }

  if (url.pathname === "/api/session" && request.method === "DELETE") {
    assertSameOrigin(request);
    return json({ connected: false }, 200, { "set-cookie": clearSessionCookie(request) });
  }

  const token = readSessionToken(request);
  if (!token) {
    throw new HttpError(401, "Connect your Cloudflare account to continue.");
  }
  const client = createCloudflareClient({ baseUrl: env.API_BASE_URL, token });

  if (url.pathname === "/api/zones" && request.method === "GET") {
    return json(await client.listZones());
  }

  const recordsMatch = url.pathname.match(/^\/api\/zones\/([a-f0-9]{32})\/records(?:\/([a-f0-9]{32}))?$/i);
  if (!recordsMatch) {
    throw new HttpError(404, "That page does not exist.");
  }
  const zoneId = recordsMatch[1];
  const recordId = recordsMatch[2];
  if (!zoneId || !ZONE_ID.test(zoneId) || (recordId && !ZONE_ID.test(recordId))) {
    throw new HttpError(404, "That page does not exist.");
  }

  if (!recordId && request.method === "GET") {
    return json(await client.listRecords(zoneId));
  }

  if (!recordId && request.method === "POST") {
    assertSameOrigin(request);
    const zone = await client.getZone(zoneId);
    const input = (await readJson(request)) as RecordInput;
    const body = buildRecordBody(input, zone.name);
    return json({ record: await client.createRecord(zoneId, body) }, 201);
  }

  if (recordId && request.method === "PATCH") {
    assertSameOrigin(request);
    const zone = await client.getZone(zoneId);
    const input = (await readJson(request)) as RecordInput;
    const body = buildRecordBody(input, zone.name);
    return json({ record: await client.updateRecord(zoneId, recordId, body) });
  }

  if (recordId && request.method === "DELETE") {
    assertSameOrigin(request);
    await client.deleteRecord(zoneId, recordId);
    return json({ deleted: true });
  }

  throw new HttpError(405, "That action is not available.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
