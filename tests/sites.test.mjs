import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";

const compiled = await build({
  stdin: { contents: await readFile(new URL("../src/sites.ts", import.meta.url), "utf8"), loader: "ts", sourcefile: "sites.ts" },
  bundle: true, write: false, format: "esm", platform: "node",
});
const sites = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
const {
  DEFAULT_SETTINGS, MAX_SITES, normalizeOrigin, parseSites, sanitizeSettings, validateSiteDraft,
  autoRefreshDelayMs, formatUpdatedAt,
} = sites;

test("normalizes bare hosts and HTTPS roots, rejects anything that is not a root", () => {
  assert.deepEqual(normalizeOrigin("relay.example.com"), { ok: true, origin: "https://relay.example.com" });
  assert.deepEqual(normalizeOrigin("  https://relay.example.com/ "), { ok: true, origin: "https://relay.example.com" });
  assert.deepEqual(normalizeOrigin("https://relay.example.com:8443"), { ok: true, origin: "https://relay.example.com:8443" });
  for (const bad of ["", "   ", "https://user:pass@relay.example.com", "https://relay.example.com/path", "https://relay.example.com/?a=1", "https://relay.example.com/#x", "ftp://relay.example.com", "https://"]) {
    assert.equal(normalizeOrigin(bad).ok, false, bad);
  }
});

test("plain HTTP is allowed only on the machine or a private network", () => {
  for (const local of ["http://localhost:3000", "http://127.0.0.1:3000", "http://192.168.1.4", "http://10.0.0.2", "http://myhost.local"]) {
    assert.equal(normalizeOrigin(local).ok, true, local);
  }
  assert.equal(normalizeOrigin("http://relay.example.com").ok, false);
});

test("drafts keep the stored token when the token field is left blank", () => {
  const kept = validateSiteDraft({ name: "", origin: "relay.example.com", token: "" }, "stored-token");
  assert.equal(kept.ok, true);
  assert.equal(kept.name, "relay.example.com");
  assert.equal(kept.token, "stored-token");

  const added = validateSiteDraft({ name: "主站", origin: "https://a.example.com", token: "abc" }, "");
  assert.deepEqual(added, { ok: true, name: "主站", origin: "https://a.example.com", token: "abc" });

  const missing = validateSiteDraft({ name: "", origin: "https://a.example.com", token: "  " }, "");
  assert.equal(missing.ok, false);
  assert.match(missing.errors.token, /access token/u);

  const badOrigin = validateSiteDraft({ name: "", origin: "https://a.example.com/x", token: "abc" }, "");
  assert.equal(badOrigin.ok, false);
  assert.match(badOrigin.errors.origin, /根地址/u);

  const whitespaceToken = validateSiteDraft({ name: "", origin: "https://a.example.com", token: "a b" }, "");
  assert.equal(whitespaceToken.ok, false);
});

test("stored sites are revalidated and malformed entries dropped", () => {
  const parsed = parseSites([
    { id: "a", name: " A ", origin: "https://a.example.com", token: "t1" },
    { id: "a", name: "duplicate", origin: "https://b.example.com", token: "t2" },
    { id: "c", origin: "https://c.example.com" },
    { id: "", origin: "https://d.example.com", token: "t" },
    { id: "e", origin: "http://public.example.com", token: "t" },
    null,
    "x",
  ]);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], { id: "a", name: "A", origin: "https://a.example.com", token: "t1" });
  assert.deepEqual(parsed[1], { id: "c", name: "c.example.com", origin: "https://c.example.com", token: "" });
  assert.equal(parseSites("nope").length, 0);
  const many = parseSites(Array.from({ length: MAX_SITES + 5 }, (_, index) => ({ id: `s${index}`, origin: `https://s${index}.example.com`, token: "t" })));
  assert.equal(many.length, MAX_SITES);
});

test("refresh settings default to 10s, clamp into range, and never invent a timer when off", () => {
  assert.deepEqual(sanitizeSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(sanitizeSettings({ autoRefresh: "yes", intervalSeconds: "fast" }), DEFAULT_SETTINGS);
  assert.deepEqual(sanitizeSettings({ autoRefresh: false, intervalSeconds: 2 }), { autoRefresh: false, intervalSeconds: 5 });
  assert.deepEqual(sanitizeSettings({ autoRefresh: true, intervalSeconds: 99_999 }), { autoRefresh: true, intervalSeconds: 3600 });
  assert.deepEqual(sanitizeSettings({ autoRefresh: true, intervalSeconds: 12.6 }), { autoRefresh: true, intervalSeconds: 13 });
  assert.equal(autoRefreshDelayMs({ autoRefresh: true, intervalSeconds: 10 }, 2), 10_000);
  assert.equal(autoRefreshDelayMs({ autoRefresh: false, intervalSeconds: 10 }, 2), undefined);
  assert.equal(autoRefreshDelayMs({ autoRefresh: true, intervalSeconds: 10 }, 0), undefined);
});

test("updated-at text is compact for today and dated otherwise", () => {
  const now = new Date(2026, 9, 20, 18, 0);
  assert.equal(formatUpdatedAt(new Date(2026, 9, 20, 9, 5), now), "09:05");
  assert.match(formatUpdatedAt(new Date(2026, 9, 19, 9, 5), now), /10\/19|10月19日/u);
});
