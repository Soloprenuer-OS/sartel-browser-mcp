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

The three changes worth knowing about:

1. **Rebrand** to Sartel, with a pinned extension key.
2. **An origin gate on the WebSocket** (see below). Upstream accepts any local handshake.
3. **No CAPTCHA solving.** `browser_solve_captcha` became `browser_captcha_handoff`.

## No CAPTCHA solving

`browser_captcha_handoff` detects that a CAPTCHA is present, reports which kind it is, and stops.
The user completes the challenge themselves in their own browser, and the agent retries the
blocked action afterwards. The upstream checkbox auto-click, image-grid clicking, and
vision-assisted solving paths were removed. This tool does not bypass, defeat, or automate a
CAPTCHA, and nothing in this project claims otherwise.

## Security

### Origin gate

The MCP server is the WebSocket *server*; the extension is the client. Any local process, and any
web page the user visits — a page can open a WebSocket to `127.0.0.1` — could otherwise connect and
drive a fully authenticated browser.

So the server verifies the handshake `Origin` and accepts only

```
chrome-extension://mjnnkmbiaoheconngckmilheckmepnam
```

plus, if set, the single origin in `SARTEL_BROWSER_MCP_ALLOWED_ORIGIN` (a development escape
hatch). Everything else, including a handshake with no `Origin` header at all, is refused with
`403`.

That ID is fixed because `extension/manifest.json` pins the public half of an RSA keypair as
`"key"`. Chrome derives the extension ID from that key, so the unpacked development build, the
Chrome Web Store build, and the server's allowlist all agree — and the ID is known before first
publication, which it otherwise would not be.

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

`key.pem` is **not** in this repository and must never be committed. Losing it means losing the
extension's identity.

## Licence

MIT — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
