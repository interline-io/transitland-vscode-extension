import { z } from 'zod';

const NTD_ODATA_URL = 'https://data.transportation.gov/api/odata/v4/2u7n-ub22?$top=5000';

// eslint-disable-next-line @typescript-eslint/naming-convention
export const NtdSearchInputSchema = z.object({
  query: z.string().describe(
    'Agency name to search, or a numeric NTD ID (1–5 digits, zero-padding optional). ' +
    'All words in the query must appear in the agency name (case-insensitive). ' +
    'NTD uses official legal names, not brand names — try significant words rather than brand names. ' +
    'E.g. "Sound Transit" matches "Central Puget Sound Regional Transit Authority"; ' +
    '"Pierce Transit" matches "Pierce County Transportation Benefit Area Authority"; ' +
    '"King County" matches "King County" (Metro is a brand name, not in NTD). ' +
    'Examples: "San Juan", "Humboldt", "Sound Transit", "Pierce Transit", "1", "00001".',
  ),
  state: z.string().optional().describe('Two-letter US state code to narrow results (e.g. CA, WA, TX, PR).'),
  limit: z.number().int().min(1).max(50).optional().describe('Max agencies to return (default: 10).'),
});

export type NtdSearchInput = z.infer<typeof NtdSearchInputSchema>;

export interface NtdMode {
  mode: string;
  modeName: string;
  modeVoms: number | null;
  tos: string;
}

export interface NtdAgency {
  /** Zero-padded 5-digit NTD ID, e.g. "00001". Use as operator tags.us_ntd_id value. */
  ntdId: string;
  agencyName: string;
  city: string;
  state: string;
  uzaName: string;
  organizationType: string;
  reporterType: string;
  agencyVoms: number | null;
  /** Unique non-empty GTFS weblinks reported to NTD. Candidate static_current URLs. */
  weblinks: string[];
  modes: NtdMode[];
  dateValidated: string | null;
  modifiedDate: string | null;
}

interface ODataRow {
  ntd_id?: string;
  agency_name?: string;
  city?: string;
  state?: string;
  uza_name?: string;
  organization_type?: string;
  reporter_type?: string;
  agency_voms?: number | null;
  mode?: string;
  mode_name?: string;
  mode_voms?: number | null;
  tos?: string;
  weblink?: string | null;
  new_date_validated?: string | null;
  new_modified_date?: string | null;
}

/** The weblink field is serialized as "Some(url)" or null by the OData endpoint. */
function parseWeblink(raw: string | null | undefined): string {
  if (!raw) { return ''; }
  const m = raw.match(/^Some\((.+)\)$/);
  return m ? m[1] : raw;
}

// Module-level cache: fetched once per process lifetime.
let cachedRows: ODataRow[] | null = null;
let fetchPromise: Promise<ODataRow[]> | null = null;

async function fetchAllRows(): Promise<ODataRow[]> {
  if (cachedRows) { return cachedRows; }
  if (fetchPromise) { return fetchPromise; }

  fetchPromise = (async () => {
    const rows: ODataRow[] = [];
    let url: string | null = NTD_ODATA_URL;
    while (url) {
      const res = await fetch(url);
      if (!res.ok) { throw new Error(`NTD OData error: HTTP ${res.status}`); }
      const data = await res.json() as { value: ODataRow[]; '@odata.nextLink'?: string };
      rows.push(...data.value);
      url = data['@odata.nextLink'] ?? null;
    }
    cachedRows = rows;
    return rows;
  })();

  return fetchPromise;
}

function isNtdId(q: string): boolean {
  return /^\d{1,5}$/.test(q.trim());
}

// Generic agency-type words that appear in almost every NTD name and don't
// help narrow a search. We strip these from the query so that e.g.
// "Pierce Transit" → ["pierce"], which matches
// "Pierce County Transportation Benefit Area Authority".
const STOP_WORDS = new Set([
  'transit', 'transportation', 'authority', 'district', 'system',
  'area', 'regional', 'public', 'benefit', 'service', 'services',
  'commission', 'department', 'agency', 'cooperative',
]);

function queryWords(q: string): string[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const significant = words.filter((w) => !STOP_WORDS.has(w));
  // If all words were stop words, fall back to all words (better than empty).
  return significant.length > 0 ? significant : words;
}

function groupByNtdId(rows: ODataRow[]): Map<string, ODataRow[]> {
  const map = new Map<string, ODataRow[]>();
  for (const row of rows) {
    const id = row.ntd_id ?? '';
    if (!map.has(id)) { map.set(id, []); }
    map.get(id)!.push(row);
  }
  return map;
}

function rowsToAgency(ntdId: string, group: ODataRow[]): NtdAgency {
  const first = group[0];
  const weblinks = [...new Set(
    group.map((r) => parseWeblink(r.weblink)).filter((w) => w.length > 0),
  )];
  const modes: NtdMode[] = group
    .filter((r) => r.mode)
    .map((r) => ({
      mode: r.mode ?? '',
      modeName: r.mode_name ?? '',
      modeVoms: r.mode_voms ?? null,
      tos: r.tos ?? '',
    }))
    .filter((m) => m.mode.length > 0);

  return {
    ntdId,
    agencyName: first.agency_name ?? '',
    city: first.city ?? '',
    state: first.state ?? '',
    uzaName: first.uza_name ?? '',
    organizationType: first.organization_type ?? '',
    reporterType: first.reporter_type ?? '',
    agencyVoms: first.agency_voms ?? null,
    weblinks,
    modes,
    dateValidated: first.new_date_validated?.slice(0, 10) ?? null,
    modifiedDate: first.new_modified_date?.slice(0, 10) ?? null,
  };
}

export async function runNtdSearch(input: NtdSearchInput): Promise<NtdAgency[]> {
  const maxAgencies = input.limit ?? 10;
  const q = input.query.trim();
  const stateFilter = input.state?.toUpperCase();

  const allRows = await fetchAllRows();

  let filtered: ODataRow[];
  if (isNtdId(q)) {
    const padded = q.padStart(5, '0');
    filtered = allRows.filter((r) => r.ntd_id === padded);
  } else {
    // Strip generic agency-type words, then require all remaining words to
    // appear somewhere in the agency name or city (case-insensitive).
    // E.g. "Pierce Transit" → ["pierce"], "Sound Transit" → ["sound"].
    const words = queryWords(q);
    filtered = allRows.filter((r) => {
      const haystack = ((r.agency_name ?? '') + ' ' + (r.city ?? '')).toLowerCase();
      return words.every((w) => haystack.includes(w));
    });
  }

  if (stateFilter) {
    filtered = filtered.filter((r) => r.state === stateFilter);
  }

  const grouped = groupByNtdId(filtered);
  const agencies: NtdAgency[] = [];
  for (const [ntdId, group] of grouped) {
    if (agencies.length >= maxAgencies) { break; }
    agencies.push(rowsToAgency(ntdId, group));
  }

  return agencies;
}

export function formatNtdAgencies(agencies: NtdAgency[]): string {
  if (agencies.length === 0) { return 'No NTD agencies found matching that query.'; }
  return agencies.map((a) => {
    const modeStr = a.modes.map((m) => `${m.modeName} (${m.mode}/${m.tos})`).join(', ');
    const lines = [
      `**${a.agencyName}** — NTD ID: \`${a.ntdId}\``,
      `${a.city}, ${a.state} | ${a.uzaName}`,
      a.agencyVoms != null ? `Vehicles (agency total): ${a.agencyVoms}` : null,
      modeStr ? `Modes: ${modeStr}` : null,
      a.weblinks.length > 0 ? `GTFS weblinks:\n${a.weblinks.map((w) => `  - ${w}`).join('\n')}` : 'No GTFS weblinks on file',
      a.dateValidated ? `NTD validated: ${a.dateValidated}` : null,
    ];
    return lines.filter(Boolean).join('\n');
  }).join('\n\n---\n\n');
}
