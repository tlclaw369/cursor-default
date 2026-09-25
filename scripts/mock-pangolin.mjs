import { createServer } from "node:http";

const orgId = "demo-org";
const domains = [
  {
    domainId: "pgdomain001",
    baseDomain: "example.com",
    verified: true,
    type: "ns",
    failed: false,
    tries: 0,
    configManaged: false,
    certResolver: null,
    preferWildcardCert: null,
    errorMessage: null,
  },
];

const sites = [
  {
    siteId: 42,
    niceId: "home-lab",
    name: "Home lab",
    type: "newt",
    online: true,
  },
];

const resources = [];
let nextResourceId = 1000;
let nextTargetId = 2000;

const port = Number(process.env.PORT || 4000);
const host = process.env.HOST || "0.0.0.0";

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${host}:${port}`);
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (token.length < 20) {
    send(res, 401, { success: false, error: true, message: "Invalid API key", status: 401 });
    return;
  }

  if (url.pathname === `/v1/org/${orgId}/domains` && req.method === "GET") {
    send(res, 200, {
      data: { domains, pagination: { total: domains.length, limit: 1000, offset: 0 } },
      success: true,
      error: false,
      message: "Domains retrieved successfully",
      status: 200,
    });
    return;
  }

  if (url.pathname === `/v1/org/${orgId}/sites` && req.method === "GET") {
    send(res, 200, {
      data: { sites, pagination: { total: sites.length, pageSize: 100, page: 1 } },
      success: true,
      error: false,
      message: "Sites retrieved successfully",
      status: 200,
    });
    return;
  }

  if (url.pathname === `/v1/org/${orgId}/public-resources` && req.method === "GET") {
    send(res, 200, {
      data: { resources, pagination: { total: resources.length, pageSize: 200, page: 1 } },
      success: true,
      error: false,
      message: "Resources retrieved successfully",
      status: 200,
    });
    return;
  }

  if (url.pathname === `/v1/org/${orgId}/public-resource` && req.method === "PUT") {
    const body = await readBody(req);
    const domain = domains.find((item) => item.domainId === body.domainId);
    if (!domain) {
      send(res, 400, { success: false, error: true, message: "Domain not found", status: 400 });
      return;
    }
    const subdomain = body.subdomain || null;
    const fullDomain = subdomain ? `${subdomain}.${domain.baseDomain}` : domain.baseDomain;
    if (resources.some((item) => item.fullDomain === fullDomain)) {
      send(res, 409, { success: false, error: true, message: "Resource with that domain already exists", status: 409 });
      return;
    }
    const resource = {
      resourceId: nextResourceId++,
      niceId: `resource-${fullDomain.replace(/\./g, "-")}`,
      name: body.name,
      subdomain,
      fullDomain,
      domainId: domain.domainId,
      mode: body.mode || "http",
    };
    resources.push(resource);
    send(res, 201, {
      data: resource,
      success: true,
      error: false,
      message: "Http resource created successfully",
      status: 201,
    });
    return;
  }

  const targetMatch = url.pathname.match(/^\/v1\/public-resource\/(\d+)\/target$/);
  if (targetMatch && req.method === "PUT") {
    const resourceId = Number(targetMatch[1]);
    const resource = resources.find((item) => item.resourceId === resourceId);
    if (!resource) {
      send(res, 404, { success: false, error: true, message: "Resource not found", status: 404 });
      return;
    }
    const body = await readBody(req);
    const target = {
      targetId: nextTargetId++,
      resourceId,
      siteId: body.siteId,
      ip: body.ip,
      method: body.method || "http",
      port: body.port,
      mode: body.mode || "http",
      enabled: true,
    };
    resource.target = target;
    send(res, 201, {
      data: target,
      success: true,
      error: false,
      message: "Target created successfully",
      status: 201,
    });
    return;
  }

  const deleteMatch = url.pathname.match(/^\/v1\/public-resource\/(\d+)$/);
  if (deleteMatch && req.method === "DELETE") {
    const resourceId = Number(deleteMatch[1]);
    const index = resources.findIndex((item) => item.resourceId === resourceId);
    if (index === -1) {
      send(res, 404, { success: false, error: true, message: "Resource not found", status: 404 });
      return;
    }
    resources.splice(index, 1);
    send(res, 200, {
      data: null,
      success: true,
      error: false,
      message: "Resource deleted successfully",
      status: 200,
    });
    return;
  }

  send(res, 404, { success: false, error: false, message: "Not found", status: 404 });
});

server.listen(port, host, () => {
  console.log(`Mock Pangolin API at http://${host}:${port}/v1`);
});

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
      } catch (error) {
        reject(error);
      }
    });
  });
}
