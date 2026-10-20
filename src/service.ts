/** Local service: the only component allowed to talk to arbitrary relay origins. */
import http from "node:http";
import { normalizeOrigin } from "./sites";

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
if (!port || !token) {
  console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}

const FETCH_TIMEOUT_MS = 12_000;
const MAX_BODY_BYTES = 1_000_000;
const MAX_REQUEST_BYTES = 16_000;
const MAX_PATH_LENGTH = 512;

type ProxyRequest = { origin?: unknown; token?: unknown; path?: unknown; method?: unknown };

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        chunks.length = 0;
        req.destroy();
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(size > MAX_REQUEST_BYTES ? undefined : Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(undefined));
  });
}

function safePath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const path = value.trim();
  if (path.length < 2 || path.length > MAX_PATH_LENGTH) return undefined;
  if (!path.startsWith("/") || path.startsWith("//")) return undefined;
  if (/[\u0000-\u001f\u007f\\]/u.test(path)) return undefined;
  if (path.includes("://") || path.includes("..")) return undefined;
  // The extension never needs a query or fragment; refusing them keeps the proxy surface minimal.
  if (path.includes("?") || path.includes("#")) return undefined;
  return path;
}

function safeToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512) return undefined;
  if (/[\u0000-\u001f\u007f\s]/u.test(trimmed)) return undefined;
  return trimmed;
}

async function proxy(originInput: string, bearer: string, path: string): Promise<{ status: number; body: string }> {
  const normalized = normalizeOrigin(originInput);
  if (!normalized.ok) throw new Error("BAD_ORIGIN");
  const url = new URL(path, `${normalized.origin}/`);
  if (url.origin !== normalized.origin) throw new Error("BAD_ORIGIN");
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json", Authorization: `Bearer ${bearer}` },
    redirect: "manual",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_BODY_BYTES) throw new Error("RESPONSE_TOO_LARGE");
  return { status: response.status, body: buffer.toString("utf8") };
}

const server = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    send(res, 401, { error: "UNAUTHORIZED" });
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/health") {
    send(res, 200, { ok: true });
    return;
  }
  if (url.pathname !== "/proxy") {
    send(res, 404, { error: "NOT_FOUND" });
    return;
  }
  if (req.method !== "POST") {
    send(res, 405, { error: "METHOD_NOT_ALLOWED" });
    return;
  }
  void (async () => {
    const raw = await readBody(req);
    if (raw === undefined) {
      send(res, 413, { error: "REQUEST_TOO_LARGE" });
      return;
    }
    let payload: ProxyRequest;
    try {
      payload = JSON.parse(raw) as ProxyRequest;
    } catch {
      send(res, 400, { error: "BAD_REQUEST" });
      return;
    }
    const path = safePath(payload.path);
    const bearer = safeToken(payload.token);
    const origin = typeof payload.origin === "string" ? payload.origin : "";
    if (!path) {
      send(res, 400, { error: "BAD_PATH" });
      return;
    }
    if (!bearer) {
      send(res, 400, { error: "BAD_TOKEN" });
      return;
    }
    try {
      const result = await proxy(origin, bearer, path);
      send(res, 200, result);
    } catch (error) {
      const code = error instanceof Error ? error.message : "NETWORK";
      // Fixed codes only: a site or Node error message could echo request data.
      send(res, 502, { error: /^(BAD_ORIGIN|RESPONSE_TOO_LARGE)$/u.test(code) ? code : "NETWORK" });
    }
  })();
});

server.listen(port, "127.0.0.1");
