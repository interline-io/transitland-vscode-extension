import * as vscode from 'vscode';
import { TransitlandCLI, resolveBinaryPath } from './cli';
import { runValidate } from './tools/validate';
import { runInspect } from './tools/inspect';
import { GtfsValidationPanel, type EntityStop, type EntityRoute, type ValidationPanelMessage } from './panels/gtfsValidation';
import { GtfsInspectPanel } from './panels/gtfsInspect';
import { GtfsRtInspectPanel } from './panels/gtfsRtInspect';
import { runRtInspect } from './tools/rtInspect';
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
    async (feedUrl?: string) => {
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
    },
  ));

  context.subscriptions.push(vscode.commands.registerCommand(
    'transitland.inspectGtfsFeed',
    async (feedUrl?: string) => {
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
      if (result) { GtfsInspectPanel.show(target, result); }
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
            GtfsInspectPanel.show(msg.feed, result);
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

          // Validate + Inspect lenses (requires static URL)
          const staticUrl = feed.urls?.static_current;
          if (staticUrl) {
            const validateLens = new vscode.CodeLens(range);
            (validateLens as any).__data = { staticUrl, lensType: 'validate' } as LensData;
            lenses.push(validateLens);

            const inspectLens = new vscode.CodeLens(range);
            (inspectLens as any).__data = { staticUrl, lensType: 'inspect' } as LensData;
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
              const rtLens = new vscode.CodeLens(range);
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

      if (data.feedId) {
        const status = await fetchFeedStatus(data.feedId);
        lens.command = {
          title: `$(globe) ${status}`,
          command: 'transitland.openFeedOnTransitland',
          arguments: [data.feedId],
        };
      } else if (data.lensType === 'validate') {
        lens.command = {
          title: '$(check) Validate',
          command: 'transitland.validateGtfsFeed',
          arguments: [data.staticUrl],
        };
      } else if (data.lensType === 'inspect') {
        lens.command = {
          title: '$(search) Inspect',
          command: 'transitland.inspectGtfsFeed',
          arguments: [data.staticUrl],
        };
      } else if (data.lensType === 'rtInspect') {
        lens.command = {
          title: `$(radio-tower) Inspect ${data.rtLabel ?? 'RT'}`,
          command: 'transitland.inspectGtfsRtFeed',
          arguments: [data.rtUrl],
        };
      }
      return lens;
    },
  };

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ language: 'dmfr' }, codeLensProvider)
  );
}

export function deactivate() {}
