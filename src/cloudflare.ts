import { readLimitedText } from "./http";

const PAGE_LIMIT = 20;
const RESPONSE_LIMIT = 2_000_000;

export class CloudflareApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CloudflareApiError";
  }
}

export type ZoneSummary = {
  id: string;
  name: string;
  status: string;
  paused: boolean;
  type: string;
  nameServers: string[];
  accountName: string;
};

export type DnsRecordSummary = {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  proxiable: boolean;
  priority: number | null;
  comment: string;
  modifiedOn: string;
  weight: number | null;
  port: number | null;
  target: string;
};

type CfError = { message?: string };
type CfEnvelope<T> = {
  success?: boolean;
  errors?: CfError[];
  result?: T;
  result_info?: { page?: number; total_pages?: number };
};

type CfZone = {
  id?: string;
  name?: string;
  status?: string;
  paused?: boolean;
  type?: string;
  name_servers?: string[];
  account?: { name?: string };
};

type CfDnsRecord = {
  id?: string;
  type?: string;
  name?: string;
  content?: string;
  ttl?: number;
  proxied?: boolean;
  proxiable?: boolean;
  priority?: number;
  comment?: string | null;
  modified_on?: string;
  data?: {
    priority?: number;
    weight?: number;
    port?: number;
    target?: string;
  };
};

export type CloudflareClient = {
  verify: () => Promise<void>;
  listZones: () => Promise<{ zones: ZoneSummary[]; truncated: boolean }>;
  getZone: (zoneId: string) => Promise<ZoneSummary>;
  listRecords: (zoneId: string) => Promise<{ records: DnsRecordSummary[]; truncated: boolean }>;
  createRecord: (zoneId: string, body: unknown) => Promise<DnsRecordSummary>;
  updateRecord: (zoneId: string, recordId: string, body: unknown) => Promise<DnsRecordSummary>;
  deleteRecord: (zoneId: string, recordId: string) => Promise<void>;
};

export function createCloudflareClient(options: {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}): CloudflareClient {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetch ?? fetch;

  async function request<T>(path: string, init?: RequestInit): Promise<CfEnvelope<T>> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${options.token}`,
          "content-type": "application/json",
          ...(init?.headers ?? {}),
        },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new CloudflareApiError("Cloudflare took too long to respond. Try again.", 504);
      }
      throw new CloudflareApiError("Zoneboard could not reach Cloudflare.", 502);
    }

    let payload: CfEnvelope<T>;
    try {
      const text = await readLimitedText(response.body, RESPONSE_LIMIT);
      payload = text ? (JSON.parse(text) as CfEnvelope<T>) : {};
    } catch (error) {
      if (error instanceof Error && error.message.includes("too large")) {
        throw new CloudflareApiError("Cloudflare returned a response that is too large.", 502);
      }
      throw new CloudflareApiError("Cloudflare returned a response Zoneboard could not read.", 502);
    }

    if (!response.ok || payload.success === false) {
      throw new CloudflareApiError(cloudflareMessage(response.status, payload.errors), response.status);
    }
    return payload;
  }

  return {
    async verify() {
      await request<CfZone[]>("/zones?page=1&per_page=5");
    },

    async getZone(zoneId: string) {
      const payload = await request<CfZone>(`/zones/${zoneId}`);
      const zone = payload.result;
      if (!zone?.id || !zone.name) {
        throw new CloudflareApiError("Cloudflare did not return that domain.", 502);
      }
      return {
        id: zone.id,
        name: zone.name,
        status: zone.status ?? "unknown",
        paused: Boolean(zone.paused),
        type: zone.type ?? "full",
        nameServers: zone.name_servers ?? [],
        accountName: zone.account?.name ?? "",
      };
    },

    async listZones() {
      const { items, truncated } = await listPages<CfZone>((page) =>
        request<CfZone[]>(`/zones?page=${page}&per_page=50&order=name&direction=asc`),
      );
      return {
        truncated,
        zones: items
          .filter((zone): zone is CfZone & { id: string; name: string } => Boolean(zone.id && zone.name))
          .map((zone) => ({
            id: zone.id,
            name: zone.name,
            status: zone.status ?? "unknown",
            paused: Boolean(zone.paused),
            type: zone.type ?? "full",
            nameServers: zone.name_servers ?? [],
            accountName: zone.account?.name ?? "",
          })),
      };
    },

    async listRecords(zoneId: string) {
      const { items, truncated } = await listPages<CfDnsRecord>((page) =>
        request<CfDnsRecord[]>(`/zones/${zoneId}/dns_records?page=${page}&per_page=100`),
      );
      return {
        truncated,
        records: items
          .filter((record): record is CfDnsRecord & { id: string } => Boolean(record.id))
          .map(toRecordSummary),
      };
    },

    async createRecord(zoneId: string, body: unknown) {
      const payload = await request<CfDnsRecord>(`/zones/${zoneId}/dns_records`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      const result = payload.result;
      if (!result?.id) {
        throw new CloudflareApiError("Cloudflare did not return the new record.", 502);
      }
      return toRecordSummary({ ...result, id: result.id });
    },

    async updateRecord(zoneId: string, recordId: string, body: unknown) {
      const payload = await request<CfDnsRecord>(`/zones/${zoneId}/dns_records/${recordId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      const result = payload.result;
      if (!result?.id) {
        throw new CloudflareApiError("Cloudflare did not return the updated record.", 502);
      }
      return toRecordSummary({ ...result, id: result.id });
    },

    async deleteRecord(zoneId: string, recordId: string) {
      await request<unknown>(`/zones/${zoneId}/dns_records/${recordId}`, { method: "DELETE" });
    },
  };
}

async function listPages<T>(fetchPage: (page: number) => Promise<CfEnvelope<T[]>>): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const payload = await fetchPage(page);
    items.push(...(payload.result ?? []));
    totalPages = payload.result_info?.total_pages ?? 1;
    page += 1;
  } while (page <= totalPages && page <= PAGE_LIMIT);
  return { items, truncated: totalPages > PAGE_LIMIT };
}

function toRecordSummary(record: CfDnsRecord & { id: string }): DnsRecordSummary {
  const data = record.data;
  let priority = record.priority ?? data?.priority ?? null;
  let weight = data?.weight ?? null;
  let port = data?.port ?? null;
  let target = data?.target ?? "";
  if (record.type === "SRV" && !target && record.content) {
    const parts = record.content.trim().split(/\s+/);
    if (parts.length >= 4) {
      priority = priority ?? numberOrNull(parts[0]);
      weight = weight ?? numberOrNull(parts[1]);
      port = port ?? numberOrNull(parts[2]);
      target = parts.slice(3).join(" ");
    }
  }
  const content =
    record.content ||
    (target ? [priority, weight, port, target].filter((part) => part !== null && part !== "").join(" ") : "");
  return {
    id: record.id,
    type: record.type ?? "",
    name: record.name ?? "",
    content,
    ttl: record.ttl ?? 1,
    proxied: Boolean(record.proxied),
    proxiable: Boolean(record.proxiable),
    priority,
    comment: record.comment ?? "",
    modifiedOn: record.modified_on ?? "",
    weight,
    port,
    target,
  };
}

function numberOrNull(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return parsed <= 65535 ? parsed : null;
}

function cloudflareMessage(status: number, errors: CfError[] | undefined): string {
  const detail = errors?.map((error) => error.message).filter(Boolean).join(" ");
  if (status === 401 || status === 403) {
    return detail
      ? `Cloudflare rejected this token. ${detail}`
      : "Cloudflare rejected this token. Create one with the Edit zone DNS template, which includes Zone Read and DNS Edit.";
  }
  if (detail) return detail;
  return "Cloudflare could not complete that request.";
}
