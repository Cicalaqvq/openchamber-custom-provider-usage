import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { hasGuestPage, requestedGuestCapabilities, resolveStatusSectionEntry } from "@openchamber/sdk";
import { parseManifest } from "@openchamber/sdk/schemas";
import { buildExtension, createManifest, validateManifest, outputMarked } from "../scripts/build.mjs";
import { createZip, filesIn } from "../scripts/package.mjs";
import { assertDirectoriesMatch } from "../scripts/check-dist.mjs";

test("declares a management panel, a Work Status section and one local service", () => {
  const manifest = createManifest();
  assert.deepEqual(manifest.openchamber.contributes.panel, {
    id: "custom-provider-usage", name: "中转站余额", icon: "wallet-line", entry: "panel/index.html",
  });
  assert.equal("integration" in manifest.openchamber.contributes, false, "no fixed apiOrigin: sites are user data");
  const parsed = parseManifest(manifest);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.message);
  const contributes = parsed.manifest.contributes;
  assert.equal(hasGuestPage(contributes), true);
  assert.equal(resolveStatusSectionEntry(contributes), "status/index.html");
  assert.deepEqual(contributes.service, { entry: "service/main.js", runtime: "host" });
  assert.deepEqual(requestedGuestCapabilities(contributes), ["service"]);
  assert.deepEqual(validateManifest(), manifest);
});

test("root and standalone manifests share contribution semantics and root-relative assets exist", async () => {
  const rootManifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const standalone = createManifest();
  const rootOpenchamber = structuredClone(rootManifest.openchamber);
  for (const item of [rootOpenchamber.contributes.panel, rootOpenchamber.contributes.statusSection, rootOpenchamber.contributes.service]) {
    item.entry = item.entry.replace(/^dist\/extension\//u, "");
  }
  assert.deepEqual(standalone.openchamber, rootOpenchamber);
  const rootContributes = rootManifest.openchamber.contributes;
  assert.equal(rootContributes.panel.entry, "dist/extension/panel/index.html");
  assert.equal(rootContributes.statusSection.entry, "dist/extension/status/index.html");
  assert.equal(rootContributes.service.entry, "dist/extension/service/main.js");
  for (const pageEntry of [rootContributes.panel.entry, rootContributes.statusSection.entry]) {
    const pagePath = new URL(`../${pageEntry}`, import.meta.url);
    const html = await readFile(pagePath, "utf8");
    for (const [, relative] of html.matchAll(/(?:src|href)="([^"?#]+)"/gu)) {
      assert.ok(await readFile(new URL(relative, pagePath)), `${pageEntry} references missing ${relative}`);
    }
  }
  assert.ok(await readFile(new URL(`../${rootContributes.service.entry}`, import.meta.url)));
});

test("packages the built extension with root-relative ZIP paths and no source/development tree", async () => {
  const output = join(resolve(tmpdir(), "opencode"), `openchamber-custom-provider-usage-test-zip-${process.pid}-${Date.now()}`);
  try {
    await buildExtension(output);
    const archive = createZip(await filesIn(output));
    const entries = new Map();
    let offset = 0;
    while (archive.readUInt32LE(offset) === 0x04034b50) {
      const size = archive.readUInt32LE(offset + 18);
      const nameLength = archive.readUInt16LE(offset + 26);
      const extraLength = archive.readUInt16LE(offset + 28);
      const nameStart = offset + 30;
      const dataStart = nameStart + nameLength + extraLength;
      const name = archive.subarray(nameStart, nameStart + nameLength).toString("utf8");
      entries.set(name, archive.subarray(dataStart, dataStart + size));
      offset = dataStart + size;
    }
    const required = ["package.json", "panel/index.html", "panel/main.js", "panel/styles.css", "status/index.html", "status/main.js", "status/styles.css", "service/main.js", "LICENSE", "third-party/openchamber-sdk-LICENSE.txt", "THIRD_PARTY_NOTICES.txt"];
    for (const path of required) assert.ok(entries.has(path), `ZIP missing ${path}`);
    for (const path of entries.keys()) {
      assert.doesNotMatch(path, /(?:^|\/)(?:node_modules|src)(?:\/|$)|(?:^|\/)extension(?:\/|$)/u, `unexpected ZIP path ${path}`);
    }
    const manifest = JSON.parse(entries.get("package.json").toString("utf8"));
    for (const entry of [manifest.openchamber.contributes.panel.entry, manifest.openchamber.contributes.statusSection.entry, manifest.openchamber.contributes.service.entry]) {
      assert.ok(entries.has(entry), `ZIP manifest entry does not resolve: ${entry}`);
    }
    for (const page of ["panel/index.html", "status/index.html"]) {
      const html = entries.get(page).toString("utf8");
      for (const [, relative] of html.matchAll(/(?:src|href)="([^"?#]+)"/gu)) {
        assert.ok(entries.has(`${page.slice(0, page.lastIndexOf("/"))}/${relative}`), `${page} resource missing from ZIP: ${relative}`);
      }
    }
  } finally { await rm(output, { recursive: true, force: true }); }
});

test("builds both pages, the service bundle and local assets", async () => {
  const approvedTemp = resolve(tmpdir(), "opencode");
  const output = join(approvedTemp, `openchamber-custom-provider-usage-test-${process.pid}-${Date.now()}`);
  try {
    assert.equal(await buildExtension(output), output);
    const files = await readdir(output);
    for (const name of ["package.json", "README.md", "LICENSE", "status", "panel", "service", "third-party"]) {
      assert.ok(files.includes(name), `missing ${name}`);
    }
    assert.equal(files.includes("node_modules"), false);
    assert.equal(await outputMarked(output), true);

    const statusHtml = await readFile(join(output, "status", "index.html"), "utf8");
    const panelHtml = await readFile(join(output, "panel", "index.html"), "utf8");
    const css = await readFile(join(output, "status", "styles.css"), "utf8");
    const sourceCss = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
    const statusMain = await readFile(join(output, "status", "main.js"), "utf8");
    const panelMain = await readFile(join(output, "panel", "main.js"), "utf8");
    const service = await readFile(join(output, "service", "main.js"), "utf8");
    const sdkLicense = await readFile(new URL("../node_modules/@openchamber/sdk/LICENSE", import.meta.url), "utf8");
    const bundledLicense = await readFile(join(output, "third-party", "openchamber-sdk-LICENSE.txt"), "utf8");
    const notices = await readFile(join(output, "THIRD_PARTY_NOTICES.txt"), "utf8");

    assert.match(statusHtml, /id="root"/u);
    assert.match(statusHtml, /href="styles\.css"/u);
    assert.match(statusHtml, /src="main\.js"/u);
    assert.match(panelHtml, /src="main\.js"/u);
    assert.equal(css, sourceCss);
    assert.equal(await readFile(join(output, "panel", "styles.css"), "utf8"), sourceCss);
    assert.match(statusMain, /StatusController/u);
    assert.match(statusMain, /plugin:custom-provider-usage/u);
    assert.match(panelMain, /添加中转站|manage/iu);
    assert.match(service, /OPENCHAMBER_SERVICE_TOKEN/u);
    assert.doesNotMatch(service, /node:child_process/u, "the service only proxies HTTPS");
    assert.equal(bundledLicense, sdkLicense);
    assert.equal(await readFile(join(output, "LICENSE"), "utf8"), await readFile(new URL("../LICENSE", import.meta.url), "utf8"));
    assert.match(notices, /Zod/u);

    const manifest = JSON.parse(await readFile(join(output, "package.json"), "utf8"));
    assert.equal(manifest.openchamber.contributes.statusSection.entry, "status/index.html");
    assert.equal(manifest.openchamber.contributes.panel.entry, "panel/index.html");
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("build refuses arguments and never overwrites an unknown directory", async () => {
  const approvedTemp = resolve(tmpdir(), "opencode");
  const output = join(approvedTemp, `openchamber-custom-provider-usage-test-${process.pid}-${Date.now()}`);
  await buildExtension(output);
  await rm(output, { recursive: true, force: true });

  const unknown = join(approvedTemp, `openchamber-custom-provider-usage-test-unknown-${process.pid}-${Date.now()}`);
  await mkdir(unknown, { recursive: true });
  await writeFile(join(unknown, "keep.txt"), "untouched");
  await assert.rejects(buildExtension(unknown), /拒绝覆盖/u);
  assert.equal(await readFile(join(unknown, "keep.txt"), "utf8"), "untouched");
  await rm(unknown, { recursive: true, force: true });
});

test("a failed build keeps a previously generated artifact intact", async () => {
  const approvedTemp = resolve(tmpdir(), "opencode");
  const output = join(approvedTemp, `openchamber-custom-provider-usage-test-${process.pid}-${Date.now()}`);
  await buildExtension(output);
  const before = await readFile(join(output, "package.json"), "utf8");
  await assert.rejects(buildExtension("ignored-argument"));
  assert.equal(await readFile(join(output, "package.json"), "utf8"), before);
  await rm(output, { recursive: true, force: true });
});

function independentCrc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    c ^= buffer[i];
    for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}

test("creates a valid independently parsed STORE ZIP with matching central/local CRCs", () => {
  const inputs = [
    { name: "package.json", data: Buffer.from('{"name":"openchamber-custom-provider-usage"}') },
    { name: "status/index.html", data: Buffer.from("<main id=\"root\">余额</main>", "utf8") },
  ];
  const archive = createZip(inputs);
  let offset = 0;
  let entries = 0;
  while (archive.readUInt32LE(offset) === 0x04034b50) {
    const crc = archive.readUInt32LE(offset + 14);
    const size = archive.readUInt32LE(offset + 18);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = archive.subarray(nameStart, nameStart + nameLength).toString("utf8");
    const data = archive.subarray(dataStart, dataStart + size);
    assert.equal(archive.readUInt16LE(offset + 8), 0, "STORE compression");
    assert.equal(archive.readUInt16LE(offset + 12), 1, "valid DOS date 1980-01-01");
    assert.equal(crc, independentCrc32(data), `${name} local CRC`);
    entries++;
    offset = dataStart + size;
  }
  assert.equal(archive.readUInt32LE(offset), 0x02014b50, "central directory follows local records");
  let centralCount = 0;
  while (archive.readUInt32LE(offset) === 0x02014b50) {
    const crc = archive.readUInt32LE(offset + 16);
    const nameLength = archive.readUInt16LE(offset + 28);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    assert.equal(crc, independentCrc32(inputs.find(file => file.name === name).data));
    assert.equal(archive.readUInt16LE(offset + 14), 1, "central DOS date 1980-01-01");
    centralCount++;
    offset += 46 + nameLength + archive.readUInt16LE(offset + 30) + archive.readUInt16LE(offset + 32);
  }
  assert.equal(archive.readUInt32LE(offset), 0x06054b50, "end of central directory");
  assert.equal(entries, inputs.length);
  assert.equal(centralCount, inputs.length);
});

test("artifact comparison rejects missing, stale and extra files", async () => {
  const base = join(resolve(tmpdir(), "opencode"), `openchamber-custom-provider-usage-compare-${process.pid}-${Date.now()}`);
  const expected = join(base, "expected");
  const actual = join(base, "actual");
  await mkdir(expected, { recursive: true });
  await mkdir(actual, { recursive: true });
  try {
    await writeFile(join(expected, "asset.js"), "current");
    await writeFile(join(actual, "asset.js"), "current");
    await assertDirectoriesMatch(expected, actual);
    await rm(join(actual, "asset.js"));
    await assert.rejects(assertDirectoriesMatch(expected, actual), /缺失/u);
    await writeFile(join(actual, "asset.js"), "stale");
    await assert.rejects(assertDirectoriesMatch(expected, actual), /过期/u);
    await writeFile(join(actual, "extra.txt"), "extra");
    await assert.rejects(assertDirectoriesMatch(expected, actual), /多余/u);
  } finally { await rm(base, { recursive: true, force: true }); }
});
