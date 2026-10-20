import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";

const compiled = await build({
  stdin: {
    contents: await readFile(new URL("../src/data.ts", import.meta.url), "utf8"),
    loader: "ts",
    sourcefile: "data.ts",
    resolveDir: new URL("../src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1"),
  },
  bundle: true, write: false, format: "esm", platform: "node",
});
const { createQuerier, querySite } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);

function fakeService(handler) {
  const calls = [];
  return {
    calls,
    serviceRequest: async (request) => { calls.push(request); return handler(request); },
  };
}

const site = { id: "a", name: "A", origin: "https://a.example.com", token: "site-token" };

test("sends origin, token and path to the local service as one JSON body", async () => {
  const host = fakeService(() => ({ status: 200, body: JSON.stringify({ status: 200, body: '{"success":true}' }) }));
  const querier = createQuerier(host);
  const result = await querier(site, "/api/user/self");
  assert.deepEqual(result, { status: 200, body: '{"success":true}' });
  assert.equal(host.calls.length, 1);
  assert.equal(host.calls[0].method, "POST");
  assert.equal(host.calls[0].path, "/proxy");
  assert.deepEqual(JSON.parse(host.calls[0].body), { origin: "https://a.example.com", token: "site-token", path: "/api/user/self" });
});

test("maps service refusals to fixed errors and never surfaces the raw body", async () => {
  const refusals = [
    [{ status: 200, body: JSON.stringify({ error: "BAD_ORIGIN" }) }, /BAD_ORIGIN/u],
    [{ status: 200, body: JSON.stringify({ error: "NETWORK" }) }, /NETWORK/u],
    [{ status: 502, body: JSON.stringify({ error: "NETWORK" }) }, /NETWORK/u],
    [{ status: 200, body: "not json" }, /SERVICE_HTTP_200|SERVICE_RESPONSE_INVALID/u],
    [{ status: 200, body: JSON.stringify({ status: "200", body: "x" }) }, /SERVICE_RESPONSE_INVALID/u],
  ];
  for (const [response, pattern] of refusals) {
    const querier = createQuerier(fakeService(() => response));
    await assert.rejects(querier(site, "/api/user/self"), pattern);
  }
  const bodyless = createQuerier(fakeService(() => ({ status: 413, body: "" })));
  await assert.rejects(bodyless(site, "/api/user/self"), /SERVICE_HTTP_413/u);
});

test("querySite runs the existing New API balance logic over the service", async () => {
  const host = fakeService((request) => {
    const { path } = JSON.parse(request.body);
    const data = path === "/api/user/self"
      ? { success: true, data: { quota: 1_915_000 } }
      : { success: true, data: { quota_per_unit: 500_000, quota_display_type: "USD" } };
    return { status: 200, body: JSON.stringify({ status: 200, body: JSON.stringify(data) }) };
  });
  const result = await querySite(site, createQuerier(host));
  assert.deepEqual(result, { quota: 1_915_000, display: "$3.83", unit: "USD" });
});
