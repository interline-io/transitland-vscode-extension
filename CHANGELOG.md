# Change Log

## [0.3.0] — Unreleased

- Renamed extension to "Transitland" (was "Transitland Atlas DMFR")
- Command IDs changed: `transitland-atlas-vscode-extension.*` → `transitland.*`
- Settings changed: `transitlandAtlas.*` → `transitland.*` (add `transitland.cliPath`)
- Switched build tooling to esbuild (multiple entry points: extension + MCP server)
- Extracted `TransitlandCLI` wrapper class with binary auto-detection
- Added VS Code Output Channel "Transitland" for CLI output
- Added MCP server entry point (`out/mcp-server.js`) — Phase 2 tools forthcoming

## [0.2.0]

- Added DMFR CodeLens showing live feed status from Transitland API

## [0.1.0]

- Initial release: DMFR language support, JSON schema validation, snippets, formatting command
