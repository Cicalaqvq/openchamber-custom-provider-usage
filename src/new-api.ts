export type Request = (path: string) => Promise<{ status: number; body: string }>;

export type BalanceResult = {
  quota: number;
  display: string;
  unit: string;
  note?: string;
};

type StatusConfig = {
  quota_per_unit?: unknown;
  quota_display_type?: unknown;
  usd_exchange_rate?: unknown;
  custom_currency_symbol?: unknown;
  custom_currency_exchange_rate?: unknown;
  display_in_currency?: unknown;
};

type ParseResult = { ok: true; data: unknown } | { ok: false; businessRejected?: boolean };

function parseJson(body: string): ParseResult {
  try {
    return { ok: true, data: JSON.parse(body) as unknown };
  } catch {
    return { ok: false };
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readSuccessData(response: { status: number; body: string }): ParseResult {
  if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) return { ok: false };
  const parsed = parseJson(response.body);
  const root = parsed.ok ? record(parsed.data) : undefined;
  if (!root) return { ok: false };
  if (root.success !== true) return { ok: false, businessRejected: root.success === false };
  return { ok: true, data: root.data };
}

function validQuota(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function rawResult(quota: number, note: string): BalanceResult {
  return { quota, display: new Intl.NumberFormat("zh-CN").format(quota), unit: "quota", note };
}

function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function currencyText(value: number, currency?: string): string {
  // Never present a non-zero amount as zero because it is below the display precision.
  if (value !== 0 && Math.abs(value) < 0.005) {
    const amount = Math.abs(value) < 1e-12
      ? Math.abs(value).toExponential(2)
      : new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 3, maximumFractionDigits: 12 }).format(Math.abs(value));
    const sign = value < 0 ? "-" : "";
    return currency ? `${sign}${currency}${amount}` : `${sign}${amount}`;
  }
  const amount = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(value));
  const sign = value < 0 ? "-" : "";
  return currency ? `${sign}${currency}${amount}` : `${sign}${amount}`;
}

function conversion(data: unknown, quota: number): { display: string; unit: string } | undefined {
  const config = record(data) as StatusConfig | undefined;
  if (!config) return undefined;
  let type = config.quota_display_type;
  if (type === undefined || type === null || type === "") {
    if (typeof config.display_in_currency !== "boolean") return undefined;
    type = config.display_in_currency ? "USD" : "TOKENS";
  }
  if (type === "TOKENS") return { display: new Intl.NumberFormat("zh-CN").format(quota), unit: "tokens" };
  if (type !== "USD" && type !== "CNY" && type !== "CUSTOM") return undefined;
  const perUnit = config.quota_per_unit;
  if (!positiveFinite(perUnit)) return undefined;
  if (type === "USD") {
    const amount = quota / perUnit;
    if (!Number.isFinite(amount) || (quota !== 0 && amount === 0)) return undefined;
    return { display: currencyText(amount, "$"), unit: "USD" };
  }
  if (type === "CNY") {
    if (!positiveFinite(config.usd_exchange_rate)) return undefined;
    const amount = (quota / perUnit) * config.usd_exchange_rate;
    if (!Number.isFinite(amount) || (quota !== 0 && amount === 0)) return undefined;
    return { display: currencyText(amount, "¥"), unit: "CNY" };
  }
  if (type === "CUSTOM") {
    const symbol = config.custom_currency_symbol;
    if (typeof symbol !== "string" || symbol.trim().length === 0 || symbol.length > 12 || /[<>]/u.test(symbol) || /[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u.test(symbol)) return undefined;
    if (!positiveFinite(config.custom_currency_exchange_rate)) return undefined;
    const amount = (quota / perUnit) * config.custom_currency_exchange_rate;
    if (!Number.isFinite(amount) || (quota !== 0 && amount === 0)) return undefined;
    return { display: currencyText(amount, symbol.trim()), unit: "CUSTOM" };
  }
  return undefined;
}

export async function loadBalance(request: Request): Promise<BalanceResult> {
  const [balanceResponse, statusResponse] = await Promise.allSettled([
    request("/api/user/self"),
    request("/api/status"),
  ]);
  if (balanceResponse.status === "rejected") throw balanceResponse.reason;
  const balance = readSuccessData(balanceResponse.value);
  const balanceData = balance.ok ? record(balance.data) : undefined;
  const quota = balanceData?.quota;
  if (!validQuota(quota)) {
    if (balanceResponse.value.status < 200 || balanceResponse.value.status >= 300) {
      throw new Error(`HTTP_${balanceResponse.value.status}`);
    }
    if (!balance.ok && balance.businessRejected) throw new Error("API_REJECTED");
    if (!balance.ok) throw new Error("API_RESPONSE_INVALID");
    throw new Error("QUOTA_INVALID");
  }

  if (statusResponse.status === "rejected") return rawResult(quota, "站点换算配置获取失败，已回退为原始 quota。请检查网络后刷新。");
  const config = readSuccessData(statusResponse.value);
  const converted = config.ok ? conversion(config.data, quota) : undefined;
  if (converted) return { quota, ...converted };
  return rawResult(quota, "站点换算配置缺失或无效，已回退为原始 quota。");
}

const STATUS_MESSAGES: Record<number, string> = {
  401: "认证失败，请在中转站余额面板中检查该站点的账号令牌。",
  403: "访问被拒绝，请确认令牌权限并允许访问用户信息接口。",
  429: "请求过于频繁，请稍后再试。",
};

const CODE_MESSAGES: Record<string, string> = {
  AUTHENTICATION_FAILED: "认证失败，请在中转站设置中检查账号令牌。",
  UNAUTHORIZED: "认证失败，请在中转站设置中检查账号令牌。",
  FORBIDDEN: "访问被拒绝，请确认令牌权限并允许访问用户信息接口。",
  TOO_MANY_REQUESTS: "请求过于频繁，请稍后再试。",
  BALANCE_REQUEST_FAILED: "余额请求失败，请检查网络和站点地址。",
  API_RESPONSE_INVALID: "站点返回了无法识别的响应，请确认 New API 版本及接口配置。",
  API_REJECTED: "站点拒绝了余额查询请求，请检查账号令牌。",
  QUOTA_INVALID: "站点返回的 quota 无效，未能安全显示余额。",
  DISCONNECTED: "集成尚未连接，请在中转站余额面板中添加站点和令牌。",
  HOST_TIMEOUT: "OpenChamber 宿主响应超时，请稍后重试。",
  HOST_UNAVAILABLE: "OpenChamber 宿主暂不可用，请刷新扩展后重试。",
  NOT_GRANTED: "扩展尚未获得本地服务授权，请在扩展权限中批准后重试。",
  NO_INTEGRATION: "未找到 New API 集成，请在中转站余额面板中添加站点。",
  NO_SERVICE: "本地服务未启动或未获授权，请在扩展权限中批准本地服务。",
  SERVICE_FAILED: "本地服务启动失败，请稍后重试或重新安装扩展。",
  REQUEST_FAILED: "本地服务未返回结果，请稍后重试。",
  DISABLED: "扩展已暂停，请在扩展设置中启用后重试。",
  HOST_REJECTED: "OpenChamber 宿主拒绝了请求，请检查扩展授权和站点配置。",
  BAD_ORIGIN: "站点地址无效，请在中转站余额面板中重新填写 HTTPS 根地址。",
  BAD_USER_ID: "站点用户 ID 无效，请在该站点设置中填写正确的数字账号用户 ID。",
  NETWORK: "无法连接该中转站，请检查地址、网络和站点状态。",
  RESPONSE_TOO_LARGE: "站点响应过大，无法安全读取。",
  SERVICE_RESPONSE_INVALID: "本地服务返回了无法识别的响应，请重新打开此区块。",
};

const FIXED_MESSAGES = new Map(Object.entries(CODE_MESSAGES).map(([code, message]) => [message, message]));

/** Return only fixed, non-sensitive Chinese messages; never include the original error. */
export function safeErrorMessage(error: unknown): string {
  const err = record(error);
  const code = typeof err?.code === "string" ? err.code.toUpperCase() : "";
  const message = typeof err?.message === "string" ? err.message : "";
  // A precise code in the message (our own service refusal) beats a transport-level wrapper code.
  if (CODE_MESSAGES[message]) return CODE_MESSAGES[message]!;
  if (CODE_MESSAGES[code]) return CODE_MESSAGES[code]!;
  if (FIXED_MESSAGES.has(message)) return FIXED_MESSAGES.get(message)!;
  const httpMatch = /^(?:SERVICE_)?HTTP_(\d{3})$/u.exec(code) ?? /^(?:SERVICE_)?HTTP_(\d{3})$/u.exec(message);
  const status = httpMatch ? Number(httpMatch[1]) : typeof err?.status === "number" ? err.status : undefined;
  if (status === 401 || status === 403) {
    // The local service answers its own 4xx only for malformed calls, never for a site's answer.
    if (!httpMatch || !/^SERVICE_HTTP_/u.test(code || message)) return STATUS_MESSAGES[status]!;
  }
  if (status !== undefined && STATUS_MESSAGES[status]) return STATUS_MESSAGES[status]!;
  if (typeof status === "number" && status >= 500 && status < 600) return "站点暂时不可用（服务器错误），请稍后再试。";
  if (status === 413) return "令牌或站点配置过长。";
  return "余额查询失败，请检查网络、站点地址和账号令牌后重试。";
}
