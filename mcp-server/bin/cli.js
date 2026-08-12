#!/usr/bin/env node

/**
 * Sartel Browser MCP CLI
 *
 * Usage:
 *   npx @sartel/browser-mcp           — start the MCP server (stdio)
 *
 * The extension is installed from the Chrome Web Store, so there is no
 * "install" subcommand here: the published extension carries a pinned key,
 * and a locally copied unpacked build would not match the ID the server
 * accepts on its WebSocket.
 */

const command = process.argv[2];

if (!command) {
  await import('../index.js');
} else {
  console.log(`
Sartel Browser MCP — let a local Sartel agent operate your real Chrome

Usage:
  npx @sartel/browser-mcp           Start the MCP server (stdio)

Install the "Sartel" extension from the Chrome Web Store, then start Sartel
Desktop. The server listens on 127.0.0.1 only.

Docs: https://github.com/Soloprenuer-OS/sartel-browser-mcp
`);
}
