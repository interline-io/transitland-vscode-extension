import { z } from 'zod';

const TRANSITLAND_API_BASE = 'https://transit.land/api/v2/rest';

// eslint-disable-next-line @typescript-eslint/naming-convention
export const FeedInfoInputSchema = z.object({
  feedId: z.string().describe('Transitland feed onestop_id (e.g. f-9q9-caltrain)'),
  apiKey: z.string().optional().describe('Transitland API key. Falls back to TRANSITLAND_API_KEY env var.'),
});

export type FeedInfoInput = z.infer<typeof FeedInfoInputSchema>;

export interface FeedVersion {
  sha1: string;
  fetchedAt: string;
  earliestCalendarDate: string | null;
  latestCalendarDate: string | null;
}

export interface FeedInfoOutput {
  onestopId: string;
  spec: string;
  latestVersion: FeedVersion | null;
  totalVersions: number;
  isActive: boolean;
  urls: {
    staticCurrent?: string;
    realtimeAlerts?: string;
    realtimeTripUpdates?: string;
    realtimeVehiclePositions?: string;
  };
  license: {
    spdxIdentifier?: string;
    url?: string;
  };
}

export async function runFeedInfo(input: FeedInfoInput): Promise<FeedInfoOutput> {
  const apiKey = input.apiKey?.trim() || process.env.TRANSITLAND_API_KEY || '';
  if (!apiKey) {
    throw new Error('No Transitland API key provided. Set apiKey parameter or TRANSITLAND_API_KEY env var.');
  }

  const url = `${TRANSITLAND_API_BASE}/feeds/${encodeURIComponent(input.feedId)}?apikey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(res.status === 404
      ? `Feed not found: ${input.feedId}`
      : `Transitland API error: HTTP ${res.status}`
    );
  }

  const data = await res.json() as { feeds?: unknown[] };
  const feed = data.feeds?.[0] as Record<string, unknown> | undefined;
  if (!feed) {
    throw new Error(`No data returned for feed: ${input.feedId}`);
  }

  const versions = (feed['feed_versions'] as Array<Record<string, unknown>> | undefined) ?? [];
  const latest = versions[0] ?? null;
  const feedUrls = (feed['urls'] as Record<string, string> | undefined) ?? {};
  const feedLicense = (feed['license'] as Record<string, string> | undefined) ?? {};

  const today = new Date().toISOString().slice(0, 10);
  const latestVersion: FeedVersion | null = latest ? {
    sha1: String(latest['sha1'] ?? ''),
    fetchedAt: String(latest['fetched_at'] ?? ''),
    earliestCalendarDate: (latest['earliest_calendar_date'] as string | null) ?? null,
    latestCalendarDate: (latest['latest_calendar_date'] as string | null) ?? null,
  } : null;

  const isActive = latestVersion !== null
    && latestVersion.earliestCalendarDate !== null
    && latestVersion.latestCalendarDate !== null
    && latestVersion.earliestCalendarDate <= today
    && today <= latestVersion.latestCalendarDate;

  return {
    onestopId: String(feed['onestop_id'] ?? input.feedId),
    spec: String(feed['spec'] ?? 'unknown'),
    latestVersion,
    totalVersions: versions.length,
    isActive,
    urls: {
      staticCurrent: feedUrls['static_current'],
      realtimeAlerts: feedUrls['realtime_alerts'],
      realtimeTripUpdates: feedUrls['realtime_trip_updates'],
      realtimeVehiclePositions: feedUrls['realtime_vehicle_positions'],
    },
    license: {
      spdxIdentifier: feedLicense['spdx_identifier'],
      url: feedLicense['url'],
    },
  };
}
