import * as vscode from 'vscode';
import * as cp from 'child_process';

const TRANSITLAND_API_BASE = 'https://transit.land/api/v2/rest';

/** Feed onestop_id typically starts with f- */
function isTransitlandFeedId(id: string): boolean {
	return typeof id === 'string' && id.startsWith('f-');
}

function getApiKey(): string {
	const config = vscode.workspace.getConfiguration('transitlandAtlas');
	const key = config.get<string>('apiKey');
	if (key && key.trim()) {
		return key.trim();
	}
	return process.env.TRANSITLAND_API_KEY || '';
}

interface TransitlandFeedResponse {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	feeds?: Array<{
		// eslint-disable-next-line @typescript-eslint/naming-convention
		onestop_id: string;
		spec?: string;
		// eslint-disable-next-line @typescript-eslint/naming-convention
		feed_versions?: Array<{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			latest_calendar_date: string | null;
			// eslint-disable-next-line @typescript-eslint/naming-convention
			earliest_calendar_date: string | null;
			// eslint-disable-next-line @typescript-eslint/naming-convention
			fetched_at: string;
			sha1?: string;
		}>;
		tags?: {
			notes?: string;
			// eslint-disable-next-line @typescript-eslint/naming-convention
			exclude_from_global_query?: string;
		};
		license?: {
			// eslint-disable-next-line @typescript-eslint/naming-convention
			spdx_identifier?: string;
			url?: string;
		};
		urls?: {
			// eslint-disable-next-line @typescript-eslint/naming-convention
			realtime_alerts?: string;
			// eslint-disable-next-line @typescript-eslint/naming-convention
			realtime_trip_updates?: string;
			// eslint-disable-next-line @typescript-eslint/naming-convention
			realtime_vehicle_positions?: string;
		};
	}>;
}

interface FeedStatusInfo {
	display: string;
}

async function fetchFeedStatus(onestopId: string): Promise<FeedStatusInfo> {
	console.log(`[Transitland DMFR] Fetching status for feed: ${onestopId}`);
	const apiKey = getApiKey();
	if (!apiKey) {
		console.log('[Transitland DMFR] No API key configured');
		return { display: 'Set transitlandAtlas.apiKey or TRANSITLAND_API_KEY for status' };
	}
	const url = `${TRANSITLAND_API_BASE}/feeds/${encodeURIComponent(onestopId)}?apikey=${encodeURIComponent(apiKey)}`;
	console.log(`[Transitland DMFR] Fetching from URL: ${TRANSITLAND_API_BASE}/feeds/${encodeURIComponent(onestopId)}?apikey=***`);
	try {
		const res = await fetch(url);
		console.log(`[Transitland DMFR] API response status: ${res.status}`);
		if (!res.ok) {
			const msg = res.status === 404 ? 'Not found in Transitland' : `API error ${res.status}`;
			return { display: msg };
		}
		const data = (await res.json()) as TransitlandFeedResponse;
		console.log(`[Transitland DMFR] API response data:`, data);
		const feed = data.feeds?.[0];
		if (!feed) {
			return { display: 'No feed data' };
		}

		const spec = feed.spec || 'Unknown';
		const versions = feed.feed_versions;

		// Handle GTFS-RT feeds (no archived versions)
		if (spec === 'GTFS_RT' || !versions || versions.length === 0) {
			// Determine RT feed type
			const rtTypes = [];
			if (feed.urls?.realtime_alerts) {
				rtTypes.push('alerts');
			}
			if (feed.urls?.realtime_trip_updates) {
				rtTypes.push('trip updates');
			}
			if (feed.urls?.realtime_vehicle_positions) {
				rtTypes.push('vehicle positions');
			}

			const rtInfo = rtTypes.length > 0 ? rtTypes.join(', ') : 'realtime';
			const display = `$(radio-tower) ${spec} - ${rtInfo}`;
			console.log(`[Transitland DMFR] Returning RT status: ${display}`);
			return { display };
		}

		// Handle static GTFS feeds with versions
		const latest = versions[0];
		const earliestDate = latest.earliest_calendar_date ?? '—';
		const latestDate = latest.latest_calendar_date ?? '—';
		const fetched = latest.fetched_at ? new Date(latest.fetched_at).toISOString().slice(0, 10) : '—';

		// Check if feed is currently active and how fresh it is
		const today = new Date().toISOString().slice(0, 10);
		const isActive = earliestDate !== '—' && latestDate !== '—' &&
			earliestDate <= today && today <= latestDate;

		// Check fetch freshness (warn if not fetched in 30+ days)
		const fetchedDate = latest.fetched_at ? new Date(latest.fetched_at) : null;
		const daysSinceFetch = fetchedDate ? Math.floor((Date.now() - fetchedDate.getTime()) / (1000 * 60 * 60 * 24)) : 999;
		const isStale = daysSinceFetch > 30;

		// Build status indicator with text
		let statusText = '';
		if (!isActive) {
			statusText = '[EXPIRED] ';
		} else if (isStale) {
			statusText = '[STALE] ';
		} else {
			statusText = '[ACTIVE] ';
		}

		// Build display text with only API-sourced info
		const display = `${statusText}${earliestDate} to ${latestDate} | Fetched: ${fetched} | ${versions.length} versions`;

		console.log(`[Transitland DMFR] Returning status: ${display}`);
		return { display };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[Transitland DMFR] Error fetching feed status:`, err);
		return { display: `Error: ${msg}` };
	}
}

/** Find line number (0-based) of the first occurrence of searchText in document */
function findLineForText(document: vscode.TextDocument, searchText: string): number {
	const text = document.getText();
	const idx = text.indexOf(searchText);
	if (idx === -1) {
		return 0;
	}
	return document.positionAt(idx).line;
}

export function activate(context: vscode.ExtensionContext) {
	console.log('[Transitland DMFR] Extension activating...');

	// Register command to open Transitland feed URL
	context.subscriptions.push(vscode.commands.registerCommand("transitland-atlas-vscode-extension.openFeedOnTransitland", (feedId: string) => {
		const url = `https://www.transit.land/feeds/${feedId}`;
		vscode.env.openExternal(vscode.Uri.parse(url));
	}));

	context.subscriptions.push(vscode.commands.registerCommand("transitland-atlas-vscode-extension.createNewDmfrFile", async (uri?: vscode.Uri) => {
		// Determine the directory where the file should be created
		let folderUri: vscode.Uri | undefined;

		if (uri) {
			// Called from explorer context menu
			const stat = await vscode.workspace.fs.stat(uri);
			folderUri = stat.type === vscode.FileType.Directory ? uri : vscode.Uri.joinPath(uri, '..');
		} else if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
			// Called from command palette - use first workspace folder
			folderUri = vscode.workspace.workspaceFolders[0].uri;
		}

		// Ask for filename
		const filename = await vscode.window.showInputBox({
			prompt: 'Enter DMFR filename (without extension)',
			placeHolder: 'example',
			validateInput: (value) => {
				if (!value) {
					return 'Filename cannot be empty';
				}
				if (value.includes('/') || value.includes('\\')) {
					return 'Filename cannot contain path separators';
				}
				return null;
			},
		});

		if (!filename) {
			return; // User cancelled
		}

		// Create the file
		const fullFilename = filename.endsWith('.dmfr.json') ? filename : `${filename}.dmfr.json`;
		const fileUri = folderUri ? vscode.Uri.joinPath(folderUri, fullFilename) : vscode.Uri.file(fullFilename);

		// Create file with template content
		const template = JSON.stringify({
			"$schema": "https://dmfr.transit.land/json-schema/dmfr.schema-v0.6.0.json",
			"feeds": []
		}, null, 2);

		await vscode.workspace.fs.writeFile(fileUri, Buffer.from(template, 'utf8'));

		// Open the file
		const doc = await vscode.workspace.openTextDocument(fileUri);
		await vscode.window.showTextDocument(doc);
	}));

	context.subscriptions.push(vscode.commands.registerCommand("transitland-atlas-vscode-extension.formatDmfrFile", async () => {
		if (vscode.window.activeTextEditor) {
			const currentDmfr = vscode.window.activeTextEditor.document.fileName;
			if (vscode.window.activeTextEditor.document.isDirty) {
				vscode.window.showWarningMessage('Save the current file before running the Transitland DMFR format command');
			} else {
				cp.exec(`transitland dmfr format --save ${currentDmfr}`, (err, stdout, stderr) => {
					if (err) {
						vscode.window.showWarningMessage('Error: ' + err.message);
						return;
					}
					if (stdout.match(/\[ERROR\]/)) {
						const errorMessage = stdout.split("[ERROR] ")[1];
						vscode.window.showWarningMessage(errorMessage);
					} else {
						vscode.window.showInformationMessage('Successfully applied opinionated DMFR format');
					}
				});
			}
		} else {
			vscode.window.showWarningMessage('No DMFR file currently open');
		}
	}));

	const codeLensProvider: vscode.CodeLensProvider = {
		provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
			console.log(`[Transitland DMFR] provideCodeLenses called for: ${document.fileName}, languageId: ${document.languageId}`);
			const lenses: vscode.CodeLens[] = [];
			try {
				const text = document.getText();
				console.log(`[Transitland DMFR] Document length: ${text.length} chars`);
				const root = JSON.parse(text) as { feeds?: Array<{ id?: string }> };
				console.log(`[Transitland DMFR] JSON parsed successfully`);
				const feeds = root?.feeds;
				console.log(`[Transitland DMFR] Feeds array:`, feeds ? `${feeds.length} feeds` : 'no feeds');
				if (!Array.isArray(feeds)) {
					console.log(`[Transitland DMFR] Not an array, returning empty lenses`);
					return lenses;
				}

				for (const feed of feeds) {
					const id = feed?.id;
					console.log(`[Transitland DMFR] Processing feed id: ${id}`);
					if (!id || !isTransitlandFeedId(id)) {
						console.log(`[Transitland DMFR] Skipping feed (invalid or not a Transitland ID): ${id}`);
						continue;
					}
					// Place CodeLens on the line containing this feed's "id" key
					const searchText = `"id": "${id}"`;
					const line = findLineForText(document, searchText);
					const range = new vscode.Range(line, 0, line, 0);
					console.log(`[Transitland DMFR] Creating CodeLens for ${id} at line ${line}`);
					// Don't set command - this signals VS Code to call resolveCodeLens
					const lens = new vscode.CodeLens(range);
					// Store the feed ID in a way we can retrieve it during resolution
					(lens as any).feedId = id;
					lenses.push(lens);
				}
			} catch (err) {
				console.error(`[Transitland DMFR] Error in provideCodeLenses:`, err);
			}
			console.log(`[Transitland DMFR] Returning ${lenses.length} CodeLens(es)`);
			return lenses;
		},

		async resolveCodeLens(lens: vscode.CodeLens): Promise<vscode.CodeLens> {
			console.log('[Transitland DMFR] Resolving CodeLens');
			const onestopId = (lens as any).feedId;
			if (!onestopId) {
				console.log('[Transitland DMFR] No feedId found on CodeLens');
				return lens;
			}
			console.log(`[Transitland DMFR] Resolving for onestop_id: ${onestopId}`);
			const status = await fetchFeedStatus(onestopId);
			lens.command = {
				title: `$(globe) ${status.display}`,
				command: 'transitland-atlas-vscode-extension.openFeedOnTransitland',
				arguments: [onestopId],
			};
			console.log(`[Transitland DMFR] CodeLens resolved with title: ${status.display}`);
			return lens;
		},
	};

	context.subscriptions.push(
		vscode.languages.registerCodeLensProvider({ language: 'dmfr' }, codeLensProvider)
	);

	console.log('[Transitland DMFR] Extension activated successfully');
}

export function deactivate() { }
