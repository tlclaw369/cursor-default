import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../src/index";
import {
  createPangolinClient,
  normalizeApiBase,
  parsePangolinPublishInput,
} from "../src/pangolin";

const CF_TOKEN = "cfut_test_token_value_123456";
const PG_KEY = "pg_test_api_key_value_123456";
const ZONE_ID = "023e105f4ecef8ad9ca31a8372d0c353";

function env(): Env {
  return {
    API_BASE_URL: "https://cloudflare.test/client/v4",
    ASSETS: {
      fetch: async () => new Response("<!doctype html><title>Zoneboard</title>"),
    },
  } as unknown as Env;
}

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (!headers.has("origin")) headers.set("origin", "https://zoneboard.test");
  return new Request(`https://zoneboard.test${path}`, { ...init, headers });
}

describe("pangolin helpers", () => {
  it("normalizes API base URLs to end with /v1", () => {
    expect(normalizeApiBase("https://api.pangolin.net")).toBe("https://api.pangolin.net/v1");
    expect(normalizeApiBase("https://api.example.com/v1/")).toBe("https://api.example.com/v1");
  });

  it("parses publish options", () => {
    expect(
      parsePangolinPublishInput({
        create: true,
        name: "App",
        domainId: "dom1",
        subdomain: "app",
        siteId: 42,
        ip: "localhost",
        port: 8080,
        method: "http",
      }),
    ).toEqual({
      name: "App",
      domainId: "dom1",
      subdomain: "app",
      siteId: 42,
      ip: "localhost",
      port: 8080,
      method: "http",
    });
    expect(parsePangolinPublishInput({ create: false })).toBeNull();
  });
});

describe("pangolin client", () => {
  it("creates a public resource and target", async () => {
    const calls: string[] = [];
    const client = createPangolinClient(
      { baseUrl: "https://pangolin.test/v1", orgId: "demo-org", apiKey: PG_KEY },
      async (input, init) => {
        const url = new URL(String(input));
        calls.push(`${init?.method || "GET"} ${url.pathname}`);
        if (url.pathname.endsWith("/public-resource") && init?.method === "PUT") {
          return Response.json({
            success: true,
            data: {
              resourceId: 10,
              niceId: "app",
              name: "App",
              subdomain: "app",
              fullDomain: "app.example.com",
              domainId: "dom1",
            },
          });
        }
        if (url.pathname.endsWith("/target") && init?.method === "PUT") {
          return Response.json({
            success: true,
            data: { targetId: 20, resourceId: 10, siteId: 42, ip: "localhost", method: "http", port: 8080 },
          });
        }
        return Response.json({ success: false, message: "unexpected" }, { status: 500 });
      },
    );

    const result = await client.createPublicHttpResource({
      name: "App",
      domainId: "dom1",
      subdomain: "app",
      siteId: 42,
      ip: "localhost",
      port: 8080,
      method: "http",
    });
    expect(result.resource.fullDomain).toBe("app.example.com");
    expect(result.target.port).toBe(8080);
    expect(calls).toEqual(["PUT /v1/org/demo-org/public-resource", "PUT /v1/public-resource/10/target"]);
  });
});

describe("dns + pangolin create", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates the DNS record and Pangolin public resource together", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === "cloudflare.test") {
        if (url.pathname === `/client/v4/zones/${ZONE_ID}`) {
          return Response.json({ success: true, result: { id: ZONE_ID, name: "example.com", status: "active" } });
        }
        if (url.pathname.endsWith("/dns_records") && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          return Response.json({
            success: true,
            result: {
              id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              type: body.type,
              name: body.name,
              content: body.content,
              ttl: body.ttl ?? 1,
              proxied: false,
              proxiable: true,
            },
          });
        }
        return Response.json({ success: false, errors: [{ message: "unexpected cf" }] }, { status: 500 });
      }

      if (url.hostname === "pangolin.test") {
        if (url.pathname.endsWith("/domains")) {
          return Response.json({
            success: true,
            data: { domains: [{ domainId: "dom1", baseDomain: "example.com", verified: true, type: "ns" }] },
          });
        }
        if (url.pathname.endsWith("/public-resource") && init?.method === "PUT") {
          return Response.json({
            success: true,
            data: {
              resourceId: 99,
              niceId: "app",
              name: "app",
              subdomain: "app",
              fullDomain: "app.example.com",
              domainId: "dom1",
            },
          });
        }
        if (url.pathname.endsWith("/target") && init?.method === "PUT") {
          return Response.json({
            success: true,
            data: { targetId: 11, resourceId: 99, siteId: 42, ip: "10.0.0.5", method: "http", port: 3000 },
          });
        }
      }
      return Response.json({ success: false, message: "unexpected" }, { status: 500 });
    });

    const pangolinCookie = encodeURIComponent(
      JSON.stringify({ baseUrl: "https://pangolin.test/v1", orgId: "demo-org", apiKey: PG_KEY }),
    );
    const response = await handleRequest(
      request(`/api/zones/${ZONE_ID}/records`, {
        method: "POST",
        headers: {
          cookie: `zoneboard_session=${CF_TOKEN}; zoneboard_pangolin=${pangolinCookie}`,
        },
        body: JSON.stringify({
          type: "A",
          name: "app",
          content: "192.0.2.50",
          ttl: 300,
          pangolin: {
            create: true,
            name: "app",
            domainId: "dom1",
            subdomain: "app",
            siteId: 42,
            ip: "10.0.0.5",
            port: 3000,
            method: "http",
          },
        }),
      }),
      env(),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      record: { name: string };
      pangolin: { resource: { fullDomain: string }; target: { port: number } };
    };
    expect(body.record.name).toBe("app.example.com");
    expect(body.pangolin.resource.fullDomain).toBe("app.example.com");
    expect(body.pangolin.target.port).toBe(3000);
  });
});
