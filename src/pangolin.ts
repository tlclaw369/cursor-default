import { readLimitedText } from "./http";

const RESPONSE_LIMIT = 2_000_000;

export class PangolinApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PangolinApiError";
  }
}

export type PangolinSession = {
  baseUrl: string;
  orgId: string;
  apiKey: string;
};

export type PangolinDomain = {
  domainId: string;
  baseDomain: string;
  verified: boolean;
  type: string;
};

export type PangolinSite = {
  siteId: number;
  niceId: string;
  name: string;
  type: string;
  online: boolean;
};

export type PangolinResource = {
  resourceId: number;
  niceId: string;
  name: string;
  subdomain: string | null;
  fullDomain: string;
  domainId: string;
};

export type PangolinTarget = {
  targetId: number;
  resourceId: number;
  siteId: number;
  ip: string;
  method: string | null;
  port: number;
};

export type CreatePublicResourceInput = {
  name: string;
  domainId: string;
  subdomain: string | null;
  siteId: number;
  ip: string;
  port: number;
  method: "http" | "https";
};

type PangolinEnvelope<T> = {
  data?: T;
  success?: boolean;
  error?: boolean;
  message?: string;
  status?: number;
};

export type PangolinClient = {
  verify: () => Promise<void>;
  listDomains: () => Promise<PangolinDomain[]>;
  listSites: () => Promise<PangolinSite[]>;
  createPublicHttpResource: (input: CreatePublicResourceInput) => Promise<{
    resource: PangolinResource;
    target: PangolinTarget;
  }>;
  findPublicResourceByDomain: (fullDomain: string) => Promise<PangolinResource | null>;
  deletePublicResource: (resourceId: number) => Promise<void>;
};

export function createPangolinClient(session: PangolinSession, fetchImpl: typeof fetch = fetch): PangolinClient {
  const baseUrl = normalizeApiBase(session.baseUrl);

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${session.apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
          ...(init?.headers ?? {}),
        },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new PangolinApiError("Pangolin took too long to respond. Try again.", 504);
      }
      throw new PangolinApiError("Zoneboard could not reach Pangolin.", 502);
    }

    let payload: PangolinEnvelope<T> = {};
    try {
      const text = await readLimitedText(response.body, RESPONSE_LIMIT);
      payload = text ? (JSON.parse(text) as PangolinEnvelope<T>) : {};
    } catch (error) {
      if (error instanceof Error && error.message.includes("too large")) {
        throw new PangolinApiError("Pangolin returned a response that is too large.", 502);
      }
      throw new PangolinApiError("Pangolin returned a response Zoneboard could not read.", 502);
    }

    if (!response.ok || payload.success === false || payload.error === true) {
      throw new PangolinApiError(pangolinMessage(response.status, payload.message), response.status);
    }
    return payload.data as T;
  }

  return {
    async verify() {
      await request<{ domains?: unknown[] }>(`/org/${encodeURIComponent(session.orgId)}/domains?limit=1&offset=0`);
    },

    async listDomains() {
      const data = await request<{ domains?: Array<Record<string, unknown>> }>(
        `/org/${encodeURIComponent(session.orgId)}/domains?limit=1000&offset=0`,
      );
      return (data.domains ?? [])
        .filter((domain) => typeof domain.domainId === "string" && typeof domain.baseDomain === "string")
        .map((domain) => ({
          domainId: domain.domainId as string,
          baseDomain: domain.baseDomain as string,
          verified: Boolean(domain.verified),
          type: typeof domain.type === "string" ? domain.type : "",
        }));
    },

    async listSites() {
      const data = await request<{ sites?: Array<Record<string, unknown>>; data?: Array<Record<string, unknown>> }>(
        `/org/${encodeURIComponent(session.orgId)}/sites?page=1&pageSize=100`,
      );
      const items = data.sites ?? data.data ?? (Array.isArray(data) ? (data as unknown as Array<Record<string, unknown>>) : []);
      return items
        .filter((site) => typeof site.siteId === "number" && typeof site.name === "string")
        .map((site) => ({
          siteId: site.siteId as number,
          niceId: typeof site.niceId === "string" ? site.niceId : "",
          name: site.name as string,
          type: typeof site.type === "string" ? site.type : "",
          online: Boolean(site.online),
        }));
    },

    async createPublicHttpResource(input) {
      const resourceData = await request<Record<string, unknown>>(`/org/${encodeURIComponent(session.orgId)}/public-resource`, {
        method: "PUT",
        body: JSON.stringify({
          name: input.name,
          mode: "http",
          domainId: input.domainId,
          subdomain: input.subdomain,
        }),
      });
      const resource = mapResource(resourceData);
      if (!resource) {
        throw new PangolinApiError("Pangolin did not return the new public resource.", 502);
      }

      try {
        const targetData = await request<Record<string, unknown>>(`/public-resource/${resource.resourceId}/target`, {
          method: "PUT",
          body: JSON.stringify({
            siteId: input.siteId,
            ip: input.ip,
            port: input.port,
            method: input.method,
            mode: "http",
            enabled: true,
          }),
        });
        const target = mapTarget(targetData, resource.resourceId);
        if (!target) {
          throw new PangolinApiError("Pangolin did not return the new target.", 502);
        }
        return { resource, target };
      } catch (error) {
        try {
          await request<unknown>(`/public-resource/${resource.resourceId}`, { method: "DELETE" });
        } catch {
          // Keep the original create error.
        }
        throw error;
      }
    },

    async findPublicResourceByDomain(fullDomain: string) {
      const needle = fullDomain.trim().replace(/\.$/, "").toLowerCase();
      const data = await request<{ resources?: Array<Record<string, unknown>>; data?: Array<Record<string, unknown>> }>(
        `/org/${encodeURIComponent(session.orgId)}/public-resources?page=1&pageSize=200`,
      );
      const items = data.resources ?? data.data ?? [];
      for (const item of items) {
        const resource = mapResource(item);
        if (resource && resource.fullDomain.toLowerCase() === needle) return resource;
      }
      return null;
    },

    async deletePublicResource(resourceId: number) {
      await request<unknown>(`/public-resource/${resourceId}`, { method: "DELETE" });
    },
  };
}

export function normalizeApiBase(input: string): string {
  const trimmed = input.trim().replace(/\/$/, "");
  if (!trimmed) throw new PangolinApiError("Enter your Pangolin API base URL.", 400);
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new PangolinApiError("Enter a valid Pangolin API URL, such as https://api.pangolin.net/v1.", 400);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new PangolinApiError("The Pangolin API URL must start with https:// or http://.", 400);
  }
  let pathname = url.pathname.replace(/\/$/, "");
  if (!pathname.endsWith("/v1")) {
    pathname = `${pathname}/v1`.replace(/\/+/g, "/");
  }
  return `${url.origin}${pathname}`;
}

export function parsePangolinPublishInput(value: unknown): CreatePublicResourceInput | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new PangolinApiError("The Pangolin options have to be an object.", 400);
  }
  const input = value as Record<string, unknown>;
  if (input.create === false || input.enabled === false) return null;
  if (input.create !== true && input.enabled !== true) return null;

  const name = typeof input.name === "string" ? input.name.trim() : "";
  const domainId = typeof input.domainId === "string" ? input.domainId.trim() : "";
  const ip = typeof input.ip === "string" ? input.ip.trim() : "";
  const method = input.method === "https" ? "https" : input.method === "http" || input.method === undefined ? "http" : null;
  const siteId = typeof input.siteId === "number" ? input.siteId : typeof input.siteId === "string" ? Number(input.siteId) : Number.NaN;
  const port = typeof input.port === "number" ? input.port : typeof input.port === "string" ? Number(input.port) : Number.NaN;
  let subdomain: string | null = null;
  if (input.subdomain === null || input.subdomain === undefined || input.subdomain === "" || input.subdomain === "@") {
    subdomain = null;
  } else if (typeof input.subdomain === "string") {
    subdomain = input.subdomain.trim().replace(/\.$/, "");
  } else {
    throw new PangolinApiError("Enter a subdomain, or leave it blank for the base domain.", 400);
  }

  if (!name || name.length > 255) throw new PangolinApiError("Enter a Pangolin resource name.", 400);
  if (!domainId) throw new PangolinApiError("Choose a Pangolin domain.", 400);
  if (!Number.isInteger(siteId) || siteId <= 0) throw new PangolinApiError("Choose a Pangolin site.", 400);
  if (!ip) throw new PangolinApiError("Enter the target host or IP on the site network.", 400);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new PangolinApiError("Enter a target port from 1 to 65535.", 400);
  if (!method) throw new PangolinApiError("Choose http or https for the Pangolin target.", 400);
  if (subdomain !== null && !/^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/i.test(subdomain) && subdomain !== "*") {
    // allow multi-label subdomains like app.staging
    if (!/^(?:\*\.)?(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/i.test(subdomain)) {
      throw new PangolinApiError("Enter a valid Pangolin subdomain, such as app or staging.app.", 400);
    }
  }

  return { name, domainId, subdomain, siteId, ip, port, method };
}

function mapResource(data: Record<string, unknown>): PangolinResource | null {
  if (typeof data.resourceId !== "number") return null;
  return {
    resourceId: data.resourceId,
    niceId: typeof data.niceId === "string" ? data.niceId : "",
    name: typeof data.name === "string" ? data.name : "",
    subdomain: typeof data.subdomain === "string" ? data.subdomain : null,
    fullDomain: typeof data.fullDomain === "string" ? data.fullDomain : "",
    domainId: typeof data.domainId === "string" ? data.domainId : "",
  };
}

function mapTarget(data: Record<string, unknown>, resourceId: number): PangolinTarget | null {
  if (typeof data.targetId !== "number") return null;
  return {
    targetId: data.targetId,
    resourceId: typeof data.resourceId === "number" ? data.resourceId : resourceId,
    siteId: typeof data.siteId === "number" ? data.siteId : 0,
    ip: typeof data.ip === "string" ? data.ip : "",
    method: typeof data.method === "string" ? data.method : null,
    port: typeof data.port === "number" ? data.port : 0,
  };
}

function pangolinMessage(status: number, message: string | undefined): string {
  if (status === 401 || status === 403) {
    return message
      ? `Pangolin rejected this API key. ${message}`
      : "Pangolin rejected this API key. Create an organization API key with permission to manage public resources, domains, and sites.";
  }
  if (message) return message;
  return "Pangolin could not complete that request.";
}
