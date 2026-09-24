import { createServer } from "node:http";

const zones = [
  {
    id: "023e105f4ecef8ad9ca31a8372d0c353",
    name: "example.com",
    status: "active",
    paused: false,
    type: "full",
    name_servers: ["ada.ns.cloudflare.com", "tim.ns.cloudflare.com"],
    account: { name: "Studio" },
  },
  {
    id: "11111111111111111111111111111111",
    name: "campaigns.test",
    status: "pending",
    paused: false,
    type: "full",
    name_servers: ["ada.ns.cloudflare.com", "tim.ns.cloudflare.com"],
    account: { name: "Studio" },
  },
];

const records = {
  "023e105f4ecef8ad9ca31a8372d0c353": [
    {
      id: "372e67954025e0ba6aaa6d586b9e0b59",
      type: "A",
      name: "example.com",
      content: "192.0.2.1",
      ttl: 1,
      proxied: true,
      proxiable: true,
      comment: "Website",
    },
    {
      id: "472e67954025e0ba6aaa6d586b9e0b59",
      type: "CNAME",
      name: "www.example.com",
      content: "example.com",
      ttl: 1,
      proxied: true,
      proxiable: true,
      comment: "",
    },
    {
      id: "572e67954025e0ba6aaa6d586b9e0b59",
      type: "MX",
      name: "example.com",
      content: "mail.example.com",
      priority: 10,
      ttl: 3600,
      proxied: false,
      proxiable: false,
      comment: "Mail",
    },
  ],
  "11111111111111111111111111111111": [],
};

const port = Number(process.env.PORT || 3999);
const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (token.length < 20) {
    send(res, 401, { success: false, errors: [{ message: "Invalid API Token" }] });
    return;
  }

  if (url.pathname === "/client/v4/zones" && req.method === "GET") {
    const page = Number(url.searchParams.get("page") || 1);
    const perPage = Number(url.searchParams.get("per_page") || 50);
    const start = (page - 1) * perPage;
    const slice = zones.slice(start, start + perPage);
    send(res, 200, {
      success: true,
      result: slice,
      result_info: { page, per_page: perPage, total_pages: Math.max(1, Math.ceil(zones.length / perPage)), total_count: zones.length },
    });
    return;
  }

  const zoneMatch = url.pathname.match(/^\/client\/v4\/zones\/([a-f0-9]{32})$/i);
  if (zoneMatch && req.method === "GET") {
    const zone = zones.find((item) => item.id === zoneMatch[1]);
    if (!zone) {
      send(res, 404, { success: false, errors: [{ message: "Zone not found" }] });
      return;
    }
    send(res, 200, { success: true, result: zone });
    return;
  }

  const listMatch = url.pathname.match(/^\/client\/v4\/zones\/([a-f0-9]{32})\/dns_records$/i);
  if (listMatch && req.method === "GET") {
    send(res, 200, {
      success: true,
      result: records[listMatch[1]] || [],
      result_info: { page: 1, total_pages: 1 },
    });
    return;
  }

  if (listMatch && req.method === "POST") {
    const body = await readBody(req);
    const created = {
      id: crypto.randomUUID().replaceAll("-", ""),
      proxiable: ["A", "AAAA", "CNAME"].includes(body.type),
      proxied: false,
      ttl: 1,
      comment: "",
      ...body,
    };
    records[listMatch[1]] = records[listMatch[1]] || [];
    records[listMatch[1]].push(created);
    send(res, 200, { success: true, result: created });
    return;
  }

  const oneMatch = url.pathname.match(/^\/client\/v4\/zones\/([a-f0-9]{32})\/dns_records\/([a-f0-9]{32})$/i);
  if (oneMatch && req.method === "PATCH") {
    const body = await readBody(req);
    const list = records[oneMatch[1]] || [];
    const index = list.findIndex((item) => item.id === oneMatch[2]);
    if (index === -1) {
      send(res, 404, { success: false, errors: [{ message: "Record not found" }] });
      return;
    }
    list[index] = { ...list[index], ...body };
    send(res, 200, { success: true, result: list[index] });
    return;
  }

  if (oneMatch && req.method === "DELETE") {
    const list = records[oneMatch[1]] || [];
    const index = list.findIndex((item) => item.id === oneMatch[2]);
    if (index === -1) {
      send(res, 404, { success: false, errors: [{ message: "Record not found" }] });
      return;
    }
    const [removed] = list.splice(index, 1);
    send(res, 200, { success: true, result: { id: removed.id } });
    return;
  }

  send(res, 404, { success: false, errors: [{ message: "Not found" }] });
});

const host = process.env.HOST || "0.0.0.0";
server.listen(port, host, () => {
  console.log(`Mock Cloudflare API at http://${host}:${port}/client/v4`);
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
