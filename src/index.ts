import { CloudflareApiError, createCloudflareClient } from "./cloudflare";
import {
  HttpError,
  assertSameOrigin,
  clearPangolinSessionCookie,
  clearSessionCookie,
  isAcceptableOrgId,
  isAcceptablePangolinKey,
  isAcceptableToken,
  json,
  jsonError,
  pangolinSessionCookie,
  readJson,
  readPangolinSession,
  readSessionToken,
  sessionCookie,
  withSecurityHeaders,
} from "./http";
import {
  PangolinApiError,
  createPangolinClient,
  normalizeApiBase,
  parsePangolinPublishInput,
} from "./pangolin";
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
    if (error instanceof PangolinApiError) {
      const status = error.status === 401 || error.status === 403 ? 401 : error.status >= 400 && error.status < 500 ? error.status : 502;
      return jsonError(status, error.message);
    }
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

  if (url.pathname === "/api/pangolin/session" && request.method === "GET") {
    const session = readPangolinSession(request);
    return json({
      connected: session !== null,
      baseUrl: session?.baseUrl ?? "",
      orgId: session?.orgId ?? "",
    });
  }

  if (url.pathname === "/api/pangolin/session" && request.method === "POST") {
    assertSameOrigin(request);
    const body = await readJson(request);
    if (!isRecord(body)) throw new HttpError(400, "Request body must be JSON.");
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    const orgId = typeof body.orgId === "string" ? body.orgId.trim() : "";
    const baseUrlRaw = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
    if (!isAcceptablePangolinKey(apiKey)) {
      throw new HttpError(400, "Paste the Pangolin organization API key shown once when the key is created.");
    }
    if (!isAcceptableOrgId(orgId)) {
      throw new HttpError(400, "Enter your Pangolin organization ID.");
    }
    const baseUrl = normalizeApiBase(baseUrlRaw || "https://api.pangolin.net/v1");
    const session = { baseUrl, orgId, apiKey };
    const client = createPangolinClient(session);
    await client.verify();
    return json(
      { connected: true, baseUrl, orgId },
      200,
      { "set-cookie": pangolinSessionCookie(session, request) },
    );
  }

  if (url.pathname === "/api/pangolin/session" && request.method === "DELETE") {
    assertSameOrigin(request);
    return json({ connected: false }, 200, { "set-cookie": clearPangolinSessionCookie(request) });
  }

  if (url.pathname === "/api/pangolin/domains" && request.method === "GET") {
    const session = requirePangolin(request);
    return json({ domains: await createPangolinClient(session).listDomains() });
  }

  if (url.pathname === "/api/pangolin/sites" && request.method === "GET") {
    const session = requirePangolin(request);
    return json({ sites: await createPangolinClient(session).listSites() });
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
    const payload = await readJson(request);
    if (!isRecord(payload)) throw new HttpError(400, "Request body must be JSON.");
    const { pangolin: pangolinRaw, deletePangolin: _ignored, ...dnsFields } = payload;
    const body = buildRecordBody(dnsFields as RecordInput, zone.name);
    const pangolinInput = parsePangolinPublishInput(pangolinRaw);
    const record = await client.createRecord(zoneId, body);

    if (!pangolinInput) {
      return json({ record }, 201);
    }

    const pangolinSession = requirePangolin(request);
    const pangolin = createPangolinClient(pangolinSession);
    try {
      const published = await pangolin.createPublicHttpResource(pangolinInput);
      return json({ record, pangolin: published }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Pangolin could not create the public resource.";
      return json(
        {
          record,
          pangolinError: message,
          warning: `The DNS record was created, but Pangolin did not create the public resource. ${message}`,
        },
        201,
      );
    }
  }

  if (recordId && request.method === "PATCH") {
    assertSameOrigin(request);
    const zone = await client.getZone(zoneId);
    const payload = await readJson(request);
    if (!isRecord(payload)) throw new HttpError(400, "Request body must be JSON.");
    const { pangolin: _pangolin, deletePangolin: _delete, ...dnsFields } = payload;
    const body = buildRecordBody(dnsFields as RecordInput, zone.name);
    return json({ record: await client.updateRecord(zoneId, recordId, body) });
  }

  if (recordId && request.method === "DELETE") {
    assertSameOrigin(request);
    const removePangolin = url.searchParams.get("pangolin") === "1";
    let pangolinDeleted: { resourceId: number; fullDomain: string } | null = null;
    let pangolinError: string | undefined;

    if (removePangolin) {
      const pangolinSession = requirePangolin(request);
      const listed = await client.listRecords(zoneId);
      const existing = listed.records.find((item) => item.id === recordId);
      if (existing?.name) {
        try {
          const pangolin = createPangolinClient(pangolinSession);
          const resource = await pangolin.findPublicResourceByDomain(existing.name);
          if (resource) {
            await pangolin.deletePublicResource(resource.resourceId);
            pangolinDeleted = { resourceId: resource.resourceId, fullDomain: resource.fullDomain };
          }
        } catch (error) {
          pangolinError = error instanceof Error ? error.message : "Pangolin could not delete the public resource.";
        }
      }
    }

    await client.deleteRecord(zoneId, recordId);
    return json({
      deleted: true,
      pangolin: pangolinDeleted,
      ...(pangolinError ? { pangolinError, warning: `The DNS record was removed, but Pangolin was not updated. ${pangolinError}` } : {}),
    });
  }

  throw new HttpError(405, "That action is not available.");
}

function requirePangolin(request: Request) {
  const session = readPangolinSession(request);
  if (!session) {
    throw new HttpError(401, "Connect your Pangolin organization to continue.");
  }
  return session;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
