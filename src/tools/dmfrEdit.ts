import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { TransitlandCLI } from '../cli';
import { runDmfrFormat } from './dmfrFormat';

// ---------------------------------------------------------------------------
// transitland_set_field
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/naming-convention
export const SetFieldInputSchema = z.object({
  filePath: z.string().describe('Absolute path to a .dmfr.json file'),
  recordType: z.enum(['feed', 'operator']).describe(
    '"feed" to update a feeds[] entry (matched by id), ' +
    '"operator" to update a top-level operators[] entry or a feed-nested operators[] entry (matched by onestop_id / operator_onestop_id).',
  ),
  id: z.string().describe(
    'For recordType "feed": the feed onestop_id (e.g. f-9q9-caltrain). ' +
    'For recordType "operator": the operator onestop_id or operator_onestop_id.',
  ),
  field: z.string().describe(
    'Dot-notation path to the field to set or remove. ' +
    'Examples: "tags.us_ntd_id", "urls.static_current", "license.spdx_identifier", "name".',
  ),
  value: z.string().nullable().describe('New string value to set, or null to remove the field.'),
});

export type SetFieldInput = z.infer<typeof SetFieldInputSchema>;

export interface SetFieldOutput {
  success: boolean;
  message: string;
}

/** Set or delete a value at a dot-notation path inside a plain object. */
function setDotPath(
  obj: Record<string, unknown>,
  dotPath: string,
  value: string | null,
): void {
  const parts = dotPath.split('.');
  let cur: Record<string, unknown> = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (typeof cur[key] !== 'object' || cur[key] === null || Array.isArray(cur[key])) {
      if (value === null) { return; } // path doesn't exist, nothing to delete
      cur[key] = {};
    }
    cur = cur[key] as Record<string, unknown>;
  }

  const last = parts[parts.length - 1];
  if (value === null) {
    delete cur[last];
  } else {
    cur[last] = value;
  }
}

/**
 * Set or remove a field in a DMFR feed or operator record, then format the file.
 *
 * @param cli - TransitlandCLI instance for post-edit formatting. If undefined, formatting is skipped.
 * @param input - Parameters (filePath, recordType, id, field, value).
 * @param signal - Optional AbortSignal for the format step.
 */
export async function runSetField(
  cli: TransitlandCLI | undefined,
  input: SetFieldInput,
  signal?: AbortSignal,
): Promise<SetFieldOutput> {
  if (!fs.existsSync(input.filePath)) {
    return { success: false, message: `File not found: ${input.filePath}` };
  }

  let dmfr: { feeds?: Record<string, unknown>[]; operators?: Record<string, unknown>[] };
  try {
    dmfr = JSON.parse(fs.readFileSync(input.filePath, 'utf8'));
  } catch (err) {
    return { success: false, message: `Cannot parse JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  let found = false;

  if (input.recordType === 'feed') {
    const feeds = (dmfr.feeds ?? []) as Record<string, unknown>[];
    const feed = feeds.find((f) => f['id'] === input.id);
    if (!feed) {
      return { success: false, message: `Feed "${input.id}" not found in ${input.filePath}` };
    }
    setDotPath(feed, input.field, input.value);
    found = true;
  } else {
    // Search top-level operators first
    const topOps = (dmfr.operators ?? []) as Record<string, unknown>[];
    const topOp = topOps.find(
      (op) => op['operator_onestop_id'] === input.id || op['onestop_id'] === input.id,
    );
    if (topOp) {
      setDotPath(topOp, input.field, input.value);
      found = true;
    }

    // Then search feed-nested operators
    if (!found) {
      for (const feed of ((dmfr.feeds ?? []) as Record<string, unknown>[])) {
        const nestedOps = Array.isArray(feed['operators'])
          ? (feed['operators'] as Record<string, unknown>[])
          : [];
        const op = nestedOps.find((o) => o['onestop_id'] === input.id);
        if (op) {
          setDotPath(op, input.field, input.value);
          found = true;
          break;
        }
      }
    }

    if (!found) {
      return { success: false, message: `Operator "${input.id}" not found in ${input.filePath}` };
    }
  }

  // Write the modified JSON back
  try {
    fs.writeFileSync(input.filePath, JSON.stringify(dmfr, null, 2) + '\n', 'utf8');
  } catch (err) {
    return { success: false, message: `Write failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Normalize with `transitland dmfr format --save` (best-effort; failure is non-fatal)
  if (cli) {
    try {
      await runDmfrFormat(cli, { filePath: input.filePath }, signal);
    } catch {
      // formatting failure does not roll back the edit
    }
  }

  const action = input.value === null
    ? `removed field "${input.field}"`
    : `set "${input.field}" = "${input.value}"`;
  return {
    success: true,
    message: `Updated ${input.recordType} "${input.id}" in ${input.filePath}: ${action}`,
  };
}

// ---------------------------------------------------------------------------
// transitland_add_feed — shared helpers
// ---------------------------------------------------------------------------

export interface DuplicateMatch {
  /** Absolute path to the file containing the duplicate URL. */
  file: string;
  /** Feed ID of the feed that already has this URL. */
  feedId: string;
  /** DMFR urls field name (e.g. static_current, realtime_vehicle_positions). */
  field: string;
  /** The duplicate URL. */
  url: string;
}

/** Recursively find all *.dmfr.json files under `dir`, up to `maxDepth` levels deep. */
export function findDmfrFiles(dir: string, maxDepth = 3): string[] {
  const results: string[] = [];
  function walk(current: string, depth: number) {
    if (depth > maxDepth) { return; }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        walk(path.join(current, entry.name), depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.dmfr.json')) {
        results.push(path.join(current, entry.name));
      }
    }
  }
  walk(dir, 0);
  return results;
}

/**
 * Scan a list of .dmfr.json files for any of the given URLs.
 * Optionally exclude one file (the target file being written to, to avoid self-match).
 */
export function scanForDuplicateUrls(
  filePaths: string[],
  urlsToCheck: string[],
  excludeFilePath?: string,
): DuplicateMatch[] {
  const urlSet = new Set(urlsToCheck.filter(Boolean));
  if (urlSet.size === 0) { return []; }

  const results: DuplicateMatch[] = [];
  for (const filePath of filePaths) {
    if (excludeFilePath && path.resolve(filePath) === path.resolve(excludeFilePath)) { continue; }
    let dmfr: { feeds?: Record<string, unknown>[] };
    try {
      dmfr = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue;
    }
    for (const feed of (dmfr.feeds ?? [])) {
      const feedId = String(feed['id'] ?? '');
      const urls = (feed['urls'] ?? {}) as Record<string, unknown>;
      for (const [field, val] of Object.entries(urls)) {
        const candidates = typeof val === 'string' ? [val] : Array.isArray(val) ? val.filter((v): v is string => typeof v === 'string') : [];
        for (const candidate of candidates) {
          if (urlSet.has(candidate)) {
            results.push({ file: filePath, feedId, field, url: candidate });
          }
        }
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// transitland_add_feed
// ---------------------------------------------------------------------------

const yesNoUnknown = z.enum(['yes', 'no', 'unknown']);

// eslint-disable-next-line @typescript-eslint/naming-convention
export const AddFeedInputSchema = z.object({
  filePath: z.string().describe('Absolute path to the .dmfr.json file to add the feed to'),
  feedId: z.string().describe(
    'Feed onestop_id in f-<geohash>-<name> format (e.g. f-9q9-caltrain). ' +
    'Use f-FIXME-<slug> as a placeholder if the geohash is unknown.',
  ),
  spec: z.enum(['gtfs', 'gtfs-rt', 'gbfs', 'mds']).optional().describe(
    'Feed spec. Auto-detected from provided URLs if omitted: ' +
    'staticUrl only → gtfs; any realtime URL only → gtfs-rt.',
  ),
  staticUrl: z.string().optional().describe('GTFS/GBFS zip URL → urls.static_current'),
  vehiclePositionsUrl: z.string().optional().describe('GTFS-RT vehicle positions URL → urls.realtime_vehicle_positions'),
  tripUpdatesUrl: z.string().optional().describe('GTFS-RT trip updates URL → urls.realtime_trip_updates'),
  alertsUrl: z.string().optional().describe('GTFS-RT service alerts URL → urls.realtime_alerts'),
  name: z.string().optional().describe(
    'Human-readable feed name. Use only for large aggregated feeds that cover many agencies ' +
    '(e.g. "UK Bus Open Data Service"). Omit for ordinary single-agency feeds.',
  ),
  license: z.object({
    spdxIdentifier: z.string().optional().describe('SPDX license code, e.g. CC-BY-4.0, ODbL-1.0, CC0-1.0'),
    useWithoutAttribution: yesNoUnknown.optional(),
    createDerivedProduct: yesNoUnknown.optional(),
    commercialUseAllowed: yesNoUnknown.optional(),
    redistributionAllowed: yesNoUnknown.optional(),
    shareAlikeOptional: yesNoUnknown.optional(),
    attributionText: z.string().optional(),
    attributionInstructions: z.string().optional(),
  }).optional().describe('License metadata for this feed'),
  authorization: z.object({
    type: z.enum(['header', 'query_param', 'path', 'replace']).optional().describe('How the token is passed'),
    paramName: z.string().optional().describe('Header or query parameter name'),
    infoUrl: z.string().optional().describe('URL where users can obtain credentials'),
  }).optional().describe('Authorization required to download this feed'),
});

export type AddFeedInput = z.infer<typeof AddFeedInputSchema>;

export interface AddFeedOutput {
  success: boolean;
  message: string;
  /** Present when the tool fails because a URL already exists elsewhere. */
  duplicates?: DuplicateMatch[];
}

/**
 * Add a new feed record to a .dmfr.json file.
 *
 * Duplicate URL detection is the caller's responsibility: pass `scanFiles` as a list
 * of absolute .dmfr.json paths to scan before writing (pass `[]` to skip the check).
 *
 * @param cli           - TransitlandCLI for post-write formatting; undefined skips formatting.
 * @param input         - Feed fields (feedId, spec/URLs, optional metadata).
 * @param scanFiles     - .dmfr.json files to scan for duplicate URLs before writing.
 * @param signal        - AbortSignal forwarded to the format step.
 */
export async function runAddFeed(
  cli: TransitlandCLI | undefined,
  input: AddFeedInput,
  scanFiles: string[],
  signal?: AbortSignal,
): Promise<AddFeedOutput> {
  // --- Resolve spec ---
  const hasStatic = !!input.staticUrl;
  const hasRt = !!(input.vehiclePositionsUrl || input.tripUpdatesUrl || input.alertsUrl);

  let spec = input.spec;
  if (!spec) {
    if (hasStatic && !hasRt) { spec = 'gtfs'; }
    else if (hasRt && !hasStatic) { spec = 'gtfs-rt'; }
    else if (hasStatic && hasRt) { spec = 'gtfs'; } // static takes precedence; RT should be a separate record
    else {
      return { success: false, message: 'Provide at least one URL (staticUrl or a realtime URL), or set spec explicitly.' };
    }
  }

  // --- Duplicate URL check across the workspace ---
  const allUrls = [input.staticUrl, input.vehiclePositionsUrl, input.tripUpdatesUrl, input.alertsUrl].filter((u): u is string => !!u);
  if (scanFiles.length > 0) {
    const dupes = scanForDuplicateUrls(scanFiles, allUrls, input.filePath);
    if (dupes.length > 0) {
      const detail = dupes.map((d) => `  "${d.url}" already in feed ${d.feedId} (${d.field}) in ${d.file}`).join('\n');
      return {
        success: false,
        message: `Duplicate URL(s) found — feed not added:\n${detail}\nUpdate the existing feed record instead, or pass an empty scanFiles list to bypass this check.`,
        duplicates: dupes,
      };
    }
  }

  // --- Read target file ---
  if (!fs.existsSync(input.filePath)) {
    return { success: false, message: `File not found: ${input.filePath}` };
  }
  let dmfr: { feeds?: Record<string, unknown>[]; operators?: Record<string, unknown>[] };
  try {
    dmfr = JSON.parse(fs.readFileSync(input.filePath, 'utf8'));
  } catch (err) {
    return { success: false, message: `Cannot parse JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  // --- Check for duplicate feed ID in this file ---
  const existingFeeds = (dmfr.feeds ?? []) as Record<string, unknown>[];
  if (existingFeeds.some((f) => f['id'] === input.feedId)) {
    return { success: false, message: `Feed ID "${input.feedId}" already exists in ${input.filePath}` };
  }

  // --- Build the new feed record ---
  const urls: Record<string, string> = {};
  if (input.staticUrl) { urls['static_current'] = input.staticUrl; }
  if (input.vehiclePositionsUrl) { urls['realtime_vehicle_positions'] = input.vehiclePositionsUrl; }
  if (input.tripUpdatesUrl) { urls['realtime_trip_updates'] = input.tripUpdatesUrl; }
  if (input.alertsUrl) { urls['realtime_alerts'] = input.alertsUrl; }

  const feed: Record<string, unknown> = { id: input.feedId, spec, urls };

  if (input.name) { feed['name'] = input.name; }

  if (input.license) {
    const l = input.license;
    const lic: Record<string, string> = {};
    if (l.spdxIdentifier) { lic['spdx_identifier'] = l.spdxIdentifier; }
    if (l.useWithoutAttribution) { lic['use_without_attribution'] = l.useWithoutAttribution; }
    if (l.createDerivedProduct) { lic['create_derived_product'] = l.createDerivedProduct; }
    if (l.commercialUseAllowed) { lic['commercial_use_allowed'] = l.commercialUseAllowed; }
    if (l.redistributionAllowed) { lic['redistribution_allowed'] = l.redistributionAllowed; }
    if (l.shareAlikeOptional) { lic['share_alike_optional'] = l.shareAlikeOptional; }
    if (l.attributionText) { lic['attribution_text'] = l.attributionText; }
    if (l.attributionInstructions) { lic['attribution_instructions'] = l.attributionInstructions; }
    if (Object.keys(lic).length > 0) { feed['license'] = lic; }
  }

  if (input.authorization) {
    const a = input.authorization;
    const auth: Record<string, string> = {};
    if (a.type) { auth['type'] = a.type; }
    if (a.paramName) { auth['param_name'] = a.paramName; }
    if (a.infoUrl) { auth['info_url'] = a.infoUrl; }
    if (Object.keys(auth).length > 0) { feed['authorization'] = auth; }
  }

  // --- Append and write ---
  if (!dmfr.feeds) { dmfr.feeds = []; }
  (dmfr.feeds as Record<string, unknown>[]).push(feed);

  try {
    fs.writeFileSync(input.filePath, JSON.stringify(dmfr, null, 2) + '\n', 'utf8');
  } catch (err) {
    return { success: false, message: `Write failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Format in-place (best-effort)
  if (cli) {
    try {
      await runDmfrFormat(cli, { filePath: input.filePath }, signal);
    } catch {
      // non-fatal
    }
  }

  return {
    success: true,
    message: `Added feed "${input.feedId}" (${spec}) to ${input.filePath}`,
  };
}

// ---------------------------------------------------------------------------
// transitland_add_operator
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/naming-convention
export const AddOperatorInputSchema = z.object({
  filePath: z.string().describe('Absolute path to a .dmfr.json file'),
  placement: z.enum(['nested', 'top_level']).describe(
    '"nested" — embed the operator inside an existing static feed\'s operators[] array; the link to that feed is then implicit and no feed_onestop_id is needed in associated_feeds. ' +
    '"top_level" — add the operator to the root operators[] array; associated_feeds must include at least one entry with a feed_onestop_id pointing to the static GTFS feed. ' +
    'Use "nested" for the simple case of one static feed with no RT. ' +
    'Use "top_level" when linking RT feeds, linking feeds from other files, or when the operator spans multiple feeds.',
  ),
  feedId: z.string().optional().describe(
    'Required when placement is "nested". The onestop_id of the static (gtfs/gbfs) feed to nest this operator under. ' +
    'Must not be a gtfs-rt feed.',
  ),
  operatorOnestopId: z.string().describe('Operator onestop_id in o-<geohash>-<name> format (e.g. o-9q9-caltrain).'),
  name: z.string().describe('Official operator name (e.g. "San Mateo County Transit District").'),
  shortName: z.string().optional().describe('Common short name or brand name (e.g. "samTrans").'),
  website: z.string().optional().describe('Operator website URL.'),
  associatedFeeds: z.array(
    z.object({
      feedOnestopId: z.string().optional().describe(
        'feed_onestop_id to link. ' +
        'For nested operators: use this to link RT or other feeds (the parent static feed link is implicit — do NOT repeat it here). ' +
        'For top_level operators: include the static feed here, plus any RT feeds.',
      ),
      gtfsAgencyId: z.string().optional().describe(
        'gtfs_agency_id value from agency.txt. Required only when the feed contains multiple agencies and you need to identify which one this operator maps to. ' +
        'Omit for single-agency feeds.',
      ),
    }),
  ).optional().describe(
    'Feed linkages. ' +
    'For single-agency nested operators with no RT feeds: omit entirely (link is implicit). ' +
    'For nested operators with RT feeds: include one entry per RT feed (feedOnestopId only). ' +
    'For multi-agency nested operators: include one entry with gtfsAgencyId (no feedOnestopId). ' +
    'For top_level operators: include one entry per linked feed (static + RT), each with feedOnestopId; add gtfsAgencyId on the static feed entry if multi-agency.',
  ),
  tags: z.record(z.string(), z.string()).optional().describe(
    'Key-value tags (e.g. { "us_ntd_id": "90009", "wikidata_id": "Q7407040", "twitter_general": "samtrans" }).',
  ),
});

export type AddOperatorInput = z.infer<typeof AddOperatorInputSchema>;

export interface AddOperatorOutput {
  success: boolean;
  message: string;
}

/**
 * Add an operator record to a .dmfr.json file, either nested under a static feed
 * or as a top-level entry.
 */
export async function runAddOperator(
  cli: TransitlandCLI | undefined,
  input: AddOperatorInput,
  signal?: AbortSignal,
): Promise<AddOperatorOutput> {
  if (!fs.existsSync(input.filePath)) {
    return { success: false, message: `File not found: ${input.filePath}` };
  }

  let dmfr: { feeds?: Record<string, unknown>[]; operators?: Record<string, unknown>[] };
  try {
    dmfr = JSON.parse(fs.readFileSync(input.filePath, 'utf8'));
  } catch (err) {
    return { success: false, message: `Cannot parse JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  const feeds = (dmfr.feeds ?? []) as Record<string, unknown>[];
  const topOps = (dmfr.operators ?? []) as Record<string, unknown>[];

  // --- Duplicate onestop_id check ---
  const allOps: Record<string, unknown>[] = [...topOps];
  for (const feed of feeds) {
    if (Array.isArray(feed['operators'])) {
      allOps.push(...(feed['operators'] as Record<string, unknown>[]));
    }
  }
  if (allOps.some((op) => op['onestop_id'] === input.operatorOnestopId)) {
    return { success: false, message: `Operator "${input.operatorOnestopId}" already exists in ${input.filePath}` };
  }

  // --- Build associated_feeds array ---
  let dmfrAssociatedFeeds: Record<string, string>[] | undefined;
  if (input.associatedFeeds && input.associatedFeeds.length > 0) {
    dmfrAssociatedFeeds = input.associatedFeeds
      .map((af) => {
        const entry: Record<string, string> = {};
        if (af.gtfsAgencyId) { entry['gtfs_agency_id'] = af.gtfsAgencyId; }
        if (af.feedOnestopId) { entry['feed_onestop_id'] = af.feedOnestopId; }
        return entry;
      })
      .filter((e) => Object.keys(e).length > 0);
    if (dmfrAssociatedFeeds.length === 0) { dmfrAssociatedFeeds = undefined; }
  }

  // --- Build the operator record ---
  const operator: Record<string, unknown> = { onestop_id: input.operatorOnestopId };
  if (input.name) { operator['name'] = input.name; }
  if (input.shortName) { operator['short_name'] = input.shortName; }
  if (input.website) { operator['website'] = input.website; }
  if (dmfrAssociatedFeeds) { operator['associated_feeds'] = dmfrAssociatedFeeds; }
  if (input.tags && Object.keys(input.tags).length > 0) { operator['tags'] = input.tags; }

  // --- Place the operator ---
  if (input.placement === 'nested') {
    if (!input.feedId) {
      return { success: false, message: 'feedId is required when placement is "nested"' };
    }
    const targetFeed = feeds.find((f) => f['id'] === input.feedId);
    if (!targetFeed) {
      return { success: false, message: `Feed "${input.feedId}" not found in ${input.filePath}` };
    }
    const feedSpec = String(targetFeed['spec'] ?? '').toLowerCase();
    if (feedSpec === 'gtfs-rt' || feedSpec === 'gtfs_rt') {
      return { success: false, message: `Cannot nest an operator under a GTFS-RT feed ("${input.feedId}"). Use placement "top_level" and reference it via associated_feeds instead.` };
    }
    if (!Array.isArray(targetFeed['operators'])) {
      targetFeed['operators'] = [];
    }
    (targetFeed['operators'] as Record<string, unknown>[]).push(operator);
  } else {
    // top_level — validate at least one associated_feeds entry has a feed_onestop_id
    if (!dmfrAssociatedFeeds || !dmfrAssociatedFeeds.some((af) => af['feed_onestop_id'])) {
      return {
        success: false,
        message: 'Top-level operators must have at least one associatedFeeds entry with a feedOnestopId linking to the static GTFS feed.',
      };
    }
    if (!dmfr.operators) { dmfr.operators = []; }
    (dmfr.operators as Record<string, unknown>[]).push(operator);
  }

  // --- Write ---
  try {
    fs.writeFileSync(input.filePath, JSON.stringify(dmfr, null, 2) + '\n', 'utf8');
  } catch (err) {
    return { success: false, message: `Write failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Format (best-effort)
  if (cli) {
    try {
      await runDmfrFormat(cli, { filePath: input.filePath }, signal);
    } catch {
      // non-fatal
    }
  }

  const location = input.placement === 'nested'
    ? `nested under feed "${input.feedId}"`
    : 'as top-level operator';
  return {
    success: true,
    message: `Added operator "${input.operatorOnestopId}" ${location} in ${input.filePath}`,
  };
}
