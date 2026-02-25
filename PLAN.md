# Transitland VS Code Extension — Expansion Plan

## Vision

Expand the extension from a DMFR-only editor into a full Transitland toolbox:
- Wrap the `transitland` CLI for GTFS validation, feed inspection, and authoring
- Expose tools via a TypeScript-based MCP server usable from Claude Code / Claude Desktop
- Progressive VS Code UI: CodeLens, webview panels, virtual filesystem for GTFS zips
- Eventually: create feeds from scratch via CSV editing + Overpass API + export pipeline

---

## Architecture principles

1. **Tools are pure functions** — `src/tools/*.ts` never import `vscode`. They take a `TransitlandCLI` instance and return typed data. Both the MCP server and VS Code extension call the same code.
2. **One codebase, two entry points** — esbuild produces `out/extension.js` (VS Code) and `out/mcp-server.js` (standalone stdio MCP server). No monorepo needed.
3. **MCP-first for agentic use** — CLI calls that return JSON go into MCP tools. VS Code UI (panels, CodeLens) is additive on top.
4. **Graceful degradation** — If the `transitland` binary is missing, the extension still works for DMFR editing and API status. MCP tools return a clear error.

---

## Binary resolution order

The `transitland` binary (~100 MB, not bundleable in VSIX) is resolved as:

1. `transitlandAtlas.cliPath` VS Code setting
2. `TRANSITLAND_BIN` environment variable
3. `PATH` walk: covers Homebrew (`/opt/homebrew/bin`), `go install` (`~/go/bin`), manual (`/usr/local/bin`)
4. Offer to download from GitHub releases into `context.globalStorageUri` (with SHA256 verification)

Release asset names (from `github.com/interline-io/transitland-lib`):
- macOS Apple Silicon: `transitland-macos-apple`
- macOS Intel: `transitland-macos-intel`
- Linux x86_64: `transitland-linux`
- Windows: no release binary yet — document manual install

Install via Homebrew tap: `brew install interline-io/transitland-lib/transitland-lib`

---

## Phase 1 — Stable foundation

**Status: in progress**

### 1a. Rename extension
- `package.json`: `name` → `transitland-vscode-extension`, `displayName` → `"Transitland"`, `description` broader, config title → `"Transitland"`, command IDs `transitland-atlas-vscode-extension.*` → `transitland.*`
- `src/extension.ts`: command strings, log prefixes
- `README.md`, `CHANGELOG.md`

### 1b. Switch build to esbuild
- Add `esbuild` as devDependency
- Build scripts: `build:extension` → `out/extension.js`, `build:mcp` → `out/mcp-server.js`
- TypeScript still used for type-checking (`tsc --noEmit`)
- Update `.vscodeignore` / packaging config

### 1c. TransitlandCLI class (`src/cli.ts`)
- Binary discovery (see resolution order above)
- `transitland version` detection on activation
- Promise-based `exec(args, options)` with `AbortController` cancellation
- VS Code `OutputChannel` for all CLI stderr/stdout
- Structured error type with `exitCode`, `stderr`

### 1d. Refactor `extension.ts`
- Replace inline `cp.exec` calls with `TransitlandCLI`
- Wire OutputChannel to extension lifecycle
- No user-visible behavior change

---

## Phase 2 — MCP server

**Status: pending**

### 2a. Tools layer (`src/tools/`)
Pure TS modules, no vscode imports:
- `validate.ts` — `transitland validate -o - --include-entities <url-or-path>`
- `dmfrFormat.ts` — `transitland dmfr format <file>`
- `feedInfo.ts` — Transitland REST API feed metadata

Each tool: Zod input schema + typed return type.

### 2b. MCP server (`src/mcp-server.ts`)
- `@modelcontextprotocol/sdk` stdio server
- Registers tools from `src/tools/`
- Built to `out/mcp-server.js`, exposed as `bin.transitland-mcp` in `package.json`

Configuration for Claude Code / Claude Desktop (`~/.claude/settings.json` or `claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "transitland": {
      "command": "node",
      "args": ["/path/to/out/mcp-server.js"]
    }
  }
}
```

### 2c. VS Code LM tool registration (optional)
- `vscode.lm.registerTool` (VS Code 1.99+) for Copilot Chat / agent mode
- Same tool implementations as MCP server

---

## Phase 3 — GTFS viewer

**Status: pending**

### 3a. Validate CodeLens on DMFR feed URLs
- Extend existing CodeLens provider
- Add "Validate" lens for feeds with `static_current` URL
- Runs `transitland validate --include-entities` in background
- Opens results panel on click

### 3b. GTFS validation results panel (Webview)
- HTML/CSS webview (no heavy framework)
- Sections: summary header (SHA1, date range, success/failure), agencies table, route count, service level calendar, errors/warnings list
- Triggered by: CodeLens button, command palette "Transitland: Validate GTFS Feed"

### 3c. GTFS zip virtual filesystem (stretch goal)
- `vscode.workspace.registerFileSystemProvider('gtfs', ...)`
- Open `.zip` as virtual directory, browse CSV files inside
- CSV files open as plain text with column header highlighting

---

## Phase 4 — Feed creation (future)

- CSV editor with GTFS column schema validation
- Overpass API query for stop/route geometries → generate `stops.txt` / `shapes.txt`
- Export pipeline: edit CSVs → validate → package as zip
- MCP tool: `transitland_overpass_stops` for agent-driven feed creation

---

## File layout (target)

```
src/
  extension.ts        ← VS Code entry point
  mcp-server.ts       ← Standalone stdio MCP entry point
  cli.ts              ← TransitlandCLI wrapper
  tools/
    validate.ts
    dmfrFormat.ts
    feedInfo.ts
  panels/
    gtfsValidation.ts  (Phase 3)
syntaxes/
snippets.json
package.json
tsconfig.json
esbuild.mjs
```
