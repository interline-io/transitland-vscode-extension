import * as vscode from 'vscode';
import type { CompareFeedSourcesOutput, FeedSourceResult, Verdict } from '../tools/compareFeedSources';

const ROUTE_TYPE_NAMES: Record<number, string> = {
  0: 'Tram/Streetcar', 1: 'Subway/Metro', 2: 'Rail', 3: 'Bus',
  4: 'Ferry', 5: 'Cable tram', 6: 'Gondola/Aerial lift', 7: 'Funicular',
  11: 'Trolleybus', 12: 'Monorail',
};

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const p = u.pathname.replace(/\/$/, '');
    return u.hostname + (p.length > 30 ? '…' + p.slice(-27) : p);
  } catch { return url.length > 50 ? url.slice(0, 47) + '…' : url; }
}

function calendarCell(r: FeedSourceResult): { html: string; cls: string } {
  const s = r.inspect?.summary;
  if (!s?.earliestCalendarDate || !s.latestCalendarDate) { return { html: 'N/A', cls: 'dim' }; }
  const today = new Date().toISOString().slice(0, 10);
  const start = s.earliestCalendarDate;
  const end = s.latestCalendarDate;
  const totalDays = Math.ceil((new Date(end).getTime() - new Date(start).getTime()) / 86400000);

  let status: string; let cls: string;
  if (today < start) {
    const days = Math.ceil((new Date(start).getTime() - Date.now()) / 86400000);
    status = `Future — starts in ${days}d`; cls = 'warn';
  } else if (today > end) {
    const days = Math.ceil((Date.now() - new Date(end).getTime()) / 86400000);
    status = `EXPIRED ${days}d ago`; cls = 'bad';
  } else {
    const elapsed = Math.ceil((Date.now() - new Date(start).getTime()) / 86400000);
    const pct = totalDays > 0 ? Math.round(100 * elapsed / totalDays) : 0;
    status = `Active — ${pct}% through`; cls = 'ok';
  }
  return {
    html: `${esc(start)} → ${esc(end)}<br><span class="note">${esc(totalDays + ' days')}</span><br><span class="${cls}">${esc(status)}</span>`,
    cls,
  };
}

function agenciesCell(r: FeedSourceResult): string {
  const agencies = r.inspect?.agencies ?? [];
  if (agencies.length === 0) { return '<span class="dim">(none)</span>'; }
  const names = agencies.map((a) => esc(a.agencyName));
  const shown = names.slice(0, 8).join('<br>');
  const more = names.length > 8 ? `<br><span class="dim">…+${names.length - 8} more</span>` : '';
  return `<span class="note">${agencies.length} ${agencies.length === 1 ? 'agency' : 'agencies'}</span><br>${shown}${more}`;
}

function routesCell(r: FeedSourceResult): string {
  if (!r.routeTypeSummary.length) { return r.inspect ? '0' : '<span class="dim">N/A</span>'; }
  const total = r.routeTypeSummary.reduce((s, rt) => s + rt.count, 0);
  const breakdown = r.routeTypeSummary
    .map((rt) => `${ROUTE_TYPE_NAMES[rt.routeType] ?? `Type ${rt.routeType}`}: ${rt.count}`)
    .join('<br>');
  return `<strong>${total}</strong><br><span class="note">${breakdown}</span>`;
}

function archiveCell(r: FeedSourceResult): { html: string; cls: string } {
  if (!r.archive) { return { html: '<span class="dim">(no API key)</span>', cls: 'dim' }; }
  if (!r.archive.found) { return { html: '<span class="warn">Not in archive</span>', cls: 'warn' }; }
  const a = r.archive;
  const date = a.fetchedAt ? a.fetchedAt.slice(0, 10) : '?';
  const cal = a.earliestCalendarDate && a.latestCalendarDate
    ? `<br><span class="note">${esc(a.earliestCalendarDate)} → ${esc(a.latestCalendarDate)}</span>` : '';
  return {
    html: `<span class="ok">${esc(a.onestopId ?? '?')}</span><br><span class="note">fetched ${esc(date)}</span>${cal}`,
    cls: 'ok',
  };
}

function issuesCell(r: FeedSourceResult): { html: string; cls: string } {
  if (!r.inspect) { return { html: '<span class="dim">N/A</span>', cls: 'dim' }; }
  if (r.errorCount === 0 && r.warningCount === 0) { return { html: '<span class="ok">None</span>', cls: 'ok' }; }
  const parts: string[] = [];
  if (r.errorCount) { parts.push(`<span class="bad">${r.errorCount} error${r.errorCount !== 1 ? 's' : ''}</span>`); }
  if (r.warningCount) { parts.push(`<span class="warn">${r.warningCount} warning${r.warningCount !== 1 ? 's' : ''}</span>`); }
  return { html: parts.join('<br>'), cls: r.errorCount ? 'bad' : 'warn' };
}

function feedInfoCell(r: FeedSourceResult): string {
  const fi = r.inspect?.feedInfo;
  if (!fi) { return '<span class="dim">(no feed_info.txt)</span>'; }
  const rows: string[] = [];
  if (fi.feedPublisherName) { rows.push(`<span class="note">Publisher</span><br>${esc(fi.feedPublisherName)}`); }
  if (fi.feedVersion) { rows.push(`<span class="note">Version</span><br>${esc(fi.feedVersion)}`); }
  if (fi.feedLang) { rows.push(`<span class="note">Language</span><br>${esc(fi.feedLang)}`); }
  if (fi.feedStartDate || fi.feedEndDate) {
    rows.push(`<span class="note">Declared dates</span><br>${esc(fi.feedStartDate ?? '?')} → ${esc(fi.feedEndDate ?? '?')}`);
  }
  return rows.length ? rows.join('<br>') : '<span class="dim">(empty)</span>';
}

function verdictHtml(verdict: Verdict, preferredIndex?: number): string {
  const cls = `verdict verdict-${verdict.type}`;
  if (verdict.type === 'identical') {
    return `<div class="${cls}">✅ <strong>Identical</strong> — ${esc(verdict.message)}</div>`;
  }
  if (verdict.type === 'one_preferred') {
    return `<div class="${cls}">⭐ <strong>URL ${verdict.preferredIndex + 1} recommended</strong> — ${esc(verdict.reason)}</div>`;
  }
  if (verdict.type === 'differs') {
    return `<div class="${cls}">⚠️ <strong>Sources differ</strong> — ${esc(verdict.message)}</div>`;
  }
  return `<div class="${cls}">❌ <strong>Error</strong> — ${esc(verdict.message)}</div>`;
}

function buildHtml(urls: string[], result: CompareFeedSourcesOutput): string {
  const n = result.results.length;
  const preferred = result.verdict.type === 'one_preferred' ? result.verdict.preferredIndex : -1;

  // Column headers
  const headerCells = result.results.map((r, i) => {
    const cls = i === preferred ? 'col-preferred' : '';
    return `<th class="${cls}" title="${esc(r.url)}">
      <span class="col-label">URL ${i + 1}</span><br>
      <span class="url-short">${esc(shortUrl(r.url))}</span>
    </th>`;
  }).join('');

  // Helper to build a full row
  const row = (label: string, cells: Array<{ html: string; cls?: string } | string>) => {
    const tds = cells.map((c, i) => {
      const colCls = i === preferred ? 'col-preferred' : '';
      const cellCls = typeof c === 'string' ? '' : (c.cls ?? '');
      const html = typeof c === 'string' ? c : c.html;
      return `<td class="${[colCls, cellCls].filter(Boolean).join(' ')}">${html}</td>`;
    }).join('');
    return `<tr><td class="metric-label">${esc(label)}</td>${tds}</tr>`;
  };

  const statusCells = result.results.map((r) =>
    r.error
      ? { html: `❌ <span class="bad">${esc(r.error)}</span>`, cls: 'bad' }
      : { html: '✅ Loaded', cls: 'ok' },
  );

  const sha1s = result.results.map((r) => r.inspect?.summary.sha1 ?? null);
  const validSha1s = sha1s.filter(Boolean);
  const allSame = validSha1s.length === n && new Set(validSha1s).size === 1;
  const sha1Cells = sha1s.map((sha1) => {
    if (!sha1) { return '<span class="dim">N/A</span>'; }
    const short = sha1.slice(0, 16) + '…';
    return allSame
      ? `<span class="mono ok" title="${esc(sha1)}">${esc(short)} <span class="badge-same">IDENTICAL</span></span>`
      : `<span class="mono dim" title="${esc(sha1)}">${esc(short)}</span>`;
  });

  const countCell = (val: number | null) =>
    val === null ? '<span class="dim">N/A</span>' : String(val);

  const rows = [
    row('Status', statusCells),
    row('SHA1', sha1Cells),
    row('Archive', result.results.map(archiveCell)),
    row('Calendar', result.results.map(calendarCell)),
    row('Agencies', result.results.map(agenciesCell)),
    row('Routes', result.results.map(routesCell)),
    row('Stops', result.results.map((r) => countCell(r.inspect?.summary.stopCount ?? null))),
    row('Trips', result.results.map((r) => countCell(r.inspect?.summary.tripCount ?? null))),
    row('feed_info.txt', result.results.map(feedInfoCell)),
    row('Issues', result.results.map(issuesCell)),
  ].join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  :root { --ok: var(--vscode-testing-iconPassed, #73c991); --warn: #cca700; --bad: var(--vscode-testing-iconFailed, #f14c4c); }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px 20px; margin: 0; }
  h2 { font-size: 1em; font-weight: 600; margin: 0 0 4px 0; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 0.88em; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  thead th { padding: 8px 10px; background: var(--vscode-list-hoverBackground); text-align: left; border-bottom: 2px solid var(--vscode-panel-border); font-weight: 600; }
  .col-label { font-size: 0.85em; color: var(--vscode-descriptionForeground); }
  .url-short { font-size: 0.82em; font-family: var(--vscode-editor-font-family, monospace); word-break: break-all; }
  td { padding: 7px 10px; vertical-align: top; border-top: 1px solid var(--vscode-panel-border); }
  .metric-label { font-weight: 600; font-size: 0.82em; text-transform: uppercase; color: var(--vscode-descriptionForeground); white-space: nowrap; width: 110px; }
  .col-preferred { background: color-mix(in srgb, var(--vscode-editor-background) 85%, var(--ok)); }
  thead th.col-preferred { background: color-mix(in srgb, var(--vscode-list-hoverBackground) 70%, var(--ok)); }
  .ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); } .dim { color: var(--vscode-descriptionForeground); }
  .note { font-size: 0.88em; color: var(--vscode-descriptionForeground); }
  .mono { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em; }
  .badge-same { display: inline-block; background: var(--ok); color: #000; font-size: 0.75em; font-weight: 700; padding: 1px 5px; border-radius: 3px; vertical-align: middle; margin-left: 4px; }
  .verdict { padding: 10px 14px; border-radius: 4px; margin-top: 18px; line-height: 1.5; }
  .verdict-identical { background: color-mix(in srgb, var(--vscode-editor-background) 80%, var(--ok)); border-left: 3px solid var(--ok); }
  .verdict-one_preferred { background: color-mix(in srgb, var(--vscode-editor-background) 85%, var(--warn)); border-left: 3px solid var(--warn); }
  .verdict-differs { background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--warn)); border-left: 3px solid var(--warn); }
  .verdict-error { background: color-mix(in srgb, var(--vscode-editor-background) 85%, var(--bad)); border-left: 3px solid var(--bad); }
</style>
</head>
<body>
<h2>GTFS Feed Source Comparison</h2>
<p class="meta">Comparing ${n} alternative data sources for the same service — assessing which is more complete, recent, or active.</p>
<table>
  <thead><tr><th style="width:110px"></th>${headerCells}</tr></thead>
  <tbody>${rows}</tbody>
</table>
${verdictHtml(result.verdict)}
</body>
</html>`;
}

export class GtfsFeedSourceComparisonPanel {
  private static current: GtfsFeedSourceComparisonPanel | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
  ) {
    panel.onDidDispose(() => { GtfsFeedSourceComparisonPanel.current = undefined; });
  }

  static show(urls: string[], result: CompareFeedSourcesOutput): GtfsFeedSourceComparisonPanel {
    if (GtfsFeedSourceComparisonPanel.current) {
      GtfsFeedSourceComparisonPanel.current.panel.webview.html = buildHtml(urls, result);
      GtfsFeedSourceComparisonPanel.current.panel.reveal();
      return GtfsFeedSourceComparisonPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'gtfsFeedSourceComparison',
      'GTFS Feed Source Comparison',
      vscode.ViewColumn.One,
      { enableScripts: false, retainContextWhenHidden: true },
    );
    const instance = new GtfsFeedSourceComparisonPanel(panel);
    panel.webview.html = buildHtml(urls, result);
    GtfsFeedSourceComparisonPanel.current = instance;
    return instance;
  }
}
