import { connectHost, type HostReadyContext } from "@openchamber/sdk";
import { applyHostReady, mountBadge, mountButton, mountSwitch, mountTextField } from "@openchamber/sdk/ui";
import { createQuerier, querySite } from "./data";
import { safeErrorMessage } from "./new-api";
import {
  DEFAULT_SETTINGS, INTERVAL_MAX_SECONDS, INTERVAL_MIN_SECONDS, MAX_SITES, SETTINGS_KEY, SITES_KEY,
  displayHost, formatUpdatedAtFull, parseSites, sanitizeSettings, validateSiteDraft,
  type AppSettings, type SiteConfig,
} from "./sites";

const host = connectHost();
const root = document.querySelector<HTMLElement>("#root");
if (!root) throw new Error("Panel root is missing");

const list = root.querySelector<HTMLElement>("[data-list]")!;
const emptyNote = root.querySelector<HTMLElement>("[data-empty]")!;
const summary = root.querySelector<HTMLElement>("[data-summary]")!;
const banner = root.querySelector<HTMLElement>("[data-banner]")!;
const actions = root.querySelector<HTMLElement>("[data-actions]")!;
const autoSlot = root.querySelector<HTMLElement>("[data-auto]")!;
const intervalSlot = root.querySelector<HTMLElement>("[data-interval]")!;

type Draft = { name: string; origin: string; token: string };
type Row = {
  /** Last saved configuration; undefined while a brand-new row has never been committed. */
  saved?: SiteConfig;
  draft: Draft;
  errors: { name?: string; origin?: string; token?: string };
  /** True while the form is open. A new row starts open and stays unsaved until it validates. */
  editing: boolean;
  confirmingDelete: boolean;
};
type Balance = { display: string; unit: string; at?: Date; note: string; error: string };

const rows: Row[] = [];
const balances = new Map<string, Balance>();
let settings: AppSettings = { ...DEFAULT_SETTINGS };
let loaded = false;
let saving = false;
let refreshing = false;
let notice = "";
/** Set by every in-memory commit; cleared by a successful write. */
let dirty = false;

const saveButton = mountButton(actions, {
  label: "保存", size: "sm", disabled: true,
  onClick: () => { void persistAll(); },
});
mountButton(actions, { label: "添加中转站", variant: "secondary", size: "sm", onClick: () => addSite() });
const refreshButton = mountButton(actions, {
  label: "刷新全部", variant: "outline", size: "sm",
  onClick: () => { void refreshAll(true); },
});

const querier = createQuerier(host);

function setNotice(text: string) {
  notice = text;
}

function syncSaveButton() {
  saveButton.update({ disabled: saving || !isDirty(), loading: saving });
}

function committed(): SiteConfig[] {
  return rows.flatMap((row) => (row.saved ? [row.saved] : []));
}

function hasUnsavedNew(): boolean {
  return rows.some((row) => !row.saved);
}

function isDirty(): boolean {
  return dirty || hasUnsavedNew() || rows.some((row) => row.editing);
}

function emptyDraft(site?: SiteConfig): Draft {
  return site
    ? { name: site.name, origin: site.origin, token: "" }
    : { name: "", origin: "", token: "" };
}

function newId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `site-${uuid ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`}`;
}

async function write(key: string, value: unknown): Promise<void> {
  await host.storage.set(key, value as never);
}

/** Persists only committed sites: a half-filled form never overwrites what was saved before. */
async function saveConfig(): Promise<boolean> {
  try {
    await write(SITES_KEY, committed());
    await write(SETTINGS_KEY, settings);
    dirty = false;
    return true;
  } catch (error) {
    setNotice(`保存失败：${safeErrorMessage(error)}`);
    render();
    return false;
  }
}

async function load(): Promise<void> {
  try {
    const [storedSites, storedSettings] = await Promise.all([
      host.storage.get(SITES_KEY).catch(() => undefined),
      host.storage.get(SETTINGS_KEY).catch(() => undefined),
    ]);
    settings = sanitizeSettings(storedSettings);
    const sites = parseSites(storedSites);
    rows.length = 0;
    for (const site of sites) {
      rows.push({ saved: site, draft: emptyDraft(site), errors: {}, editing: false, confirmingDelete: false });
    }
    for (const id of Array.from(balances.keys())) {
      if (!sites.some((site) => site.id === id)) balances.delete(id);
    }
    loaded = true;
    render();
    void refreshAll(false);
  } catch (error) {
    setNotice(`读取设置失败：${safeErrorMessage(error)}`);
    loaded = true;
    render();
  }
}

/** Validates every open form, commits what it can, and writes the whole document once. */
async function persistAll(): Promise<void> {
  if (saving) return;
  let invalid = false;
  for (const row of rows) {
    if (!row.editing && row.saved) continue;
    const result = validateSiteDraft(row.draft, row.saved?.token ?? "");
    if (!result.ok) {
      row.errors = result.errors;
      row.editing = true;
      invalid = true;
      continue;
    }
    row.saved = { id: row.saved?.id ?? newId(), name: result.name, origin: result.origin, token: result.token };
    row.draft = emptyDraft(row.saved);
    row.errors = {};
    row.editing = false;
  }
  if (invalid) {
    setNotice("请先修正标记的字段。");
    render();
    return;
  }
  saving = true;
  setNotice("");
  render();
  const ok = await saveConfig();
  saving = false;
  if (ok) setNotice("已保存。");
  render();
  if (ok) void refreshAll(false);
}

async function queryOne(row: Row): Promise<void> {
  const site = row.saved;
  if (!site || !site.token) return;
  const previous = balances.get(site.id);
  try {
    const result = await querySite(site, querier);
    balances.set(site.id, { display: result.display, unit: result.unit, at: new Date(), note: result.note ?? "", error: "" });
  } catch (error) {
    balances.set(site.id, {
      display: previous?.display ?? "", unit: previous?.unit ?? "", at: previous?.at,
      note: previous?.note ?? "", error: safeErrorMessage(error),
    });
  }
}

async function refreshAll(announce: boolean): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  refreshButton.update({ loading: true, disabled: true });
  render();
  const targets = rows.filter((row) => row.saved?.token);
  const queue = [...targets];
  const workers = Array.from({ length: Math.min(3, queue.length) || 1 }, async () => {
    for (;;) {
      const row = queue.shift();
      if (!row) return;
      await queryOne(row);
      render();
    }
  });
  await Promise.all(workers);
  refreshing = false;
  refreshButton.update({ loading: false, disabled: false });
  if (announce && targets.length === 0) setNotice("还没有可查询的中转站：先添加站点并填写令牌。");
  render();
}

function addSite(): void {
  if (rows.filter((row) => row.saved).length >= MAX_SITES) {
    setNotice(`最多支持 ${MAX_SITES} 个中转站。`);
    render();
    return;
  }
  setNotice("");
  rows.push({ draft: emptyDraft(), errors: {}, editing: true, confirmingDelete: false });
  render();
  const editors = list.querySelectorAll<HTMLElement>(".site-editor");
  editors[editors.length - 1]?.querySelector<HTMLInputElement>("input")?.focus();
}

function removeSite(row: Row): void {
  const index = rows.indexOf(row);
  if (index < 0) return;
  rows.splice(index, 1);
  if (row.saved) balances.delete(row.saved.id);
  render();
  if (!row.saved) return;
  dirty = true;
  void saveConfig().then((ok) => {
    if (!ok) return;
    setNotice("已移除该中转站。");
    render();
  });
}

function move(row: Row, delta: number): void {
  const index = rows.indexOf(row);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= rows.length) return;
  const [item] = rows.splice(index, 1);
  rows.splice(target, 0, item!);
  dirty = true;
  render();
  void saveConfig();
}

function startEdit(row: Row): void {
  row.draft = emptyDraft(row.saved);
  row.errors = {};
  row.editing = true;
  setNotice("");
  render();
}

function cancelEdit(row: Row): void {
  if (!row.saved) rows.splice(rows.indexOf(row), 1);
  else {
    row.editing = false;
    row.errors = {};
    row.draft = emptyDraft(row.saved);
  }
  render();
}

/** "完成" commits the form in memory; the header's 保存 writes it, matching the button's stated scope. */
function finishEdit(row: Row): void {
  const result = validateSiteDraft(row.draft, row.saved?.token ?? "");
  if (!result.ok) {
    row.errors = result.errors;
    render();
    return;
  }
  row.saved = { id: row.saved?.id ?? newId(), name: result.name, origin: result.origin, token: result.token };
  row.draft = emptyDraft(row.saved);
  row.errors = {};
  row.editing = false;
  loaded = true;
  dirty = true;
  setNotice("已修改，点击“保存”写入设置。");
  render();
}

function clearToken(row: Row): void {
  if (!row.saved) return;
  row.saved = { ...row.saved, token: "" };
  row.draft = { ...row.draft, token: "" };
  dirty = true;
  setNotice("令牌已清除，保存后生效。");
  render();
}

function renderEditor(row: Row): HTMLElement {
  const box = document.createElement("div");
  box.className = "site-editor";
  const nameSlot = document.createElement("div");
  const originSlot = document.createElement("div");
  const tokenSlot = document.createElement("div");
  const footer = document.createElement("div");
  footer.className = "site-editor-actions";
  box.append(nameSlot, originSlot, tokenSlot, footer);

  mountTextField(nameSlot, {
    label: "名称（可选）",
    value: row.draft.name,
    placeholder: displayHost(row.draft.origin) || "relay.example.com",
    helper: "留空时使用站点域名。",
    onChange: (value) => { row.draft.name = value; },
  });
  mountTextField(originSlot, {
    label: "站点地址",
    value: row.draft.origin,
    placeholder: "https://relay.example.com",
    mono: true,
    error: row.errors.origin,
    helper: "只填根地址，不要带路径、查询参数或账号信息。",
    onChange: (value) => { row.draft.origin = value; delete row.errors.origin; },
  });
  mountTextField(tokenSlot, {
    label: "API 令牌",
    value: row.draft.token,
    placeholder: row.saved?.token ? "已保存令牌，留空则保持不变" : "New API 账号 access token",
    password: true,
    mono: true,
    error: row.errors.token,
    helper: "账号 access token / PAT，不是 sk- 开头的模型 API Key。",
    onChange: (value) => { row.draft.token = value; delete row.errors.token; },
  });

  mountButton(footer, { label: "完成", size: "sm", onClick: () => finishEdit(row) });
  mountButton(footer, { label: "取消", variant: "ghost", size: "sm", onClick: () => cancelEdit(row) });
  if (row.saved?.token) {
    mountButton(footer, { label: "清除令牌", variant: "ghost", size: "sm", onClick: () => clearToken(row) });
  }
  return box;
}

function renderRow(row: Row): HTMLElement {
  const site = row.saved;
  const item = document.createElement("li");
  item.className = "site-item";
  item.dataset.site = site?.id ?? "unsaved";

  const head = document.createElement("div");
  head.className = "site-item-head";
  const copy = document.createElement("div");
  copy.className = "site-item-copy";
  const title = document.createElement("div");
  title.className = "site-item-title";
  const shownOrigin = row.editing ? (row.draft.origin || site?.origin || "") : (site?.origin ?? "");
  const shownName = row.editing ? (row.draft.name || site?.name || "") : (site?.name ?? "");
  title.textContent = shownName || displayHost(shownOrigin) || "新中转站";
  const sub = document.createElement("div");
  sub.className = "site-item-sub";
  sub.textContent = shownOrigin || "尚未填写地址";
  copy.append(title, sub);

  const side = document.createElement("div");
  side.className = "site-item-side";
  const balance = site ? balances.get(site.id) : undefined;
  if (site?.token && refreshing) {
    mountBadge(side, { label: "查询中" });
  } else if (balance?.error) {
    mountBadge(side, { label: "查询失败", tone: "error" });
  } else if (balance?.display) {
    const value = document.createElement("span");
    value.className = "site-value";
    value.textContent = `${balance.display} ${balance.unit}`;
    side.append(value);
  } else if (site && !site.token) {
    mountBadge(side, { label: "缺少令牌", tone: "warning" });
  } else if (!site) {
    mountBadge(side, { label: "未保存", tone: "warning" });
  }
  head.append(copy, side);
  item.append(head);

  if (row.editing) {
    item.append(renderEditor(row));
    return item;
  }

  const meta = document.createElement("div");
  meta.className = "site-item-meta";
  if (balance?.error) meta.textContent = balance.error;
  else if (balance?.note) meta.textContent = balance.note;
  else if (balance?.at) meta.textContent = `最后成功更新：${formatUpdatedAtFull(balance.at)}`;
  if (meta.textContent) item.append(meta);

  const tools = document.createElement("div");
  tools.className = "site-item-actions";
  item.append(tools);
  if (site?.origin) {
    mountButton(tools, {
      label: "官网", variant: "ghost", size: "xs",
      onClick: () => { void host.openUrl(site.origin).catch(() => { setNotice("无法打开该地址。"); render(); }); },
    });
  }
  mountButton(tools, {
    label: "查询", variant: "ghost", size: "xs", disabled: !site?.token,
    onClick: () => { void queryOne(row).then(() => render()); },
  });
  mountButton(tools, { label: "编辑", variant: "ghost", size: "xs", onClick: () => startEdit(row) });
  mountButton(tools, { label: "上移", variant: "ghost", size: "xs", disabled: rows.indexOf(row) === 0, onClick: () => move(row, -1) });
  mountButton(tools, { label: "下移", variant: "ghost", size: "xs", disabled: rows.indexOf(row) === rows.length - 1, onClick: () => move(row, 1) });
  if (row.confirmingDelete) {
    mountButton(tools, { label: "确认移除", variant: "destructive", size: "xs", onClick: () => removeSite(row) });
    mountButton(tools, { label: "取消", variant: "ghost", size: "xs", onClick: () => { row.confirmingDelete = false; render(); } });
  } else {
    mountButton(tools, { label: "移除", variant: "ghost", size: "xs", onClick: () => { row.confirmingDelete = true; render(); } });
  }
  return item;
}

let autoHandle: ReturnType<typeof mountSwitch> | undefined;
function renderAuto(): void {
  if (!autoHandle) {
    autoHandle = mountSwitch(autoSlot, {
      label: "按间隔自动查询",
      description: "关闭后只在你手动刷新时查询。",
      checked: settings.autoRefresh,
      onChange: (checked) => {
        settings = { ...settings, autoRefresh: checked };
        dirty = true;
        autoHandle?.update({ checked });
        render();
        void saveConfig();
      },
    });
    return;
  }
  autoHandle.update({ checked: settings.autoRefresh });
}

let intervalField: ReturnType<typeof mountTextField> | undefined;
let intervalValue = "";
let intervalTimer: ReturnType<typeof setTimeout> | undefined;
function renderInterval(): void {
  const value = String(settings.intervalSeconds);
  if (!intervalField) {
    intervalValue = value;
    intervalField = mountTextField(intervalSlot, {
      label: "刷新间隔（秒）",
      value,
      helper: `默认 10 秒，范围 ${INTERVAL_MIN_SECONDS}–${INTERVAL_MAX_SECONDS} 秒。`,
      disabled: !settings.autoRefresh,
      onChange: (next) => {
        intervalValue = next;
        // Wait for the number to stop changing so "1" → "12" → "120" is one decision, not three.
        if (intervalTimer) clearTimeout(intervalTimer);
        intervalTimer = setTimeout(() => {
          intervalTimer = undefined;
          const parsed = Number(intervalValue.trim());
          const valid = Number.isInteger(parsed) && parsed >= INTERVAL_MIN_SECONDS && parsed <= INTERVAL_MAX_SECONDS;
          intervalField?.update({ error: valid ? undefined : `请输入 ${INTERVAL_MIN_SECONDS}–${INTERVAL_MAX_SECONDS} 之间的整数秒。` });
          if (!valid || parsed === settings.intervalSeconds) return;
          settings = { ...settings, intervalSeconds: parsed };
          dirty = true;
          syncSaveButton();
          void saveConfig();
        }, 600);
      },
    });
    return;
  }
  // Only an external change rewrites the field, so a value being typed is never replaced.
  if (intervalValue === value) intervalField.update({ disabled: !settings.autoRefresh });
  else {
    intervalValue = value;
    intervalField.update({ value, disabled: !settings.autoRefresh });
  }
}

function render(): void {
  list.textContent = "";
  for (const row of rows) list.append(renderRow(row));
  emptyNote.hidden = rows.length > 0;
  const saved = committed().length;
  const pending = committed().filter((site) => !site.token).length;
  summary.textContent = loaded
    ? `${saved} 个中转站${pending > 0 ? ` · ${pending} 个缺少令牌` : ""}${hasUnsavedNew() ? ` · ${rows.length - saved} 个未保存` : ""}`
    : "正在读取设置…";
  saveButton.update({ disabled: saving || !isDirty(), loading: saving });
  banner.hidden = !notice;
  banner.textContent = notice;
  renderAuto();
  renderInterval();
}

let unsubscribeReady: (() => void) | undefined = host.onReady((ctx: HostReadyContext) => {
  applyHostReady(ctx, document.documentElement);
});

render();
void load();

window.addEventListener("pagehide", () => {
  if (intervalTimer) clearTimeout(intervalTimer);
  unsubscribeReady?.();
  saveButton.dispose();
  refreshButton.dispose();
  host.dispose();
}, { once: true });
