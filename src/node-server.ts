import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleRequest } from "./index";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const API_BASE_URL = process.env.API_BASE_URL || "https://api.cloudflare.com/client/v4";

const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
};

const env = {
  API_BASE_URL,
  ASSETS: {
    async fetch(input: RequestInfo | URL): Promise<Response> {
      const requestUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      return serveAsset(new URL(requestUrl).pathname);
    },
  },
} as unknown as Env;

const server = createServer((req, res) => {
  void handleNodeRequest(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Zoneboard listening on http://${HOST}:${PORT}`);
  console.log(`Cloudflare API: ${API_BASE_URL}`);
});

async function handleNodeRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const request = await toFetchRequest(req);
    const response = await handleRequest(request, env);
    await writeFetchResponse(res, response);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    }
    res.end(JSON.stringify({ error: "Zoneboard hit an unexpected error. Try again." }));
  }
}

async function toFetchRequest(req: IncomingMessage): Promise<Request> {
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  const protocol = process.env.FORCE_HTTPS === "1" ? "https" : "http";
  const url = new URL(req.url || "/", `${protocol}://${host}`);
  const method = req.method || "GET";
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  if (!headers.has("origin") && (method === "POST" || method === "PATCH" || method === "DELETE" || method === "PUT")) {
    headers.set("origin", url.origin);
  }
  const body = method === "GET" || method === "HEAD" ? undefined : await readIncomingBody(req);
  return new Request(url, { method, headers, body });
}

function readIncomingBody(req: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

async function writeFetchResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") {
      const existing = headers[key];
      headers[key] = existing ? ([] as string[]).concat(existing, value) : [value];
      return;
    }
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  if (response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    res.end(Buffer.from(bytes));
  } else {
    res.end();
  }
}

async function serveAsset(pathname: string): Promise<Response> {
  const relative = pathname === "/" ? "/index.html" : pathname;
  const safePath = path.normalize(relative).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return new Response("Not found", { status: 404 });
  }
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      return new Response("Not found", { status: 404 });
    }
    const body = await readFile(filePath);
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": MIME[path.extname(filePath)] || "application/octet-stream",
        "cache-control": "no-cache",
      },
    });
  } catch {
    if (path.extname(safePath) === "") {
      return serveAsset("/index.html");
    }
    return new Response("Not found", { status: 404 });
  }
}
