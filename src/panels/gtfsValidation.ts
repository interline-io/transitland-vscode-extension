import * as vscode from 'vscode';
import type { ValidateOutput, ValidationError, RtFeedResult } from '../tools/validate';

// ---------------------------------------------------------------------------
// Public types for cross-panel communication
// ---------------------------------------------------------------------------

export interface EntityStop {
  name: string;
  lat: number | null;
  lon: number | null;
  locationType: number;
  parent: string | null;
}

export interface EntityRoute {
  shortName: string | null;
  longName: string | null;
  routeType: number;
  color: string | null;
}

export type ValidationPanelMessage =
  | { command: 'loadEntities' }
  | { command: 'openInInspector'; tab: 'stops' | 'routes'; filter: string };

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

/**
 * Singleton webview panel for GTFS validation results (errors, warnings, pass/fail).
 */
export class GtfsValidationPanel {
  private static current: GtfsValidationPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private onMessageCallback?: (msg: ValidationPanelMessage) => void;

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg: ValidationPanelMessage) => this.onMessageCallback?.(msg),
      null,
      this.disposables,
    );
  }

  static show(
    feedUrl: string,
    result: ValidateOutput,
    onMessage?: (msg: ValidationPanelMessage) => void,
  ): GtfsValidationPanel {
    const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;

    if (GtfsValidationPanel.current) {
      GtfsValidationPanel.current.onMessageCallback = onMessage;
      GtfsValidationPanel.current.panel.reveal(column);
      GtfsValidationPanel.current.update(feedUrl, result);
      return GtfsValidationPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      'transitland.gtfsValidation',
      'GTFS Validation',
      column,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    GtfsValidationPanel.current = new GtfsValidationPanel(panel);
    GtfsValidationPanel.current.onMessageCallback = onMessage;
    GtfsValidationPanel.current.update(feedUrl, result);
    return GtfsValidationPanel.current;
  }

  postEntityLoading(): void {
    this.panel.webview.postMessage({ command: 'entityLoading' });
  }

  postEntityData(stops: Record<string, EntityStop>, routes: Record<string, EntityRoute>): void {
    this.panel.webview.postMessage({ command: 'entityData', stops, routes });
  }

  postEntityError(message: string): void {
    this.panel.webview.postMessage({ command: 'entityError', message });
  }

  private update(feedUrl: string, result: ValidateOutput) {
    const short = shortUrl(feedUrl);
    this.panel.title = result.summary.success ? `✓ ${short}` : `✗ ${short}`;
    this.panel.webview.html = buildHtml(feedUrl, result);
  }

  private dispose() {
    GtfsValidationPanel.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables) { d.dispose(); }
    this.disposables = [];
  }
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const file = u.pathname.split('/').filter(Boolean).pop() ?? u.hostname;
    return file.length > 30 ? file.slice(0, 30) + '…' : file;
  } catch {
    return url.slice(0, 30);
  }
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function issueRows(issues: ValidationError[], rowClass: string): string {
  if (issues.length === 0) { return ''; }
  return issues.map((e) => `
    <tr class="${rowClass}">
      <td class="mono">${esc(e.errorType)}</td>
      <td>${esc(e.message)}</td>
      <td class="mono dim">${esc(e.filename ?? '')}</td>
      <td class="mono dim entity-id-cell" data-entity-id="${esc(e.entityId ?? '')}" data-entity-filename="${esc(e.filename ?? '')}">${esc(e.entityId ?? '')}</td>
    </tr>`).join('');
}

function pct(n: number, total: number): string {
  if (total === 0) { return '—'; }
  return `${Math.round((n / total) * 100)}%`;
}

function rtSection(feeds: RtFeedResult[]): string {
  if (feeds.length === 0) { return ''; }

  const cards = feeds.map((feed) => {
    const { entityCounts, totals } = feed;
    const hasTrips = entityCounts.tripUpdate > 0;
    const hasVehicles = entityCounts.vehicle > 0;
    const hasAlerts = entityCounts.alert > 0;

    const entityBadges = [
      hasTrips ? `<span class="rt-badge">${entityCounts.tripUpdate} trip updates</span>` : null,
      hasVehicles ? `<span class="rt-badge">${entityCounts.vehicle} vehicles</span>` : null,
      hasAlerts ? `<span class="rt-badge">${entityCounts.alert} alerts</span>` : null,
    ].filter(Boolean).join(' ');

    const matchRows: string[] = [];
    if (hasTrips && totals.tripScheduledCount > 0) {
      matchRows.push(
        `<tr><td>Scheduled trips active now</td><td class="num">${totals.tripScheduledCount}</td></tr>`,
        `<tr><td>Found in RT feed</td><td class="num ${totals.tripScheduledMatched < totals.tripScheduledCount ? 'warn' : 'ok'}">${totals.tripScheduledMatched} <span class="dim">(${pct(totals.tripScheduledMatched, totals.tripScheduledCount)})</span></td></tr>`,
        `<tr><td>Not in RT feed</td><td class="num ${totals.tripScheduledNotMatched > 0 ? 'warn' : ''}">${totals.tripScheduledNotMatched}</td></tr>`,
      );
    }
    if ((hasTrips || hasVehicles) && totals.tripRtCount > 0) {
      matchRows.push(
        `<tr><td>RT trips total</td><td class="num">${totals.tripRtCount}</td></tr>`,
        `<tr><td>Matched to schedule</td><td class="num">${totals.tripRtMatched} <span class="dim">(${pct(totals.tripRtMatched, totals.tripRtCount)})</span></td></tr>`,
        `<tr><td>Unscheduled / added</td><td class="num ${totals.tripRtNotMatched > 0 ? 'warn' : ''}">${totals.tripRtNotMatched}</td></tr>`,
      );
    }

    const matchTable = matchRows.length > 0
      ? `<table class="rt-table"><tbody>${matchRows.join('')}</tbody></table>`
      : '';

    return `<div class="rt-card">
      <div class="rt-url">${esc(feed.url)}</div>
      <div class="rt-badges">${entityBadges || '<span class="dim">No entities</span>'}</div>
      ${matchTable}
    </div>`;
  }).join('');

  return `<section>
    <h2>Realtime feeds (${feeds.length})</h2>
    ${cards}
  </section>`;
}

function buildHtml(feedUrl: string, result: ValidateOutput): string {
  const { summary, errors, warnings, realtimeFeeds } = result;
  const statusClass = summary.success ? 'success' : 'failure';
  const statusIcon = summary.success ? '✓' : '✗';
  const statusLabel = summary.success ? 'Valid' : `Invalid${summary.failureReason ? ': ' + summary.failureReason : ''}`;

  const noIssues = errors.length === 0 && warnings.length === 0;
  const hasEntityIds = !noIssues && [...errors, ...warnings].some((e) => e.entityId != null && e.entityId !== '');

  const issueTable = noIssues ? `<p class="ok-msg">✓ No errors or warnings found.</p>` : `
    <table>
      <thead>
        <tr><th>Type</th><th>Message</th><th>File</th><th>Entity</th></tr>
      </thead>
      <tbody>
        ${issueRows(errors, 'error-row')}
        ${issueRows(warnings, 'warn-row')}
      </tbody>
    </table>`;

  const entityLoadBar = hasEntityIds ? `
<div class="entity-load-bar">
  <button id="btn-load-entities">Load entity details</button>
  <span id="entity-status" class="entity-status-text"></span>
</div>` : '';

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  :root {
    --success: #3fb950; --failure: #f85149; --warning: #d29922;
    --border: var(--vscode-panel-border, #3c3c3c);
    --bg: var(--vscode-editor-background, #1e1e1e);
    --fg: var(--vscode-editor-foreground, #d4d4d4);
    --muted: var(--vscode-descriptionForeground, #888);
    --sidebar: var(--vscode-sideBar-background, #252526);
    --accent: var(--vscode-focusBorder, #007acc);
    --link: var(--vscode-textLink-foreground, #4daafc);
    --hover: var(--vscode-list-hoverBackground, rgba(255,255,255,.04));
  }
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family, system-ui, sans-serif); font-size: 13px; background: var(--bg); color: var(--fg); margin: 0; padding: 0; }

  header { background: var(--sidebar); border-bottom: 1px solid var(--border); padding: 14px 20px 12px; }
  .status { font-size: 15px; font-weight: 700; margin-bottom: 4px; }
  .status.success { color: var(--success); }
  .status.failure { color: var(--failure); }
  .url { font-size: 11px; color: var(--muted); word-break: break-all; }

  .meta { display: flex; gap: 24px; padding: 10px 20px; background: var(--sidebar); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .meta-item { display: flex; flex-direction: column; gap: 1px; }
  .meta-item .label { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
  .meta-item .value { font-weight: 600; }
  .value.bad { color: var(--failure); }
  .value.warn { color: var(--warning); }

  /* Entity load bar */
  .entity-load-bar { padding: 8px 20px; background: var(--sidebar); border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 10px; }
  #btn-load-entities { background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #ccc); border: none; padding: 4px 10px; border-radius: 2px; font-size: 12px; font-family: inherit; cursor: pointer; }
  #btn-load-entities:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
  #btn-load-entities:disabled { opacity: .6; cursor: default; }
  .entity-status-text { font-size: 11px; color: var(--muted); }

  section { padding: 16px 20px; }
  h2 { margin: 0 0 10px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }

  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--border); color: var(--muted); font-weight: 400; font-size: 11px; }
  td { padding: 5px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: var(--hover); }
  .error-row td { color: var(--failure); }
  .warn-row td { color: var(--warning); }
  .mono { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
  .dim { opacity: .7; }
  .ok-msg { color: var(--success); font-weight: 600; margin: 0; }

  /* Entity enrichment */
  .entity-id-cell { cursor: default; transition: color .1s; }
  .entity-clickable { cursor: pointer; color: var(--link) !important; text-decoration: underline; opacity: 1 !important; }
  .entity-clickable::after { content: ' ▸'; font-size: 9px; opacity: .7; }
  .entity-clickable.entity-clickable-open::after { content: ' ▾'; }
  .entity-detail-td { padding: 6px 8px 8px 28px; background: var(--vscode-editor-inactiveSelectionBackground, rgba(255,255,255,.03)); color: var(--fg); }
  .edt-name { font-weight: 600; }
  .edt-badge { background: rgba(100,180,255,.15); color: #6ab4ff; font-size: 10px; padding: 1px 5px; border-radius: 2px; margin-left: 6px; }
  .edt-coords { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; color: var(--muted); margin-left: 8px; }
  .edt-meta { font-size: 11px; color: var(--muted); margin-left: 8px; }
  .edt-color { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-left: 6px; vertical-align: middle; }
  .edt-view-btn { margin-left: 14px; background: transparent; border: 1px solid var(--accent); color: var(--link); padding: 2px 8px; border-radius: 2px; font-size: 11px; font-family: inherit; cursor: pointer; }
  .edt-view-btn:hover { background: rgba(0,122,204,.15); }

  .rt-card { background: var(--sidebar); border: 1px solid var(--border); border-radius: 3px; padding: 12px 14px; margin-bottom: 12px; }
  .rt-url { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; color: var(--muted); word-break: break-all; margin-bottom: 8px; }
  .rt-badges { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
  .rt-badge { background: rgba(100, 180, 255, .15); color: #6ab4ff; font-size: 11px; padding: 2px 7px; border-radius: 3px; }
  .rt-table { width: auto; min-width: 280px; }
  .rt-table td { padding: 3px 8px; border-bottom: 1px solid var(--border); font-size: 12px; }
  .rt-table td:first-child { color: var(--muted); }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .ok { color: var(--success); }
  .warn { color: var(--warning); }
</style>
</head>
<body>
<header>
  <div class="status ${statusClass}">${statusIcon} ${esc(statusLabel)}</div>
  <div class="url">${esc(feedUrl)}</div>
</header>
<div class="meta">
  ${summary.sha1 ? `<div class="meta-item"><span class="label">SHA1</span><span class="value mono" title="${esc(summary.sha1)}">${esc(summary.sha1.slice(0, 12))}…</span></div>` : ''}
  ${summary.earliestCalendarDate ? `<div class="meta-item"><span class="label">From</span><span class="value">${esc(summary.earliestCalendarDate)}</span></div>` : ''}
  ${summary.latestCalendarDate ? `<div class="meta-item"><span class="label">To</span><span class="value">${esc(summary.latestCalendarDate)}</span></div>` : ''}
  <div class="meta-item"><span class="label">Errors</span><span class="value ${summary.errorCount > 0 ? 'bad' : ''}">${esc(summary.errorCount)}</span></div>
  <div class="meta-item"><span class="label">Warnings</span><span class="value ${summary.warningCount > 0 ? 'warn' : ''}">${esc(summary.warningCount)}</span></div>
  ${result.includesRt ? `<div class="meta-item"><span class="label">Realtime</span><span class="value ok">${realtimeFeeds.length} feed${realtimeFeeds.length !== 1 ? 's' : ''}</span></div>` : ''}
</div>
${entityLoadBar}
<section>
  <h2>Issues (${errors.length} errors, ${warnings.length} warnings)</h2>
  ${issueTable}
</section>
${rtSection(realtimeFeeds)}
<script>
  const vscode = acquireVsCodeApi();
  let stopsMap = {};
  let routesMap = {};

  document.getElementById('btn-load-entities')?.addEventListener('click', () => {
    vscode.postMessage({ command: 'loadEntities' });
  });

  window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.command === 'entityLoading') {
      const btn = document.getElementById('btn-load-entities');
      if (btn) { btn.disabled = true; btn.textContent = '⟳ Loading entity details…'; }
    } else if (msg.command === 'entityData') {
      stopsMap = msg.stops || {};
      routesMap = msg.routes || {};
      const btn = document.getElementById('btn-load-entities');
      if (btn) { btn.style.display = 'none'; }
      const status = document.getElementById('entity-status');
      if (status) { status.textContent = ''; }
      enrichTable();
    } else if (msg.command === 'entityError') {
      const btn = document.getElementById('btn-load-entities');
      if (btn) { btn.disabled = false; btn.textContent = 'Retry loading entity details'; }
      const status = document.getElementById('entity-status');
      if (status) { status.textContent = '⚠ ' + String(msg.message ?? 'Unknown error'); }
    }
  });

  function enrichTable() {
    let enriched = 0;
    document.querySelectorAll('td.entity-id-cell').forEach(cell => {
      const entityId = cell.getAttribute('data-entity-id');
      const filename = cell.getAttribute('data-entity-filename') || '';
      if (!entityId) { return; }

      const stop = stopsMap[entityId];
      const route = routesMap[entityId];
      if (!stop && !route) { return; }

      enriched++;
      const row = cell.closest('tr');
      if (!row || row.dataset.enriched) { return; }
      row.dataset.enriched = '1';

      // Determine inspector tab routing
      let tab = null;
      if (filename === 'stops.txt') { tab = 'stops'; }
      else if (filename === 'routes.txt') { tab = 'routes'; }

      // Make cell look clickable
      cell.classList.add('entity-clickable');
      cell.setAttribute('title', 'Click to expand entity details');

      // Build detail row
      const detailRow = document.createElement('tr');
      const detailTd = document.createElement('td');
      detailTd.colSpan = row.cells.length;
      detailTd.className = 'entity-detail-td';

      if (stop) {
        const locLabels = ['Stop', 'Station', 'Entrance', 'Node', 'Boarding'];
        const locLabel = locLabels[stop.locationType] || ('Type ' + stop.locationType);
        detailTd.innerHTML = '<span class="edt-name">' + escHtml(stop.name) + '</span>'
          + ' <span class="edt-badge">' + locLabel + '</span>'
          + ((stop.lat !== null && stop.lon !== null)
            ? ' <span class="edt-coords">' + stop.lat.toFixed(5) + ', ' + stop.lon.toFixed(5) + '</span>'
            : '')
          + (stop.parent ? ' <span class="edt-meta">Parent: ' + escHtml(stop.parent) + '</span>' : '');
      } else if (route) {
        const rtLabels = ['Tram/LRT', 'Subway', 'Rail', 'Bus', 'Ferry', 'Cable car', 'Gondola', 'Funicular'];
        const rtLabel = rtLabels[route.routeType] || ('Type ' + route.routeType);
        const name = route.shortName || route.longName || entityId;
        detailTd.innerHTML = '<span class="edt-name">' + escHtml(name) + '</span>'
          + (route.shortName && route.longName ? ' <span class="edt-meta">' + escHtml(route.longName) + '</span>' : '')
          + ' <span class="edt-badge">' + rtLabel + '</span>'
          + (route.color ? ' <span class="edt-color" style="background:#' + escHtml(route.color) + '"></span>' : '');
      }

      if (tab) {
        const viewBtn = document.createElement('button');
        viewBtn.className = 'edt-view-btn';
        viewBtn.textContent = 'View in inspector \u2192';
        viewBtn.dataset.tab = tab;
        viewBtn.dataset.filter = entityId;
        viewBtn.addEventListener('click', e => {
          e.stopPropagation();
          vscode.postMessage({ command: 'openInInspector', tab: viewBtn.dataset.tab, filter: viewBtn.dataset.filter });
        });
        detailTd.appendChild(viewBtn);
      }

      detailRow.appendChild(detailTd);
      detailRow.style.display = 'none';
      row.parentNode.insertBefore(detailRow, row.nextSibling);

      cell.addEventListener('click', () => {
        const showing = detailRow.style.display !== 'none';
        detailRow.style.display = showing ? 'none' : '';
        cell.classList.toggle('entity-clickable-open', !showing);
      });
    });

    if (enriched === 0) {
      const status = document.getElementById('entity-status');
      if (status) { status.textContent = 'No entity details found for these errors.'; }
      const btn = document.getElementById('btn-load-entities');
      if (btn) { btn.style.display = 'none'; }
    }
  }

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
</script>
</body>
</html>`;
}
