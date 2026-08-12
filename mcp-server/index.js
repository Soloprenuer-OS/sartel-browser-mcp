#!/usr/bin/env node
/**
 * Sartel Browser MCP Server
 *
 * Bridges the agent (stdio MCP) to the Sartel Chrome extension (WebSocket).
 * Auto-selects the first available port in range 9876-9895 for multi-session support.
 *
 * Architecture:
 *   Agent ←(stdio)→ this process ←(WS 127.0.0.1:port)→ Offscreen Doc ←(sendMessage)→ Service Worker → Chrome APIs
 *
 * Fork of Agent360dk/browser-mcp (MIT, © 2026 Agent360). See ../NOTICE.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { WebSocketServer } from 'ws';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { TOOLS, PROVIDER_PAGES } from './tools.js';

// Read version from package.json — single source of truth, never drifts
const PKG_VERSION = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8')
).version;

const __dirname = dirname(fileURLToPath(import.meta.url));

const BASE_PORT = 9876;
const MAX_PORT = 9895; // 20 ports instead of 10 — zombies die within 5s via parent check
let extensionSocket = null;
let activePort = null;
let wss = null; // Track WSS for graceful shutdown
let cmdId = 0;
let lastActivity = Date.now();
const pending = new Map();

// Timers hoisted to module scope so gracefulShutdown can clear them deterministically.
let heartbeat = null;
let parentCheck = null;

// ── Origin gate ─────────────────────────────────────────────────────────────
//
// Upstream accepted any WebSocket handshake on 127.0.0.1. That let any local
// process — and any web page the user visits, since a page may open a socket to
// 127.0.0.1 — drive a fully logged-in browser. We accept only our own extension.
//
// Known and accepted limitation: a malicious local process can forge an Origin
// header. That process already runs as the user.
//
// ── About the ID below ──
//
// This is the REAL Chrome Web Store identity, assigned by CWS at item creation
// (item ibkmogfbmahilhjcafoahjifiiinmnlf). Its public key is pinned as "key" in
// extension/manifest.json, so Chrome derives the same ID for the unpacked build
// and the store build — one ID, one allowlist entry, no divergence.
//
// Getting here required an ordering that is easy to get backwards: CWS REJECTS a
// first upload whose manifest carries a "key" field. It generates the keypair and
// assigns the ID at that upload; the "key" field is how that CWS-issued public key
// is put back afterwards. So the ID could only be learned, never chosen.
//
// The repo-root key.pem is now dead weight — it produced the pre-submission
// stand-in ID and nothing signs with it any more.
const PUBLISHED_EXTENSION_ID = 'ibkmogfbmahilhjcafoahjifiiinmnlf';

export const EXTENSION_ID = (process.env.SARTEL_BROWSER_MCP_EXTENSION_ID || PUBLISHED_EXTENSION_ID).trim();

export function allowedOrigins() {
  const origins = [`chrome-extension://${EXTENSION_ID}`];
  const extra = process.env.SARTEL_BROWSER_MCP_ALLOWED_ORIGIN;
  if (extra) origins.push(extra.trim());
  return origins;
}

export function isAllowedOrigin(origin) {
  if (!origin) return false; // a missing Origin is not our extension
  return allowedOrigins().includes(origin);
}

function verifyClient(info, done) {
  const origin = info.req.headers.origin;
  if (isAllowedOrigin(origin)) {
    done(true);
    return;
  }
  process.stderr.write(`[MCP] Rejected WebSocket handshake from origin: ${origin || '(none)'}\n`);
  done(false, 403, 'Forbidden');
}

// ── WebSocket Server ───────────────────────────────────────────────────────

function createWSS(port = BASE_PORT) {
  const server = new WebSocketServer({ host: '127.0.0.1', port, verifyClient });
  wss = server;

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      if (port < MAX_PORT) {
        process.stderr.write(`[MCP] Port ${port} in use, trying ${port + 1}...\n`);
        // Drop the heartbeat this attempt installed; the retry installs its own.
        if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
        try { server.close(); } catch {}
        createWSS(port + 1);
      } else {
        process.stderr.write(`[MCP] All ports ${BASE_PORT}-${MAX_PORT} in use. Cannot start.\n`);
      }
    } else {
      process.stderr.write(`[MCP] WebSocket error: ${err.message}\n`);
    }
  });

  server.on('connection', (ws) => {
    extensionSocket = ws;
    process.stderr.write(`[MCP] Sartel extension connected on port ${port}\n`);

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (msg.type === 'terminate') {
        gracefulShutdown('Terminate signal from extension (last tab closed)');
        return;
      }

      const { id, result, error } = msg;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      clearTimeout(p.timer);
      if (error) p.reject(new Error(error));
      else p.resolve(result);
    });

    ws.on('close', () => {
      if (extensionSocket === ws) {
        extensionSocket = null;
        process.stderr.write(`[MCP] Sartel extension disconnected\n`);
      }
    });
  });

  server.on('listening', () => {
    activePort = port;
    process.stderr.write(`[MCP] WebSocket server listening on ws://127.0.0.1:${port}\n`);
  });

  // Heartbeat + idle timeout (4 hours) — hoisted to module scope so gracefulShutdown can clear it
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = setInterval(() => {
    if (extensionSocket && extensionSocket.readyState === 1) {
      extensionSocket.ping();
    }
    if (Date.now() - lastActivity > 4 * 60 * 60 * 1000) {
      gracefulShutdown('Idle timeout (4h)');
    }
  }, 20000);
}

createWSS();

// ── Send command to extension ───────────────────────────────────────────────

// How long the FIRST call waits for the extension to appear.
//
// Upstream used 5 × 1500ms = 7.5s, which is fine when the server is long-lived —
// their users start it once from an MCP client config and it outlives every
// reconnect. We are spawned per session by the connector daemon via `npx`, so a
// brand-new server meets a possibly-asleep extension at the start of nearly every
// chat that touches the browser.
//
// The extension's offscreen document scans for us every 2s, but only while it is
// alive; once the MV3 service worker has gone idle the document must be recreated
// first. Measured against a real idle Chrome, that round trip took ~9s — losing to
// a 7.5s budget by a hair, and failing the first tool call of the session.
//
// 15 × 1500ms = 22.5s clears the measured worst case with real margin, while
// staying far below anything that reads as a hang.
export const CONNECT_RETRIES = 15;
const RETRY_DELAY_MS = 1500;

async function sendToExtension(method, params = {}, timeoutMs = 30000, _retries = CONNECT_RETRIES) {
  if (!extensionSocket || extensionSocket.readyState !== 1) {
    if (_retries > 0) {
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      return sendToExtension(method, params, timeoutMs, _retries - 1);
    }
    // Name both halves — the missing one is usually Chrome, not the extension.
    throw new Error(
      `Chrome extension did not connect within ${Math.round((CONNECT_RETRIES * RETRY_DELAY_MS) / 1000)}s. ` +
      'Check that Chrome is running, and that the Sartel extension is installed and enabled at chrome://extensions.',
    );
  }
  return new Promise((resolve, reject) => {
    const id = ++cmdId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    extensionSocket.send(JSON.stringify({ id, method, params }));
  });
}

// ── MCP Server ──────────────────────────────────────────────────────────────

const INSTRUCTIONS = `You control the user's real Chrome browser via this MCP server. Each session gets its own color-coded Chrome Tab Group.

## Key behaviors
- **Always use browser_ask_user** when you need credentials, 2FA codes, CAPTCHA help, or any user input. Never guess passwords or tokens.
- **ALWAYS close tabs when done** with browser_close_tab after completing each task. Don't leave tabs open — close them immediately after extracting the data you need. Use browser_list_tabs to find and close all session tabs when a task is complete.
- **Check existing tabs first** with browser_list_tabs before navigating — reuse tabs instead of opening duplicates.
- **One task per tab** — navigate to a URL, do your work, then close or move on.
- **Tell the user what you're doing** in the browser. "I'm navigating to Stripe to find the API key" not just silently calling tools.

## Tab management
- navigate creates tabs in your session's tab group (visible in Chrome as colored groups)
- list_tabs only shows YOUR session's tabs — other Claude sessions have their own
- switch_tab lets you jump between your tabs
- close_tab cleans up when you're done

## Authentication flows
1. Navigate to login page
2. Use browser_ask_user with fields for email/password
3. Fill credentials with browser_fill
4. Click submit with browser_click
5. If 2FA required, use browser_ask_user again: "Please enter the 2FA code shown in your authenticator app"
6. After success, extract what you need with browser_get_page_content

## Screenshots
- browser_screenshot captures the visible tab — useful for visual verification
- The tab is auto-activated before capture, so it always shows the right page

## Text-based selectors (preferred for dynamic sites)
- browser_click("text=Get started") — clicks any element containing "Get started"
- browser_click("button:text(Submit)") — clicks a button containing "Submit"
- browser_fill("text=Email", "user@example.com") — fills input near "Email" label
- browser_wait("text=Success") — waits for text to appear
- These work on ALL sites including Google Cloud, Stripe, Slack (CSP-strict)

## Keyboard
- browser_press_key("Enter") — submit forms
- browser_press_key("Tab") — navigate between fields
- browser_press_key("Escape") — close dialogs
- browser_press_key("ArrowDown") — navigate dropdowns
- browser_press_key("a", ctrl=true) — select all

## CAPTCHA handling
CAPTCHAs are for the human, not for you. Never try to defeat one.
1. Call browser_captcha_handoff() — detects whether a CAPTCHA is present and of what type
2. If one is present → call browser_captcha_handoff(action="ask_human"), then browser_ask_user to ask the user to complete it in the browser and confirm when done
3. Once the user confirms, retry the action that was blocked

## OAuth popups
- OAuth popups (Google, Microsoft, GitHub, Slack, HubSpot) are automatically intercepted and added to your session's tab group
- Use browser_get_new_tab to access them, or they'll become your active tab automatically

## Shadow DOM (Shopify, Salesforce, etc.)
- CSS selectors automatically search inside shadow DOM
- If a standard selector fails, the extension recursively searches shadow roots
- Text-based selectors ("text=Submit") also traverse shadow DOM

## Hard inputs — use the specialised tools first
- **Date inputs** → use browser_set_date (NOT browser_fill). Handles native date inputs, masked text inputs (MM/DD/YYYY etc.), AND calendar pickers (MUI, react-datepicker, AntD, Lexical/Meta). 3-path fallback with read-back verification.
- **Autocomplete / combobox** (Languages on Meta Ads, country selects, async dropdowns) → use browser_set_combobox (NOT browser_select_option). Types partial query, waits for filtered listbox, clicks option. Supports multi-value chips.
- **Drag-drop file zones without visible file input** → use browser_drop_file (NOT browser_upload_file). Finds hidden input in subtree/parent.
- **Annoying popups blocking the flow** (cookie banners, "Don't show again", Advantage+ tooltips, draft-confirm prompts) → call browser_dismiss_overlays before each major step. It only clicks safe close affordances by default; preserves forms with editable text fields.

## When things fail
- Element not found → try text-based selector instead of CSS
- Screenshot fails → debugger fallback is automatic
- Click doesn't work on SPA → debugger mouse events are used automatically
- CAPTCHA blocks page → use browser_ask_user, let the human complete it
- browser_fill seemingly succeeds but value reverts → switch to browser_set_date or browser_set_combobox (most reverts are React-controlled validators)

## Extension
The Sartel extension is installed from the Chrome Web Store and updates itself.
You cannot navigate to chrome:// pages — the user must do that manually.

## Sharing wishes / use-cases / bugs
Whenever the user (a) expresses a missing feature, (b) hits something that looks like a bug in Sartel Browser itself, or (c) describes something cool they built with it — call **browser_about** with the matching intent ("wish" / "use_case" / "bug") and a short title + body, then offer the returned submit_url to the user as a clickable link. Don't ask permission, just draft + offer the link.`;

const mcpServer = new Server(
  { name: 'sartel-browser', version: PKG_VERSION },
  { capabilities: { tools: {} } },
  { instructions: INSTRUCTIONS },
);

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  lastActivity = Date.now();

  try {
    const methodMap = {
      browser_navigate: 'navigate',
      browser_get_page_content: 'get_page_content',
      browser_screenshot: 'screenshot',
      browser_execute_script: 'execute_script',
      browser_click: 'click',
      browser_fill: 'fill',
      browser_wait: 'wait',
      browser_press_key: 'press_key',
      browser_scroll: 'scroll',
      browser_hover: 'hover',
      browser_fetch: 'fetch',
      browser_select_option: 'select_option',
      browser_handle_dialog: 'handle_dialog',
      browser_wait_for_network: 'wait_for_network',
      browser_list_tabs: 'list_tabs',
      browser_get_cookies: 'get_cookies',
      browser_get_local_storage: 'get_local_storage',
      browser_ask_user: 'ask_user',
      browser_select_frame: 'select_frame',
      browser_list_frames: 'list_frames',
      browser_get_new_tab: 'get_new_tab',
      browser_switch_tab: 'switch_tab',
      browser_close_tab: 'close_tab',
      browser_upload_file: 'upload_file',
      browser_set_cookies: 'set_cookies',
      browser_set_local_storage: 'set_local_storage',
      browser_console_logs: 'console_logs',
      browser_captcha_handoff: 'captcha_handoff',
      browser_set_date: 'set_date',
      browser_dismiss_overlays: 'dismiss_overlays',
      browser_set_combobox: 'set_combobox',
      browser_drop_file: 'drop_file',
      browser_copy_to_clipboard: 'copy_to_clipboard',
      browser_paste_from_clipboard: 'paste_from_clipboard',
      browser_clipboard_stats: 'clipboard_stats',
      browser_double_click: 'double_click',
      browser_right_click: 'right_click',
      browser_click_xy: 'click_xy',
      browser_reattach_debugger: 'reattach_debugger',
    };

    if (name === 'browser_about') {
      return handleAbout(args);
    }

    if (name === 'browser_extract_token') {
      return await handleExtractToken(args);
    }

    const method = methodMap[name];
    if (!method) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }

    const timeout = method === 'ask_user' ? (args?.timeout || 120000) + 5000 :
                    method === 'captcha_handoff' ? 60000 : 30000;
    const result = await sendToExtension(method, args || {}, timeout);

    if (name === 'browser_screenshot' && result?.image) {
      const isJpeg = result.image.startsWith('data:image/jpeg');
      const prefix = isJpeg ? /^data:image\/jpeg;base64,/ : /^data:image\/png;base64,/;
      const mimeType = isJpeg ? 'image/jpeg' : 'image/png';
      const base64 = result.image.replace(prefix, '');

      if (args && args.path) {
        const targetPath = resolve(process.cwd(), args.path);
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, Buffer.from(base64, 'base64'));
        return {
          content: [
            { type: 'text', text: `Screenshot successfully saved to: ${targetPath}` },
            { type: 'image', data: base64, mimeType }
          ]
        };
      }

      return { content: [{ type: 'image', data: base64, mimeType }] };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

const REPO_URL = 'https://github.com/Soloprenuer-OS/sartel-browser-mcp';
const UPSTREAM_URL = 'https://github.com/Agent360dk/browser-mcp';
const ISSUE_LABELS = { wish: 'enhancement', use_case: 'use-case', bug: 'bug' };

function handleAbout(args) {
  const intent = args?.intent || 'info';
  const title = args?.title || '';
  const body = args?.body || '';

  const submit_url = intent === 'info' || !ISSUE_LABELS[intent]
    ? `${REPO_URL}/issues/new`
    : `${REPO_URL}/issues/new?labels=${ISSUE_LABELS[intent]}` +
      (title ? `&title=${encodeURIComponent(title)}` : '') +
      (body ? `&body=${encodeURIComponent(body)}` : '');

  const instruction =
    intent === 'wish'
      ? `Share this exact submission link with the user as a clickable link, with a short note like "Click to submit your wish — it'll open a pre-filled GitHub issue you can review before submitting": ${submit_url}`
      : intent === 'use_case'
      ? `Share this exact submission link with the user as a clickable link, with a short note like "Click to share your use-case — pre-filled, you can edit before submitting": ${submit_url}`
      : intent === 'bug'
      ? `Share this exact bug-report link with the user as a clickable link, with a short note like "Click to report — pre-filled, please add reproduction steps before submitting": ${submit_url}`
      : `Sartel Browser is an open MIT fork of Agent360dk/browser-mcp. Source: ${REPO_URL} · Submit anything: ${REPO_URL}/issues/new`;

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        name: 'Sartel Browser MCP',
        version: PKG_VERSION,
        repo: REPO_URL,
        upstream: UPSTREAM_URL,
        license: 'MIT (© 2026 Agent360, © 2026 Sartel)',
        submit_url,
        instruction,
      }, null, 2),
    }],
  };
}

async function handleExtractToken(args) {
  const { provider } = args;
  const info = PROVIDER_PAGES[provider];

  if (!info) {
    return {
      content: [{
        type: 'text',
        text: `Unknown provider: ${provider}. Known: ${Object.keys(PROVIDER_PAGES).join(', ')}\n\nYou can still use browser_navigate + browser_get_page_content to extract tokens from any provider manually.`,
      }],
    };
  }

  const nav = await sendToExtension('navigate', { url: info.url });
  return {
    content: [
      { type: 'text', text: `Navigated to ${info.url} (${nav.title})\n\nInstructions: ${info.instructions}\n\nUse browser_get_page_content or browser_screenshot to find the token, then use browser_execute_script to extract it.` },
    ],
  };
}

// ── Graceful shutdown ──────────────────────────────────────────────────────
// All shutdown paths funnel through gracefulShutdown so the cleanup chain runs
// deterministically — even on abrupt parent-exit. Without this, process.exit(0)
// was racing against WS close-handshake, leaving zombie tabs in Chrome.

let shuttingDown = false;
function gracefulShutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`[MCP] ${reason} — shutting down\n`);

  // Stop timers so they can't re-enter gracefulShutdown
  if (parentCheck) clearInterval(parentCheck);
  if (heartbeat) clearInterval(heartbeat);

  // Close WS with explicit close-frame so extension's onclose handler fires
  if (extensionSocket && extensionSocket.readyState === 1) {
    try { extensionSocket.close(1000, 'mcp-shutdown'); } catch {}
  }
  if (wss) try { wss.close(); } catch {}

  // 300ms grace for FIN-flush + extension session_disconnect cleanup
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('exit', () => {
  // Safety net for direct process.exit calls that bypass gracefulShutdown
  if (wss) try { wss.close(); } catch {}
  if (extensionSocket) try { extensionSocket.close(); } catch {}
});

// Detect Claude Code exit — check if parent process is still alive
// stdin.on('end') doesn't work because MCP SDK's StdioServerTransport owns stdin
const parentPid = process.ppid;
parentCheck = setInterval(() => {
  try {
    process.kill(parentPid, 0); // signal 0 = check if process exists
  } catch {
    gracefulShutdown(`Parent process ${parentPid} died`);
  }
}, 5000); // check every 5 seconds

// Also listen for stdin close as backup
process.stdin.on('end', () => gracefulShutdown('stdin closed'));

const transport = new StdioServerTransport();
await mcpServer.connect(transport);
process.stderr.write(`[MCP] Sartel Browser MCP server running (stdio)\n`);
