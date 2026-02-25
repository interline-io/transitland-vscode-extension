import { z } from 'zod';
import { TransitlandCLI } from '../cli';

// eslint-disable-next-line @typescript-eslint/naming-convention
export const InspectInputSchema = z.object({
  feed: z.string().describe('URL or local file path of a GTFS zip to inspect'),
  includeServiceLevels: z.boolean().optional().describe('Include per-route service level details (slower, adds calendar coverage data)'),
  includeRouteGeometries: z.boolean().optional().describe('Include route geometries in output'),
});

export type InspectInput = z.infer<typeof InspectInputSchema>;

export interface Agency {
  agencyId: string;
  agencyName: string;
  agencyUrl: string;
  agencyTimezone: string;
  agencyLang: string | null;
  agencyPhone: string | null;
}

export interface Route {
  routeId: string;
  agencyId: string;
  routeShortName: string | null;
  routeLongName: string | null;
  routeType: number;
  routeColor: string | null;
  routeTextColor: string | null;
  geometry: unknown | null;
}

export interface Stop {
  stopId: string;
  stopName: string;
  stopCode: string | null;
  locationType: number; // 0=Stop, 1=Station, 2=Entrance/Exit, 3=Generic Node, 4=Boarding Area
  parentStation: string | null;
  stopLat: number | null;
  stopLon: number | null;
  wheelchairBoarding: number; // 0=unknown, 1=accessible, 2=not accessible
  stopTimezone: string | null;
  zoneId: string | null;
}

export interface FeedInfo {
  feedPublisherName: string | null;
  feedPublisherUrl: string | null;
  feedLang: string | null;
  feedVersion: string | null;
  feedStartDate: string | null;
  feedEndDate: string | null;
  feedContactEmail: string | null;
  feedContactUrl: string | null;
}

export interface GtfsFile {
  name: string;
  rows: number;
  size: number; // bytes
  csvlike: boolean;
}

export interface ServiceLevel {
  startDate: string;
  endDate: string;
  monday: number;
  tuesday: number;
  wednesday: number;
  thursday: number;
  friday: number;
  saturday: number;
  sunday: number;
}

export interface InspectOutput {
  raw: unknown;
  summary: {
    sha1: string | null;
    earliestCalendarDate: string | null;
    latestCalendarDate: string | null;
    agencyCount: number;
    routeCount: number;
    stopCount: number | null;
    tripCount: number | null;
    timezone: string | null;
  };
  feedInfo: FeedInfo | null;
  agencies: Agency[];
  routes: Route[];
  stops: Stop[];
  files: GtfsFile[];
  serviceLevels: ServiceLevel[] | null;
}

function parseAgency(a: Record<string, unknown>): Agency {
  return {
    agencyId: String(a['agency_id'] ?? ''),
    agencyName: String(a['agency_name'] ?? ''),
    agencyUrl: String(a['agency_url'] ?? ''),
    agencyTimezone: String(a['agency_timezone'] ?? ''),
    agencyLang: (a['agency_lang'] as string | null) ?? null,
    agencyPhone: (a['agency_phone'] as string | null) ?? null,
  };
}

function parseRoute(r: Record<string, unknown>): Route {
  return {
    routeId: String(r['route_id'] ?? ''),
    agencyId: String(r['agency_id'] ?? ''),
    routeShortName: (r['route_short_name'] as string | null) ?? null,
    routeLongName: (r['route_long_name'] as string | null) ?? null,
    routeType: Number(r['route_type'] ?? 3),
    routeColor: (r['route_color'] as string | null) ?? null,
    routeTextColor: (r['route_text_color'] as string | null) ?? null,
    geometry: r['geometry'] ?? null,
  };
}

function parseStop(s: Record<string, unknown>): Stop {
  return {
    stopId: String(s['stop_id'] ?? ''),
    stopName: String(s['stop_name'] ?? ''),
    stopCode: (s['stop_code'] as string | null) ?? null,
    locationType: Number(s['location_type'] ?? 0),
    parentStation: (s['parent_station'] as string | null) ?? null,
    stopLat: s['stop_lat'] !== null && s['stop_lat'] !== undefined ? Number(s['stop_lat']) : null,
    stopLon: s['stop_lon'] !== null && s['stop_lon'] !== undefined ? Number(s['stop_lon']) : null,
    wheelchairBoarding: Number(s['wheelchair_boarding'] ?? 0),
    stopTimezone: (s['stop_timezone'] as string | null) ?? null,
    zoneId: (s['zone_id'] as string | null) ?? null,
  };
}

function parseFeedInfo(f: Record<string, unknown>): FeedInfo {
  return {
    feedPublisherName: (f['feed_publisher_name'] as string | null) ?? null,
    feedPublisherUrl: (f['feed_publisher_url'] as string | null) ?? null,
    feedLang: (f['feed_lang'] as string | null) ?? null,
    feedVersion: (f['feed_version'] as string | null) ?? null,
    feedStartDate: (f['feed_start_date'] as string | null) ?? null,
    feedEndDate: (f['feed_end_date'] as string | null) ?? null,
    feedContactEmail: (f['feed_contact_email'] as string | null) ?? null,
    feedContactUrl: (f['feed_contact_url'] as string | null) ?? null,
  };
}

function parseGtfsFile(f: Record<string, unknown>): GtfsFile {
  return {
    name: String(f['name'] ?? ''),
    rows: Number(f['rows'] ?? 0),
    size: Number(f['size'] ?? 0),
    csvlike: Boolean(f['csvlike']),
  };
}

function parseServiceLevel(s: Record<string, unknown>): ServiceLevel {
  return {
    startDate: String(s['start_date'] ?? ''),
    endDate: String(s['end_date'] ?? ''),
    monday: Number(s['monday'] ?? 0),
    tuesday: Number(s['tuesday'] ?? 0),
    wednesday: Number(s['wednesday'] ?? 0),
    thursday: Number(s['thursday'] ?? 0),
    friday: Number(s['friday'] ?? 0),
    saturday: Number(s['saturday'] ?? 0),
    sunday: Number(s['sunday'] ?? 0),
  };
}

export async function runInspect(
  cli: TransitlandCLI,
  input: InspectInput,
  signal?: AbortSignal,
): Promise<InspectOutput> {
  const args = ['validate', '-o', '-', '--include-entities'];

  if (input.includeServiceLevels) { args.push('--include-service-levels'); }
  if (input.includeRouteGeometries) { args.push('--include-route-geometries'); }

  args.push(input.feed);

  const result = await cli.exec(args, signal);
  const raw = JSON.parse(result.stdout) as Record<string, unknown>;
  const details = (raw['details'] ?? {}) as Record<string, unknown>;

  const rawAgencies = Array.isArray(details['agencies']) ? details['agencies'] as Record<string, unknown>[] : [];
  const rawRoutes = Array.isArray(details['routes']) ? details['routes'] as Record<string, unknown>[] : [];
  const rawStops = Array.isArray(details['stops']) ? details['stops'] as Record<string, unknown>[] : [];
  const rawFiles = Array.isArray(details['files']) ? details['files'] as Record<string, unknown>[] : [];
  const rawServiceLevels = Array.isArray(details['service_levels']) ? details['service_levels'] as Record<string, unknown>[] : null;
  const rawFeedInfos = Array.isArray(details['feed_infos']) ? details['feed_infos'] as Record<string, unknown>[] : [];

  const files = rawFiles.map(parseGtfsFile);
  const tripFile = files.find((f) => f.name === 'trips.txt');

  return {
    raw,
    summary: {
      sha1: (details['sha1'] as string | null) ?? null,
      earliestCalendarDate: (details['earliest_calendar_date'] as string | null) ?? null,
      latestCalendarDate: (details['latest_calendar_date'] as string | null) ?? null,
      agencyCount: rawAgencies.length,
      routeCount: rawRoutes.length,
      stopCount: rawStops.length > 0 ? rawStops.length : null,
      tripCount: tripFile ? tripFile.rows : null,
      timezone: (details['timezone'] as string | null) ?? null,
    },
    feedInfo: rawFeedInfos.length > 0 ? parseFeedInfo(rawFeedInfos[0]) : null,
    agencies: rawAgencies.map(parseAgency),
    routes: rawRoutes.map(parseRoute),
    stops: rawStops.map(parseStop),
    files,
    serviceLevels: rawServiceLevels ? rawServiceLevels.map(parseServiceLevel) : null,
  };
}
