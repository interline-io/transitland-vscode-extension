import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TransitlandCLI, resolveBinaryPath } from './cli';
import { runValidate } from './tools/validate';
import { runInspect } from './tools/inspect';
import { GtfsValidationPanel, type EntityStop, type EntityRoute, type ValidationPanelMessage } from './panels/gtfsValidation';
import { GtfsInspectPanel } from './panels/gtfsInspect';
import { GtfsRtInspectPanel } from './panels/gtfsRtInspect';
import { runRtInspect } from './tools/rtInspect';
import { runFeedInfo } from './tools/feedInfo';
import { runCompareFeedSources } from './tools/compareFeedSources';
import { runNtdSearch, formatNtdAgencies } from './tools/ntdSearch';
import { runSetField, runAddFeed, runAddOperator, findDmfrFiles } from './tools/dmfrEdit';
import { runDmfrFormat } from './tools/dmfrFormat';
import { GtfsFeedSourceComparisonPanel } from './panels/gtfsFeedSourceComparison';
import { WelcomePanel, WelcomeMessage } from './panels/welcome';

const TRANSITLAND_API_BASE = 'https://transit.land/api/v2/rest';

let outputChannel: vscode.OutputChannel;
let cli: TransitlandCLI | undefined;

function getConfig() {
  return vscode.workspace.getConfiguration('transitland');
}

function getApiKey(): string {
  const key = getConfig().get<string>('apiKey');
  if (key && key.trim()) { return key.trim(); }
  return process.env.TRANSITLAND_API_KEY ?? '';
}

function initCLI(): TransitlandCLI | undefined {
  const configPath = getConfig().get<string>('cliPath') ?? '';
  const envPath = process.env.TRANSITLAND_BIN ?? '';
  const resolved = resolveBinaryPath(configPath || envPath);
  if (!resolved) { return undefined; }
  return new TransitlandCLI({
    binaryPath: resolved,
    log: (line) => outputChannel.appendLine(line),
  });
}

function requireCLI(): TransitlandCLI | undefined {
  if (!cli) {
    vscode.window.showErrorMessage(
      'transitland CLI not found.',
      'Install via Homebrew',
    ).then((choice) => {
      if (choice === 'Install via Homebrew') {
        vscode.env.openExternal(vscode.Uri.parse('https://github.com/interline-io/homebrew-transitland-lib'));
      }
    });
  }
  return cli;
}

function token2signal(token: vscode.CancellationToken): AbortSignal {
  const controller = new AbortController();
  token.onCancellationRequested(() => controller.abort());
  return controller.signal;
}

function isTransitlandFeedId(id: string): boolean {
  return typeof id === 'string' && id.startsWith('f-');
}

interface DmfrFeed {
  id?: string;
  spec?: string;
  urls?: {
    static_current?: string; // eslint-disable-line @typescript-eslint/naming-convention
    realtime_alerts?: string; // eslint-disable-line @typescript-eslint/naming-convention
    realtime_trip_updates?: string; // eslint-disable-line @typescript-eslint/naming-convention
    realtime_vehicle_positions?: string; // eslint-disable-line @typescript-eslint/naming-convention
  };
}

// ---------------------------------------------------------------------------
// Transitland API feed status
// ---------------------------------------------------------------------------

interface TransitlandFeedResponse {
  feeds?: Array<{
    onestop_id: string; // eslint-disable-line @typescript-eslint/naming-convention
    spec?: string;
    feed_versions?: Array<{ // eslint-disable-line @typescript-eslint/naming-convention
      latest_calendar_date: string | null; // eslint-disable-line @typescript-eslint/naming-convention
      earliest_calendar_date: string | null; // eslint-disable-line @typescript-eslint/naming-convention
      fetched_at: string; // eslint-disable-line @typescript-eslint/naming-convention
    }>;
    urls?: {
      realtime_alerts?: string; // eslint-disable-line @typescript-eslint/naming-convention
      realtime_trip_updates?: string; // eslint-disable-line @typescript-eslint/naming-convention
      realtime_vehicle_positions?: string; // eslint-disable-line @typescript-eslint/naming-convention
    };
  }>;
}

interface TransitlandFeedInfo {
  onestopId: string;
  versionCount: number | null; // null when only a single version was looked up (SHA1 path)
  fetchedAt: string | null;
}

type FeedApiShape = { onestop_id: string; feed_versions?: Array<{ fetched_at: string }> }; // eslint-disable-line @typescript-eslint/naming-convention

/** Look up a feed by its onestop_id. Returns structured info or null. */
async function lookupFeedByOnestopId(onestopId: string): Promise<TransitlandFeedInfo | null> {
  const apiKey = getApiKey();
  if (!apiKey) { return null; }
  try {
    const url = `${TRANSITLAND_API_BASE}/feeds/${encodeURIComponent(onestopId)}?apikey=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);
    if (!res.ok) { return null; }
    const data = await res.json() as { feeds?: FeedApiShape[] };
    const feed = data.feeds?.[0];
    if (!feed) { return null; }
    return {
      onestopId: String(feed.onestop_id ?? onestopId),
      versionCount: feed.feed_versions?.length ?? 0,
      fetchedAt: feed.feed_versions?.[0]?.fetched_at ?? null,
    };
  } catch {
    return null;
  }
}

/** Look up a feed version by SHA1 hash. Returns structured info (no version count) or null. */
async function lookupFeedBySha1(sha1: string): Promise<TransitlandFeedInfo | null> {
  if (!sha1) { return null; }
  const apiKey = getApiKey();
  if (!apiKey) { return null; }
  try {
    const url = `${TRANSITLAND_API_BASE}/feed_versions/${encodeURIComponent(sha1)}?apikey=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);
    if (!res.ok) { return null; }
    // eslint-disable-next-line @typescript-eslint/naming-convention
    const data = await res.json() as { feed_versions?: Array<{ fetched_at: string; feed: { onestop_id: string } }> };
    const fv = data.feed_versions?.[0];
    if (!fv?.feed?.onestop_id) { return null; }
    return {
      onestopId: String(fv.feed.onestop_id),
      versionCount: null,
      fetchedAt: fv.fetched_at ?? null,
    };
  } catch {
    return null;
  }
}

async function fetchFeedStatus(onestopId: string): Promise<string> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return 'Set transitland.apiKey or TRANSITLAND_API_KEY for status';
  }
  const url = `${TRANSITLAND_API_BASE}/feeds/${encodeURIComponent(onestopId)}?apikey=${encodeURIComponent(apiKey)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return res.status === 404 ? 'Not found in Transitland' : `API error ${res.status}`;
    }
    const data = (await res.json()) as TransitlandFeedResponse;
    const feed = data.feeds?.[0];
    if (!feed) { return 'No feed data'; }

    const spec = feed.spec ?? 'Unknown';
    const versions = feed.feed_versions;

    if (spec === 'GTFS_RT' || !versions || versions.length === 0) {
      const rtTypes: string[] = [];
      if (feed.urls?.realtime_alerts) { rtTypes.push('alerts'); }
      if (feed.urls?.realtime_trip_updates) { rtTypes.push('trip updates'); }
      if (feed.urls?.realtime_vehicle_positions) { rtTypes.push('vehicle positions'); }
      return `$(radio-tower) ${spec} — ${rtTypes.length > 0 ? rtTypes.join(', ') : 'realtime'}`;
    }

    const latest = versions[0];
    const earliest = latest.earliest_calendar_date ?? '—';
    const latestDate = latest.latest_calendar_date ?? '—';
    const fetched = latest.fetched_at ? new Date(latest.fetched_at).toISOString().slice(0, 10) : '—';

    const today = new Date().toISOString().slice(0, 10);
    const isActive = earliest !== '—' && latestDate !== '—' && earliest <= today && today <= latestDate;
    const fetchedDate = latest.fetched_at ? new Date(latest.fetched_at) : null;
    const stale = fetchedDate ? Math.floor((Date.now() - fetchedDate.getTime()) / 86400000) > 30 : true;

    const tag = !isActive ? '[EXPIRED]' : stale ? '[STALE]' : '[ACTIVE]';
    return `${tag} ${earliest} to ${latestDate} | fetched ${fetched} | ${versions.length} versions`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function findLineForText(document: vscode.TextDocument, searchText: string): number {
  const idx = document.getText().indexOf(searchText);
  if (idx === -1) { return 0; }
  return document.positionAt(idx).line;
}

// ---------------------------------------------------------------------------
// Progress-wrapped CLI helpers
// ---------------------------------------------------------------------------

async function runWithProgress<T>(
  title: string,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    async (_progress, token) => {
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());
      try {
        return await task(abort.signal);
      } catch (err) {
        if (abort.signal.aborted) { return undefined; }
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`${title} failed: ${msg}`);
        return undefined;
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Entity lookup helpers
// ---------------------------------------------------------------------------

function buildEntityLookup(output: Awaited<ReturnType<typeof runInspect>>): {
  stops: Record<string, EntityStop>;
  routes: Record<string, EntityRoute>;
} {
  const stops: Record<string, EntityStop> = {};
  for (const s of output.stops) {
    stops[s.stopId] = { name: s.stopName, lat: s.stopLat, lon: s.stopLon, locationType: s.locationType, parent: s.parentStation };
  }
  const routes: Record<string, EntityRoute> = {};
  for (const r of output.routes) {
    routes[r.routeId] = { shortName: r.routeShortName, longName: r.routeLongName, routeType: r.routeType, color: r.routeColor };
  }
  return { stops, routes };
}

/** Wire the onMessage callback for entity enrichment on a validation panel. */
function attachEntityEnrichment(
  target: string,
  getPanel: () => GtfsValidationPanel | undefined,
): (msg: ValidationPanelMessage) => Promise<void> {
  let inspectOutput: Awaited<ReturnType<typeof runInspect>> | undefined;
  return async (msg) => {
    if (msg.command === 'loadEntities') {
      const activeCLI = requireCLI();
      if (!activeCLI) { getPanel()?.postEntityError('transitland CLI not found'); return; }
      getPanel()?.postEntityLoading();
      try {
        const insp = await runInspect(activeCLI, { feed: target });
        inspectOutput = insp;
        const { stops, routes } = buildEntityLookup(insp);
        getPanel()?.postEntityData(stops, routes);
      } catch (err) {
        getPanel()?.postEntityError(err instanceof Error ? err.message : String(err));
      }
    } else if (msg.command === 'openInInspector') {
      if (!inspectOutput) { return; }
      const inspPanel = GtfsInspectPanel.show(target, inspectOutput);
      inspPanel.postFilter(msg.tab, msg.filter);
    }
  };
}

// ---------------------------------------------------------------------------
// Activate
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('Transitland');
  context.subscriptions.push(outputChannel);

  cli = initCLI();
  if (cli) {
    cli.version().then((v) => outputChannel.appendLine(`transitland CLI: ${v}`))
      .catch(() => outputChannel.appendLine('transitland CLI found but version check failed'));
  } else {
    outputChannel.appendLine('transitland CLI not found — set transitland.cliPath or install via Homebrew');
  }

  const resourcesDir = path.join(context.extensionUri.fsPath, 'resources');
  const dmfrSchema = fs.readFileSync(path.join(resourcesDir, 'dmfr-schema.json'), 'utf8');
  const gtfsScheduleSpec = fs.readFileSync(path.join(resourcesDir, 'gtfs-schedule-reference.md'), 'utf8');
  const gtfsRtSpec = fs.readFileSync(path.join(resourcesDir, 'gtfs-rt-reference.md'), 'utf8');
  const participantSystemPrompt = fs.readFileSync(
    path.join(context.extensionUri.fsPath, 'instructions', 'dmfr-assistant.instructions.md'), 'utf8');

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('transitland.cliPath')) { cli = initCLI(); }
  }));

  // --- Commands ---

  context.subscriptions.push(vscode.commands.registerCommand(
    'transitland.openFeedOnTransitland',
    (feedId: string) => vscode.env.openExternal(vscode.Uri.parse(`https://www.transit.land/feeds/${feedId}`)),
  ));

  context.subscriptions.push(vscode.commands.registerCommand(
    'transitland.validateGtfsFeed',
    async (feedUrl?: string, knownFeedId?: string) => {
      if (!feedUrl) {
        feedUrl = await vscode.window.showInputBox({
          prompt: 'GTFS feed URL or local path to validate',
          placeHolder: 'https://example.com/gtfs.zip',
          validateInput: (v) => v ? null : 'URL cannot be empty',
        });
        if (!feedUrl) { return; }
      }
      const target = feedUrl;
      const activeCLI = requireCLI();
      if (!activeCLI) { return; }
      const result = await runWithProgress('Validating GTFS feed', (signal) =>
        runValidate(activeCLI, { feed: target }, signal)
      );
      if (!result) { return; }
      let valPanel: GtfsValidationPanel | undefined;
      valPanel = GtfsValidationPanel.show(target, result, attachEntityEnrichment(target, () => valPanel));
      const tlLookup = knownFeedId
        ? lookupFeedByOnestopId(knownFeedId)
        : lookupFeedBySha1(result.summary.sha1 ?? '');
      tlLookup.then(info => { if (info) { valPanel?.postTransitlandInfo(info); } });
    },
  ));

  context.subscriptions.push(vscode.commands.registerCommand(
    'transitland.inspectGtfsFeed',
    async (feedUrl?: string, knownFeedId?: string) => {
      if (!feedUrl) {
        feedUrl = await vscode.window.showInputBox({
          prompt: 'GTFS feed URL or local path to inspect',
          placeHolder: 'https://example.com/gtfs.zip',
          validateInput: (v) => v ? null : 'URL cannot be empty',
        });
        if (!feedUrl) { return; }
      }
      const target = feedUrl;
      const activeCLI = requireCLI();
      if (!activeCLI) { return; }
      const result = await runWithProgress('Inspecting GTFS feed', (signal) =>
        runInspect(activeCLI, { feed: target, includeServiceLevels: true }, signal)
      );
      if (result) {
        const inspPanel = GtfsInspectPanel.show(target, result);
        const tlLookup = knownFeedId
          ? lookupFeedByOnestopId(knownFeedId)
          : lookupFeedBySha1(result.summary.sha1 ?? '');
        tlLookup.then(info => { if (info) { inspPanel.postTransitlandInfo(info); } });
      }
    },
  ));

  context.subscriptions.push(vscode.commands.registerCommand(
    'transitland.createNewDmfrFile',
    async (uri?: vscode.Uri) => {
      let folderUri: vscode.Uri | undefined;
      if (uri) {
        const stat = await vscode.workspace.fs.stat(uri);
        folderUri = stat.type === vscode.FileType.Directory ? uri : vscode.Uri.joinPath(uri, '..');
      } else if (vscode.workspace.workspaceFolders?.length) {
        folderUri = vscode.workspace.workspaceFolders[0].uri;
      }
      const filename = await vscode.window.showInputBox({
        prompt: 'Enter DMFR filename (without extension)',
        placeHolder: 'example',
        validateInput: (v) => {
          if (!v) { return 'Filename cannot be empty'; }
          if (v.includes('/') || v.includes('\\')) { return 'Filename cannot contain path separators'; }
          return null;
        },
      });
      if (!filename) { return; }
      const full = filename.endsWith('.dmfr.json') ? filename : `${filename}.dmfr.json`;
      const fileUri = folderUri ? vscode.Uri.joinPath(folderUri, full) : vscode.Uri.file(full);
      const template = JSON.stringify({ '$schema': 'https://dmfr.transit.land/json-schema/dmfr.schema-v0.6.0.json', feeds: [] }, null, 2);
      await vscode.workspace.fs.writeFile(fileUri, Buffer.from(template, 'utf8'));
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(fileUri));
    },
  ));

  context.subscriptions.push(vscode.commands.registerCommand(
    'transitland.formatDmfrFile',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showWarningMessage('No DMFR file currently open'); return; }
      if (editor.document.isDirty) { vscode.window.showWarningMessage('Save the file before formatting'); return; }
      const activeCLI = requireCLI();
      if (!activeCLI) { return; }
      try {
        await activeCLI.exec(['dmfr', 'format', '--save', editor.document.fileName]);
        vscode.window.showInformationMessage('DMFR file formatted');
      } catch (err) {
        vscode.window.showWarningMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  ));

  context.subscriptions.push(vscode.commands.registerCommand(
    'transitland.inspectGtfsRtFeed',
    async (feedUrl?: string) => {
      if (!feedUrl) {
        feedUrl = await vscode.window.showInputBox({
          prompt: 'GTFS Realtime feed URL or local .pb file path',
          placeHolder: 'https://example.com/gtfs-rt/vehicles.pb',
          validateInput: (v) => v ? null : 'URL cannot be empty',
        });
        if (!feedUrl) { return; }
      }
      const activeCLI = requireCLI();
      if (!activeCLI) { return; }
      const result = await runWithProgress('Inspecting GTFS-RT feed', (signal) =>
        runRtInspect(activeCLI, { url: feedUrl! }, signal)
      );
      if (result) { GtfsRtInspectPanel.show(result); }
    },
  ));

  context.subscriptions.push(vscode.commands.registerCommand(
    'transitland.compareFeedSources',
    async (url1?: string, url2?: string) => {
      const urls: string[] = [];
      if (url1) { urls.push(url1); }
      if (url2) { urls.push(url2); }

      // Prompt for URLs: require at least 2, allow more
      for (let i = urls.length; ; i++) {
        const required = i < 2;
        const input = await vscode.window.showInputBox({
          prompt: i === 0 ? 'First GTFS feed URL or file path to compare'
            : i === 1 ? 'Second GTFS feed URL or file path to compare'
            : 'Add a third URL to compare (optional — press Escape to start)',
          placeHolder: 'https://example.com/gtfs.zip',
          ignoreFocusOut: required,
          validateInput: required ? (v) => v ? null : 'URL cannot be empty' : undefined,
        });
        if (!input) {
          if (required) { return; }
          break;
        }
        urls.push(input.trim());
        if (!required && i >= 2) { break; } // stop prompting after 3rd
      }

      const activeCLI = requireCLI();
      if (!activeCLI) { return; }
      const apiKey = getApiKey();
      const result = await runWithProgress('Comparing GTFS feed sources…', (signal) =>
        runCompareFeedSources(activeCLI, { urls, apiKey: apiKey || undefined }, signal)
      );
      if (result) { GtfsFeedSourceComparisonPanel.show(urls, result); }
    },
  ));

  context.subscriptions.push(vscode.commands.registerCommand(
    'transitland.showWelcome',
    () => {
      let panel: WelcomePanel | undefined;
      panel = WelcomePanel.show(async (msg: WelcomeMessage) => {
        if (msg.command === 'validate') {
          panel?.postStatus({ type: 'loading', tab: 'validate' });
          const activeCLI = requireCLI();
          if (!activeCLI) {
            panel?.postStatus({ type: 'error', tab: 'validate', message: 'transitland CLI not found' });
            return;
          }
          try {
            const result = await runValidate(activeCLI, { feed: msg.feed, rtUrls: msg.rtUrls });
            const feedTarget = msg.feed;
            let valPanel: GtfsValidationPanel | undefined;
            valPanel = GtfsValidationPanel.show(feedTarget, result, attachEntityEnrichment(feedTarget, () => valPanel));
            lookupFeedBySha1(result.summary.sha1 ?? '').then(info => { if (info) { valPanel?.postTransitlandInfo(info); } });
            panel?.postStatus({ type: 'done', tab: 'validate' });
          } catch (err) {
            panel?.postStatus({ type: 'error', tab: 'validate', message: err instanceof Error ? err.message : String(err) });
          }
        } else if (msg.command === 'inspect') {
          panel?.postStatus({ type: 'loading', tab: 'inspect' });
          const activeCLI = requireCLI();
          if (!activeCLI) {
            panel?.postStatus({ type: 'error', tab: 'inspect', message: 'transitland CLI not found' });
            return;
          }
          try {
            const result = await runInspect(activeCLI, {
              feed: msg.feed,
              includeServiceLevels: msg.includeServiceLevels,
              includeRouteGeometries: msg.includeRouteGeometries,
            });
            const inspPanel2 = GtfsInspectPanel.show(msg.feed, result);
            lookupFeedBySha1(result.summary.sha1 ?? '').then(info => { if (info) { inspPanel2.postTransitlandInfo(info); } });
            panel?.postStatus({ type: 'done', tab: 'inspect' });
          } catch (err) {
            panel?.postStatus({ type: 'error', tab: 'inspect', message: err instanceof Error ? err.message : String(err) });
          }
        } else if (msg.command === 'rtInspect') {
          panel?.postStatus({ type: 'loading', tab: 'rtInspect' });
          const activeCLI = requireCLI();
          if (!activeCLI) {
            panel?.postStatus({ type: 'error', tab: 'rtInspect', message: 'transitland CLI not found' });
            return;
          }
          try {
            const result = await runRtInspect(activeCLI, { url: msg.url });
            GtfsRtInspectPanel.show(result);
            panel?.postStatus({ type: 'done', tab: 'rtInspect' });
          } catch (err) {
            panel?.postStatus({ type: 'error', tab: 'rtInspect', message: err instanceof Error ? err.message : String(err) });
          }
        } else if (msg.command === 'createDmfr') {
          vscode.commands.executeCommand('transitland.createNewDmfrFile');
        } else if (msg.command === 'formatDmfr') {
          vscode.commands.executeCommand('transitland.formatDmfrFile');
        }
      });
    },
  ));

  // --- CodeLens ---

  interface LensData { feedId?: string; staticUrl?: string; rtUrl?: string; rtLabel?: string; lensType?: 'validate' | 'inspect' | 'rtInspect'; }

  const codeLensProvider: vscode.CodeLensProvider = {
    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
      const lenses: vscode.CodeLens[] = [];
      try {
        const root = JSON.parse(document.getText()) as { feeds?: DmfrFeed[] };
        if (!Array.isArray(root?.feeds)) { return lenses; }

        for (const feed of root.feeds) {
          const id = feed?.id;
          if (!id || !isTransitlandFeedId(id)) { continue; }

          const line = findLineForText(document, `"id": "${id}"`);
          const range = new vscode.Range(line, 0, line, 0);

          // Status lens
          const statusLens = new vscode.CodeLens(range);
          (statusLens as any).__data = { feedId: id } as LensData;
          lenses.push(statusLens);

          // Validate + Inspect lenses — attached to the static_current URL line
          const staticUrl = feed.urls?.static_current;
          if (staticUrl) {
            const urlLine = findLineForText(document, staticUrl);
            const urlRange = new vscode.Range(urlLine, 0, urlLine, 0);

            const validateLens = new vscode.CodeLens(urlRange);
            (validateLens as any).__data = { staticUrl, feedId: id, lensType: 'validate' } as LensData;
            lenses.push(validateLens);

            const inspectLens = new vscode.CodeLens(urlRange);
            (inspectLens as any).__data = { staticUrl, feedId: id, lensType: 'inspect' } as LensData;
            lenses.push(inspectLens);
          }

          // Inspect RT lenses — one per realtime URL present on gtfs-rt feeds
          const isRtFeed = feed.spec === 'gtfs-rt' || feed.spec === 'gtfs_rt' || feed.spec === 'GTFS-RT' || feed.spec === 'GTFS_RT';
          if (isRtFeed) {
            const rtEntries: Array<{ url: string; label: string }> = [
              { url: feed.urls?.realtime_vehicle_positions ?? '', label: 'vehicle positions' },
              { url: feed.urls?.realtime_trip_updates ?? '', label: 'trip updates' },
              { url: feed.urls?.realtime_alerts ?? '', label: 'alerts' },
            ].filter((e) => e.url);
            for (const { url: rtUrl, label: rtLabel } of rtEntries) {
              const rtLine = findLineForText(document, rtUrl);
              const rtRange = new vscode.Range(rtLine, 0, rtLine, 0);
              const rtLens = new vscode.CodeLens(rtRange);
              (rtLens as any).__data = { rtUrl, rtLabel, lensType: 'rtInspect' } as LensData;
              lenses.push(rtLens);
            }
          }
        }
      } catch { /* unparseable JSON */ }
      return lenses;
    },

    async resolveCodeLens(lens: vscode.CodeLens): Promise<vscode.CodeLens> {
      const data = (lens as any).__data as LensData | undefined;
      if (!data) { return lens; }

      if (data.lensType === 'validate') {
        lens.command = {
          title: '$(check) Validate',
          command: 'transitland.validateGtfsFeed',
          arguments: [data.staticUrl, data.feedId],
        };
      } else if (data.lensType === 'inspect') {
        lens.command = {
          title: '$(search) Inspect',
          command: 'transitland.inspectGtfsFeed',
          arguments: [data.staticUrl, data.feedId],
        };
      } else if (data.lensType === 'rtInspect') {
        lens.command = {
          title: `$(radio-tower) Inspect ${data.rtLabel ?? 'RT'}`,
          command: 'transitland.inspectGtfsRtFeed',
          arguments: [data.rtUrl],
        };
      } else if (data.feedId) {
        const status = await fetchFeedStatus(data.feedId);
        lens.command = {
          title: `$(globe) ${status}`,
          command: 'transitland.openFeedOnTransitland',
          arguments: [data.feedId],
        };
      }
      return lens;
    },
  };

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ language: 'dmfr' }, codeLensProvider)
  );

  // --- Chat Participant (@transitland) ---

  const participant = vscode.chat.createChatParticipant('transitland.assistant',
    async (request, chatContext, stream, token) => {
      const model = request.model;

      const messages: vscode.LanguageModelChatMessage[] = [
        vscode.LanguageModelChatMessage.User(participantSystemPrompt),
      ];

      for (const turn of chatContext.history) {
        if (turn instanceof vscode.ChatRequestTurn) {
          messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
        } else if (turn instanceof vscode.ChatResponseTurn) {
          const text = turn.response
            .filter((p): p is vscode.ChatResponseMarkdownPart => p instanceof vscode.ChatResponseMarkdownPart)
            .map((p) => p.value.value)
            .join('');
          if (text) { messages.push(vscode.LanguageModelChatMessage.Assistant(text)); }
        }
      }

      let userPrompt = request.prompt;
      if (request.command === 'validate') { userPrompt = `Validate this GTFS feed: ${userPrompt}`; }
      if (request.command === 'inspect')  { userPrompt = `Inspect this GTFS feed: ${userPrompt}`; }
      messages.push(vscode.LanguageModelChatMessage.User(userPrompt));

      const tools = vscode.lm.tools.filter((t) => t.name.startsWith('transitland_'));

      let response = await model.sendRequest(messages, { tools }, token);

      while (true) {
        const toolCalls: vscode.LanguageModelToolCallPart[] = [];
        const textParts: string[] = [];

        for await (const chunk of response.stream) {
          if (chunk instanceof vscode.LanguageModelTextPart) {
            stream.markdown(chunk.value);
            textParts.push(chunk.value);
          } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
            toolCalls.push(chunk);
          }
        }

        if (toolCalls.length === 0) { break; }

        messages.push(vscode.LanguageModelChatMessage.Assistant([
          ...textParts.map((t) => new vscode.LanguageModelTextPart(t)),
          ...toolCalls,
        ]));

        const results: vscode.LanguageModelToolResultPart[] = [];
        for (const call of toolCalls) {
          stream.progress(`Using ${call.name}…`);
          try {
            const result = await vscode.lm.invokeTool(
              call.name,
              { input: call.input as Record<string, unknown>, toolInvocationToken: request.toolInvocationToken },
              token,
            );
            results.push(new vscode.LanguageModelToolResultPart(call.callId, result.content));
          } catch (err) {
            results.push(new vscode.LanguageModelToolResultPart(call.callId, [
              new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`),
            ]));
          }
        }

        messages.push(vscode.LanguageModelChatMessage.User(results));
        response = await model.sendRequest(messages, { tools }, token);
      }

      return {};
    },
  );

  participant.iconPath = new vscode.ThemeIcon('globe');
  participant.followupProvider = {
    provideFollowups(_result, _context, _token) {
      return [
        { prompt: 'validate the static_current URL', label: 'Validate this feed' },
        { prompt: 'inspect the static_current URL to show agencies and routes', label: 'Inspect this feed' },
        { prompt: 'check if this feed is already in the Transitland archive', label: 'Check archive' },
        { prompt: 'show me the DMFR schema for the urls field', label: 'DMFR schema: urls' },
      ];
    },
  };

  context.subscriptions.push(participant);

  // --- Language Model Tools (GitHub Copilot) ---

  context.subscriptions.push(
    vscode.lm.registerTool<{ feed: string; rtUrls?: string[]; errorLimit?: number }>(
      'transitland_validate',
      {
        async invoke(options, token) {
          const activeCLI = requireCLI();
          if (!activeCLI) { throw new Error('transitland CLI not found. Set transitland.cliPath in settings.'); }
          const result = await runValidate(activeCLI, options.input, token2signal(token));
          const { summary, errors, warnings } = result;
          const lines: string[] = [
            `**Result:** ${summary.success ? '✅ Pass' : '❌ Fail'}`,
            ...(summary.failureReason ? [`**Failure reason:** ${summary.failureReason}`] : []),
            ...(summary.sha1 ? [`**SHA1:** ${summary.sha1}`] : []),
            ...(summary.earliestCalendarDate && summary.latestCalendarDate
              ? [`**Calendar:** ${summary.earliestCalendarDate} → ${summary.latestCalendarDate}`] : []),
            `**Errors:** ${summary.errorCount}  **Warnings:** ${summary.warningCount}`,
          ];
          if (errors.length > 0) {
            lines.push('', '### Errors');
            for (const e of errors.slice(0, 30)) {
              lines.push(`- **${e.errorType}**${e.filename ? ` (${e.filename})` : ''}: ${e.message}${e.entityId ? ` [entity: ${e.entityId}]` : ''}`);
            }
            if (errors.length > 30) { lines.push(`_…and ${errors.length - 30} more_`); }
          }
          if (warnings.length > 0) {
            lines.push('', '### Warnings');
            for (const w of warnings.slice(0, 30)) {
              lines.push(`- **${w.errorType}**${w.filename ? ` (${w.filename})` : ''}: ${w.message}${w.entityId ? ` [entity: ${w.entityId}]` : ''}`);
            }
            if (warnings.length > 30) { lines.push(`_…and ${warnings.length - 30} more_`); }
          }
          return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(lines.join('\n'))]);
        },
      },
    ),

    vscode.lm.registerTool<{ feed: string; includeServiceLevels?: boolean; includeRouteGeometries?: boolean }>(
      'transitland_inspect',
      {
        async invoke(options, token) {
          const activeCLI = requireCLI();
          if (!activeCLI) { throw new Error('transitland CLI not found. Set transitland.cliPath in settings.'); }
          const result = await runInspect(activeCLI, options.input, token2signal(token));
          const { summary, feedInfo, agencies, routes, files } = result;
          const lines: string[] = [
            `**SHA1:** ${summary.sha1 ?? 'n/a'}`,
            ...(summary.earliestCalendarDate && summary.latestCalendarDate
              ? [`**Calendar:** ${summary.earliestCalendarDate} → ${summary.latestCalendarDate}`] : []),
            `**Agencies:** ${summary.agencyCount}  **Routes:** ${summary.routeCount}  **Stops:** ${summary.stopCount ?? 'n/a'}  **Trips:** ${summary.tripCount ?? 'n/a'}`,
            ...(summary.timezone ? [`**Timezone:** ${summary.timezone}`] : []),
          ];
          if (feedInfo) {
            lines.push('', '### Feed Info');
            if (feedInfo.feedPublisherName) { lines.push(`**Publisher:** ${feedInfo.feedPublisherName}`); }
            if (feedInfo.feedVersion) { lines.push(`**Version:** ${feedInfo.feedVersion}`); }
            if (feedInfo.feedLang) { lines.push(`**Language:** ${feedInfo.feedLang}`); }
          }
          if (agencies.length > 0) {
            lines.push('', '### Agencies');
            for (const a of agencies) {
              lines.push(`- **${a.agencyName}** (${a.agencyId}) — ${a.agencyTimezone}`);
            }
          }
          if (routes.length > 0) {
            lines.push('', '### Routes');
            for (const r of routes.slice(0, 50)) {
              const name = r.routeShortName ?? r.routeLongName ?? r.routeId;
              lines.push(`- ${name} (type ${r.routeType}, id: ${r.routeId})`);
            }
            if (routes.length > 50) { lines.push(`_…and ${routes.length - 50} more_`); }
          }
          if (files.length > 0) {
            lines.push('', '### Files');
            for (const f of files) {
              lines.push(`- ${f.name}: ${f.rows.toLocaleString()} rows`);
            }
          }
          return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(lines.join('\n'))]);
        },
      },
    ),

    vscode.lm.registerTool<{ url: string }>(
      'transitland_inspect_rt',
      {
        async invoke(options, token) {
          const activeCLI = requireCLI();
          if (!activeCLI) { throw new Error('transitland CLI not found. Set transitland.cliPath in settings.'); }
          const result = await runRtInspect(activeCLI, options.input, token2signal(token));
          const { header, vehicles, tripUpdates, alerts } = result;
          const ts = header.timestamp ? new Date(header.timestamp * 1000).toISOString() : 'n/a';
          const lines: string[] = [
            `**GTFS-RT version:** ${header.gtfsRealtimeVersion}  **Feed timestamp:** ${ts}`,
            `**Vehicles:** ${vehicles.length}  **Trip updates:** ${tripUpdates.length}  **Alerts:** ${alerts.length}`,
          ];
          if (vehicles.length > 0) {
            lines.push('', '### Vehicle Positions (first 20)');
            for (const v of vehicles.slice(0, 20)) {
              const pos = v.latitude !== null && v.longitude !== null ? `${v.latitude.toFixed(4)},${v.longitude.toFixed(4)}` : 'no position';
              lines.push(`- Entity ${v.entityId}: route ${v.routeId ?? 'n/a'}, trip ${v.tripId ?? 'n/a'}, ${pos}`);
            }
            if (vehicles.length > 20) { lines.push(`_…and ${vehicles.length - 20} more_`); }
          }
          if (tripUpdates.length > 0) {
            lines.push('', '### Trip Updates (first 20)');
            for (const tu of tripUpdates.slice(0, 20)) {
              lines.push(`- Entity ${tu.entityId}: route ${tu.routeId ?? 'n/a'}, trip ${tu.tripId ?? 'n/a'}, ${tu.stopTimeUpdates.length} stop time updates`);
            }
            if (tripUpdates.length > 20) { lines.push(`_…and ${tripUpdates.length - 20} more_`); }
          }
          if (alerts.length > 0) {
            lines.push('', '### Alerts');
            for (const a of alerts) {
              lines.push(`- **${a.effect ?? 'UNKNOWN_EFFECT'}** (${a.cause ?? 'UNKNOWN_CAUSE'}): ${a.headerText ?? a.descriptionText ?? 'no text'}`);
            }
          }
          return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(lines.join('\n'))]);
        },
      },
    ),

    vscode.lm.registerTool<{ file?: string }>(
      'transitland_read_dmfr',
      {
        async invoke(options) {
          let content: string;
          let label: string;

          if (options.input.file) {
            const folders = vscode.workspace.workspaceFolders;
            if (!folders?.length) { throw new Error('No workspace folder open'); }
            const uri = vscode.Uri.joinPath(folders[0].uri, options.input.file);
            const bytes = await vscode.workspace.fs.readFile(uri);
            content = Buffer.from(bytes).toString('utf8');
            label = options.input.file;
          } else {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { throw new Error('No file specified and no active editor'); }
            if (!editor.document.uri.fsPath.endsWith('.dmfr.json')) {
              throw new Error('Active file is not a .dmfr.json file');
            }
            content = editor.document.getText();
            label = vscode.workspace.asRelativePath(editor.document.uri);
          }

          // Use flexible raw parsing — the DMFR schema has many more url types and
          // feed-level operators than the internal DmfrFeed interface captures
          type RawFeed = Record<string, unknown>;
          const dmfr = JSON.parse(content) as { feeds?: RawFeed[]; operators?: RawFeed[] };
          const feeds = dmfr.feeds ?? [];
          const operators = dmfr.operators ?? [];
          const lines: string[] = [
            `**File:** ${label}`,
            `**Feeds:** ${feeds.length}  **Top-level operators:** ${operators.length}`,
            '',
          ];

          if (feeds.length > 0) {
            lines.push('### Feeds');
            for (const feed of feeds) {
              const id = String(feed['id'] ?? '(no id)');
              const spec = String(feed['spec'] ?? 'unknown');
              // Feed-level operators (inline on each feed entry)
              const feedOps = Array.isArray(feed['operators'])
                ? (feed['operators'] as RawFeed[]).map((op) => String(op['name'] ?? op['onestop_id'] ?? '')).filter(Boolean)
                : [];
              lines.push(`- **${id}** (${spec})${feedOps.length ? ` — ${feedOps.join(', ')}` : ''}`);
              // All URL fields — handles strings and string arrays (e.g. static_historic)
              const urls = (feed['urls'] ?? {}) as Record<string, unknown>;
              for (const [k, v] of Object.entries(urls)) {
                if (typeof v === 'string') {
                  lines.push(`  - ${k}: ${v}`);
                } else if (Array.isArray(v)) {
                  for (const item of v) {
                    if (typeof item === 'string') { lines.push(`  - ${k}: ${item}`); }
                  }
                }
              }
            }
          }

          if (operators.length > 0) {
            lines.push('', '### Top-level Operators');
            for (const op of operators) {
              const opId = String(op['onestop_id'] ?? op['id'] ?? '(no id)');
              const name = String(op['name'] ?? '');
              lines.push(`- **${opId}**${name ? ` — ${name}` : ''}`);
            }
          }
          return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(lines.join('\n'))]);
        },
      },
    ),

    vscode.lm.registerTool<{ query: string; field?: 'any' | 'url' | 'id' | 'spec' }>(
      'transitland_search_feeds',
      {
        async invoke(options) {
          const { query, field = 'any' } = options.input;
          const uris = await vscode.workspace.findFiles('**/*.dmfr.json', '**/node_modules/**', 500);

          interface FeedMatch { file: string; feedId: string; spec: string; urls: Record<string, string>; }
          const matches: FeedMatch[] = [];

          for (const uri of uris) {
            try {
              const bytes = await vscode.workspace.fs.readFile(uri);
              const dmfr = JSON.parse(Buffer.from(bytes).toString('utf8')) as { feeds?: DmfrFeed[] };
              for (const feed of dmfr.feeds ?? []) {
                const searchTarget =
                  field === 'url' ? Object.values(feed.urls ?? {}).filter(Boolean).join(' ') :
                  field === 'id' ? (feed.id ?? '') :
                  field === 'spec' ? (feed.spec ?? '') :
                  JSON.stringify(feed);
                if (searchTarget.toLowerCase().includes(query.toLowerCase())) {
                  const urls: Record<string, string> = {};
                  if (feed.urls?.static_current) { urls['static_current'] = feed.urls.static_current; }
                  if (feed.urls?.realtime_vehicle_positions) { urls['realtime_vehicle_positions'] = feed.urls.realtime_vehicle_positions; }
                  if (feed.urls?.realtime_trip_updates) { urls['realtime_trip_updates'] = feed.urls.realtime_trip_updates; }
                  if (feed.urls?.realtime_alerts) { urls['realtime_alerts'] = feed.urls.realtime_alerts; }
                  matches.push({ file: vscode.workspace.asRelativePath(uri), feedId: feed.id ?? '', spec: feed.spec ?? 'unknown', urls });
                }
              }
            } catch { /* skip unparseable files */ }
          }

          const lines: string[] = [`**${matches.length} feed(s) matching "${query}"**`, ''];
          for (const m of matches) {
            lines.push(`- **${m.feedId}** (${m.spec}) — \`${m.file}\``);
            for (const [k, v] of Object.entries(m.urls)) {
              lines.push(`  - ${k}: ${v}`);
            }
          }
          if (matches.length === 0) { lines.push('No matching feeds found.'); }
          return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(lines.join('\n'))]);
        },
      },
    ),

    vscode.lm.registerTool<Record<string, never>>(
      'transitland_dmfr_schema',
      {
        async invoke() {
          return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(dmfrSchema)]);
        },
      },
    ),

    vscode.lm.registerTool<{ file?: string; type?: 'schedule' | 'rt' }>(
      'transitland_gtfs_spec',
      {
        async invoke(options) {
          const spec = options.input.type === 'rt' ? gtfsRtSpec : gtfsScheduleSpec;
          const file = options.input.file;
          if (!file) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(spec)]);
          }
          const heading = `### ${file}`;
          const start = spec.indexOf(heading);
          if (start === -1) {
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(`No section found for "${file}" in the GTFS spec.`),
            ]);
          }
          const nextHeading = spec.indexOf('\n### ', start + heading.length);
          const section = nextHeading === -1 ? spec.slice(start) : spec.slice(start, nextHeading);
          return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(section)]);
        },
      },
    ),

    vscode.lm.registerTool<{ feedId: string }>(
      'transitland_feed_info',
      {
        async invoke(options) {
          const apiKey = getApiKey();
          if (!apiKey) { throw new Error('No Transitland API key. Set transitland.apiKey in settings or TRANSITLAND_API_KEY env var.'); }
          const result = await runFeedInfo({ feedId: options.input.feedId, apiKey });
          const { latestVersion } = result;
          const lines: string[] = [
            `**Onestop ID:** ${result.onestopId}`,
            `**Spec:** ${result.spec}`,
            `**Active:** ${result.isActive ? 'yes' : 'no'}`,
            `**Total versions:** ${result.totalVersions}`,
          ];
          if (result.name) { lines.push(`**Name:** ${result.name}`); }
          if (result.languages?.length) { lines.push(`**Languages:** ${result.languages.join(', ')}`); }
          const tagEntries = Object.entries(result.tags);
          if (tagEntries.length > 0) {
            lines.push('', '### Tags');
            for (const [k, v] of tagEntries) { lines.push(`- **${k}:** ${v}`); }
          }
          if (latestVersion) {
            const importStatus = result.feedState
              ? (result.feedState.importInProgress ? 'in progress' : result.feedState.importSuccess ? 'success' : 'failed')
              : null;
            lines.push('', '### Latest Version');
            lines.push(`**SHA1:** ${latestVersion.sha1}`);
            lines.push(`**Fetched:** ${latestVersion.fetchedAt.slice(0, 10)}`);
            if (latestVersion.earliestCalendarDate && latestVersion.latestCalendarDate) {
              lines.push(`**Calendar:** ${latestVersion.earliestCalendarDate} → ${latestVersion.latestCalendarDate}`);
            }
            if (importStatus) { lines.push(`**Import:** ${importStatus}`); }
          }
          if (result.recentVersions.length > 1) {
            lines.push('', `### Recent Versions (${Math.min(result.recentVersions.length, 10)} of ${result.totalVersions})`);
            for (const v of result.recentVersions) {
              const cal = (v.earliestCalendarDate && v.latestCalendarDate)
                ? ` | ${v.earliestCalendarDate} → ${v.latestCalendarDate}` : '';
              lines.push(`- \`${v.sha1.slice(0, 12)}…\` fetched ${v.fetchedAt.slice(0, 10)}${cal}`);
            }
          }
          const urlEntries = Object.entries(result.urls).filter(([, v]) => v != null && v !== undefined);
          if (urlEntries.length > 0) {
            lines.push('', '### URLs');
            for (const [k, v] of urlEntries) {
              if (Array.isArray(v)) {
                for (const item of v) { lines.push(`- **${k}:** ${item}`); }
              } else {
                lines.push(`- **${k}:** ${v}`);
              }
            }
          }
          const licenseEntries = Object.entries(result.license).filter(([, v]) => v);
          if (licenseEntries.length > 0) {
            lines.push('', '### License');
            for (const [k, v] of licenseEntries) { lines.push(`- **${k}:** ${v}`); }
          }
          const authEntries = Object.entries(result.authorization).filter(([, v]) => v);
          if (authEntries.length > 0) {
            lines.push('', '### Authorization');
            for (const [k, v] of authEntries) { lines.push(`- **${k}:** ${v}`); }
          }
          return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(lines.join('\n'))]);
        },
      },
    ),

    vscode.lm.registerTool<{ urls: string[] }>(
      'transitland_compare_feed_sources',
      {
        async invoke(options, token) {
          const activeCLI = requireCLI();
          if (!activeCLI) { throw new Error('transitland CLI not found. Set transitland.cliPath in settings.'); }
          const apiKey = getApiKey();
          const result = await runCompareFeedSources(
            activeCLI,
            { urls: options.input.urls, apiKey: apiKey || undefined },
            token2signal(token),
          );
          const lines: string[] = [];
          for (let i = 0; i < result.results.length; i++) {
            const r = result.results[i];
            lines.push(`### URL ${i + 1}: ${r.url}`);
            if (r.error) {
              lines.push(`❌ **Error:** ${r.error}`);
            } else if (r.inspect) {
              const s = r.inspect.summary;
              lines.push(`**Status:** ✅ Loaded`);
              if (s.sha1) { lines.push(`**SHA1:** ${s.sha1}`); }
              if (s.earliestCalendarDate && s.latestCalendarDate) {
                lines.push(`**Calendar:** ${s.earliestCalendarDate} → ${s.latestCalendarDate}`);
              }
              lines.push(`**Agencies:** ${s.agencyCount}  **Routes:** ${s.routeCount}  **Stops:** ${s.stopCount ?? 'n/a'}  **Trips:** ${s.tripCount ?? 'n/a'}`);
              if (r.errorCount || r.warningCount) {
                lines.push(`**Issues:** ${r.errorCount} error(s), ${r.warningCount} warning(s)`);
              }
              if (r.routeTypeSummary.length) {
                const breakdown = r.routeTypeSummary.map((rt) => `${rt.count}× type ${rt.routeType}`).join(', ');
                lines.push(`**Route types:** ${breakdown}`);
              }
              if (r.archive) {
                lines.push(r.archive.found
                  ? `**Archive:** ${r.archive.onestopId} (fetched ${r.archive.fetchedAt?.slice(0, 10) ?? '?'})`
                  : `**Archive:** not found in Transitland`);
              }
            }
            lines.push('');
          }
          const v = result.verdict;
          lines.push('### Verdict');
          if (v.type === 'identical') { lines.push(`✅ ${v.message}`); }
          else if (v.type === 'one_preferred') { lines.push(`⭐ **URL ${v.preferredIndex + 1} recommended** — ${v.reason}`); }
          else if (v.type === 'differs') { lines.push(`⚠️ ${v.message}`); }
          else { lines.push(`❌ ${v.message}`); }
          return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(lines.join('\n'))]);
        },
      },
    ),

    vscode.lm.registerTool<{ query: string; state?: string; limit?: number }>(
      'transitland_ntd_search',
      {
        async invoke(options) {
          const agencies = await runNtdSearch(options.input);
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(formatNtdAgencies(agencies)),
          ]);
        },
      },
    ),

    vscode.lm.registerTool<{ feed: string }>(
      'transitland_agencies_in_feed',
      {
        async invoke(options, token) {
          const activeCLI = requireCLI();
          if (!activeCLI) { throw new Error('transitland CLI not found. Set transitland.cliPath in settings.'); }
          const result = await runInspect(activeCLI, { feed: options.input.feed }, token2signal(token));
          const { agencies, summary, feedInfo } = result;
          const lines: string[] = [
            `**Feed:** ${options.input.feed}`,
            `**SHA1:** ${summary.sha1 ?? 'n/a'}`,
            `**Calendar:** ${summary.earliestCalendarDate ?? '?'} → ${summary.latestCalendarDate ?? '?'}`,
            `**Routes:** ${summary.routeCount} | **Stops:** ${summary.stopCount ?? '?'} | **Trips:** ${summary.tripCount ?? '?'}`,
          ];
          if (feedInfo?.feedPublisherName) {
            lines.push(`**Publisher:** ${feedInfo.feedPublisherName}${feedInfo.feedVersion ? ` (${feedInfo.feedVersion})` : ''}`);
          }
          lines.push('', `### Agencies (${agencies.length})`);
          for (const a of agencies) {
            lines.push('');
            lines.push(`**${a.agencyName}**${a.agencyId ? ` — agency_id: \`${a.agencyId}\`` : ''}`);
            if (a.agencyUrl) { lines.push(`Website: ${a.agencyUrl}`); }
            if (a.agencyTimezone) { lines.push(`Timezone: ${a.agencyTimezone}`); }
            if (a.agencyPhone) { lines.push(`Phone: ${a.agencyPhone}`); }
            if (a.agencyLang) { lines.push(`Language: ${a.agencyLang}`); }
          }
          return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(lines.join('\n'))]);
        },
      },
    ),

    vscode.lm.registerTool<{ file?: string; recordType: 'feed' | 'operator'; id: string; field: string; value: string | null }>(
      'transitland_set_field',
      {
        async invoke(options) {
          const { file, recordType, id, field, value } = options.input;

          // Resolve absolute file path
          let filePath: string;
          if (file) {
            const folders = vscode.workspace.workspaceFolders;
            if (!folders?.length) { throw new Error('No workspace folder open'); }
            const uri = vscode.Uri.joinPath(folders[0].uri, file);
            filePath = uri.fsPath;
          } else {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { throw new Error('No file specified and no active editor'); }
            if (!editor.document.uri.fsPath.endsWith('.dmfr.json')) {
              throw new Error('Active file is not a .dmfr.json file');
            }
            filePath = editor.document.uri.fsPath;
          }

          const activeCLI = requireCLI(); // optional; format is best-effort
          const result = await runSetField(activeCLI, { filePath, recordType, id, field, value });
          return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
            result.success ? `✅ ${result.message}` : `❌ ${result.message}`,
          )]);
        },
      },
    ),

    vscode.lm.registerTool<{
      file?: string;
      feedId: string;
      spec?: 'gtfs' | 'gtfs-rt' | 'gbfs' | 'mds';
      staticUrl?: string;
      vehiclePositionsUrl?: string;
      tripUpdatesUrl?: string;
      alertsUrl?: string;
      name?: string;
      license?: {
        spdxIdentifier?: string;
        useWithoutAttribution?: 'yes' | 'no' | 'unknown';
        createDerivedProduct?: 'yes' | 'no' | 'unknown';
        commercialUseAllowed?: 'yes' | 'no' | 'unknown';
        redistributionAllowed?: 'yes' | 'no' | 'unknown';
        shareAlikeOptional?: 'yes' | 'no' | 'unknown';
        attributionText?: string;
        attributionInstructions?: string;
      };
      authorization?: { type?: 'header' | 'query_param' | 'path' | 'replace'; paramName?: string; infoUrl?: string };
    }>(
      'transitland_add_feed',
      {
        async invoke(options, token) {
          const { file, feedId, spec, staticUrl, vehiclePositionsUrl, tripUpdatesUrl, alertsUrl, name, license, authorization } = options.input;

          // Resolve target file path
          let filePath: string;
          if (file) {
            const folders = vscode.workspace.workspaceFolders;
            if (!folders?.length) { throw new Error('No workspace folder open'); }
            filePath = vscode.Uri.joinPath(folders[0].uri, file).fsPath;
          } else {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { throw new Error('No file specified and no active editor'); }
            if (!editor.document.uri.fsPath.endsWith('.dmfr.json')) {
              throw new Error('Active file is not a .dmfr.json file');
            }
            filePath = editor.document.uri.fsPath;
          }

          // Collect all workspace .dmfr.json paths for duplicate URL scanning
          const dmfrUris = await vscode.workspace.findFiles('**/*.dmfr.json', '**/node_modules/**', 500);
          const scanFiles = dmfrUris.map((u) => u.fsPath);

          const activeCLI = requireCLI();
          const result = await runAddFeed(
            activeCLI,
            { filePath, feedId, spec, staticUrl, vehiclePositionsUrl, tripUpdatesUrl, alertsUrl, name, license, authorization },
            scanFiles,
            token2signal(token),
          );
          return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
            result.success ? `✅ ${result.message}` : `❌ ${result.message}`,
          )]);
        },
      },
    ),

    vscode.lm.registerTool<{
      file?: string;
      placement: 'nested' | 'top_level';
      feedId?: string;
      operatorOnestopId: string;
      name: string;
      shortName?: string;
      website?: string;
      associatedFeeds?: Array<{ feedOnestopId?: string; gtfsAgencyId?: string }>;
      tags?: Record<string, string>;
    }>(
      'transitland_add_operator',
      {
        async invoke(options, token) {
          const { file, placement, feedId, operatorOnestopId, name, shortName, website, associatedFeeds, tags } = options.input;

          // Resolve target file path
          let filePath: string;
          if (file) {
            const folders = vscode.workspace.workspaceFolders;
            if (!folders?.length) { throw new Error('No workspace folder open'); }
            filePath = vscode.Uri.joinPath(folders[0].uri, file).fsPath;
          } else {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { throw new Error('No file specified and no active editor'); }
            if (!editor.document.uri.fsPath.endsWith('.dmfr.json')) {
              throw new Error('Active file is not a .dmfr.json file');
            }
            filePath = editor.document.uri.fsPath;
          }

          const activeCLI = requireCLI();
          const result = await runAddOperator(
            activeCLI,
            { filePath, placement, feedId, operatorOnestopId, name, shortName, website, associatedFeeds, tags },
            token2signal(token),
          );
          return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
            result.success ? `✅ ${result.message}` : `❌ ${result.message}`,
          )]);
        },
      },
    ),

    vscode.lm.registerTool<{ file?: string }>(
      'transitland_dmfr_format',
      {
        async invoke(options, token) {
          const activeCLI = requireCLI();
          if (!activeCLI) { throw new Error('transitland CLI not found. Set transitland.cliPath in settings.'); }

          let filePath: string;
          if (options.input.file) {
            const folders = vscode.workspace.workspaceFolders;
            if (!folders?.length) { throw new Error('No workspace folder open'); }
            filePath = vscode.Uri.joinPath(folders[0].uri, options.input.file).fsPath;
          } else {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { throw new Error('No file specified and no active editor'); }
            if (!editor.document.uri.fsPath.endsWith('.dmfr.json')) {
              throw new Error('Active file is not a .dmfr.json file');
            }
            filePath = editor.document.uri.fsPath;
          }

          const result = await runDmfrFormat(activeCLI, { filePath }, token2signal(token));
          return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
            result.success ? `✅ ${result.message}` : `❌ ${result.message}`,
          )]);
        },
      },
    ),
  );
}

export function deactivate() {}
