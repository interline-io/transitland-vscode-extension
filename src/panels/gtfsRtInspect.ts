import * as vscode from 'vscode';
import type { RtInspectOutput, RtVehicle, RtTripUpdate, RtAlert } from '../tools/rtInspect';

/**
 * Singleton webview panel for GTFS Realtime feed inspection.
 */
export class GtfsRtInspectPanel {
  private static current: GtfsRtInspectPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  static show(result: RtInspectOutput): GtfsRtInspectPanel {
    const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;

    if (GtfsRtInspectPanel.current) {
      GtfsRtInspectPanel.current.panel.reveal(column);
      GtfsRtInspectPanel.current.update(result);
      return GtfsRtInspectPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      'transitland.gtfsRtInspect',
      'GTFS-RT Inspect',
      column,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    GtfsRtInspectPanel.current = new GtfsRtInspectPanel(panel);
    GtfsRtInspectPanel.current.update(result);
    return GtfsRtInspectPanel.current;
  }

  private update(result: RtInspectOutput) {
    const total = result.vehicles.length + result.tripUpdates.length + result.alerts.length;
    const type = result.vehicles.length > 0 ? 'Vehicles'
      : result.tripUpdates.length > 0 ? 'Trip Updates'
      : 'Alerts';
    this.panel.title = `RT: ${type} (${total})`;
    this.panel.webview.html = buildHtml(result);
  }

  private dispose() {
    GtfsRtInspectPanel.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables) { d.dispose(); }
    this.disposables = [];
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtTs(ts: number | null): string {
  if (ts === null) { return '—'; }
  // ts is unix seconds
  return new Date(ts * 1000).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function fmtDate(d: string | null): string {
  if (!d) { return '—'; }
  // YYYYMMDD → YYYY-MM-DD
  if (d.length === 8 && /^\d+$/.test(d)) {
    return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  }
  return d;
}

function fmtSpeed(mps: number | null): string {
  if (mps === null) { return '—'; }
  return `${(mps * 3.6).toFixed(1)} km/h`;
}

function fmtBearing(deg: number | null): string {
  if (deg === null) { return '—'; }
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const compass = dirs[Math.round(deg / 45) % 8];
  return `${Math.round(deg)}° ${compass}`;
}

function fmtDelay(sec: number | null): string {
  if (sec === null) { return '—'; }
  const abs = Math.abs(sec);
  const sign = sec < 0 ? '−' : '+';
  if (abs < 60) { return `${sign}${abs}s`; }
  return `${sign}${Math.floor(abs / 60)}m ${abs % 60}s`;
}

function delayCls(sec: number | null): string {
  if (sec === null) { return ''; }
  if (sec > 120) { return 'delay-late'; }
  if (sec < -30) { return 'delay-early'; }
  return 'delay-ok';
}

function humanLabel(s: string | null): string {
  if (!s) { return '—'; }
  return s.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/* eslint-disable @typescript-eslint/naming-convention */
const OCCUPANCY_CLS: Record<string, string> = {
  EMPTY: 'occ-low', MANY_SEATS_AVAILABLE: 'occ-low',
  FEW_SEATS_AVAILABLE: 'occ-mid', STANDING_ROOM_ONLY: 'occ-mid',
  CRUSHED_STANDING_ROOM_ONLY: 'occ-high', FULL: 'occ-high',
  NOT_ACCEPTING_PASSENGERS: 'occ-na',
};

const EFFECT_CLS: Record<string, string> = {
  NO_SERVICE: 'effect-bad', REDUCED_SERVICE: 'effect-warn',
  SIGNIFICANT_DELAYS: 'effect-warn', DETOUR: 'effect-warn',
  ADDITIONAL_SERVICE: 'effect-ok', MODIFIED_SERVICE: 'effect-warn',
  OTHER_EFFECT: 'effect-neutral', UNKNOWN_EFFECT: 'effect-neutral',
  STOP_MOVED: 'effect-warn', NO_EFFECT: 'effect-neutral',
  ACCESSIBILITY_ISSUE: 'effect-warn',
};
/* eslint-enable @typescript-eslint/naming-convention */

// ---------------------------------------------------------------------------
// Tab content builders
// ---------------------------------------------------------------------------

function vehiclesTab(vehicles: RtVehicle[]): string {
  if (vehicles.length === 0) { return '<p class="empty">No vehicle positions in this feed.</p>'; }

  const shown = vehicles.slice(0, 500);
  const more = vehicles.length > 500 ? `<p class="dim small">Showing 500 of ${vehicles.length} vehicles.</p>` : '';

  const rows = shown.map((v) => {
    const occ = v.occupancyStatus ?? '';
    const occCls = OCCUPANCY_CLS[occ] ?? '';
    const coords = (v.latitude !== null && v.longitude !== null)
      ? `${v.latitude.toFixed(4)}, ${v.longitude.toFixed(4)}`
      : '—';

    return `<tr>
      <td>${v.routeId ? `<span class="route-tag">${esc(v.routeId)}</span>` : '<span class="dim">—</span>'}</td>
      <td>${v.directionId !== null ? esc(v.directionId) : '<span class="dim">—</span>'}</td>
      <td class="mono dim small">${esc(v.tripId ?? '—')}</td>
      <td>${esc(v.vehicleLabel ?? v.vehicleId ?? '—')}</td>
      <td class="mono small">${esc(coords)}</td>
      <td>${esc(fmtSpeed(v.speedMs))}</td>
      <td class="dim small">${esc(fmtBearing(v.bearing))}</td>
      <td class="dim small">${esc(v.stopId ?? '—')}</td>
      <td>${occ ? `<span class="${esc(occCls)}">${esc(humanLabel(occ))}</span>` : '<span class="dim">—</span>'}</td>
    </tr>`;
  }).join('');

  return `
    <div class="filter-row">
      <input type="text" id="veh-filter" placeholder="Filter by route or vehicle…" oninput="filterTable('veh-table', this.value)">
    </div>
    <table id="veh-table">
      <thead><tr>
        <th>Route</th><th>Dir</th><th>Trip</th><th>Vehicle</th>
        <th>Lat, Lon</th><th>Speed</th><th>Bearing</th><th>Stop</th><th>Occupancy</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>${more}`;
}

function tripUpdatesTab(updates: RtTripUpdate[]): string {
  if (updates.length === 0) { return '<p class="empty">No trip updates in this feed.</p>'; }

  const shown = updates.slice(0, 500);
  const more = updates.length > 500 ? `<p class="dim small">Showing 500 of ${updates.length} updates.</p>` : '';

  const rows = shown.map((tu) => {
    const firstUpdate = tu.stopTimeUpdates.find((s) =>
      s.arrivalDelay !== null || s.departureDelay !== null
    );
    const delay = firstUpdate?.arrivalDelay ?? firstUpdate?.departureDelay ?? null;
    const nextStop = firstUpdate?.stopId ?? tu.stopTimeUpdates[0]?.stopId ?? null;
    const updateCount = tu.stopTimeUpdates.length;

    return `<tr>
      <td>${tu.routeId ? `<span class="route-tag">${esc(tu.routeId)}</span>` : '<span class="dim">—</span>'}</td>
      <td>${tu.directionId !== null ? esc(tu.directionId) : '<span class="dim">—</span>'}</td>
      <td class="mono dim small">${esc(tu.tripId ?? '—')}</td>
      <td class="dim small">${esc(fmtDate(tu.startDate))} ${esc(tu.startTime ?? '')}</td>
      <td class="num">${esc(updateCount)}</td>
      <td class="dim small">${esc(nextStop ?? '—')}</td>
      <td class="${esc(delayCls(delay))}">${esc(fmtDelay(delay))}</td>
      <td class="dim small">${esc(tu.vehicleId ?? '—')}</td>
    </tr>`;
  }).join('');

  return `
    <div class="filter-row">
      <input type="text" id="tu-filter" placeholder="Filter by route or trip…" oninput="filterTable('tu-table', this.value)">
    </div>
    <table id="tu-table">
      <thead><tr>
        <th>Route</th><th>Dir</th><th>Trip</th><th>Start</th>
        <th class="num">Updates</th><th>Next stop</th><th>Delay</th><th>Vehicle</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>${more}`;
}

function alertsTab(alerts: RtAlert[]): string {
  if (alerts.length === 0) { return '<p class="empty">No service alerts in this feed.</p>'; }

  const cards = alerts.map((a) => {
    const effectCls = EFFECT_CLS[a.effect ?? ''] ?? 'effect-neutral';
    const affectedTags = [
      ...a.routeIds.map((r) => `<span class="route-tag">${esc(r)}</span>`),
      ...a.stopIds.slice(0, 5).map((s) => `<span class="stop-tag">${esc(s)}</span>`),
      a.stopIds.length > 5 ? `<span class="dim small">+${a.stopIds.length - 5} stops</span>` : null,
    ].filter(Boolean).join(' ');

    const period = (a.activePeriodStart || a.activePeriodEnd)
      ? `<div class="alert-period">${esc(fmtTs(a.activePeriodStart))} → ${esc(fmtTs(a.activePeriodEnd))}</div>`
      : '';

    return `<div class="alert-card">
      <div class="alert-meta">
        ${a.effect ? `<span class="effect-badge ${esc(effectCls)}">${esc(humanLabel(a.effect))}</span>` : ''}
        ${a.cause && a.cause !== 'UNKNOWN_CAUSE' ? `<span class="cause-badge">${esc(humanLabel(a.cause))}</span>` : ''}
        ${affectedTags ? `<span class="affected">${affectedTags}</span>` : ''}
      </div>
      ${a.headerText ? `<div class="alert-header">${esc(a.headerText)}</div>` : ''}
      ${a.descriptionText ? `<div class="alert-desc">${esc(a.descriptionText)}</div>` : ''}
      ${period}
    </div>`;
  }).join('');

  return `<div class="alerts-list">${cards}</div>`;
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function buildHtml(result: RtInspectOutput): string {
  const { header, vehicles, tripUpdates, alerts } = result;
  const total = vehicles.length + tripUpdates.length + alerts.length;

  const tabs: Array<{ id: string; label: string; content: string }> = [];
  if (vehicles.length > 0) {
    tabs.push({ id: 'vehicles', label: `Vehicles (${vehicles.length})`, content: vehiclesTab(vehicles) });
  }
  if (tripUpdates.length > 0) {
    tabs.push({ id: 'trip-updates', label: `Trip Updates (${tripUpdates.length})`, content: tripUpdatesTab(tripUpdates) });
  }
  if (alerts.length > 0) {
    tabs.push({ id: 'alerts', label: `Alerts (${alerts.length})`, content: alertsTab(alerts) });
  }
  if (tabs.length === 0) {
    tabs.push({ id: 'empty', label: 'No entities', content: '<p class="empty">Feed contained no recognizable entities.</p>' });
  }

  const tabButtons = tabs.map((t, i) =>
    `<button class="tab-btn${i === 0 ? ' active' : ''}" data-tab="${t.id}">${esc(t.label)}</button>`
  ).join('');
  const tabPanels = tabs.map((t, i) =>
    `<div class="tab-panel${i === 0 ? ' active' : ''}" id="tab-${t.id}">${t.content}</div>`
  ).join('');

  const feedTs = header.timestamp ? fmtTs(header.timestamp) : 'unknown';

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
    --success: #3fb950; --warning: #d29922; --error: #f85149;
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

  .tabs { display: flex; background: var(--tab-inactive-bg); border-bottom: 1px solid var(--border); flex-shrink: 0; overflow-x: auto; }
  .tab-btn { background: var(--tab-inactive-bg); color: var(--muted); border: none; border-right: 1px solid var(--border); padding: 8px 16px; font-size: 12px; font-family: inherit; cursor: pointer; transition: background .1s; white-space: nowrap; flex-shrink: 0; }
  .tab-btn:hover { background: var(--hover); color: var(--fg); }
  .tab-btn.active { background: var(--tab-active-bg); color: var(--fg); border-bottom: 2px solid var(--accent); margin-bottom: -1px; }

  .tab-panel { display: none; padding: 14px 20px; overflow-y: auto; flex: 1; }
  .tab-panel.active { display: block; }

  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--border); color: var(--muted); font-weight: 400; font-size: 11px; white-space: nowrap; }
  td { padding: 4px 8px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  tr:hover td { background: var(--hover); }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .mono { font-family: monospace; }
  .dim { opacity: .6; }
  .small { font-size: 11px; }
  .empty { color: var(--muted); font-style: italic; }

  .route-tag { display: inline-block; background: rgba(100, 180, 255, .18); color: #6ab4ff; padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: 600; }
  .stop-tag { display: inline-block; background: rgba(180,180,180,.12); color: var(--muted); padding: 1px 5px; border-radius: 3px; font-size: 10px; }

  /* Occupancy */
  .occ-low { color: var(--success); font-size: 11px; }
  .occ-mid { color: var(--warning); font-size: 11px; }
  .occ-high { color: var(--error); font-size: 11px; }
  .occ-na { color: var(--muted); font-size: 11px; }

  /* Delays */
  .delay-late { color: var(--error); font-weight: 600; }
  .delay-early { color: #6ab4ff; }
  .delay-ok { color: var(--success); }

  /* Alerts */
  .alerts-list { display: flex; flex-direction: column; gap: 10px; }
  .alert-card { background: var(--sidebar); border: 1px solid var(--border); border-radius: 3px; padding: 12px 14px; }
  .alert-meta { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-bottom: 8px; }
  .effect-badge { display: inline-block; padding: 2px 8px; border-radius: 3px; font-size: 11px; font-weight: 600; }
  .cause-badge { display: inline-block; padding: 2px 7px; border-radius: 3px; font-size: 11px; background: rgba(180,180,180,.12); color: var(--muted); }
  .affected { display: flex; gap: 4px; flex-wrap: wrap; }
  .effect-bad { background: rgba(248,81,73,.2); color: var(--error); }
  .effect-warn { background: rgba(210,153,34,.2); color: var(--warning); }
  .effect-ok { background: rgba(63,185,80,.15); color: var(--success); }
  .effect-neutral { background: rgba(180,180,180,.12); color: var(--muted); }
  .alert-header { font-weight: 600; font-size: 13px; margin-bottom: 5px; }
  .alert-desc { font-size: 12px; color: var(--muted); line-height: 1.5; margin-bottom: 6px; white-space: pre-wrap; }
  .alert-period { font-size: 11px; color: var(--muted); font-family: monospace; }

  /* Filter */
  .filter-row { margin-bottom: 10px; }
  .filter-row input { background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border); border-radius: 2px; padding: 5px 8px; font-size: 12px; font-family: inherit; outline: none; width: 260px; }
</style>
</head>
<body>
<header>
  <h1>GTFS Realtime Inspector</h1>
  <div class="url">${esc(result.url)}</div>
</header>
<div class="meta">
  <div class="meta-item"><span class="label">Feed time</span><span class="value">${esc(feedTs)}</span></div>
  <div class="meta-item"><span class="label">GTFS-RT version</span><span class="value">${esc(header.gtfsRealtimeVersion || '—')}</span></div>
  ${header.incrementality ? `<div class="meta-item"><span class="label">Incrementality</span><span class="value">${esc(humanLabel(header.incrementality))}</span></div>` : ''}
  <div class="meta-item"><span class="label">Total entities</span><span class="value">${esc(total)}</span></div>
  ${vehicles.length > 0 ? `<div class="meta-item"><span class="label">Vehicles</span><span class="value">${esc(vehicles.length)}</span></div>` : ''}
  ${tripUpdates.length > 0 ? `<div class="meta-item"><span class="label">Trip updates</span><span class="value">${esc(tripUpdates.length)}</span></div>` : ''}
  ${alerts.length > 0 ? `<div class="meta-item"><span class="label">Alerts</span><span class="value">${esc(alerts.length)}</span></div>` : ''}
</div>
<div class="tabs">${tabButtons}</div>
${tabPanels}
<script>
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + id));
    });
  });

  function filterTable(tableId, q) {
    const lower = q.toLowerCase();
    document.querySelectorAll('#' + tableId + ' tbody tr').forEach(row => {
      row.style.display = row.textContent.toLowerCase().includes(lower) ? '' : 'none';
    });
  }
</script>
</body>
</html>`;
}

