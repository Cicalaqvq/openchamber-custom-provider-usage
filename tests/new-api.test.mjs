import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const compiled = await build({
  stdin: { contents: await (await import("node:fs/promises")).readFile(new URL("../src/new-api.ts", import.meta.url), "utf8"), loader: "ts", sourcefile: "new-api.ts" },
  bundle: true, write: false, format: "esm", platform: "node",
});
const { loadBalance, safeErrorMessage } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
const response = (data, status = 200) => ({ status, body: JSON.stringify(data) });
const ok = data => response({ success: true, data });
const fake = (balance, status = ok({ quota_per_unit: 500000, quota_display_type: "USD", usd_exchange_rate: 1 })) => async path => path === "/api/user/self" ? balance : status;

test("loads USD at q/P regardless of exchange rate configuration", async () => {
  assert.deepEqual(await loadBalance(fake(ok({ quota: 1_000_000 }))), { quota: 1_000_000, display: "$2.00", unit: "USD" });
  assert.deepEqual(await loadBalance(fake(ok({ quota: 1_000_000 }), ok({ quota_per_unit: 500_000, quota_display_type: "USD", usd_exchange_rate: 7.2 }))), { quota: 1_000_000, display: "$2.00", unit: "USD" });
  assert.deepEqual(await loadBalance(fake(ok({ quota: 1_000_000 }), ok({ quota_per_unit: 500_000, quota_display_type: "USD" }))), { quota: 1_000_000, display: "$2.00", unit: "USD" });
});

test("supports CNY, custom currency, tokens and legacy boolean type", async () => {
  const balance = ok({ quota: 250_000 });
  assert.deepEqual(await loadBalance(fake(balance, ok({ quota_per_unit: 500_000, quota_display_type: "CNY", usd_exchange_rate: 7.2 }))), { quota: 250_000, display: "¥3.60", unit: "CNY" });
  assert.deepEqual(await loadBalance(fake(balance, ok({ quota_per_unit: 500_000, quota_display_type: "CUSTOM", custom_currency_symbol: "€", custom_currency_exchange_rate: 2 }))), { quota: 250_000, display: "€1.00", unit: "CUSTOM" });
  assert.deepEqual(await loadBalance(fake(balance, ok({ quota_display_type: "TOKENS" }))), { quota: 250_000, display: "250,000", unit: "tokens" });
  assert.deepEqual(await loadBalance(fake(balance, ok({ quota_per_unit: 500_000, display_in_currency: true, usd_exchange_rate: 1 }))), { quota: 250_000, display: "$0.50", unit: "USD" });
});

test("preserves zero and negative quota, and avoids rounding tiny amounts to zero", async () => {
  assert.equal((await loadBalance(fake(ok({ quota: 0 })))).display, "$0.00");
  assert.equal((await loadBalance(fake(ok({ quota: -500_000 })))).display, "-$1.00");
  const small = await loadBalance(fake(ok({ quota: 1 }), ok({ quota_per_unit: 1_000_000_000, quota_display_type: "USD", usd_exchange_rate: 1 })));
  assert.notEqual(small.display, "$0.00");
  const tinier = await loadBalance(fake(ok({ quota: 1 }), ok({ quota_per_unit: 1e13, quota_display_type: "USD" })));
  assert.match(tinier.display, /e-13/u);
});

test("falls back explicitly to raw quota when conversion configuration is unavailable or unsafe", async () => {
  const balance = ok({ quota: 42 });
  for (const status of [Promise.reject(new Error("secret")), response("oops"), ok({}), ok({ quota_per_unit: 0, quota_display_type: "USD" }), ok({ quota_per_unit: 1, quota_display_type: "EUR" }), ...["\n", "  \t", "\u202e$", "\u200f€", "\u0001x", "<b>"].map(custom_currency_symbol => ok({ quota_per_unit: 1, quota_display_type: "CUSTOM", custom_currency_symbol, custom_currency_exchange_rate: 1 })), ok({ quota_per_unit: 1e308, quota_display_type: "CNY", usd_exchange_rate: 1e-308 })]) {
    const result = await loadBalance(async path => path === "/api/user/self" ? balance : await status);
    assert.equal(result.display, "42");
    assert.equal(result.unit, "quota");
    assert.match(result.note, /回退/u);
  }
});

test("rejects failed HTTP/business responses and unsafe quota values", async () => {
  await assert.rejects(loadBalance(fake(response({ success: true, data: { quota: 1 } }, 401))), /HTTP_401/);
  await assert.rejects(loadBalance(fake(response({ success: false, message: "secret" }))), /API_REJECTED/);
  for (const quota of ["100", 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null]) {
    await assert.rejects(loadBalance(fake(ok({ quota }))), /QUOTA_INVALID/);
  }
});

test("safe errors are fixed Chinese messages and never reveal supplied secrets", () => {
  for (const error of [new Error("Bearer do-not-leak"), { code: "HTTP_403", message: "token-secret" }, { code: "SOMETHING", message: "secret" }, { status: 503, message: "secret" }]) {
    const message = safeErrorMessage(error);
    assert.match(message, /[\u4e00-\u9fff]/u);
    assert.doesNotMatch(message, /do-not-leak|token-secret|secret/u);
  }
  assert.match(safeErrorMessage({ code: "UNAUTHORIZED" }), /认证失败/u);
  assert.match(safeErrorMessage(new Error("QUOTA_INVALID")), /quota 无效/u);
  assert.match(safeErrorMessage(new Error("HTTP_401")), /认证失败/u);
  assert.match(safeErrorMessage({ status: 503 }), /服务器错误/u);
  for (const code of ["DISCONNECTED", "HOST_TIMEOUT", "HOST_UNAVAILABLE", "NOT_GRANTED", "NO_INTEGRATION", "DISABLED", "HOST_REJECTED", "QUOTA_INVALID", "API_RESPONSE_INVALID"]) {
    const message = safeErrorMessage(Object.assign(new Error("Bearer never-show-this"), { code }));
    assert.match(message, /[\u4e00-\u9fff]/u, code);
    assert.doesNotMatch(message, /never-show-this/u, code);
  }
  assert.match(safeErrorMessage(new Error("站点返回的 quota 无效，未能安全显示余额。")), /quota 无效/u);
});
