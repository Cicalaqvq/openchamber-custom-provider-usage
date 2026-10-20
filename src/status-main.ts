import { connectHost, type HostReadyContext } from "@openchamber/sdk";
import { applyHostReady, mountButton } from "@openchamber/sdk/ui";
import { createQuerier, querySite } from "./data";
import { safeErrorMessage } from "./new-api";
import { SETTINGS_KEY, SITES_KEY, formatUpdatedAt } from "./sites";
import { StatusController, type SiteState, type StatusState } from "./ui-state";

const root = document.querySelector<HTMLElement>("#root");
if (!root) throw new Error("Status root is missing");

const host = connectHost();
const list = root.querySelector<HTMLElement>("[data-sites]")!;
const empty = root.querySelector<HTMLElement>("[data-empty]")!;
const emptyText = root.querySelector<HTMLElement>("[data-empty-text]")!;
const issue = root.querySelector<HTMLElement>("[data-issue]")!;
const actionBar = root.querySelector<HTMLElement>("[data-action]")!;
const label = root.querySelector<HTMLElement>("[data-label]")!;
const querier = createQuerier(host);

let refreshButton: ReturnType<typeof mountButton> | undefined;
let addButton: ReturnType<typeof mountButton> | undefined;
let unsubscribeReady: (() => void) | undefined;
let resizeObserver: ResizeObserver | undefined;
let lastHeight = -1;
let readyTimer: ReturnType<typeof setTimeout> | undefined;

const updateHeight = () => {
  const height = Math.ceil(root.scrollHeight);
  if (height === lastHeight) return;
  lastHeight = height;
  void host.setHeight(height).catch(() => { /* host may not be ready */ });
};

const openPanel = () => {
  void host.openSurface("plugin:custom-provider-usage").catch(() => {
    void host.toast({
      kind: "info",
      message: "请在左侧扩展栏打开“中转站余额”来管理站点。",
      dismiss: true,
    }).catch(() => { /* best effort */ });
  });
};

const controller = new StatusController({
  readConfig: async () => ({
    sites: await host.storage.get(SITES_KEY),
    settings: await host.storage.get(SETTINGS_KEY),
  }),
  query: (site) => querySite(site, querier),
  safeErrorMessage,
  onChange: (state) => render(state),
  concurrency: 4,
});

function setText(node: HTMLElement, text: string) {
  if (node.textContent !== text) node.textContent = text;
}

function siteRow(site: SiteState, now: Date): HTMLElement {
  const row = document.createElement("li");
  row.className = "site-row";
  row.dataset.site = site.id;

  const title = document.createElement("div");
  title.className = "site-name";
  setText(title, site.name);

  const value = document.createElement("div");
  value.className = "site-value";
  setText(value, site.hasBalance ? `${site.display} ${site.unit}` : (site.pending ? "读取中…" : "—"));
  value.classList.toggle("is-stale", Boolean(site.hasBalance && (site.error || site.pending)));

  const hostName = document.createElement("div");
  hostName.className = "site-host";
  setText(hostName, site.host);

  const detail = document.createElement("div");
  detail.className = "site-detail";
  if (site.error) {
    setText(detail, site.error);
    detail.classList.add("is-issue");
  } else if (site.note) {
    setText(detail, site.note);
  } else if (site.lastSuccess) {
    setText(detail, `${site.pending ? "刷新中 · " : ""}${formatUpdatedAt(site.lastSuccess, now)}`);
  } else {
    setText(detail, site.pending ? "" : "尚未更新");
  }
  if (!detail.textContent) detail.hidden = true;
  if (site.error) row.classList.add("has-issue");

  row.append(title, value, hostName, detail);
  return row;
}

function render(state: Readonly<StatusState>) {
  const now = new Date();
  const hasSites = state.sites.length > 0;
  empty.hidden = hasSites;
  list.hidden = !hasSites;
  setText(label, hasSites
    ? `${state.sites.length} 个站点 · ${state.autoRefresh ? `${state.intervalSeconds} 秒刷新` : "手动刷新"}`
    : "账户余额");

  if (!hasSites) {
    setText(emptyText, state.loaded ? "还没有添加中转站。添加后即可在此查看余额。" : "正在读取中转站设置…");
    addButton ??= mountButton(empty.querySelector<HTMLElement>("[data-manage]")!, {
      label: "添加中转站", size: "sm", onClick: openPanel,
    });
  }

  const rows = new Map(Array.from(list.querySelectorAll<HTMLElement>("[data-site]")).map((row) => [row.dataset.site ?? "", row]));
  for (const site of state.sites) {
    const next = siteRow(site, now);
    const current = rows.get(site.id);
    if (current) current.replaceWith(next);
    else list.append(next);
    rows.delete(site.id);
  }
  for (const leftover of rows.values()) leftover.remove();
  const order = new Map(state.sites.map((site, index) => [site.id, index]));
  Array.from(list.children)
    .sort((a, b) => (order.get((a as HTMLElement).dataset.site ?? "") ?? 0) - (order.get((b as HTMLElement).dataset.site ?? "") ?? 0))
    .forEach((node) => list.append(node));

  const issues: string[] = [];
  if (!state.hostAvailable) issues.push("正在等待 OpenChamber 宿主…");
  if (state.error) issues.push(state.error);
  const issueText = issues.join("\n");
  setText(issue, issueText);
  issue.hidden = !issueText;

  refreshButton?.update({
    loading: state.pending,
    disabled: state.pending || !state.hostAvailable || !hasSites,
    label: state.pending ? "刷新中" : "刷新",
  });
  requestAnimationFrame(updateHeight);
}

refreshButton = mountButton(actionBar, {
  label: "刷新", variant: "outline", size: "sm", disabled: true,
  onClick: () => { void controller.refresh(); },
});
const manageButton = mountButton(actionBar, { label: "管理", variant: "ghost", size: "sm", onClick: openPanel });

resizeObserver = new ResizeObserver(updateHeight);
resizeObserver.observe(root);
requestAnimationFrame(updateHeight);

readyTimer = setTimeout(() => controller.markHostUnavailable(), 3500);

unsubscribeReady = host.onReady((ctx: HostReadyContext) => {
  if (readyTimer) clearTimeout(readyTimer);
  readyTimer = undefined;
  applyHostReady(ctx, document.documentElement);
  controller.ready();
});

document.addEventListener("visibilitychange", () => controller.setVisible(document.visibilityState !== "hidden"));

window.addEventListener("pagehide", () => {
  if (readyTimer) clearTimeout(readyTimer);
  controller.dispose();
  unsubscribeReady?.();
  resizeObserver?.disconnect();
  refreshButton?.dispose();
  addButton?.dispose();
  manageButton.dispose();
  host.dispose();
}, { once: true });
