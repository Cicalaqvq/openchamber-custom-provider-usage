/** Site configuration and app settings shared by the status section, the panel and the service. */

export type SiteConfig = {
  id: string;
  name: string;
  /** Normalized HTTPS origin, no path, no credentials. */
  origin: string;
  /** New API account access token / PAT. Never rendered in the status section. */
  token: string;
  /** Optional New-Api-User account identifier. */
  userId?: string;
};

export type AppSettings = {
  autoRefresh: boolean;
  intervalSeconds: number;
};

export const SITES_KEY = "sites.v1";
export const SETTINGS_KEY = "settings.v1";

export const DEFAULT_SETTINGS: AppSettings = { autoRefresh: true, intervalSeconds: 10 };
export const INTERVAL_MIN_SECONDS = 5;
export const INTERVAL_MAX_SECONDS = 3600;
export const MAX_SITES = 20;
export const MAX_NAME_LENGTH = 40;
export const MAX_TOKEN_LENGTH = 512;
const MAX_ID_LENGTH = 64;

const PRIVATE_HOST = /^(localhost|[^.]+\.localhost|[^.]+\.local|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|::1|\[::1\])$/iu;

export type OriginResult = { ok: true; origin: string } | { ok: false; message: string };

export type UserIdResult = { ok: true; userId?: string } | { ok: false };

/** Accepts only a positive safe decimal integer; blank strings mean not configured. */
export function validateUserId(value: unknown): UserIdResult {
  if (value === undefined) return { ok: true };
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true };
  if (!/^[1-9]\d*$/u.test(trimmed)) return { ok: false };
  const number = Number(trimmed);
  if (!Number.isSafeInteger(number) || number < 1) return { ok: false };
  return { ok: true, userId: String(number) };
}

function failOrigin(message: string): OriginResult {
  return { ok: false, message };
}

/** True for hosts where plain HTTP stays on the machine or the local network. */
export function isPrivateHost(hostname: string): boolean {
  return PRIVATE_HOST.test(hostname);
}

/** Accepts `relay.example.com` as well as `https://relay.example.com/`; returns a bare origin. */
export function normalizeOrigin(input: string): OriginResult {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) return failOrigin("请填写中转站地址。");
  if (raw.length > 2048) return failOrigin("地址过长。");
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return failOrigin("地址格式无效，请填写形如 https://relay.example.com 的根地址。");
  }
  if (url.username || url.password) return failOrigin("地址中不能包含账号或密码。");
  if (url.protocol !== "https:" && url.protocol !== "http:") return failOrigin("只支持 https 地址。");
  if (url.protocol === "http:" && !isPrivateHost(url.hostname)) {
    return failOrigin("公网中转站必须使用 https；http 仅允许本机或内网地址。");
  }
  if (url.search || url.hash) return failOrigin("地址不能包含查询参数或片段。");
  if (url.pathname !== "/" && url.pathname.replace(/\/+$/u, "") !== "") {
    return failOrigin("只填写根地址，不要包含路径（例如 https://relay.example.com）。");
  }
  return { ok: true, origin: url.origin };
}

/** Host part of an origin, for compact display. */
export function displayHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export type SiteDraft = { name: string; origin: string; token: string; userId?: string };
export type SiteDraftErrors = { name?: string; origin?: string; token?: string; userId?: string };
export type SiteDraftResult =
  | { ok: true; name: string; origin: string; token: string; userId?: string }
  | { ok: false; errors: SiteDraftErrors };

/** Validates one edited site; `existingToken` lets a blank token keep the stored one. */
export function validateSiteDraft(draft: SiteDraft, existingToken: string): SiteDraftResult {
  const errors: SiteDraftErrors = {};
  const origin = normalizeOrigin(draft.origin);
  if (!origin.ok) errors.origin = origin.message;
  const userId = validateUserId(draft.userId);
  if (!userId.ok) errors.userId = "用户 ID 必须是正整数。";
  const token = draft.token.trim();
  if (!token && !existingToken) errors.token = "请填写账号 access token（不是 sk- 开头的模型 API Key）。";
  if (token.length > MAX_TOKEN_LENGTH) errors.token = "令牌过长。";
  if (/[\u0000-\u001f\u007f\s]/u.test(token)) errors.token = "令牌不能包含空白或控制字符。";
  const rawName = draft.name.trim();
  if (rawName.length > MAX_NAME_LENGTH) errors.name = `名称最多 ${MAX_NAME_LENGTH} 个字符。`;
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const safeOrigin = origin.ok ? origin.origin : "";
  return {
    ok: true,
    name: rawName || displayHost(safeOrigin),
    origin: safeOrigin,
    token: token || existingToken,
    ...(userId.ok && userId.userId ? { userId: userId.userId } : {}),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Storage is trusted only as far as it validates; anything malformed is dropped. */
export function parseSites(value: unknown): SiteConfig[] {
  if (!Array.isArray(value)) return [];
  const sites: SiteConfig[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const item = record(entry);
    if (!item) continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id || id.length > MAX_ID_LENGTH || seen.has(id)) continue;
    const origin = normalizeOrigin(typeof item.origin === "string" ? item.origin : "");
    if (!origin.ok) continue;
    const rawName = typeof item.name === "string" ? item.name.trim() : "";
    const token = typeof item.token === "string" ? item.token.trim() : "";
    if (token.length > MAX_TOKEN_LENGTH) continue;
    const userId = validateUserId(item.userId);
    if (!userId.ok) continue;
    seen.add(id);
    sites.push({
      id,
      name: (rawName.slice(0, MAX_NAME_LENGTH) || displayHost(origin.origin)),
      origin: origin.origin,
      token,
      ...(userId.userId ? { userId: userId.userId } : {}),
    });
    if (sites.length >= MAX_SITES) break;
  }
  return sites;
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function sanitizeSettings(value: unknown): AppSettings {
  const item = record(value);
  const autoRefresh = typeof item?.autoRefresh === "boolean" ? item.autoRefresh : DEFAULT_SETTINGS.autoRefresh;
  const raw = item?.intervalSeconds;
  const intervalSeconds = typeof raw === "number" && Number.isFinite(raw)
    ? clampInteger(raw, INTERVAL_MIN_SECONDS, INTERVAL_MAX_SECONDS)
    : DEFAULT_SETTINGS.intervalSeconds;
  return { autoRefresh, intervalSeconds };
}

/** Milliseconds until the next automatic refresh, or undefined when it is off or there is nothing to query. */
export function autoRefreshDelayMs(settings: AppSettings, siteCount: number): number | undefined {
  if (!settings.autoRefresh || siteCount <= 0) return undefined;
  return clampInteger(settings.intervalSeconds, INTERVAL_MIN_SECONDS, INTERVAL_MAX_SECONDS) * 1000;
}

/** Compact "time since" text for the status rows. */
export function formatUpdatedAt(date: Date, now: Date): string {
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  if (sameDay) return time;
  const day = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(date);
  return `${day} ${time}`;
}

export function formatUpdatedAtFull(date: Date): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
