import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

async function loadController() {
  const [controllerSource, settingsSource] = await Promise.all([
    readFile(new URL("../src/ui-state.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/sites.ts", import.meta.url), "utf8"),
  ]);
  const compiled = ts.transpileModule(controllerSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const settings = evaluate(settingsSource);
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports,
    Intl, Date, Promise, JSON, Math, Number, Map, Array, Object, String, console, globalThis: { setTimeout, clearTimeout },
    require: (id) => {
      if (id === "./sites") return settings;
      if (id === "./new-api") return {};
      throw new Error(`unexpected import ${id}`);
    },
  });
  return module.exports.StatusController;
}

function evaluate(source) {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, Intl, Date, Promise, JSON, Math, Number, Map, Array, Object, String, URL });
  return module.exports;
}

const StatusController = await loadController();

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve)); };
const balance = (display) => ({ quota: 1, display, unit: "USD" });
const site = (id, token = "t") => ({ id, name: `站${id}`, origin: `https://${id}.example.com`, token });

function harness(config = { sites: [site("a")], settings: { autoRefresh: true, intervalSeconds: 10 } }) {
  const calls = [];
  const timers = [];
  const updates = [];
  let stored = structuredClone(config);
  const controller = new StatusController({
    readConfig: async () => structuredClone(stored),
    query: (target) => { const item = deferred(); calls.push({ site: target, item }); return item.promise; },
    safeErrorMessage: () => "余额查询失败，请检查网络后重试。",
    onChange: (state) => updates.push(JSON.parse(JSON.stringify(state))),
    setTimer: (handler, ms) => {
      const entry = { ms, cleared: false, handler: () => { entry.cleared = true; handler(); } };
      timers.push(entry);
      return entry;
    },
    clearTimer: (entry) => { entry.cleared = true; },
    concurrency: 2,
  });
  const live = () => timers.filter((entry) => !entry.cleared);
  return {
    controller, calls, timers, live, updates,
    write: (next) => { stored = structuredClone(next); },
    settle,
  };
}

test("ready 一次性读取配置并按并发上限查询所有站点", async () => {
  const h = harness({ sites: [site("a"), site("b"), site("c")], settings: { autoRefresh: true, intervalSeconds: 10 } });
  h.controller.ready();
  h.controller.ready(); // repeated host snapshots must not re-read
  await settle();
  assert.equal(h.calls.length, 2);
  assert.equal(h.controller.state.sites.map((entry) => entry.name).join(","), "站a,站b,站c");
  h.calls[0].item.resolve(balance("$1.00"));
  await settle();
  assert.equal(h.calls.length, 3);
  h.calls[1].item.resolve(balance("$1.00"));
  h.calls[2].item.resolve(balance("$1.00"));
  await settle();
  assert.equal(h.controller.state.sites.map((entry) => entry.display).join(","), "$1.00,$1.00,$1.00");
  assert.equal(h.controller.state.pending, false);
  assert.ok(h.controller.state.sites.every((entry) => entry.lastSuccess instanceof Date && entry.lastSuccess.getTime() > 0));
});

test("单个站点失败只影响自身，其余站点照常显示", async () => {
  const h = harness({ sites: [site("a"), site("b")], settings: { autoRefresh: true, intervalSeconds: 10 } });
  h.controller.ready();
  await settle();
  h.calls[0].item.resolve(balance("$3.83"));
  h.calls[1].item.reject(new Error("secret-token-should-not-leak"));
  await settle();
  assert.equal(h.controller.state.sites[0].display, "$3.83");
  assert.equal(h.controller.state.sites[0].error, "");
  assert.equal(h.controller.state.sites[1].error, "余额查询失败，请检查网络后重试。");
  assert.doesNotMatch(JSON.stringify(h.controller.state), /secret-token-should-not-leak/u);
});

test("自动刷新按设置的秒数排一次定时器，默认 10 秒", async () => {
  const h = harness();
  h.controller.ready();
  await settle();
  h.calls[0].item.resolve(balance("$1.00"));
  await settle();
  assert.equal(h.live().at(-1).ms, 10_000);
});

test("关闭自动刷新后不再按时查询，只保留配置检查", async () => {
  const h = harness({ sites: [site("a")], settings: { autoRefresh: false, intervalSeconds: 5 } });
  h.controller.ready();
  await settle();
  h.calls[0].item.resolve(balance("$1.00"));
  await settle();
  assert.equal(h.live().length, 1);
  assert.equal(h.live()[0].ms, 15_000);
  assert.equal(h.controller.state.autoRefresh, false);
});

test("自定义间隔被采用；隐藏后停止计时，重新显示立即刷新一次", async () => {
  const h = harness({ sites: [site("a")], settings: { autoRefresh: true, intervalSeconds: 45 } });
  h.controller.ready();
  await settle();
  h.calls[0].item.resolve(balance("$1.00"));
  await settle();
  assert.equal(h.live().at(-1).ms, 45_000);

  h.controller.setVisible(false);
  assert.equal(h.live().length, 0);
  h.controller.setVisible(true);
  const immediate = h.live().at(-1);
  assert.equal(immediate.ms, 0);
  immediate.handler();
  await settle();
  assert.equal(h.calls.length, 2);
});

test("定时到点重新读取存储：面板新增的站点会立即查询", async () => {
  const h = harness({ sites: [site("a")], settings: { autoRefresh: true, intervalSeconds: 10 } });
  h.controller.ready();
  await settle();
  h.calls[0].item.resolve(balance("$1.00"));
  await settle();
  h.write({ sites: [site("a"), site("b")], settings: { autoRefresh: true, intervalSeconds: 10 } });
  h.live().at(-1).handler();
  await settle();
  assert.equal(h.controller.state.sites.map((entry) => entry.id).join(","), "a,b");
  assert.equal(h.calls.length, 3);
  h.calls[1].item.resolve(balance("$1.00"));
  h.calls[2].item.resolve(balance("$3.00"));
  await settle();
  assert.equal(h.controller.state.sites[1].display, "$3.00");
});

test("面板改间隔后，下一轮沿用新间隔", async () => {
  const h = harness({ sites: [site("a")], settings: { autoRefresh: true, intervalSeconds: 10 } });
  h.controller.ready();
  await settle();
  h.calls[0].item.resolve(balance("$1.00"));
  await settle();
  h.write({ sites: [site("a")], settings: { autoRefresh: true, intervalSeconds: 30 } });
  h.live().at(-1).handler();
  await settle();
  h.calls[1].item.resolve(balance("$1.10"));
  await settle();
  assert.equal(h.controller.state.intervalSeconds, 30);
  assert.equal(h.live().at(-1).ms, 30_000);
});

test("关闭自动刷新但仍保留区块可见时，面板改动站点会触发一次查询", async () => {
  const h = harness({ sites: [site("a")], settings: { autoRefresh: false, intervalSeconds: 10 } });
  h.controller.ready();
  await settle();
  h.calls[0].item.resolve(balance("$1.00"));
  await settle();
  h.write({ sites: [site("a"), site("b")], settings: { autoRefresh: false, intervalSeconds: 10 } });
  h.live().at(-1).handler();
  await settle();
  // Existing site data is kept, only the new site is queried.
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].site.id, "b");
  h.calls[1].item.resolve(balance("$2.00"));
  await settle();
  assert.equal(h.controller.state.sites[0].display, "$1.00");
  assert.equal(h.controller.state.sites[1].display, "$2.00");
  assert.equal(h.live().at(-1).ms, 15_000);
});

test("关闭自动刷新时，仅 userId 的新增、修改和清除都会触发该站点重查", async () => {
  const h = harness({ sites: [site("a")], settings: { autoRefresh: false, intervalSeconds: 10 } });
  h.controller.ready();
  await settle();
  h.calls[0].item.resolve(balance("$1.00"));
  await settle();
  for (const userId of ["9527", "9528", undefined]) {
    h.write({ sites: [{ ...site("a"), ...(userId ? { userId } : {}) }], settings: { autoRefresh: false, intervalSeconds: 10 } });
    h.live().at(-1).handler();
    await settle();
    assert.equal(h.calls.length, userId === "9527" ? 2 : userId === "9528" ? 3 : 4);
    assert.equal(h.calls.at(-1).site.userId, userId);
    h.calls.at(-1).item.resolve(balance("$2.00"));
    await settle();
  }
});

test("没有站点时给出空态，不发出查询也不排查询定时器", async () => {
  const h = harness({ sites: [], settings: { autoRefresh: true, intervalSeconds: 10 } });
  h.controller.ready();
  await settle();
  assert.equal(h.calls.length, 0);
  assert.equal(h.controller.state.loaded, true);
  assert.equal(h.controller.state.sites.length, 0);
  assert.equal(h.live().length, 0);
});

test("手动刷新时旧余额保持可见并标记 pending；重复点击不叠加请求", async () => {
  const h = harness();
  h.controller.ready();
  await settle();
  h.calls[0].item.resolve(balance("$1.00"));
  await settle();
  void h.controller.refresh();
  void h.controller.refresh();
  assert.equal(h.calls.length, 2);
  assert.equal(h.controller.state.sites[0].display, "$1.00");
  assert.equal(h.controller.state.sites[0].pending, true);
  h.calls[1].item.resolve(balance("$2.00"));
  await settle();
  assert.equal(h.controller.state.sites[0].display, "$2.00");
  assert.equal(h.controller.state.pending, false);
});

test("自动刷新进行中点手动刷新：不并发重复请求，但结束后补一次手动查询", async () => {
  const h = harness();
  h.controller.ready();
  await settle();
  h.calls[0].item.resolve(balance("$1.00"));
  await settle();
  h.live().at(-1).handler();          // automatic pass starts
  await settle();
  assert.equal(h.calls.length, 2);
  void h.controller.refresh();        // user clicks while it runs
  void h.controller.refresh();
  assert.equal(h.calls.length, 2, "no second in-flight request");
  h.calls[1].item.resolve(balance("$2.00"));
  await settle();
  assert.equal(h.calls.length, 3, "queued manual pass runs once");
  h.calls[2].item.resolve(balance("$3.00"));
  await settle();
  assert.equal(h.controller.state.sites[0].display, "$3.00");
  assert.equal(h.controller.state.pending, false);
});

test("自动刷新完成后仍按间隔排下一次，定时器不会因为手动刷新丢失", async () => {
  const h = harness();
  h.controller.ready();
  await settle();
  h.calls[0].item.resolve(balance("$1.00"));
  await settle();
  h.live().at(-1).handler();
  await settle();
  h.calls[1].item.resolve(balance("$2.00"));
  await settle();
  assert.equal(h.live().length, 1);
  assert.equal(h.live()[0].ms, 10_000);
});

test("宿主无响应显示可读提示，之后 ready 可恢复", () => {
  const h = harness();
  h.controller.markHostUnavailable();
  assert.match(h.controller.state.error, /无法连接 OpenChamber/);
  h.controller.ready();
  assert.equal(h.controller.state.hostAvailable, true);
  assert.equal(h.controller.state.error, "");
});

test("dispose 忽略过期响应、停止计时并不再通知", async () => {
  const h = harness();
  h.controller.ready();
  await settle();
  h.controller.dispose();
  const emissions = h.updates.length;
  h.calls[0].item.resolve(balance("$9.99"));
  await settle();
  assert.equal(h.updates.length, emissions);
  assert.equal(h.live().length, 0);
  assert.equal(h.controller.state.sites[0]?.display ?? "", "");
});

test("Work Status 与面板模板引用存在的脚本，且样式使用宿主 token", async () => {
  const statusHtml = await readFile(new URL("../status/index.html", import.meta.url), "utf8");
  const panelHtml = await readFile(new URL("../panel/index.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const statusMain = await readFile(new URL("../src/status-main.ts", import.meta.url), "utf8");
  for (const html of [statusHtml, panelHtml]) {
    assert.match(html, /id="root"/u);
    assert.match(html, /styles\.css/u);
    assert.match(html, /main\.js/u);
  }
  assert.match(statusHtml, /正在等待 OpenChamber 宿主/u);
  assert.match(statusHtml, /data-sites/u);
  assert.match(statusHtml, /data-empty/u);
  assert.match(statusHtml, /data-label/u);
  assert.match(panelHtml, /data-list/u);
  assert.match(panelHtml, /data-auto/u);
  assert.match(panelHtml, /data-interval/u);
  for (const token of ["--oc-bg", "--oc-fg", "--oc-muted", "--oc-warning-text", "--oc-error-text", "--oc-radius", "--oc-font"]) {
    assert.ok(css.includes(token) || statusMain.includes(token), `missing host token ${token}`);
  }
  assert.match(css, /@media \(max-width: 320px\)/u);
  assert.doesNotMatch(css, /var\(--card|var\(--muted-foreground/u);
  assert.match(statusMain, /type HostReadyContext/u);
  assert.match(statusMain, /plugin:custom-provider-usage/u);
});
