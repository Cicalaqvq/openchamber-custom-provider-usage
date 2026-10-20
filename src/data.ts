/** Host-side data access shared by the Work Status section and the management panel. */
import type { Request } from "./new-api";
import { loadBalance, type BalanceResult } from "./new-api";
import type { SiteConfig } from "./sites";

type ServiceCaller = {
  serviceRequest: (request: { method: "POST"; path: string; body: string }) => Promise<{ status: number; body: string }>;
};

export type SiteQuerier = (site: SiteConfig, path: string) => Promise<{ status: number; body: string }>;

function parseEnvelope(body: string): { status?: unknown; body?: unknown; error?: unknown } {
  try {
    const parsed = JSON.parse(body) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as { status?: unknown; body?: unknown; error?: unknown }) : {};
  } catch {
    return {};
  }
}

/**
 * Asks the local service to perform one GET. The service, not this frame, enforces
 * HTTPS and attaches the bearer header, so tokens never enter a URL or a log line here.
 */
export function createQuerier(host: ServiceCaller): SiteQuerier {
  return async (site, path) => {
    const response = await host.serviceRequest({
      method: "POST",
      path: "/proxy",
      body: JSON.stringify({ origin: site.origin, token: site.token, path }),
    });
    const envelope = parseEnvelope(response.body);
    // The service's own refusals arrive as `{ error }`, including on a 4xx.
    if (typeof envelope.error === "string" && SERVICE_CODES.has(envelope.error)) throw new Error(envelope.error);
    if (response.status !== 200) throw new Error(`SERVICE_HTTP_${response.status}`);
    if (typeof envelope.status !== "number" || typeof envelope.body !== "string") throw new Error("SERVICE_RESPONSE_INVALID");
    return { status: envelope.status, body: envelope.body };
  };
}

/** Codes the shipped service can return; anything else is treated as a failure, never displayed. */
const SERVICE_CODES = new Set(["BAD_ORIGIN", "BAD_PATH", "BAD_TOKEN", "REQUEST_TOO_LARGE", "BAD_REQUEST", "NETWORK", "RESPONSE_TOO_LARGE", "UNAUTHORIZED"]);

export async function querySite(site: SiteConfig, service: SiteQuerier): Promise<BalanceResult> {
  const request: Request = (path) => service(site, path);
  return loadBalance(request);
}
