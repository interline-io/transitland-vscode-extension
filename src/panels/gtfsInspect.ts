import * as vscode from 'vscode';
import type { InspectOutput, Route, ServiceLevel, Stop, GtfsFile } from '../tools/inspect';

/**
 * Singleton webview panel for GTFS feed inspection (agencies, routes, stops, service coverage).
 */
export class GtfsInspectPanel {
  private static current: GtfsInspectPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  static show(feedUrl: string, result: InspectOutput): GtfsInspectPanel {
    const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;

    if (GtfsInspectPanel.current) {
      GtfsInspectPanel.current.panel.reveal(column);
      GtfsInspectPanel.current.update(feedUrl, result);
      return GtfsInspectPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      'transitland.gtfsInspect',
      'GTFS Inspect',
      column,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    GtfsInspectPanel.current = new GtfsInspectPanel(panel);
    GtfsInspectPanel.current.update(feedUrl, result);
    return GtfsInspectPanel.current;
  }

  postTransitlandInfo(info: { onestopId: string; versionCount: number | null; fetchedAt: string | null }): void {
    this.panel.webview.postMessage({ command: 'transitlandInfo', ...info });
  }

  /** Post a filterTab message to switch tabs and apply a filter. */
  postFilter(tab: 'stops' | 'routes', filter: string): void {
    this.panel.webview.postMessage({ command: 'filterTab', tab, filter });
  }

  private update(feedUrl: string, result: InspectOutput) {
    this.panel.title = `GTFS: ${shortUrl(feedUrl)}`;
    this.panel.webview.html = buildHtml(feedUrl, result);
  }

  private dispose() {
    GtfsInspectPanel.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables) { d.dispose(); }
    this.disposables = [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
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

function fmtBytes(n: number): string {
  if (n < 1024) { return `${n} B`; }
  if (n < 1024 * 1024) { return `${(n / 1024).toFixed(1)} KB`; }
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtNumber(n: number): string {
  return n.toLocaleString();
}

/* eslint-disable @typescript-eslint/naming-convention */
const ROUTE_TYPES: Record<number, string> = {
  0: 'Tram / Light rail', 1: 'Subway / Metro', 2: 'Rail', 3: 'Bus', 4: 'Ferry',
  5: 'Cable car', 6: 'Gondola', 7: 'Funicular', 11: 'Trolleybus', 12: 'Monorail',
};
/* eslint-enable @typescript-eslint/naming-convention */

function routeTypeName(type: number): string {
  return ROUTE_TYPES[type] ?? `Type ${type}`;
}

function routeBadge(r: Route): string {
  const bg = r.routeColor ? `#${r.routeColor.replace('#', '')}` : '#555';
  const fg = r.routeTextColor ? `#${r.routeTextColor.replace('#', '')}` : '#fff';
  const label = r.routeShortName ?? r.routeId;
  return `<span class="badge" style="background:${esc(bg)};color:${esc(fg)}">${esc(label)}</span>`;
}

/* eslint-disable @typescript-eslint/naming-convention */
const LOCATION_TYPE_LABELS: Record<number, { label: string; cls: string }> = {
  0: { label: 'Stop', cls: 'lt-stop' },
  1: { label: 'Station', cls: 'lt-station' },
  2: { label: 'Entrance', cls: 'lt-entrance' },
  3: { label: 'Node', cls: 'lt-node' },
  4: { label: 'Boarding', cls: 'lt-boarding' },
};
/* eslint-enable @typescript-eslint/naming-convention */

function locationTypeBadge(type: number): string {
  const { label, cls } = LOCATION_TYPE_LABELS[type] ?? { label: `Type ${type}`, cls: '' };
  return `<span class="lt-badge ${esc(cls)}">${esc(label)}</span>`;
}

function wheelchairBadge(wb: number): string {
  if (wb === 1) { return '<span class="wc-yes" title="Wheelchair accessible">♿ Yes</span>'; }
  if (wb === 2) { return '<span class="wc-no" title="Not wheelchair accessible">✕ No</span>'; }
  return '<span class="wc-unk" title="No information">—</span>';
}

// Core required GTFS files (bold in the files table)
const CORE_FILES = new Set([
  'agency.txt', 'routes.txt', 'trips.txt', 'stop_times.txt', 'stops.txt',
  'calendar.txt', 'calendar_dates.txt',
]);

// ---------------------------------------------------------------------------
// Tab content builders
// ---------------------------------------------------------------------------

function agencyTab(result: InspectOutput): string {
  if (result.agencies.length === 0) { return '<p class="empty">No agency data.</p>'; }
  const rows = result.agencies.map((a) => `
    <tr>
      <td>${esc(a.agencyId)}</td>
      <td>${esc(a.agencyName)}</td>
      <td>${esc(a.agencyTimezone)}</td>
      <td>${a.agencyPhone ? esc(a.agencyPhone) : '<span class="dim">—</span>'}</td>
      <td>${a.agencyLang ? esc(a.agencyLang) : '<span class="dim">—</span>'}</td>
      <td><a href="${esc(a.agencyUrl)}">${esc(a.agencyUrl)}</a></td>
    </tr>`).join('');
  return `<table>
    <thead><tr><th>ID</th><th>Name</th><th>Timezone</th><th>Phone</th><th>Lang</th><th>URL</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function routesTab(result: InspectOutput): string {
  if (result.routes.length === 0) { return '<p class="empty">No route data.</p>'; }
  const shown = result.routes.slice(0, 200);
  const more = result.routes.length > 200 ? `<p class="dim small">Showing 200 of ${result.routes.length} routes.</p>` : '';
  const rows = shown.map((r) => `
    <tr data-route-id="${esc(r.routeId)}">
      <td>${routeBadge(r)}</td>
      <td>${esc(r.routeLongName ?? '')}</td>
      <td>${esc(r.agencyId)}</td>
      <td>${esc(routeTypeName(r.routeType))}</td>
    </tr>`).join('');
  return `
    <div class="filter-row">
      <input type="text" id="routes-filter" placeholder="Filter routes…" oninput="filterRoutes(this.value)">
    </div>
    <table id="routes-table">
      <thead><tr><th>Route</th><th>Name</th><th>Agency</th><th>Type</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>${more}`;
}

function stopsTab(result: InspectOutput): string {
  if (result.stops.length === 0) { return '<p class="empty">No stop data.</p>'; }

  // Sort: stations first, then stops, then entrances/nodes
  const sorted = [...result.stops].sort((a, b) => {
    if (a.locationType !== b.locationType) { return a.locationType - b.locationType; }
    return a.stopName.localeCompare(b.stopName);
  });
  // Stations first (locationType=1), then stops (0), then others (2+)
  const reordered = [
    ...sorted.filter((s) => s.locationType === 1),
    ...sorted.filter((s) => s.locationType === 0),
    ...sorted.filter((s) => s.locationType !== 0 && s.locationType !== 1),
  ];

  const shown = reordered.slice(0, 500);
  const more = reordered.length > 500 ? `<p class="dim small">Showing 500 of ${reordered.length} stops.</p>` : '';

  const rows = shown.map((s: Stop) => {
    const coords = (s.stopLat !== null && s.stopLon !== null)
      ? `<span class="mono dim">${s.stopLat.toFixed(5)}, ${s.stopLon.toFixed(5)}</span>`
      : '<span class="dim">—</span>';
    const parent = s.parentStation ? `<span class="dim small">${esc(s.parentStation)}</span>` : '<span class="dim">—</span>';
    const zone = s.zoneId ? esc(s.zoneId) : '<span class="dim">—</span>';
    return `<tr data-stop-id="${esc(s.stopId)}">
      <td>${locationTypeBadge(s.locationType)}</td>
      <td>${esc(s.stopName)}${s.stopCode && s.stopCode !== s.stopId ? `<br><span class="dim small">${esc(s.stopCode)}</span>` : ''}</td>
      <td>${parent}</td>
      <td>${zone}</td>
      <td>${wheelchairBadge(s.wheelchairBoarding)}</td>
      <td>${coords}</td>
    </tr>`;
  }).join('');

  // Summary counts by type
  const typeCounts: Record<number, number> = {};
  for (const s of result.stops) { typeCounts[s.locationType] = (typeCounts[s.locationType] ?? 0) + 1; }
  const typeBreakdown = Object.entries(typeCounts).sort(([a], [b]) => Number(a) - Number(b))
    .map(([t, n]) => `${n} ${LOCATION_TYPE_LABELS[Number(t)]?.label ?? `Type ${t}`}${n !== 1 ? 's' : ''}`)
    .join(' · ');

  // Wheelchair summary
  const wcYes = result.stops.filter((s) => s.wheelchairBoarding === 1).length;
  const wcNo = result.stops.filter((s) => s.wheelchairBoarding === 2).length;
  const wcUnk = result.stops.filter((s) => s.wheelchairBoarding === 0).length;

  return `
    <div class="stops-summary">
      <span>${typeBreakdown}</span>
      <span class="dim">·</span>
      <span>Wheelchair: <span class="wc-yes">${wcYes} accessible</span> · <span class="wc-no">${wcNo} not accessible</span> · <span class="wc-unk">${wcUnk} unknown</span></span>
    </div>
    <div class="filter-row">
      <input type="text" id="stops-filter" placeholder="Filter stops by name…" oninput="filterStops(this.value)">
    </div>
    <table id="stops-table">
      <thead><tr><th>Type</th><th>Name / Code</th><th>Parent station</th><th>Zone</th><th>Wheelchair</th><th>Coordinates</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>${more}`;
}

function filesTab(result: InspectOutput): string {
  if (result.files.length === 0) { return '<p class="empty">No file data.</p>'; }

  const sorted = [...result.files].sort((a, b) => {
    // Core files first, then alphabetical
    const aC = CORE_FILES.has(a.name) ? 0 : 1;
    const bC = CORE_FILES.has(b.name) ? 0 : 1;
    if (aC !== bC) { return aC - bC; }
    return a.name.localeCompare(b.name);
  });

  const rows = sorted.map((f: GtfsFile) => {
    const isCore = CORE_FILES.has(f.name);
    const isEmpty = f.rows === 0;
    const nameCls = isEmpty ? 'dim' : isCore ? 'core-file' : '';
    const rowsStr = f.csvlike
      ? (f.rows === 0 ? '<span class="dim">empty</span>' : fmtNumber(f.rows))
      : '<span class="dim">—</span>';
    return `<tr class="${isEmpty ? 'row-empty' : ''}">
      <td class="${esc(nameCls)}">${esc(f.name)}${isCore ? ' <span class="core-tag">core</span>' : ''}</td>
      <td class="num">${rowsStr}</td>
      <td class="num dim">${esc(fmtBytes(f.size))}</td>
    </tr>`;
  }).join('');

  const totalSize = result.files.reduce((sum, f) => sum + f.size, 0);
  const presentCount = result.files.filter((f) => f.rows > 0 || !f.csvlike).length;

  return `
    <p class="files-summary">${result.files.length} files · ${presentCount} with data · ${fmtBytes(totalSize)} total (uncompressed)</p>
    <table class="files-table">
      <thead><tr><th>File</th><th class="num">Rows</th><th class="num">Size</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function coverageTab(result: InspectOutput): string {
  const { summary, serviceLevels } = result;
  const parts: string[] = [];

  parts.push(`<div class="coverage-range">
    <span class="label">Service window</span>
    <span class="range">${esc(summary.earliestCalendarDate ?? '?')} → ${esc(summary.latestCalendarDate ?? '?')}</span>
  </div>`);

  if (!serviceLevels) {
    parts.push(`<p class="dim small">Re-run with "Include service levels" to see weekly coverage breakdown.</p>`);
    return parts.join('');
  }

  const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
  const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // Normalize heatmap to max value across all days/periods
  let maxVal = 1;
  for (const s of serviceLevels) {
    for (const d of DAYS) { if ((s[d] ?? 0) > maxVal) { maxVal = s[d]; } }
  }

  const rows = serviceLevels.slice(0, 52).map((s: ServiceLevel) => {
    const cells = DAYS.map((d, i) => {
      const count = s[d] ?? 0;
      const alpha = count > 0 ? (0.15 + (count / maxVal) * 0.85).toFixed(2) : '0';
      return `<td class="day-cell" style="--alpha:${alpha}" title="${DAY_LABELS[i]}: ${fmtNumber(count)}">${count > 0 ? '·' : ''}</td>`;
    }).join('');
    return `<tr><td class="date-cell">${esc(s.startDate)}</td>${cells}<td class="date-cell">${esc(s.endDate)}</td></tr>`;
  }).join('');

  const moreRows = serviceLevels.length > 52
    ? `<p class="dim small">Showing first 52 periods of ${serviceLevels.length} total.</p>`
    : '';

  parts.push(`
    <table class="coverage-table">
      <thead><tr><th>Start</th>${DAY_LABELS.map((d) => `<th>${d}</th>`).join('')}<th>End</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>${moreRows}
    <p class="dim small" style="margin-top:8px">Cell shading reflects relative scheduled service intensity.</p>`);

  return parts.join('');
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function buildHtml(feedUrl: string, result: InspectOutput): string {
  const { summary, feedInfo } = result;

  const tabs = [
    { id: 'agencies', label: `Agencies (${summary.agencyCount})`, content: agencyTab(result) },
    { id: 'routes', label: `Routes (${summary.routeCount})`, content: routesTab(result) },
    { id: 'stops', label: result.stops.length > 0 ? `Stops (${summary.stopCount})` : 'Stops', content: stopsTab(result) },
    { id: 'files', label: result.files.length > 0 ? `Files (${result.files.length})` : 'Files', content: filesTab(result) },
    { id: 'coverage', label: 'Service coverage', content: coverageTab(result) },
  ];

  const tabButtons = tabs.map((t, i) =>
    `<button class="tab-btn${i === 0 ? ' active' : ''}" data-tab="${t.id}">${esc(t.label)}</button>`
  ).join('');

  const tabPanels = tabs.map((t, i) =>
    `<div class="tab-panel${i === 0 ? ' active' : ''}" id="tab-${t.id}">${t.content}</div>`
  ).join('');

  const metaItems: string[] = [];
  if (summary.sha1) {
    metaItems.push(`<div class="meta-item"><span class="label">SHA1</span><span class="value mono-sm" title="${esc(summary.sha1)}">${esc(summary.sha1.slice(0, 12))}…</span></div>`);
  }
  metaItems.push(`<div class="meta-item"><span class="label">From</span><span class="value">${esc(summary.earliestCalendarDate ?? '?')}</span></div>`);
  metaItems.push(`<div class="meta-item"><span class="label">To</span><span class="value">${esc(summary.latestCalendarDate ?? '?')}</span></div>`);
  if (summary.timezone) {
    metaItems.push(`<div class="meta-item"><span class="label">Timezone</span><span class="value">${esc(summary.timezone)}</span></div>`);
  }
  metaItems.push(`<div class="meta-item"><span class="label">Agencies</span><span class="value">${esc(summary.agencyCount)}</span></div>`);
  metaItems.push(`<div class="meta-item"><span class="label">Routes</span><span class="value">${esc(summary.routeCount)}</span></div>`);
  if (summary.stopCount !== null) {
    metaItems.push(`<div class="meta-item"><span class="label">Stops</span><span class="value">${esc(summary.stopCount)}</span></div>`);
  }
  if (summary.tripCount !== null) {
    metaItems.push(`<div class="meta-item"><span class="label">Trips</span><span class="value">${esc(fmtNumber(summary.tripCount))}</span></div>`);
  }
  if (feedInfo?.feedPublisherName) {
    metaItems.push(`<div class="meta-item"><span class="label">Publisher</span><span class="value">${esc(feedInfo.feedPublisherName)}</span></div>`);
  }
  if (feedInfo?.feedVersion) {
    metaItems.push(`<div class="meta-item"><span class="label">Version</span><span class="value mono-sm" title="${esc(feedInfo.feedVersion)}">${esc(feedInfo.feedVersion.slice(0, 20))}${feedInfo.feedVersion.length > 20 ? '…' : ''}</span></div>`);
  }
  if (feedInfo?.feedLang) {
    metaItems.push(`<div class="meta-item"><span class="label">Language</span><span class="value">${esc(feedInfo.feedLang)}</span></div>`);
  }

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  :root {
    --border: var(--vscode-panel-border, #3c3c3c);
    --bg: var(--vscode-editor-background, #1e1e1e);
    --fg: var(--vscode-editor-foreground, #d4d4d4);
    --muted: var(--vscode-descriptionForeground, #888);
    --sidebar: var(--vscode-sideBar-background, #252526);
    --accent: var(--vscode-focusBorder, #007acc);
    --hover: var(--vscode-list-hoverBackground, rgba(255,255,255,.05));
    --tab-active-bg: var(--vscode-tab-activeBackground, #1e1e1e);
    --tab-inactive-bg: var(--vscode-tab-inactiveBackground, #2d2d2d);
    --input-bg: var(--vscode-input-background, #3c3c3c);
    --input-fg: var(--vscode-input-foreground, #ccc);
    --input-border: var(--vscode-input-border, #555);
    --success: #3fb950;
    --error: #f85149;
  }
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family, system-ui, sans-serif); font-size: 13px; background: var(--bg); color: var(--fg); margin: 0; padding: 0; display: flex; flex-direction: column; height: 100vh; }

  header { background: var(--sidebar); border-bottom: 1px solid var(--border); padding: 12px 20px 10px; flex-shrink: 0; }
  header h1 { margin: 0 0 2px; font-size: 14px; font-weight: 600; }
  .url { font-size: 11px; color: var(--muted); word-break: break-all; }

  .meta { display: flex; gap: 18px; padding: 8px 20px; background: var(--sidebar); border-bottom: 1px solid var(--border); flex-wrap: wrap; flex-shrink: 0; }
  .meta-item { display: flex; flex-direction: column; gap: 1px; }
  .meta-item .label { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
  .meta-item .value { font-weight: 600; font-size: 12px; }
  .mono-sm { font-family: monospace; font-size: 11px !important; }

  .tabs { display: flex; gap: 0; background: var(--tab-inactive-bg); border-bottom: 1px solid var(--border); flex-shrink: 0; overflow-x: auto; }
  .tab-btn { background: var(--tab-inactive-bg); color: var(--muted); border: none; border-right: 1px solid var(--border); padding: 8px 16px; font-size: 12px; font-family: inherit; cursor: pointer; transition: background .1s; white-space: nowrap; flex-shrink: 0; }
  .tab-btn:hover { background: var(--hover); color: var(--fg); }
  .tab-btn.active { background: var(--tab-active-bg); color: var(--fg); border-bottom: 2px solid var(--accent); margin-bottom: -1px; }

  .tab-panel { display: none; padding: 16px 20px; overflow-y: auto; flex: 1; }
  .tab-panel.active { display: block; }

  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--border); color: var(--muted); font-weight: 400; font-size: 11px; }
  td { padding: 5px 8px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  tr:hover td { background: var(--hover); }
  .row-empty td { opacity: .45; }
  a { color: var(--vscode-textLink-foreground, #4daafc); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .mono { font-family: monospace; }

  .badge { display: inline-block; padding: 1px 7px; border-radius: 3px; font-weight: 700; font-size: 11px; white-space: nowrap; }
  .dim { opacity: .6; }
  .small { font-size: 11px; }
  .empty { color: var(--muted); font-style: italic; }

  /* Location type badges */
  .lt-badge { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 10px; font-weight: 600; white-space: nowrap; }
  .lt-station { background: rgba(100, 180, 255, .18); color: #6ab4ff; }
  .lt-stop { background: rgba(100, 220, 120, .15); color: #7cd48a; }
  .lt-entrance { background: rgba(255, 200, 80, .15); color: #f0c060; }
  .lt-node, .lt-boarding { background: rgba(180, 180, 180, .12); color: var(--muted); }

  /* Wheelchair */
  .wc-yes { color: var(--success); font-size: 11px; }
  .wc-no { color: var(--error); font-size: 11px; }
  .wc-unk { color: var(--muted); font-size: 11px; }

  /* Files table */
  .files-table { table-layout: auto; }
  .core-file { font-weight: 600; }
  .core-tag { font-size: 9px; font-weight: 400; background: rgba(100, 180, 255, .18); color: #6ab4ff; padding: 1px 4px; border-radius: 2px; vertical-align: middle; }
  .files-summary { font-size: 11px; color: var(--muted); margin-bottom: 10px; }

  /* Stops and routes filter */
  .stops-summary { font-size: 11px; color: var(--muted); margin-bottom: 10px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .filter-row { margin-bottom: 10px; }
  .filter-row input { background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border); border-radius: 2px; padding: 5px 8px; font-size: 12px; font-family: inherit; outline: none; width: 260px; }

  /* Coverage */
  .coverage-range { display: flex; flex-direction: column; gap: 3px; margin-bottom: 16px; }
  .coverage-range .label { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
  .coverage-range .range { font-weight: 700; font-size: 14px; }

  .coverage-table { table-layout: fixed; }
  .coverage-table th { text-align: center; width: 44px; }
  .coverage-table th:first-child { text-align: left; width: 84px; }
  .coverage-table th:last-child { text-align: left; width: 84px; }
  .date-cell { font-size: 10px; font-family: monospace; color: var(--muted); }
  .day-cell { text-align: center; font-size: 11px; background: rgba(0, 130, 255, var(--alpha, 0)); border-radius: 2px; color: transparent; }
  .day-cell:hover { color: var(--fg); }

  /* Transitland archive info bar */
  .tl-info-bar { padding: 6px 20px; background: rgba(100,180,255,.05); border-bottom: 1px solid var(--border); font-size: 11px; display: flex; align-items: center; gap: 6px; color: var(--muted); flex-shrink: 0; }
  .tl-info-bar a { color: var(--vscode-textLink-foreground, #4daafc); text-decoration: none; font-weight: 600; font-family: monospace; }
  .tl-info-bar a:hover { text-decoration: underline; }
  .tl-meta-text { color: var(--muted); }
</style>
</head>
<body>
<header>
  <h1>GTFS Feed Inspector</h1>
  <div class="url">${esc(feedUrl)}</div>
</header>
<div class="meta">${metaItems.join('\n')}</div>
<div id="tl-info-bar" class="tl-info-bar" style="display:none"></div>
<div class="tabs">${tabButtons}</div>
${tabPanels}
<script>
  // Tab switching
  const btns = document.querySelectorAll('.tab-btn');
  const panels = document.querySelectorAll('.tab-panel');
  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.tab;
      btns.forEach(b => b.classList.toggle('active', b === btn));
      panels.forEach(p => p.classList.toggle('active', p.id === 'tab-' + id));
    });
  });

  // Stops filter
  function filterStops(q) {
    const lower = q.toLowerCase();
    document.querySelectorAll('#stops-table tbody tr').forEach(row => {
      row.style.display =
        row.textContent.toLowerCase().includes(lower) || row.dataset.stopId === q ? '' : 'none';
    });
  }

  // Routes filter
  function filterRoutes(q) {
    const lower = q.toLowerCase();
    document.querySelectorAll('#routes-table tbody tr').forEach(row => {
      row.style.display =
        row.textContent.toLowerCase().includes(lower) || row.dataset.routeId === q ? '' : 'none';
    });
  }

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Handle messages from the extension
  window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.command === 'transitlandInfo') {
      const bar = document.getElementById('tl-info-bar');
      if (!bar) { return; }
      const versions = (msg.versionCount !== null && msg.versionCount > 0)
        ? ' \u00b7 ' + msg.versionCount + ' archived version' + (msg.versionCount !== 1 ? 's' : '')
        : '';
      const fetched = msg.fetchedAt ? ' \u00b7 fetched ' + msg.fetchedAt.slice(0, 10) : '';
      bar.innerHTML = '\u2197 <a href="https://transit.land/feeds/' + encodeURIComponent(msg.onestopId) + '">'
        + escHtml(msg.onestopId) + '</a><span class="tl-meta-text"> on transit.land' + versions + fetched + '</span>';
      bar.style.display = 'flex';
      return;
    }
    if (msg.command !== 'filterTab') { return; }

    // Switch to the requested tab
    btns.forEach(b => b.classList.toggle('active', b.dataset.tab === msg.tab));
    panels.forEach(p => p.classList.toggle('active', p.id === 'tab-' + msg.tab));

    // Fill filter and apply
    const input = document.getElementById(msg.tab + '-filter');
    if (!input) { return; }
    input.value = msg.filter;
    if (msg.tab === 'stops') { filterStops(msg.filter); }
    else if (msg.tab === 'routes') { filterRoutes(msg.filter); }

    // Scroll filter input into view
    input.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
</script>
</body>
</html>`;
}
