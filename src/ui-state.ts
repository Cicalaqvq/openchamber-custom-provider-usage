import type { BalanceResult } from "./new-api";
import type { AppSettings, SiteConfig } from "./sites";
import { autoRefreshDelayMs, displayHost, sanitizeSettings, parseSites } from "./sites";

export type SiteState = {
  id: string;
  name: string;
  host: string;
  pending: boolean;
  hasBalance: boolean;
  display: string;
  unit: string;
  lastSuccess?: Date;
  error: string;
  note: string;
};

export type StatusState = {
  hostAvailable: boolean;
  loaded: boolean;
  pending: boolean;
  sites: SiteState[];
  autoRefresh: boolean;
  intervalSeconds: number;
  error: string;
};

export type Config = { sites: SiteConfig[]; settings: AppSettings };

type Options = {
  readConfig: () => Promise<{ sites: unknown; settings: unknown }>;
  query: (site: SiteConfig) => Promise<BalanceResult>;
  safeErrorMessage: (error: unknown) => string;
  onChange: (state: Readonly<StatusState>) => void;
  now?: () => Date;
  setTimer?: (handler: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Concurrent site queries. Keeps a long list from bursting through the local service. */
  concurrency?: number;
};

const EMPTY_SETTINGS: AppSettings = { autoRefresh: true, intervalSeconds: 10 };
/** How often an open section re-reads configuration while auto-refresh is off. */
const CONFIG_CHECK_MS = 15_000;
/** Marker for "query every configured site". */
const ALL_SITES = "*";
type TargetSelection = ReadonlySet<string> | typeof ALL_SITES;

/** Lifecycle-aware state model for every configured site, independent of the DOM. */
export class StatusController {
  readonly state: StatusState = {
    hostAvailable: false, loaded: false, pending: false, sites: [],
    autoRefresh: EMPTY_SETTINGS.autoRefresh, intervalSeconds: EMPTY_SETTINGS.intervalSeconds, error: "",
  };

  private config: Config | undefined;
  private epoch = 0;
  private disposed = false;
  private started = false;
  private visible = true;
  private timer: unknown;
  private running = false;
  private runningSilent = false;
  private manualQueued = false;
  private readonly now: () => Date;
  private readonly setTimer: (handler: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: Options) {
    this.now = options.now ?? (() => new Date());
    const scope = globalThis as unknown as {
      setTimeout: (handler: () => void, ms: number) => unknown;
      clearTimeout: (handle: unknown) => void;
    };
    this.setTimer = options.setTimer ?? ((handler, ms) => scope.setTimeout(handler, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => scope.clearTimeout(handle));
  }

  private emit() { this.options.onChange(this.state); }

  markHostUnavailable() {
    if (this.disposed || this.state.hostAvailable) return;
    this.state.error = "暂时无法连接 OpenChamber 宿主，请稍后重试或重新打开此区块。";
    this.emit();
  }

  /** Called on every host snapshot; only the first one loads configuration. */
  ready() {
    if (this.disposed) return;
    const recovering = !this.state.hostAvailable;
    this.state.hostAvailable = true;
    if (recovering) this.state.error = "";
    this.emit();
    if (this.started) return;
    this.started = true;
    void this.reload();
  }

  /** Re-reads stored sites and settings, then refreshes whenever anything is configured. */
  async reload(): Promise<void> {
    if (this.disposed) return;
    const epoch = ++this.epoch;
    this.cancelTimer();
    try {
      const stored = await this.options.readConfig();
      if (this.disposed || epoch !== this.epoch) return;
      const sites = parseSites(stored.sites);
      const settings = sanitizeSettings(stored.settings);
      this.state.autoRefresh = settings.autoRefresh;
      this.state.intervalSeconds = settings.intervalSeconds;
      this.config = { sites, settings };
      this.syncSites(sites);
      this.state.loaded = true;
      this.state.error = "";
      this.emit();
      if (sites.length > 0) await this.refresh();
      else this.scheduleNext();
    } catch (error) {
      if (this.disposed || epoch !== this.epoch) return;
      this.state.loaded = true;
      this.state.error = this.options.safeErrorMessage(error);
      this.emit();
      this.scheduleNext();
    }
  }

  /** Manual refresh: shows the pending state even when the last values are still displayed. */
  async refresh(): Promise<void> {
    await this.run(false);
  }

  private async run(silent: boolean, targetIds?: TargetSelection): Promise<void> {
    const config = this.config;
    if (this.disposed) return;
    if (!config || config.sites.length === 0) {
      this.scheduleNext();
      return;
    }
    const targets: TargetSelection = targetIds ?? ALL_SITES;
    // One pass at a time, whichever started it. A click during an automatic pass queues one manual
    // pass for right after it; clicks during a manual pass are already covered by it.
    if (this.running) {
      if (!silent && this.runningSilent) this.manualQueued = true;
      return;
    }
    this.running = true;
    this.runningSilent = silent;
    const epoch = ++this.epoch;
    this.cancelTimer();
    // A background pass must not flash the manual spinner every interval.
    if (!silent) {
      this.state.pending = true;
      for (const site of this.state.sites) site.pending = true;
    }
    this.state.error = "";
    this.emit();

    const queue = config.sites.filter((site) => targets === ALL_SITES || targets.has(site.id));
    if (queue.length === 0) {
      this.finish(epoch);
      return;
    }
    const limit = Math.max(1, Math.min(this.options.concurrency ?? 4, queue.length));
    const workers = Array.from({ length: limit }, async () => {
      for (;;) {
        const site = queue.shift();
        if (!site || this.disposed || epoch !== this.epoch) return;
        await this.queryOne(site, epoch);
      }
    });
    try {
      await Promise.all(workers);
    } finally {
      this.finish(epoch);
    }
  }

  /** Ends a pass: clear the spinners, then schedule (or run) the next one. */
  private finish(epoch: number) {
    this.running = false;
    const queued = this.manualQueued;
    this.manualQueued = false;
    if (this.disposed || epoch !== this.epoch) return;
    this.state.pending = false;
    for (const site of this.state.sites) site.pending = false;
    this.emit();
    if (queued) void this.run(false);
    else this.scheduleNext();
  }

  private async queryOne(site: SiteConfig, epoch: number): Promise<void> {
    const target = this.state.sites.find((entry) => entry.id === site.id);
    if (!target) return;
    try {
      const result = await this.options.query(site);
      if (this.disposed || epoch !== this.epoch) return;
      target.display = result.display;
      target.unit = result.unit;
      target.hasBalance = true;
      target.lastSuccess = this.now();
      target.error = "";
      target.note = result.note || "";
    } catch (error) {
      if (this.disposed || epoch !== this.epoch) return;
      target.error = this.options.safeErrorMessage(error);
    } finally {
      if (!this.disposed && epoch === this.epoch && this.state.sites.includes(target)) {
        target.pending = false;
        this.emit();
      }
    }
  }

  /** Config edits in the panel reach the section through this, without a reload of the frame. */
  private syncSites(sites: SiteConfig[]) {
    const previous = new Map(this.state.sites.map((site) => [site.id, site]));
    this.state.sites = sites.map((site) => {
      const host = displayHost(site.origin);
      const existing = previous.get(site.id);
      if (existing && existing.name === site.name && existing.host === host) return existing;
      return {
        id: site.id, name: site.name, host, pending: false, hasBalance: false,
        display: "", unit: "", error: "", note: "",
      };
    });
  }

  /** Work Status frames are torn down when collapsed, but the document may stay hidden. */
  setVisible(visible: boolean) {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    if (visible) {
      this.scheduleNext(0);
    } else {
      this.cancelTimer();
    }
  }

  /**
   * Automatic queries follow the stored interval; with auto-refresh off a slower
   * configuration check still runs so a panel edit reaches an open section.
   */
  private scheduleNext(delayOverride?: number) {
    this.cancelTimer();
    if (this.disposed || !this.visible || !this.config) return;
    const automatic = autoRefreshDelayMs(this.config.settings, this.config.sites.length);
    const delay = delayOverride ?? automatic ?? (this.config.sites.length > 0 ? CONFIG_CHECK_MS : undefined);
    if (delay === undefined) return;
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      if (this.disposed || !this.visible) return;
      void this.tick();
    }, delay);
  }

  private async tick() {
    if (this.disposed) return;
    let targets: TargetSelection | undefined;
    // Storage is re-read before every pass, so panel edits apply to an already-mounted frame.
    try {
      const stored = await this.options.readConfig();
      if (this.disposed) return;
      const sites = parseSites(stored.sites);
      const settings = sanitizeSettings(stored.settings);
      const current = this.config;
      const previous = new Map((current?.sites ?? []).map((site) => [site.id, site]));
      const added = new Set<string>();
      for (const site of sites) {
        const old = previous.get(site.id);
        if (!old || old.origin !== site.origin || old.token !== site.token || old.userId !== site.userId) added.add(site.id);
      }
      const removedOrReordered = !current
        || sites.length !== current.sites.length
        || sites.some((site, index) => current.sites[index]?.id !== site.id);
      const changed = removedOrReordered
        || added.size > 0
        || settings.autoRefresh !== current.settings.autoRefresh
        || settings.intervalSeconds !== current.settings.intervalSeconds
        || sites.some((site, index) => current.sites[index]?.name !== site.name);
      if (changed) {
        this.config = { sites, settings };
        this.state.autoRefresh = settings.autoRefresh;
        this.state.intervalSeconds = settings.intervalSeconds;
        this.state.loaded = true;
        this.syncSites(sites);
        this.emit();
      }
      if (sites.length > 0) {
        // With automatic refresh off, only new or edited sites are queried, so the panel edit lands at once.
        targets = settings.autoRefresh ? ALL_SITES : added;
      }
    } catch {
      // Keep the last known configuration; the refresh below reports real failures.
    }
    if (this.disposed) return;
    if (!targets || (targets !== ALL_SITES && targets.size === 0)) {
      this.scheduleNext();
      return;
    }
    await this.run(true, targets);
  }

  private cancelTimer() {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch++;
    this.running = false;
    this.cancelTimer();
    this.state.pending = false;
  }
}
