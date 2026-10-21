import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";

/** Builds the service bundle exactly as the extension ships it, then runs it as the host would. */
async function bundleService() {
  const root = resolve(tmpdir(), "opencode");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "openchamber-custom-provider-usage-service-"));
  const outfile = join(directory, "service.js");
  await build({ entryPoints: [new URL("../src/service.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1")], outfile, bundle: true, format: "iife", platform: "node", target: ["es2022"], charset: "utf8", logLevel: "silent" });
  return { directory, outfile, source: await readFile(outfile, "utf8") };
}

function listen(server) {
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server.address().port)));
}

function startService(entry) {
  const port = 40_000 + Math.floor(Math.random() * 10_000);
  const token = "service-secret-token";
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, OPENCHAMBER_SERVICE_PORT: String(port), OPENCHAMBER_SERVICE_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const post = async (path, payload, bearer = token) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: JSON.parse(await response.text()) };
  };
  return { child, token, port, post };
}

async function waitForHealth(port, token) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: `Bearer ${token}` } });
      if (response.status === 200) return;
    } catch { /* not up yet */ }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error("service never became healthy");
}

test("the service only answers its holder, and only through the proxy route", async () => {
  const built = await bundleService();
  const service = startService(built.outfile);
  try {
    try { await waitForHealth(service.port, service.token); }
    catch (error) { throw new Error(`${error.message}\n${built.source.slice(0, 400)}`); }
    assert.equal((await service.post("/proxy", { origin: "https://a.example.com", token: "t", path: "/api/user/self" }, "wrong")).status, 401);
    assert.equal((await service.post("/../etc/passwd", {})).status, 404);
    assert.equal((await service.post("/proxy", { origin: "https://a.example.com", token: "t", path: "api/user/self" })).body.error, "BAD_PATH");
    assert.equal((await service.post("/proxy", { origin: "https://a.example.com", token: "t", path: "//evil.example.com/x" })).body.error, "BAD_PATH");
    assert.equal((await service.post("/proxy", { origin: "https://a.example.com", token: "t", path: "/x?y=1" })).body.error, "BAD_PATH");
    assert.equal((await service.post("/proxy", { origin: "http://public.example.com", token: "t", path: "/api/user/self" })).body.error, "BAD_ORIGIN");
    assert.equal((await service.post("/proxy", { origin: "https://a.example.com", token: "", path: "/api/user/self" })).body.error, "BAD_TOKEN");
    assert.equal((await service.post("/proxy", { origin: "https://a.example.com", token: "a b", path: "/api/user/self" })).body.error, "BAD_TOKEN");
  } finally {
    service.child.kill();
    await rm(built.directory, { recursive: true, force: true });
  }
});

test("the service forwards only the bearer and returns the site response untouched", async () => {
  const seen = [];
  const site = createServer((request, response) => {
    seen.push({ url: request.url, authorization: request.headers.authorization });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ success: true, data: { quota: 1_915_000 } }));
  });
  const sitePort = await listen(site);
  const built = await bundleService();
  const service = startService(built.outfile);
  try {
    await waitForHealth(service.port, service.token);
    const result = await service.post("/proxy", { origin: `http://127.0.0.1:${sitePort}`, token: "site-token", path: "/api/user/self" });
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 200);
    assert.deepEqual(JSON.parse(result.body.body), { success: true, data: { quota: 1_915_000 } });
    assert.deepEqual(seen, [{ url: "/api/user/self", authorization: "Bearer site-token" }]);
  } finally {
    service.child.kill();
    await new Promise((done) => site.close(done));
    await rm(built.directory, { recursive: true, force: true });
  }
});

test("an unreachable site answers a fixed code instead of an error message", async () => {
  const built = await bundleService();
  const service = startService(built.outfile);
  try {
    await waitForHealth(service.port, service.token);
    const result = await service.post("/proxy", { origin: "http://127.0.0.1:1", token: "site-token", path: "/api/user/self" });
    assert.equal(result.status, 502);
    assert.deepEqual(result.body, { error: "NETWORK" });
    assert.doesNotMatch(JSON.stringify(result.body), /127\.0\.0\.1|ECONN/u);
  } finally {
    service.child.kill();
    await rm(built.directory, { recursive: true, force: true });
  }
});

test("a site that redirects is not followed", async () => {
  let redirected = false;
  const elsewhere = createServer((request, response) => { redirected = true; response.end("{}"); });
  const elsewherePort = await listen(elsewhere);
  const site = createServer((request, response) => {
    response.writeHead(302, { Location: `http://127.0.0.1:${elsewherePort}/steal` });
    response.end();
  });
  const sitePort = await listen(site);
  const built = await bundleService();
  const service = startService(built.outfile);
  try {
    await waitForHealth(service.port, service.token);
    const result = await service.post("/proxy", { origin: `http://127.0.0.1:${sitePort}`, token: "site-token", path: "/api/user/self" });
    assert.equal(result.body.status, 302);
    assert.equal(redirected, false);
  } finally {
    service.child.kill();
    await new Promise((done) => site.close(done));
    await new Promise((done) => elsewhere.close(done));
    await rm(built.directory, { recursive: true, force: true });
  }
});
