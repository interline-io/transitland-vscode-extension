# Transitland VS Code Extension

GTFS feed tools, DMFR editing, and Transitland integration for Visual Studio Code.

## Features

- **DMFR editing** — JSON schema validation, snippets, and opinionated formatting for `.dmfr.json` files
- **Feed status CodeLens** — live status for Transitland feeds inline in DMFR files (requires API key)
- **GTFS validation** — run `transitland validate` on feed URLs or local files (requires CLI)
- **MCP server** — expose Transitland tools to AI agents via the Model Context Protocol

## Requirements

### Transitland API key (for feed status CodeLens)

Set via `transitland.apiKey` in VS Code settings, or the `TRANSITLAND_API_KEY` environment variable.

### transitland CLI (for GTFS tools)

Install via Homebrew:

```sh
brew install interline-io/transitland-lib/transitland-lib
```

Or set the path manually in settings: `transitland.cliPath`.

The extension auto-detects the binary from common locations (`~/go/bin`, `/opt/homebrew/bin`, `/usr/local/bin`).

## Commands

Access from the command palette (`Cmd+Shift+P`):

- `Transitland: New DMFR File`
- `Transitland: Apply opinionated format to current DMFR file`

## MCP server

The extension ships a standalone MCP server for use with Claude Code, Claude Desktop, or any MCP-compatible agent:

```json
{
  "mcpServers": {
    "transitland": {
      "command": "node",
      "args": ["/path/to/transitland-vscode-extension/out/mcp-server.js"]
    }
  }
}
```

## Development

```sh
# Install dependencies
yarn install

# Build extension + MCP server
yarn run build

# Watch mode
yarn run build:watch

# Package VSIX
yarn run package
```
