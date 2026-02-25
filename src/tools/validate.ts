import { z } from 'zod';
import { TransitlandCLI } from '../cli';

// eslint-disable-next-line @typescript-eslint/naming-convention
export const ValidateInputSchema = z.object({
  feed: z.string().describe('URL or local file path of a GTFS zip to validate'),
  rtUrls: z.array(z.string()).optional().describe('GTFS-RT feed URLs to pair with the static feed during validation'),
  errorLimit: z.number().int().optional().describe('Max detailed errors per error group (default: 1000)'),
});

export type ValidateInput = z.infer<typeof ValidateInputSchema>;

export interface ValidationError {
  errorType: string;
  message: string;
  entityId: string | null;
  filename: string | null;
}

export interface RtEntityCounts {
  alert: number;
  tripUpdate: number;
  vehicle: number;
}

export interface RtRouteStat {
  agencyId: string;
  routeId: string;
  tripScheduledCount: number;
  tripScheduledMatched: number;
  tripScheduledNotMatched: number;
  tripRtCount: number;
  tripRtMatched: number;
  tripRtNotMatched: number;
}

export interface RtFeedResult {
  url: string;
  entityCounts: RtEntityCounts;
  /** Per-route stats (trip_update_stats or vehicle_position_stats), excluding the catch-all empty-route entry. */
  routeStats: RtRouteStat[];
  /** Aggregate totals computed from routeStats. */
  totals: {
    tripScheduledCount: number;
    tripScheduledMatched: number;
    tripScheduledNotMatched: number;
    tripRtCount: number;
    tripRtMatched: number;
    tripRtNotMatched: number;
  };
}

export interface ValidateOutput {
  raw: unknown;
  includesRt: boolean;
  summary: {
    success: boolean;
    failureReason: string | null;
    sha1: string | null;
    earliestCalendarDate: string | null;
    latestCalendarDate: string | null;
    errorCount: number;
    warningCount: number;
  };
  errors: ValidationError[];
  warnings: ValidationError[];
  realtimeFeeds: RtFeedResult[];
}

/**
 * Parse errors/warnings from either format:
 * - Array (old format): [{error_type, message, entity_id, filename}, ...]
 * - Object (new format): {"file::Type:": {error_type, filename, errors: [{message, entity_id}, ...]}}
 */
function parseIssues(raw: unknown): ValidationError[] {
  if (Array.isArray(raw)) {
    return raw.map((item) => {
      const i = item as Record<string, unknown>;
      return {
        errorType: String(i['error_type'] ?? i['level'] ?? i['type'] ?? 'unknown'),
        message: String(i['message'] ?? JSON.stringify(i)),
        entityId: (i['entity_id'] as string | null) ?? null,
        filename: (i['filename'] as string | null) ?? null,
      };
    });
  }
  if (raw && typeof raw === 'object') {
    const result: ValidationError[] = [];
    for (const group of Object.values(raw as Record<string, unknown>)) {
      const g = group as Record<string, unknown>;
      const errorType = String(g['error_type'] ?? 'unknown');
      const filename = (g['filename'] as string | null) ?? null;
      const instances = Array.isArray(g['errors']) ? g['errors'] as Record<string, unknown>[] : [];
      for (const inst of instances) {
        result.push({
          errorType,
          message: String(inst['message'] ?? JSON.stringify(inst)),
          entityId: (inst['entity_id'] as string | null) ?? null,
          filename,
        });
      }
    }
    return result;
  }
  return [];
}

export async function runValidate(
  cli: TransitlandCLI,
  input: ValidateInput,
  signal?: AbortSignal,
): Promise<ValidateOutput> {
  const args = ['validate', '-o', '-', '--best-practices'];

  if (input.errorLimit !== undefined) { args.push('--error-limit', String(input.errorLimit)); }
  for (const rt of input.rtUrls ?? []) { args.push('--rt', rt); }

  args.push(input.feed);

  const result = await cli.exec(args, signal);
  const raw = JSON.parse(result.stdout) as Record<string, unknown>;

  const details = (raw['details'] ?? {}) as Record<string, unknown>;
  const errors = parseIssues(raw['errors']);
  const warnings = parseIssues(raw['warnings']);

  const rawRealtime = Array.isArray(details['realtime']) ? details['realtime'] as Record<string, unknown>[] : [];
  const realtimeFeeds: RtFeedResult[] = rawRealtime.map((rt) => {
    const counts = (rt['entity_counts'] ?? {}) as Record<string, unknown>;
    const rawStats = (
      Array.isArray(rt['trip_update_stats']) ? rt['trip_update_stats'] :
      Array.isArray(rt['vehicle_position_stats']) ? rt['vehicle_position_stats'] : []
    ) as Record<string, unknown>[];

    // Skip the catch-all entry with empty route_id
    const routeStats: RtRouteStat[] = rawStats
      .filter((s) => s['route_id'] !== '')
      .map((s) => ({
        agencyId: String(s['agency_id'] ?? ''),
        routeId: String(s['route_id'] ?? ''),
        tripScheduledCount: Number(s['trip_scheduled_count'] ?? 0),
        tripScheduledMatched: Number(s['trip_scheduled_matched'] ?? 0),
        tripScheduledNotMatched: Number(s['trip_scheduled_not_matched'] ?? 0),
        tripRtCount: Number(s['trip_rt_count'] ?? 0),
        tripRtMatched: Number(s['trip_rt_matched'] ?? 0),
        tripRtNotMatched: Number(s['trip_rt_not_matched'] ?? 0),
      }));

    const totals = routeStats.reduce(
      (acc, s) => ({
        tripScheduledCount: acc.tripScheduledCount + s.tripScheduledCount,
        tripScheduledMatched: acc.tripScheduledMatched + s.tripScheduledMatched,
        tripScheduledNotMatched: acc.tripScheduledNotMatched + s.tripScheduledNotMatched,
        tripRtCount: acc.tripRtCount + s.tripRtCount,
        tripRtMatched: acc.tripRtMatched + s.tripRtMatched,
        tripRtNotMatched: acc.tripRtNotMatched + s.tripRtNotMatched,
      }),
      { tripScheduledCount: 0, tripScheduledMatched: 0, tripScheduledNotMatched: 0, tripRtCount: 0, tripRtMatched: 0, tripRtNotMatched: 0 },
    );

    return {
      url: String(rt['url'] ?? ''),
      entityCounts: {
        alert: Number(counts['alert'] ?? 0),
        tripUpdate: Number(counts['trip_update'] ?? 0),
        vehicle: Number(counts['vehicle'] ?? 0),
      },
      routeStats,
      totals,
    };
  });

  return {
    raw,
    includesRt: Boolean(raw['includes_rt']),
    summary: {
      success: Boolean(raw['success']),
      failureReason: (raw['failure_reason'] as string | null) ?? null,
      sha1: (details['sha1'] as string | null) ?? null,
      earliestCalendarDate: (details['earliest_calendar_date'] as string | null) ?? null,
      latestCalendarDate: (details['latest_calendar_date'] as string | null) ?? null,
      errorCount: errors.length,
      warningCount: warnings.length,
    },
    errors,
    warnings,
    realtimeFeeds,
  };
}
