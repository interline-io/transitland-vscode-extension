import { z } from 'zod';
import { TransitlandCLI } from '../cli';

// eslint-disable-next-line @typescript-eslint/naming-convention
export const RtInspectInputSchema = z.object({
  url: z.string().describe('URL or local file path of a GTFS Realtime protobuf feed (.pb) to inspect'),
});

export type RtInspectInput = z.infer<typeof RtInspectInputSchema>;

export interface RtHeader {
  gtfsRealtimeVersion: string;
  incrementality: string | null;
  timestamp: number | null; // unix seconds (int64 encoded as string in protobuf JSON)
}

export interface RtVehicle {
  entityId: string;
  tripId: string | null;
  routeId: string | null;
  directionId: number | null;
  startTime: string | null;
  startDate: string | null; // YYYYMMDD
  vehicleId: string | null;
  vehicleLabel: string | null;
  latitude: number | null;
  longitude: number | null;
  bearing: number | null;   // degrees, 0=north
  speedMs: number | null;   // meters per second
  currentStopSequence: number | null;
  stopId: string | null;
  occupancyStatus: string | null;
  timestamp: number | null;
}

export interface RtStopTimeUpdate {
  stopSequence: number | null;
  stopId: string | null;
  arrivalDelay: number | null;    // seconds
  departureDelay: number | null;  // seconds
  scheduleRelationship: string | null;
}

export interface RtTripUpdate {
  entityId: string;
  tripId: string | null;
  routeId: string | null;
  directionId: number | null;
  startTime: string | null;
  startDate: string | null;
  vehicleId: string | null;
  stopTimeUpdates: RtStopTimeUpdate[];
}

export interface RtAlert {
  entityId: string;
  cause: string | null;
  effect: string | null;
  headerText: string | null;
  descriptionText: string | null;
  activePeriodStart: number | null;
  activePeriodEnd: number | null;
  routeIds: string[];
  stopIds: string[];
  tripIds: string[];
}

export interface RtInspectOutput {
  url: string;
  header: RtHeader;
  vehicles: RtVehicle[];
  tripUpdates: RtTripUpdate[];
  alerts: RtAlert[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseTs(v: unknown): number | null {
  if (v === null || v === undefined) { return null; }
  const n = Number(v);
  return isNaN(n) || n === 0 ? null : n;
}

function getTranslation(field: unknown): string | null {
  if (!field || typeof field !== 'object') { return null; }
  const f = field as Record<string, unknown>;
  const translations = Array.isArray(f['translation']) ? f['translation'] as Record<string, unknown>[] : [];
  if (translations.length === 0) { return null; }
  const en = translations.find((t) => !t['language'] || String(t['language']).startsWith('en'));
  const t = en ?? translations[0];
  return (t['text'] as string | null) ?? null;
}

function parseStopTimeUpdate(s: Record<string, unknown>): RtStopTimeUpdate {
  const arrival = (s['arrival'] ?? {}) as Record<string, unknown>;
  const departure = (s['departure'] ?? {}) as Record<string, unknown>;
  return {
    stopSequence: s['stop_sequence'] !== null && s['stop_sequence'] !== undefined ? Number(s['stop_sequence']) : null,
    stopId: (s['stop_id'] as string | null) ?? null,
    arrivalDelay: arrival['delay'] !== null && arrival['delay'] !== undefined ? Number(arrival['delay']) : null,
    departureDelay: departure['delay'] !== null && departure['delay'] !== undefined ? Number(departure['delay']) : null,
    scheduleRelationship: (s['schedule_relationship'] as string | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runRtInspect(
  cli: TransitlandCLI,
  input: RtInspectInput,
  signal?: AbortSignal,
): Promise<RtInspectOutput> {
  const args = ['rt-convert', '--format', 'json', input.url];
  const result = await cli.exec(args, signal);
  const raw = JSON.parse(result.stdout) as Record<string, unknown>;

  const hdr = (raw['header'] ?? {}) as Record<string, unknown>;
  const entities = Array.isArray(raw['entity']) ? raw['entity'] as Record<string, unknown>[] : [];

  const vehicles: RtVehicle[] = [];
  const tripUpdates: RtTripUpdate[] = [];
  const alerts: RtAlert[] = [];

  for (const entity of entities) {
    const entityId = String(entity['id'] ?? '');

    if (entity['vehicle']) {
      const v = entity['vehicle'] as Record<string, unknown>;
      const trip = (v['trip'] ?? {}) as Record<string, unknown>;
      const veh = (v['vehicle'] ?? {}) as Record<string, unknown>;
      const pos = (v['position'] ?? {}) as Record<string, unknown>;

      vehicles.push({
        entityId,
        tripId: (trip['trip_id'] as string | null) ?? null,
        routeId: (trip['route_id'] as string | null) ?? null,
        directionId: trip['direction_id'] !== null && trip['direction_id'] !== undefined ? Number(trip['direction_id']) : null,
        startTime: (trip['start_time'] as string | null) ?? null,
        startDate: (trip['start_date'] as string | null) ?? null,
        vehicleId: (veh['id'] as string | null) ?? null,
        vehicleLabel: (veh['label'] as string | null) ?? null,
        latitude: pos['latitude'] !== null && pos['latitude'] !== undefined ? Number(pos['latitude']) : null,
        longitude: pos['longitude'] !== null && pos['longitude'] !== undefined ? Number(pos['longitude']) : null,
        bearing: pos['bearing'] !== null && pos['bearing'] !== undefined ? Number(pos['bearing']) : null,
        speedMs: pos['speed'] !== null && pos['speed'] !== undefined ? Number(pos['speed']) : null,
        currentStopSequence: v['current_stop_sequence'] !== null && v['current_stop_sequence'] !== undefined ? Number(v['current_stop_sequence']) : null,
        stopId: (v['stop_id'] as string | null) ?? null,
        occupancyStatus: (v['occupancy_status'] as string | null) ?? null,
        timestamp: parseTs(v['timestamp']),
      });
    }

    if (entity['trip_update']) {
      const tu = entity['trip_update'] as Record<string, unknown>;
      const trip = (tu['trip'] ?? {}) as Record<string, unknown>;
      const veh = (tu['vehicle'] ?? {}) as Record<string, unknown>;
      const rawUpdates = Array.isArray(tu['stop_time_update']) ? tu['stop_time_update'] as Record<string, unknown>[] : [];

      tripUpdates.push({
        entityId,
        tripId: (trip['trip_id'] as string | null) ?? null,
        routeId: (trip['route_id'] as string | null) ?? null,
        directionId: trip['direction_id'] !== null && trip['direction_id'] !== undefined ? Number(trip['direction_id']) : null,
        startTime: (trip['start_time'] as string | null) ?? null,
        startDate: (trip['start_date'] as string | null) ?? null,
        vehicleId: (veh['id'] as string | null) ?? null,
        stopTimeUpdates: rawUpdates.map(parseStopTimeUpdate),
      });
    }

    if (entity['alert']) {
      const a = entity['alert'] as Record<string, unknown>;
      const activePeriods = Array.isArray(a['active_period']) ? a['active_period'] as Record<string, unknown>[] : [];
      const firstPeriod = activePeriods[0] ?? {};
      const informedEntities = Array.isArray(a['informed_entity']) ? a['informed_entity'] as Record<string, unknown>[] : [];

      const routeIds = [...new Set(
        informedEntities.map((e) => e['route_id'] as string).filter(Boolean),
      )];
      const stopIds = [...new Set(
        informedEntities.map((e) => e['stop_id'] as string).filter(Boolean),
      )];
      const tripIds = [...new Set(
        informedEntities.map((e) => ((e['trip'] ?? {}) as Record<string, unknown>)['trip_id'] as string).filter(Boolean),
      )];

      alerts.push({
        entityId,
        cause: (a['cause'] as string | null) ?? null,
        effect: (a['effect'] as string | null) ?? null,
        headerText: getTranslation(a['header_text']),
        descriptionText: getTranslation(a['description_text']),
        activePeriodStart: parseTs(firstPeriod['start']),
        activePeriodEnd: parseTs(firstPeriod['end']),
        routeIds,
        stopIds,
        tripIds,
      });
    }
  }

  return {
    url: input.url,
    header: {
      gtfsRealtimeVersion: String(hdr['gtfs_realtime_version'] ?? ''),
      incrementality: (hdr['incrementality'] as string | null) ?? null,
      timestamp: parseTs(hdr['timestamp']),
    },
    vehicles,
    tripUpdates,
    alerts,
  };
}
