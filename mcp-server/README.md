# @sartel/browser-mcp

Local stdio MCP server for the **Sartel** Chrome extension. It bridges an agent to the user's own,
already-logged-in Chrome over a WebSocket bound to `127.0.0.1` (first free port in `9876-9895`).

```sh
npx @sartel/browser-mcp
```

Install the "Sartel" extension from the Chrome Web Store first; the server accepts connections only
from that extension's origin (plus one optional `SARTEL_BROWSER_MCP_ALLOWED_ORIGIN` for
development). It never connects to a remote endpoint.

CAPTCHAs are detected and handed to the user — `browser_captcha_handoff`. This package does not
solve or bypass them.

Fork of [Agent360dk/browser-mcp](https://github.com/Agent360dk/browser-mcp) (MIT, © 2026 Agent360).
Full attribution, change list and security notes:
<https://github.com/Soloprenuer-OS/sartel-browser-mcp>.
