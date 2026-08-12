# Sartel Browser

A Chrome extension and a local MCP server that let a Sartel agent operate the user's own,
already-logged-in Chrome — navigate, click, fill forms, read pages, take screenshots — instead of
a fresh headless browser that is signed into nothing.

Everything runs on the user's machine. The server binds `127.0.0.1` only; the extension talks to
nothing else.

## This is a fork

Sartel Browser is a fork of **[Agent360dk/browser-mcp](https://github.com/Agent360dk/browser-mcp)**,
MIT licensed, © 2026 Agent360. The extension and the MCP server are substantially Agent360's work.
The MIT licence is carried over verbatim in [`LICENSE`](LICENSE), and [`NOTICE`](NOTICE) records
the attribution together with the full list of changes made here.

The tool surface tracks upstream 1:1 — all 41 tools, unchanged behaviour. The changes worth
knowing about are around it:

1. **Rebrand** to Sartel, with the Chrome Web Store key pinned in the manifest.
2. **An origin gate on the WebSocket** (see below). Upstream accepts any local handshake.
3. **No self-update on startup.** Upstream ran `git pull` and `npm install` every time the server
   started, which is wrong under `npx` delivery and mutates a working tree that may not be ours.
4. **A longer connect budget.** Upstream waited 7.5s for the extension; a server spawned per
   session routinely meets an extension whose offscreen document has to be recreated first, which
   measured ~9s. See the comment in `mcp-server/index.js`.

## Security

### Origin gate

The MCP server is the WebSocket *server*; the extension is the client. Any local process, and any
web page the user visits — a page can open a WebSocket to `127.0.0.1` — could otherwise connect and
drive a fully authenticated browser.

So the server verifies the handshake `Origin` and accepts exactly one
`chrome-extension://<id>` origin, plus, if set, the single origin in
`SARTEL_BROWSER_MCP_ALLOWED_ORIGIN` (a development escape hatch). Everything else, including a
handshake with no `Origin` header at all, is refused with `403`.

Which ID that is:

- **Development.** `extension/manifest.json` pins the public half of a local RSA keypair as
  `"key"`, so the unpacked build always loads as `mjnnkmbiaoheconngckmilheckmepnam`. That is the
  server's built-in fallback.
- **Published.** The Chrome Web Store rejects a first upload whose manifest carries a `"key"`
  field: it generates its own keypair and assigns the ID at that upload. The real ID is therefore
  known only *after* the first draft upload, and must then be put back into the manifest as
  `"key"` and into the server — baked in, or supplied as `SARTEL_BROWSER_MCP_EXTENSION_ID`.
  **Publishing the npm package before that ships a server that refuses every store user's
  extension.** [`store/SUBMIT.md`](store/SUBMIT.md) has the ordering.

**Known limitation, accepted deliberately:** a malicious *local* process can forge an `Origin`
header. That process already runs as the user. A pairing token was considered and rejected as
friction that buys little against an attacker already inside the trust boundary. The gate is aimed
at the web-page case, which it closes completely.

### What the extension can do

The permission set is broad on purpose — `debugger` over `<all_urls>` is total authority over the
browsing session. `debugger` is used to synthesise *trusted* input events, which React and
web-component form controls reject when they are synthetic; it is not used for remote debugging
and connects to no remote endpoint. This repository is public so that claim is checkable.

## Layout

```
extension/     MV3 extension: service worker, offscreen WebSocket bridge, popup
mcp-server/    stdio MCP server; WebSocket server on 127.0.0.1:9876-9895
```

The server picks the first free port in `9876-9895`, which is what allows several agent sessions to
run at once; the extension's offscreen document scans that range and holds a connection to each.

## Development

```sh
cd mcp-server
npm install
npm test              # node --test
node index.js         # starts the MCP server on stdio
```

Load `extension/` unpacked at `chrome://extensions` with Developer mode on. Because the manifest
pins `"key"`, the unpacked build gets the same ID the store build will, so the origin gate accepts
it.

`key.pem` is **not** in this repository and must never be committed. It is the *development*
identity only — the published extension's keypair is held by the Chrome Web Store — so losing it
costs a stable unpacked ID, nothing more.

## Licence

MIT — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
