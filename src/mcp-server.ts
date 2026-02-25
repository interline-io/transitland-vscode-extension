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

const rtInspectSchema = z.object({
  url: z.string().describe('URL or local file path of a GTFS Realtime protobuf feed (.pb) to inspect'),
});

const dmfrFormatSchema = z.object({
  filePath: z.string().describe('Absolute path to a .dmfr.json file to format in-place'),
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
      const lines = [
        `Feed: ${info.onestopId}`,
        `Spec: ${info.spec}`,
        `Active: ${info.isActive}`,
        `Total versions: ${info.totalVersions}`,
        info.latestVersion
          ? `Latest: ${info.latestVersion.earliestCalendarDate} to ${info.latestVersion.latestCalendarDate} (fetched ${info.latestVersion.fetchedAt?.slice(0, 10)})`
          : 'No versions',
        info.urls.staticCurrent ? `Static URL: ${info.urls.staticCurrent}` : null,
        info.license.spdxIdentifier ? `License: ${info.license.spdxIdentifier}` : null,
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
