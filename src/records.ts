import { qualifyName } from "./names";

export const RECORD_TYPES = ["A", "AAAA", "CNAME", "TXT", "MX", "NS", "CAA", "SRV"] as const;

export type RecordType = (typeof RECORD_TYPES)[number];

const PROXYABLE = new Set<RecordType>(["A", "AAAA", "CNAME"]);

export type RecordInput = {
  type?: unknown;
  name?: unknown;
  content?: unknown;
  ttl?: unknown;
  proxied?: unknown;
  priority?: unknown;
  comment?: unknown;
  weight?: unknown;
  port?: unknown;
  target?: unknown;
};

export type CloudflareRecordBody = {
  type: RecordType;
  name: string;
  ttl: number;
  comment?: string;
  content?: string;
  proxied?: boolean;
  priority?: number;
  data?: {
    priority: number;
    weight: number;
    port: number;
    target: string;
  };
};

export class RecordValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordValidationError";
  }
}

function fail(message: string): never {
  throw new RecordValidationError(message);
}

export function isRecordType(value: string): value is RecordType {
  return (RECORD_TYPES as readonly string[]).includes(value);
}

export function buildRecordBody(input: RecordInput, zoneName: string): CloudflareRecordBody {
  if (typeof input.type !== "string" || !isRecordType(input.type)) {
    fail("Choose a record type: A, AAAA, CNAME, TXT, MX, NS, CAA, or SRV.");
  }
  if (typeof input.name !== "string" || input.name.trim() === "") {
    fail("Enter a name. Use @ for the root of the domain.");
  }

  const type = input.type;
  const name = qualifyName(input.name, zoneName);
  if (name.length > 255 || !isDnsName(name)) {
    fail("Enter a valid DNS name. Use @ for the root, or a name like www.");
  }

  const proxied = Boolean(input.proxied);
  if (proxied && !PROXYABLE.has(type)) {
    fail("Proxying is available for A, AAAA, and CNAME records.");
  }

  const ttl = proxied ? 1 : parseTtl(input.ttl);
  const comment = parseComment(input.comment);
  const body: CloudflareRecordBody = { type, name, ttl };
  if (comment) body.comment = comment;
  if (PROXYABLE.has(type)) body.proxied = proxied;

  if (type === "SRV") {
    const priority = parseNumber(input.priority, "priority");
    const weight = parseNumber(input.weight, "weight");
    const port = parseNumber(input.port, "port");
    const target = typeof input.target === "string" ? input.target.trim().replace(/\.$/, "") : "";
    if (!isHostname(target)) {
      fail("Enter the host this service should reach, such as sip.example.com.");
    }
    body.data = { priority, weight, port, target };
    return body;
  }

  const rawContent = typeof input.content === "string" ? input.content.trim() : "";
  const content = type === "TXT" || type === "CAA" ? rawContent : rawContent.replace(/\.$/, "");
  if (!content) {
    fail(contentMessage(type));
  }
  if (content.length > (type === "TXT" ? 2048 : 1024)) {
    fail("That value is too long.");
  }
  if (type !== "TXT" && /[\r\n]/.test(content)) {
    fail("Keep this value on one line.");
  }

  switch (type) {
    case "A":
      if (!isIpv4(content)) fail("Enter an IPv4 address, such as 192.0.2.1.");
      break;
    case "AAAA":
      if (!isIpv6(content)) fail("Enter an IPv6 address, such as 2001:db8::1.");
      break;
    case "CNAME":
      if (!isHostname(content)) fail("Enter a hostname, such as example.com.");
      if (content.replace(/\.$/, "").toLowerCase() === name.toLowerCase()) {
        fail("A CNAME cannot point at its own name.");
      }
      break;
    case "MX":
      if (!isHostname(content)) fail("Enter the mail server hostname, such as mail.example.com.");
      body.priority = parseNumber(input.priority, "priority");
      break;
    case "NS":
      if (!isHostname(content)) fail("Enter a name server hostname, such as ns1.example.com.");
      break;
    case "CAA":
      if (!/^\d+\s+(issue|issuewild|iodef)\s+\S+/i.test(content)) {
        fail('Enter a CAA value such as 0 issue "letsencrypt.org".');
      }
      break;
    case "TXT":
      break;
    default:
      break;
  }

  body.content = content;
  return body;
}

function contentMessage(type: RecordType): string {
  switch (type) {
    case "A":
      return "Enter an IPv4 address, such as 192.0.2.1.";
    case "AAAA":
      return "Enter an IPv6 address, such as 2001:db8::1.";
    case "CNAME":
      return "Enter a hostname, such as example.com.";
    case "MX":
      return "Enter the mail server hostname, such as mail.example.com.";
    case "NS":
      return "Enter a name server hostname, such as ns1.example.com.";
    case "CAA":
      return 'Enter a CAA value such as 0 issue "letsencrypt.org".';
    case "TXT":
      return "Enter the text you want to publish.";
    default:
      return "Enter a value for this record.";
  }
}

function parseTtl(value: unknown): number {
  if (value === undefined || value === null || value === "" || value === "auto" || value === 1 || value === "1") {
    return 1;
  }
  const ttl = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400) {
    fail("Choose Auto, or a TTL from 60 to 86400 seconds.");
  }
  return ttl;
}

function parseComment(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") fail("The note has to be text.");
  const comment = value.trim();
  if (!comment) return undefined;
  if (comment.length > 500) fail("Keep the note under 500 characters.");
  return comment;
}

function parseNumber(value: unknown, label: string): number {
  if (typeof value === "string" && value.trim() === "") {
    fail(`Enter a ${label} from 0 to 65535.`);
  }
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    fail(`Enter a ${label} from 0 to 65535.`);
  }
  return parsed;
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    if (part.length > 1 && part.startsWith("0")) return false;
    const number = Number(part);
    return number >= 0 && number <= 255;
  });
}

function isIpv6(value: string): boolean {
  if (!value || value.includes("%") || value.includes(" ")) return false;
  try {
    const url = new URL(`http://[${value}]/`);
    return url.hostname.includes(":");
  } catch {
    return false;
  }
}

function isHostname(value: string): boolean {
  const host = value.replace(/\.$/, "");
  if (!host || host.length > 253) return false;
  return isDnsName(host) && !host.split(".").some((label) => label === "*");
}

function isDnsName(value: string): boolean {
  if (!value || value.length > 253) return false;
  const labels = value.split(".");
  if (labels.some((label) => label.length === 0 || label.length > 63)) return false;
  return labels.every((label, index) => {
    if (label === "*" && index === 0) return true;
    return /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/i.test(label) || /^[a-z0-9_]$/i.test(label);
  });
}
