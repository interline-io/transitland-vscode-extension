/**
 * Transitland MCP Server
 *
 * Standalone stdio MCP server wrapping the transitland CLI.
 *
 * Configure in Claude Code (~/.claude/settings.json):
 *   {
 *     "mcpServers": {
 *       "transitland": {
 *         "command": "node",
 *         "args": ["/path/to/transitland-vscode-extension/out/mcp-server.js"]
 *       }
 *     }
 *   }
 *
 * Environment variables:
 *   TRANSITLAND_BIN       - path to transitland binary (auto-detected if unset)
 *   TRANSITLAND_API_KEY   - Transitland API key for feed info queries
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
// Use Zod v4 sub-path so types align with @modelcontextprotocol/sdk v1.27+
import { z } from 'zod/v4';
import { TransitlandCLI, resolveBinaryPath, CliError } from './cli';
import { runValidate } from './tools/validate';
import { runInspect } from './tools/inspect';
import { runRtInspect } from './tools/rtInspect';
import { runDmfrFormat } from './tools/dmfrFormat';
import { runFeedInfo } from './tools/feedInfo';
import { runNtdSearch, formatNtdAgencies } from './tools/ntdSearch';
import type { NtdSearchInput } from './tools/ntdSearch';
import { runSetField, runAddFeed, runAddOperator, findDmfrFiles } from './tools/dmfrEdit';
import type { SetFieldInput, AddFeedInput, AddOperatorInput } from './tools/dmfrEdit';

// ---------------------------------------------------------------------------
// CLI setup
// ---------------------------------------------------------------------------

const binaryPath = resolveBinaryPath(process.env.TRANSITLAND_BIN);

function getCLI(): TransitlandCLI {
  if (!binaryPath) {
    throw new Error(
      'transitland binary not found. Install via: brew install interline-io/transitland-lib/transitland-lib\n' +
      'Or set TRANSITLAND_BIN env var to the binary path.'
    );
  }
  return new TransitlandCLI({
    binaryPath,
    log: (line) => process.stderr.write(line + '\n'),
  });
}

// ---------------------------------------------------------------------------
// Input schemas (z.object form, required by MCP SDK registerTool)
// ---------------------------------------------------------------------------

const validateSchema = z.object({
  feed: z.string().describe('URL or local file path of a GTFS zip to validate'),
  rtUrls: z.array(z.string()).optional().describe('GTFS-RT feed URLs to pair with the static feed during validation'),
  errorLimit: z.number().int().optional().describe('Max detailed errors per error group (default: 1000)'),
});

const inspectSchema = z.object({
  feed: z.string().describe('URL or local file path of a GTFS zip to inspect'),
  includeServiceLevels: z.boolean().optional().describe('Include per-route service level / calendar coverage details (slower)'),
  includeRouteGeometries: z.boolean().optional().describe('Include route geometries in output'),
});

const feedInfoSchema = z.object({
  feedId: z.string().describe('Transitland feed onestop_id (e.g. f-9q9-caltrain)'),
  apiKey: z.string().optional().describe('Transitland API key. Falls back to TRANSITLAND_API_KEY env var.'),
});

const ntdSearchSchema = z.object({
  query: z.string().describe('Agency name to search (partial match), or a numeric NTD ID (1–5 digits, zero-padding optional)'),
  state: z.string().optional().describe('Two-letter US state code to narrow results (e.g. CA, WA, TX)'),
  limit: z.number().optional().describe('Max agencies to return (default: 10, max: 50)'),
});

const rtInspectSchema = z.object({
  url: z.string().describe('URL or local file path of a GTFS Realtime protobuf feed (.pb) to inspect'),
});

const dmfrFormatSchema = z.object({
  filePath: z.string().describe('Absolute path to a .dmfr.json file to format in-place'),
});

const setFieldSchema = z.object({
  filePath: z.string().describe('Absolute path to a .dmfr.json file'),
  recordType: z.enum(['feed', 'operator']).describe(
    '"feed" to update a feeds[] entry (matched by id), ' +
    '"operator" to update a top-level operators[] entry or a feed-nested operators[] entry.',
  ),
  id: z.string().describe('Feed onestop_id (e.g. f-9q9-caltrain) or operator onestop_id / operator_onestop_id.'),
  field: z.string().describe('Dot-notation field path (e.g. "tags.us_ntd_id", "urls.static_current", "license.spdx_identifier").'),
  value: z.string().nullable().describe('New string value to set, or null to remove the field.'),
});

const yesNoUnknown = z.enum(['yes', 'no', 'unknown']);

const addFeedSchema = z.object({
  filePath: z.string().describe('Absolute path to the .dmfr.json file to add the feed to'),
  feedId: z.string().describe('Feed onestop_id in f-<geohash>-<name> format. Use f-FIXME-<slug> as a placeholder if the geohash is unknown.'),
  spec: z.enum(['gtfs', 'gtfs-rt', 'gbfs', 'mds']).optional().describe('Feed spec. Auto-detected from provided URLs if omitted.'),
  staticUrl: z.string().optional().describe('GTFS/GBFS zip URL → urls.static_current'),
  vehiclePositionsUrl: z.string().optional().describe('GTFS-RT vehicle positions URL → urls.realtime_vehicle_positions'),
  tripUpdatesUrl: z.string().optional().describe('GTFS-RT trip updates URL → urls.realtime_trip_updates'),
  alertsUrl: z.string().optional().describe('GTFS-RT service alerts URL → urls.realtime_alerts'),
  name: z.string().optional().describe('Human-readable feed name. Use only for large aggregated feeds covering many agencies. Omit for ordinary single-agency feeds.'),
  license: z.object({
    spdxIdentifier: z.string().optional(),
    useWithoutAttribution: yesNoUnknown.optional(),
    createDerivedProduct: yesNoUnknown.optional(),
    commercialUseAllowed: yesNoUnknown.optional(),
    redistributionAllowed: yesNoUnknown.optional(),
    shareAlikeOptional: yesNoUnknown.optional(),
    attributionText: z.string().optional(),
    attributionInstructions: z.string().optional(),
  }).optional(),
  authorization: z.object({
    type: z.enum(['header', 'query_param', 'path', 'replace']).optional(),
    paramName: z.string().optional(),
    infoUrl: z.string().optional(),
  }).optional(),
  workspaceRoot: z.string().optional().describe(
    'Root directory to scan for existing .dmfr.json files when checking for duplicate URLs. ' +
    'Defaults to the directory containing filePath. Pass an empty string to skip the duplicate check.',
  ),
});

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'transitland',
  version: '0.3.0',
});

// --- transitland_validate ---------------------------------------------------

server.registerTool(
  'transitland_validate',
  {
    description: 'Validate a GTFS feed from a URL or local file path using the transitland CLI. Returns a structured report with success status, date range, agency/route counts, and any errors.',
    inputSchema: validateSchema,
  },
  async (args) => {
    const { feed, rtUrls, errorLimit } = args as unknown as z.infer<typeof validateSchema>;
    try {
      const cli = getCLI();
      const output = await runValidate(cli, { feed, rtUrls, errorLimit });

      const { summary, errors, warnings } = output;
      const lines = [
        `Result: ${summary.success ? '✓ Valid' : `✗ Invalid${summary.failureReason ? ': ' + summary.failureReason : ''}`}`,
        `SHA1: ${summary.sha1 ?? 'unknown'}`,
        `Date range: ${summary.earliestCalendarDate ?? '?'} to ${summary.latestCalendarDate ?? '?'}`,
        `Errors: ${summary.errorCount}`,
        `Warnings: ${summary.warningCount}`,
        errors.length > 0 ? '\nErrors:\n' + errors.slice(0, 20).map((e) => `  [${e.errorType}] ${e.message}${e.entityId ? ` (${e.entityId})` : ''}`).join('\n') : null,
        warnings.length > 0 ? '\nWarnings:\n' + warnings.slice(0, 20).map((w) => `  [${w.errorType}] ${w.message}${w.entityId ? ` (${w.entityId})` : ''}`).join('\n') : null,
      ].filter(Boolean).join('\n');

      return { content: [{ type: 'text' as const, text: lines }] };
    } catch (err) {
      const msg = err instanceof CliError
        ? `CLI error (exit ${err.exitCode}): ${err.stderr || err.message}`
        : err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  },
);

// --- transitland_inspect ----------------------------------------------------

server.registerTool(
  'transitland_inspect',
  {
    description: 'Inspect the contents of a GTFS feed: agencies, routes, stop count, and service coverage dates. Optionally includes per-route service level calendar and route geometries.',
    inputSchema: inspectSchema,
  },
  async (args) => {
    const { feed, includeServiceLevels, includeRouteGeometries } = args as unknown as z.infer<typeof inspectSchema>;
    try {
      const cli = getCLI();
      const output = await runInspect(cli, { feed, includeServiceLevels, includeRouteGeometries });

      const { summary, feedInfo, agencies, routes, stops, files } = output;
      const agencyList = agencies.map((a) => `  ${a.agencyId}: ${a.agencyName} (${a.agencyTimezone})`).join('\n');
      const routeList = routes.slice(0, 30).map((r) => `  ${r.routeShortName ?? r.routeId}: ${r.routeLongName ?? ''} [${r.agencyId}]`).join('\n');
      const moreRoutes = routes.length > 30 ? `  … and ${routes.length - 30} more routes` : '';
      const coreFiles = ['agency.txt', 'routes.txt', 'trips.txt', 'stop_times.txt', 'stops.txt', 'calendar.txt', 'calendar_dates.txt'];
      const presentFiles = files.filter((f) => f.rows > 0).map((f) => `  ${f.name} (${f.rows.toLocaleString()} rows)`).join('\n');

      const lines = [
        `SHA1: ${summary.sha1 ?? 'unknown'}`,
        `Date range: ${summary.earliestCalendarDate ?? '?'} to ${summary.latestCalendarDate ?? '?'}`,
        summary.timezone ? `Timezone: ${summary.timezone}` : null,
        feedInfo?.feedPublisherName ? `Publisher: ${feedInfo.feedPublisherName}${feedInfo.feedVersion ? ` (${feedInfo.feedVersion})` : ''}` : null,
        feedInfo?.feedLang ? `Feed language: ${feedInfo.feedLang}` : null,
        `Agencies (${summary.agencyCount}):\n${agencyList}`,
        `Routes (${summary.routeCount}):\n${routeList}${moreRoutes ? '\n' + moreRoutes : ''}`,
        summary.stopCount !== null ? `Stops: ${summary.stopCount}` : null,
        summary.tripCount !== null ? `Trips: ${summary.tripCount.toLocaleString()}` : null,
        presentFiles ? `Files with data:\n${presentFiles}` : null,
        stops.length > 0 ? `Stop types: ${[...new Set(stops.map((s) => s.locationType))].sort().map((t) => `${stops.filter((s) => s.locationType === t).length}×type${t}`).join(', ')}` : null,
        output.serviceLevels ? `Service periods: ${output.serviceLevels.length}` : null,
        files.some((f) => !coreFiles.includes(f.name) && f.rows > 0) ? `Extended files: ${files.filter((f) => !coreFiles.includes(f.name) && f.rows > 0).map((f) => f.name).join(', ')}` : null,
      ].filter(Boolean).join('\n\n');

      return { content: [{ type: 'text' as const, text: lines }] };
    } catch (err) {
      const msg = err instanceof CliError
        ? `CLI error (exit ${err.exitCode}): ${err.stderr || err.message}`
        : err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  },
);

// --- transitland_rt_inspect -------------------------------------------------

server.registerTool(
  'transitland_rt_inspect',
  {
    description: 'Inspect a GTFS Realtime feed from a URL or local .pb file. Returns vehicle positions, trip updates, and service alerts.',
    inputSchema: rtInspectSchema,
  },
  async (args) => {
    const { url } = args as unknown as z.infer<typeof rtInspectSchema>;
    try {
      const cli = getCLI();
      const output = await runRtInspect(cli, { url });

      const { header, vehicles, tripUpdates, alerts } = output;
      const ts = header.timestamp ? new Date(header.timestamp * 1000).toISOString() : 'unknown';

      const lines: string[] = [
        `GTFS-RT version: ${header.gtfsRealtimeVersion}`,
        `Incrementality: ${header.incrementality ?? 'unknown'}`,
        `Feed time: ${ts}`,
        `Vehicles: ${vehicles.length}`,
        `Trip updates: ${tripUpdates.length}`,
        `Alerts: ${alerts.length}`,
      ];

      if (vehicles.length > 0) {
        lines.push('\nVehicles (first 10):');
        for (const v of vehicles.slice(0, 10)) {
          const parts = [v.routeId ? `route ${v.routeId}` : null, v.vehicleLabel ?? v.vehicleId, v.latitude !== null ? `${v.latitude.toFixed(4)},${v.longitude!.toFixed(4)}` : null].filter(Boolean);
          lines.push(`  [${v.entityId}] ${parts.join(' | ')}`);
        }
      }

      if (tripUpdates.length > 0) {
        lines.push('\nTrip updates (first 10):');
        for (const t of tripUpdates.slice(0, 10)) {
          const next = t.stopTimeUpdates[0];
          const delay = next?.arrivalDelay ?? next?.departureDelay;
          lines.push(`  [${t.entityId}] route ${t.routeId ?? '?'} trip ${t.tripId ?? '?'}${delay !== null && delay !== undefined ? ` delay ${delay}s` : ''} (${t.stopTimeUpdates.length} updates)`);
        }
      }

      if (alerts.length > 0) {
        lines.push('\nAlerts:');
        for (const a of alerts) {
          lines.push(`  [${a.entityId}] ${a.effect ?? ''} ${a.headerText ?? a.descriptionText ?? ''}`.trim());
        }
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      const msg = err instanceof CliError
        ? `CLI error (exit ${err.exitCode}): ${err.stderr || err.message}`
        : err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  },
);

// --- transitland_feed_info --------------------------------------------------

server.registerTool(
  'transitland_feed_info',
  {
    description: 'Fetch metadata for a Transitland feed by its onestop_id (e.g. f-9q9-caltrain). Returns spec type, active status, date range, version count, and feed URLs.',
    inputSchema: feedInfoSchema,
  },
  async (args) => {
    const { feedId, apiKey } = args as unknown as z.infer<typeof feedInfoSchema>;
    try {
      const info = await runFeedInfo({ feedId, apiKey });
      const tagStr = Object.entries(info.tags).map(([k, v]) => `${k}: ${v}`).join(', ');
      const lines = [
        `Feed: ${info.onestopId}`,
        info.name ? `Name: ${info.name}` : null,
        `Spec: ${info.spec}`,
        `Active: ${info.isActive}`,
        `Total versions: ${info.totalVersions}`,
        info.latestVersion
          ? `Latest: ${info.latestVersion.earliestCalendarDate} to ${info.latestVersion.latestCalendarDate} (fetched ${info.latestVersion.fetchedAt?.slice(0, 10)})`
          : 'No versions',
        info.feedState ? `Import: ${info.feedState.importInProgress ? 'in progress' : info.feedState.importSuccess ? 'success' : 'failed'}` : null,
        info.urls.staticCurrent ? `Static URL: ${info.urls.staticCurrent}` : null,
        tagStr ? `Tags: ${tagStr}` : null,
        info.license.spdxIdentifier ? `License: ${info.license.spdxIdentifier}` : null,
        info.authorization.type ? `Auth: ${info.authorization.type}` : null,
      ].filter(Boolean).join('\n');

      return {
        content: [
          { type: 'text' as const, text: lines },
          { type: 'text' as const, text: '```json\n' + JSON.stringify(info, null, 2) + '\n```' },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  },
);

// --- transitland_ntd_search -------------------------------------------------

server.registerTool(
  'transitland_ntd_search',
  {
    description: 'Search the US National Transit Database (NTD) GTFS Weblinks dataset. ' +
      'Returns matching agencies with their NTD ID (use as operator tags.us_ntd_id), city, state, modes, and GTFS weblinks (candidate static_current URLs). ' +
      'Query by agency name or numeric NTD ID; optionally filter by two-letter state code.',
    inputSchema: ntdSearchSchema,
  },
  async (args) => {
    const input = args as unknown as NtdSearchInput;
    try {
      const agencies = await runNtdSearch(input);
      return { content: [{ type: 'text' as const, text: formatNtdAgencies(agencies) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  },
);

// --- transitland_agencies_in_feed -------------------------------------------

server.registerTool(
  'transitland_agencies_in_feed',
  {
    description: 'List all agencies defined in a GTFS feed (agency.txt), plus a brief feed summary. ' +
      'Use this when setting up operator records or associated_feeds crosslinks in DMFR — it tells you the official agency names, IDs, websites, and timezones ' +
      'without the noise of routes, stops, and files that transitland_inspect returns.',
    inputSchema: z.object({
      feed: z.string().describe('URL or local file path of a GTFS zip'),
    }),
  },
  async (args) => {
    const { feed } = args as unknown as { feed: string };
    const cli = getCLI();
    try {
      const result = await runInspect(cli, { feed });
      const { agencies, summary, feedInfo } = result;
      const lines = [
        `Feed: ${feed}`,
        `SHA1: ${summary.sha1 ?? 'n/a'}`,
        `Calendar: ${summary.earliestCalendarDate ?? '?'} to ${summary.latestCalendarDate ?? '?'}`,
        `Routes: ${summary.routeCount} | Stops: ${summary.stopCount ?? '?'} | Trips: ${summary.tripCount ?? '?'}`,
        feedInfo?.feedPublisherName ? `Publisher: ${feedInfo.feedPublisherName}${feedInfo.feedVersion ? ` (${feedInfo.feedVersion})` : ''}` : null,
        '',
        `Agencies (${agencies.length}):`,
        ...agencies.map((a) => [
          `  ${a.agencyName}${a.agencyId ? ` [agency_id: ${a.agencyId}]` : ''}`,
          a.agencyUrl ? `    website: ${a.agencyUrl}` : null,
          a.agencyTimezone ? `    timezone: ${a.agencyTimezone}` : null,
          a.agencyPhone ? `    phone: ${a.agencyPhone}` : null,
        ].filter(Boolean).join('\n')),
      ].filter((l) => l !== null).join('\n');
      return { content: [{ type: 'text' as const, text: lines }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  },
);

const addOperatorSchema = z.object({
  filePath: z.string().describe('Absolute path to a .dmfr.json file'),
  placement: z.enum(['nested', 'top_level']).describe(
    '"nested" — embed operator inside an existing static feed\'s operators[]; the feed link is implicit. ' +
    '"top_level" — add to root operators[]; must include associated_feeds with at least one feed_onestop_id.',
  ),
  feedId: z.string().optional().describe('Required when placement is "nested". The static feed to nest under.'),
  operatorOnestopId: z.string().describe('Operator onestop_id (o-<geohash>-<name> format).'),
  name: z.string().describe('Official operator name.'),
  shortName: z.string().optional(),
  website: z.string().optional(),
  associatedFeeds: z.array(z.object({
    feedOnestopId: z.string().optional().describe('feed_onestop_id to link (RT feeds, external feeds, or static feed for top_level operators).'),
    gtfsAgencyId: z.string().optional().describe('gtfs_agency_id from agency.txt. Only needed for multi-agency feeds.'),
  })).optional().describe(
    'Omit entirely for single-agency nested operators (link is implicit). ' +
    'For multi-agency nested: one entry with gtfsAgencyId only. ' +
    'For nested + RT: entries with feedOnestopId for each RT feed. ' +
    'For top_level: entries for each linked feed including the static feed.',
  ),
  tags: z.record(z.string(), z.string()).optional(),
});

// --- transitland_add_feed ---------------------------------------------------

server.registerTool(
  'transitland_add_feed',
  {
    description:
      'Add a new feed record to a .dmfr.json file. ' +
      'Provide a feedId (f-<geohash>-<name> format), one or more URLs, and optional license/authorization metadata. ' +
      'Spec is auto-detected: staticUrl only → gtfs; realtime URLs only → gtfs-rt; override with the spec field. ' +
      'Scans existing .dmfr.json files for duplicate URLs before writing and fails fast if any are found. ' +
      'Use name only for large aggregated feeds covering many agencies (e.g. "UK Bus Open Data Service").',
    inputSchema: addFeedSchema,
  },
  async (args) => {
    const raw = args as unknown as AddFeedInput & { workspaceRoot?: string };
    const { workspaceRoot, ...input } = raw as AddFeedInput & { workspaceRoot?: string };
    try {
      // Determine scan root: explicit workspaceRoot > parent dir of target file > skip if empty string
      let scanFiles: string[] = [];
      if (workspaceRoot !== '') {
        const scanRoot = workspaceRoot || path.dirname(input.filePath);
        if (fs.existsSync(scanRoot)) {
          scanFiles = findDmfrFiles(scanRoot);
        }
      }
      const cli = binaryPath ? getCLI() : undefined;
      const output = await runAddFeed(cli, input, scanFiles);
      return {
        content: [{ type: 'text' as const, text: output.success ? output.message : `Error: ${output.message}` }],
        isError: !output.success,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  },
);

// --- transitland_add_operator -----------------------------------------------

server.registerTool(
  'transitland_add_operator',
  {
    description:
      'Add an operator record to a .dmfr.json file. ' +
      'Use placement="nested" to embed the operator inside an existing static (gtfs/gbfs) feed — the feed link is then implicit and no feed_onestop_id is needed in associated_feeds. ' +
      'Use placement="top_level" to add the operator at the root operators[] level — associated_feeds must include at least one feedOnestopId pointing to the static feed. ' +
      'For single-agency nested operators, omit associatedFeeds entirely. ' +
      'For multi-agency feeds, supply gtfsAgencyId (from agency.txt) in the associatedFeeds entry. ' +
      'RT feeds are always linked via associated_feeds feedOnestopId — never nest an operator under a gtfs-rt feed.',
    inputSchema: addOperatorSchema,
  },
  async (args) => {
    const input = args as unknown as AddOperatorInput;
    try {
      const cli = binaryPath ? getCLI() : undefined;
      const output = await runAddOperator(cli, input);
      return {
        content: [{ type: 'text' as const, text: output.success ? output.message : `Error: ${output.message}` }],
        isError: !output.success,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  },
);

// --- transitland_set_field --------------------------------------------------

server.registerTool(
  'transitland_set_field',
  {
    description:
      'Set or remove a single field in a feed or operator record inside a .dmfr.json file. ' +
      'Locate the record by type ("feed" or "operator") and its ID, then specify the field using ' +
      'dot-notation (e.g. "tags.us_ntd_id", "urls.static_current", "license.spdx_identifier"). ' +
      'Pass value=null to remove the field. The file is formatted in-place after the edit.',
    inputSchema: setFieldSchema,
  },
  async (args) => {
    const input = args as unknown as SetFieldInput;
    try {
      const cli = binaryPath ? getCLI() : undefined;
      const output = await runSetField(cli, input);
      return {
        content: [{ type: 'text' as const, text: output.success ? output.message : `Error: ${output.message}` }],
        isError: !output.success,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  },
);

// --- transitland_dmfr_format ------------------------------------------------

server.registerTool(
  'transitland_dmfr_format',
  {
    description: 'Apply the opinionated transitland DMFR format to a .dmfr.json file, saving the result in-place.',
    inputSchema: dmfrFormatSchema,
  },
  async (args) => {
    const { filePath } = args as unknown as z.infer<typeof dmfrFormatSchema>;
    try {
      const cli = getCLI();
      const output = await runDmfrFormat(cli, { filePath });
      return { content: [{ type: 'text' as const, text: output.message }] };
    } catch (err) {
      const msg = err instanceof CliError
        ? `CLI error (exit ${err.exitCode}): ${err.stderr || err.message}`
        : err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('Transitland MCP server running\n');
  if (binaryPath) {
    process.stderr.write(`Using transitland CLI: ${binaryPath}\n`);
  } else {
    process.stderr.write('WARNING: transitland binary not found — CLI tools will fail\n');
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
