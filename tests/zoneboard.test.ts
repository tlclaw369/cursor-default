import { afterEach, describe, expect, it, vi } from "vitest";
import { createCloudflareClient } from "../src/cloudflare";
import { handleRequest } from "../src/index";
import { displayName, qualifyName } from "../src/names";
import { buildRecordBody } from "../src/records";

const TOKEN = "cfut_test_token_value_123456";
const ZONE_ID = "023e105f4ecef8ad9ca31a8372d0c353";
const RECORD_ID = "372e67954025e0ba6aaa6d586b9e0b59";

function env(): Env {
  return {
    API_BASE_URL: "https://cloudflare.test/client/v4",
    ASSETS: {
      fetch: async () =>
        new Response("<!doctype html><title>Zoneboard</title>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    },
  } as unknown as Env;
}

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (!headers.has("origin")) headers.set("origin", "https://zoneboard.test");
  return new Request(`https://zoneboard.test${path}`, { ...init, headers });
}

describe("names", () => {
  it("turns a short name into the full domain", () => {
    expect(qualifyName("www", "Example.com")).toBe("www.Example.com");
    expect(qualifyName("@", "example.com")).toBe("example.com");
    expect(qualifyName("www.example.com", "example.com")).toBe("www.example.com");
  });

  it("shows the root as @", () => {
    expect(displayName("example.com", "example.com")).toBe("@");
    expect(displayName("www.example.com.", "example.com")).toBe("www");
  });
});

describe("record validation", () => {
  it("builds an A record and forces automatic TTL when proxied", () => {
    expect(
      buildRecordBody({ type: "A", name: "www", content: "192.0.2.10", ttl: 300, proxied: true }, "example.com"),
    ).toEqual({
      type: "A",
      name: "www.example.com",
      content: "192.0.2.10",
      ttl: 1,
      proxied: true,
    });
  });

  it("rejects a bad address and a CNAME that points at itself", () => {
    expect(() => buildRecordBody({ type: "A", name: "@", content: "192.0.2" }, "example.com")).toThrow(/IPv4/);
    expect(() => buildRecordBody({ type: "CNAME", name: "www", content: "www.example.com" }, "example.com")).toThrow(/own name/);
  });

  it("builds MX and SRV records", () => {
    expect(
      buildRecordBody({ type: "MX", name: "@", content: "mail.example.com.", priority: 10, ttl: 3600 }, "example.com"),
    ).toMatchObject({
      type: "MX",
      name: "example.com",
      content: "mail.example.com",
      priority: 10,
      ttl: 3600,
    });
    expect(
      buildRecordBody(
        { type: "SRV", name: "_sip._tcp", priority: 1, weight: 5, port: 5060, target: "sip.example.com" },
        "example.com",
      ),
    ).toEqual({
      type: "SRV",
      name: "_sip._tcp.example.com",
      ttl: 1,
      data: { priority: 1, weight: 5, port: 5060, target: "sip.example.com" },
    });
  });

  it("keeps a trailing period in TXT content", () => {
    expect(buildRecordBody({ type: "TXT", name: "@", content: "v=spf1 -all." }, "example.com").content).toBe("v=spf1 -all.");
  });
});

describe("cloudflare client", () => {
  it("follows pages and maps zones", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const page = url.searchParams.get("page");
      const result =
        page === "1"
          ? [
              {
                id: ZONE_ID,
                name: "example.com",
                status: "active",
                paused: false,
                type: "full",
                name_servers: ["a.ns"],
                account: { name: "Studio" },
              },
            ]
          : [{ id: "11111111111111111111111111111111", name: "other.test", status: "pending", name_servers: [] }];
      return Response.json({
        success: true,
        result,
        result_info: { page: Number(page), total_pages: 2 },
      });
    });
    const client = createCloudflareClient({
      baseUrl: "https://cloudflare.test/client/v4",
      token: TOKEN,
      fetch: fetchImpl,
    });
    const listed = await client.listZones();
    expect(listed.zones.map((zone) => zone.name)).toEqual(["example.com", "other.test"]);
    expect(listed.truncated).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("uses the Cloudflare error message", async () => {
    const client = createCloudflareClient({
      baseUrl: "https://cloudflare.test/client/v4",
      token: TOKEN,
      fetch: async () => Response.json({ success: false, errors: [{ message: "Record already exists." }] }, { status: 400 }),
    });
    await expect(client.deleteRecord(ZONE_ID, RECORD_ID)).rejects.toThrow("Record already exists.");
  });
});

describe("http routes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serves the page with security headers", async () => {
    const response = await handleRequest(request("/"), env());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Zoneboard");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("connects a token, lists records, and removes one", async () => {
    const records = [
      {
        id: RECORD_ID,
        type: "A",
        name: "example.com",
        content: "192.0.2.1",
        ttl: 1,
        proxied: true,
        proxiable: true,
      },
    ];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/zones") && (!init?.method || init.method === "GET")) {
        return Response.json({
          success: true,
          result: [
            {
              id: ZONE_ID,
              name: "example.com",
              status: "active",
              name_servers: ["a.ns"],
              account: { name: "Studio" },
            },
          ],
          result_info: { page: 1, total_pages: 1 },
        });
      }
      if (url.pathname === `/client/v4/zones/${ZONE_ID}`) {
        return Response.json({ success: true, result: { id: ZONE_ID, name: "example.com", status: "active" } });
      }
      if (url.pathname.endsWith("/dns_records") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        const created = {
          id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          proxiable: true,
          ...body,
        };
        records.push(created as (typeof records)[number]);
        return Response.json({ success: true, result: created });
      }
      if (url.pathname.endsWith(`/dns_records/${RECORD_ID}`) && init?.method === "DELETE") {
        records.splice(0, 1);
        return Response.json({ success: true, result: { id: RECORD_ID } });
      }
      if (url.pathname.endsWith("/dns_records")) {
        return Response.json({ success: true, result: records, result_info: { page: 1, total_pages: 1 } });
      }
      return Response.json({ success: false, errors: [{ message: "unexpected" }] }, { status: 500 });
    });

    const connected = await handleRequest(
      request("/api/session", { method: "POST", body: JSON.stringify({ token: TOKEN }) }),
      env(),
    );
    expect(connected.status).toBe(200);
    const cookie = connected.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(decodeURIComponent(cookie)).toContain(TOKEN);
    const session = cookie.split(";")[0] ?? "";

    const zones = await handleRequest(request("/api/zones", { headers: { cookie: session } }), env());
    expect(await zones.json()).toMatchObject({ zones: [{ name: "example.com", accountName: "Studio" }] });

    const created = await handleRequest(
      request(`/api/zones/${ZONE_ID}/records`, {
        method: "POST",
        headers: { cookie: session },
        body: JSON.stringify({ type: "A", name: "www", content: "192.0.2.20", proxied: false }),
      }),
      env(),
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { record: { content: string; name: string } };
    expect(createdBody.record.content).toBe("192.0.2.20");
    expect(createdBody.record.name).toBe("www.example.com");

    const removed = await handleRequest(
      request(`/api/zones/${ZONE_ID}/records/${RECORD_ID}`, { method: "DELETE", headers: { cookie: session } }),
      env(),
    );
    expect(removed.status).toBe(200);
    expect(records.map((record) => record.id)).not.toContain(RECORD_ID);
  });

  it("refuses actions from another site and requests without a session", async () => {
    const foreign = await handleRequest(
      new Request("https://zoneboard.test/api/session", {
        method: "POST",
        headers: { origin: "https://evil.test", "content-type": "application/json" },
        body: JSON.stringify({ token: TOKEN }),
      }),
      env(),
    );
    expect(foreign.status).toBe(403);

    const missing = await handleRequest(request("/api/zones"), env());
    expect(missing.status).toBe(401);
  });
});
