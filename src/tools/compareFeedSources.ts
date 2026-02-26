import { z } from 'zod';
import { TransitlandCLI } from '../cli';
import { runInspect, type InspectOutput, type Route } from './inspect';

// eslint-disable-next-line @typescript-eslint/naming-convention
export const CompareFeedSourcesInputSchema = z.object({
  urls: z.array(z.string()).min(2).describe(
    'Two or more GTFS feed URLs or local file paths representing alternative data sources for the same service or agency. The goal is to assess which source is more complete, recent, or active — not to diff versions within a single feed lineage.',
  ),
  apiKey: z.string().optional().describe('Transitland API key for archive lookup. Falls back to TRANSITLAND_API_KEY env var.'),
});

export type CompareFeedSourcesInput = z.infer<typeof CompareFeedSourcesInputSchema>;

export interface ArchiveStatus {
  found: boolean;
  onestopId: string | null;
  fetchedAt: string | null;
  earliestCalendarDate: string | null;
  latestCalendarDate: string | null;
  archivedUrl: string | null;
}

export interface RouteTypeSummary {
  routeType: number;
  count: number;
}

export interface FeedSourceResult {
  url: string;
  /** Null on success, error message on failure. */
  error: string | null;
  inspect: InspectOutput | null;
  errorCount: number;
  warningCount: number;
  routeTypeSummary: RouteTypeSummary[];
  /** Null when archive lookup was not attempted (no API key or no SHA1). */
  archive: ArchiveStatus | null;
}

export type Verdict =
  | { type: 'identical'; message: string }
  | { type: 'one_preferred'; preferredIndex: number; reason: string }
  | { type: 'differs'; message: string }
  | { type: 'error'; message: string };

export interface CompareFeedSourcesOutput {
  urls: string[];
  results: FeedSourceResult[];
  verdict: Verdict;
}

// ---------------------------------------------------------------------------
// Archive lookup
// ---------------------------------------------------------------------------

const TRANSITLAND_API_BASE = 'https://transit.land/api/v2/rest';

async function lookupBySha1(sha1: string, apiKey: string): Promise<ArchiveStatus> {
  const notFound: ArchiveStatus = {
    found: false, onestopId: null, fetchedAt: null,
    earliestCalendarDate: null, latestCalendarDate: null, archivedUrl: null,
  };
  try {
    const url = `${TRANSITLAND_API_BASE}/feed_versions/${encodeURIComponent(sha1)}?apikey=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);
    if (!res.ok) { return notFound; }
    const data = await res.json() as { feed_versions?: Array<Record<string, unknown>> };
    const fv = data.feed_versions?.[0];
    if (!fv) { return notFound; }
    const feed = (fv['feed'] ?? {}) as Record<string, unknown>;
    return {
      found: true,
      onestopId: (feed['onestop_id'] as string | null) ?? null,
      fetchedAt: (fv['fetched_at'] as string | null) ?? null,
      earliestCalendarDate: (fv['earliest_calendar_date'] as string | null) ?? null,
      latestCalendarDate: (fv['latest_calendar_date'] as string | null) ?? null,
      archivedUrl: (fv['url'] as string | null) ?? null,
    };
  } catch { return notFound; }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countRouteTypes(routes: Route[]): RouteTypeSummary[] {
  const counts = new Map<number, number>();
  for (const r of routes) { counts.set(r.routeType, (counts.get(r.routeType) ?? 0) + 1); }
  return Array.from(counts.entries())
    .map(([routeType, count]) => ({ routeType, count }))
    .sort((a, b) => a.routeType - b.routeType);
}

function extractIssueCounts(raw: unknown): { errorCount: number; warningCount: number } {
  if (!raw || typeof raw !== 'object') { return { errorCount: 0, warningCount: 0 }; }
  const r = raw as Record<string, unknown>;
  const countIssues = (issues: unknown): number => {
    if (!Array.isArray(issues) || issues.length === 0) { return 0; }
    // Grouped format: { errorType, errors: [{message, entity_id}] }
    if (typeof issues[0] === 'object' && issues[0] !== null && 'errors' in (issues[0] as object)) {
      return issues.reduce((sum, g) => sum + (Array.isArray((g as Record<string, unknown>)['errors']) ? ((g as Record<string, unknown>)['errors'] as unknown[]).length : 0), 0);
    }
    return issues.length;
  };
  return { errorCount: countIssues(r['errors']), warningCount: countIssues(r['warnings']) };
}

function computeVerdict(results: FeedSourceResult[]): Verdict {
  const successful = results.filter((r) => !r.error && r.inspect !== null);

  if (successful.length === 0) {
    return { type: 'error', message: 'All feed sources failed to load.' };
  }
  if (successful.length < results.length) {
    const failed = results.map((r, i) => r.error ? `URL ${i + 1}` : null).filter(Boolean);
    return { type: 'error', message: `${failed.join(', ')} failed to load.` };
  }

  // Identical SHA1 → same content
  const sha1s = results.map((r) => r.inspect?.summary.sha1).filter(Boolean);
  if (sha1s.length === results.length && new Set(sha1s).size === 1) {
    return { type: 'identical', message: 'All sources serve identical content (same SHA1). Any URL will work equally well.' };
  }

  // Most recent calendar coverage wins
  const withDates = results
    .map((r, i) => ({ index: i, date: r.inspect?.summary.latestCalendarDate ?? '' }))
    .filter((x) => x.date)
    .sort((a, b) => b.date.localeCompare(a.date));

  if (withDates.length >= 2 && withDates[0].date !== withDates[1].date) {
    return {
      type: 'one_preferred',
      preferredIndex: withDates[0].index,
      reason: `URL ${withDates[0].index + 1} has more recent calendar coverage (ends ${withDates[0].date} vs ${withDates[1].date}).`,
    };
  }

  return {
    type: 'differs',
    message: 'Sources have different content but similar calendar coverage. Review agencies, routes, and stop counts above to determine which best represents the service.',
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runCompareFeedSources(
  cli: TransitlandCLI,
  input: CompareFeedSourcesInput,
  signal?: AbortSignal,
): Promise<CompareFeedSourcesOutput> {
  const apiKey = input.apiKey?.trim() || process.env.TRANSITLAND_API_KEY || '';

  // Inspect all URLs in parallel (service levels for calendar coverage data)
  const results = await Promise.all(input.urls.map(async (url): Promise<FeedSourceResult> => {
    try {
      const inspect = await runInspect(cli, { feed: url, includeServiceLevels: true }, signal);
      const { errorCount, warningCount } = extractIssueCounts(inspect.raw);
      return {
        url, error: null, inspect, errorCount, warningCount,
        routeTypeSummary: countRouteTypes(inspect.routes),
        archive: null,
      };
    } catch (err) {
      return {
        url, error: err instanceof Error ? err.message : String(err),
        inspect: null, errorCount: 0, warningCount: 0, routeTypeSummary: [], archive: null,
      };
    }
  }));

  // Archive lookups in parallel
  if (apiKey) {
    await Promise.all(results.map(async (r) => {
      if (r.inspect?.summary.sha1) {
        r.archive = await lookupBySha1(r.inspect.summary.sha1, apiKey);
      }
    }));
  }

  return { urls: input.urls, results, verdict: computeVerdict(results) };
}
