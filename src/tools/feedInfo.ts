import { z } from 'zod';

const TRANSITLAND_API_BASE = 'https://transit.land/api/v2/rest';

// eslint-disable-next-line @typescript-eslint/naming-convention
export const FeedInfoInputSchema = z.object({
  feedId: z.string().describe('Transitland feed onestop_id (e.g. f-9q9-caltrain)'),
  apiKey: z.string().optional().describe('Transitland API key. Falls back to TRANSITLAND_API_KEY env var.'),
});

export type FeedInfoInput = z.infer<typeof FeedInfoInputSchema>;

export interface FeedVersion {
  id: number;
  sha1: string;
  fetchedAt: string;
  earliestCalendarDate: string | null;
  latestCalendarDate: string | null;
  url: string;
}

export interface FeedInfoOutput {
  onestopId: string;
  spec: string;
  name: string | null;
  languages: string[] | null;
  tags: Record<string, string>;
  /** Latest fetched version — retained for CodeLens use. */
  latestVersion: FeedVersion | null;
  totalVersions: number;
  /** The 10 most recent versions (includes latestVersion as first entry). */
  recentVersions: FeedVersion[];
  isActive: boolean;
  urls: {
    staticCurrent?: string;
    staticHistoric?: string[];
    staticPlanned?: string[];
    realtimeAlerts?: string;
    realtimeTripUpdates?: string;
    realtimeVehiclePositions?: string;
    gbfsAutoDiscovery?: string;
    mdsProvider?: string;
  };
  license: {
    spdxIdentifier?: string;
    url?: string;
    commercialUseAllowed?: string;
    createDerivedProduct?: string;
    redistributionAllowed?: string;
    shareAlikeOptional?: string;
    useWithoutAttribution?: string;
    attributionText?: string;
    attributionInstructions?: string;
  };
  authorization: {
    type?: string;
    paramName?: string;
    infoUrl?: string;
  };
  /** Current import status from feed_state. Null if not present. */
  feedState: {
    importSuccess: boolean | null;
    importInProgress: boolean | null;
  } | null;
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
  const feedUrls = (feed['urls'] as Record<string, unknown> | undefined) ?? {};
  const feedLicense = (feed['license'] as Record<string, string> | undefined) ?? {};
  const feedAuth = (feed['authorization'] as Record<string, string> | undefined) ?? {};
  const feedStateRaw = (feed['feed_state'] as Record<string, unknown> | null) ?? null;
  const fvImport = feedStateRaw
    ? ((feedStateRaw['feed_version'] as Record<string, unknown> | null)?.['feed_version_gtfs_import'] as Record<string, unknown> | null) ?? null
    : null;

  const today = new Date().toISOString().slice(0, 10);

  const mapVersion = (v: Record<string, unknown>): FeedVersion => ({
    id: (v['id'] as number) ?? 0,
    sha1: String(v['sha1'] ?? ''),
    fetchedAt: String(v['fetched_at'] ?? ''),
    earliestCalendarDate: (v['earliest_calendar_date'] as string | null) ?? null,
    latestCalendarDate: (v['latest_calendar_date'] as string | null) ?? null,
    url: String(v['url'] ?? ''),
  });

  const latestVersion = versions.length > 0 ? mapVersion(versions[0]) : null;
  const recentVersions = versions.slice(0, 10).map(mapVersion);

  const isActive = latestVersion !== null
    && latestVersion.earliestCalendarDate !== null
    && latestVersion.latestCalendarDate !== null
    && latestVersion.earliestCalendarDate <= today
    && today <= latestVersion.latestCalendarDate;

  const strArr = (v: unknown): string[] | undefined => {
    if (!Array.isArray(v)) { return undefined; }
    const filtered = v.filter((x): x is string => typeof x === 'string' && x.length > 0);
    return filtered.length > 0 ? filtered : undefined;
  };

  return {
    onestopId: String(feed['onestop_id'] ?? input.feedId),
    spec: String(feed['spec'] ?? 'unknown'),
    name: (feed['name'] as string | null) ?? null,
    languages: Array.isArray(feed['languages']) ? feed['languages'] as string[] : null,
    tags: (feed['tags'] as Record<string, string> | null) ?? {},
    latestVersion,
    totalVersions: versions.length,
    recentVersions,
    isActive,
    urls: {
      staticCurrent: (feedUrls['static_current'] as string | undefined) || undefined,
      staticHistoric: strArr(feedUrls['static_historic']),
      staticPlanned: strArr(feedUrls['static_planned']),
      realtimeAlerts: (feedUrls['realtime_alerts'] as string | undefined) || undefined,
      realtimeTripUpdates: (feedUrls['realtime_trip_updates'] as string | undefined) || undefined,
      realtimeVehiclePositions: (feedUrls['realtime_vehicle_positions'] as string | undefined) || undefined,
      gbfsAutoDiscovery: (feedUrls['gbfs_auto_discovery'] as string | undefined) || undefined,
      mdsProvider: (feedUrls['mds_provider'] as string | undefined) || undefined,
    },
    license: {
      spdxIdentifier: feedLicense['spdx_identifier'] || undefined,
      url: feedLicense['url'] || undefined,
      commercialUseAllowed: feedLicense['commercial_use_allowed'] || undefined,
      createDerivedProduct: feedLicense['create_derived_product'] || undefined,
      redistributionAllowed: feedLicense['redistribution_allowed'] || undefined,
      shareAlikeOptional: feedLicense['share_alike_optional'] || undefined,
      useWithoutAttribution: feedLicense['use_without_attribution'] || undefined,
      attributionText: feedLicense['attribution_text'] || undefined,
      attributionInstructions: feedLicense['attribution_instructions'] || undefined,
    },
    authorization: {
      type: feedAuth['type'] || undefined,
      paramName: feedAuth['param_name'] || undefined,
      infoUrl: feedAuth['info_url'] || undefined,
    },
    feedState: fvImport ? {
      importSuccess: (fvImport['success'] as boolean | null) ?? null,
      importInProgress: (fvImport['in_progress'] as boolean | null) ?? null,
    } : null,
  };
}
