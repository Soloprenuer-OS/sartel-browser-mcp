#!/usr/bin/env node
/**
 * One-time OAuth bootstrap for the Chrome Web Store publish API.
 *
 * Starts a loopback HTTP server, opens Google's consent screen with that
 * loopback as the redirect, waits for the authorization code, exchanges it for
 * a refresh token, and appends the refresh token to .env (gitignored).
 *
 * The refresh token is never printed — it only ever reaches .env.
 *
 * Run once:  node scripts/oauth-init.mjs
 * Requires:  CWS_CLIENT_ID and CWS_CLIENT_SECRET already in .env
 *            (docs/CWS_PUBLISH_SETUP.md step 3)
 *
 * You, not this script, sign in to Google and approve the consent screen.
 */

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, '.env');
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
const SETUP_DOC = 'docs/CWS_PUBLISH_SETUP.md';

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log(`Usage: node scripts/oauth-init.mjs [--port N] [--force]

Obtains a Chrome Web Store refresh token and appends it to .env.

  --port N   Loopback port for the OAuth callback (default 8085).
  --force    Replace an existing CWS_REFRESH_TOKEN line in .env.

Needs CWS_CLIENT_ID and CWS_CLIENT_SECRET in .env first — see ${SETUP_DOC}.
You sign in to Google and approve the consent screen yourself; this script
only catches the redirect.`);
  process.exit(0);
}

const FORCE = process.argv.includes('--force');
const portArg = process.argv.indexOf('--port');
const PORT = portArg !== -1 ? Number(process.argv[portArg + 1]) : 8085;
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  fail(`--port must be a number between 1 and 65535, got "${process.argv[portArg + 1]}"`);
}

function fail(msg, hint) {
  console.error(`\n✗ ${msg}`);
  if (hint) console.error(`\n  ${hint}`);
  process.exit(1);
}

// ------------------------------------------------------------------ read .env

if (!existsSync(ENV_PATH)) {
  fail(
    `No .env file at ${ENV_PATH}`,
    `Create it with the OAuth client you made in the Google Cloud console:\n\n` +
      `      printf 'CWS_CLIENT_ID=…\\nCWS_CLIENT_SECRET=…\\n' > .env\n\n` +
      `  .env is gitignored. Full walkthrough: ${SETUP_DOC}`
  );
}

const envText = readFileSync(ENV_PATH, 'utf8');
const envLines = envText.split('\n');
const env = {};
for (const raw of envLines) {
  const line = raw.trim().replace(/^export\s+/, '');
  if (!line || line.startsWith('#')) continue;
  const i = line.indexOf('=');
  if (i === -1) continue;
  env[line.slice(0, i)] = line.slice(i + 1).replace(/^["']|["']$/g, '');
}

const CLIENT_ID = env.CWS_CLIENT_ID;
const CLIENT_SECRET = env.CWS_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  fail(
    `.env is missing ${!CLIENT_ID ? 'CWS_CLIENT_ID' : ''}${!CLIENT_ID && !CLIENT_SECRET ? ' and ' : ''}${!CLIENT_SECRET ? 'CWS_CLIENT_SECRET' : ''}`,
    `Create a Desktop-app OAuth client in the Google Cloud console and paste both\n` +
      `  values into .env. That step is yours — it needs your Google sign-in.\n` +
      `  See ${SETUP_DOC} step 3.`
  );
}

if (env.CWS_REFRESH_TOKEN && !FORCE) {
  console.log('CWS_REFRESH_TOKEN is already in .env — nothing to do.');
  console.log('Re-run with --force (or delete the line) to obtain a new one.');
  process.exit(0);
}

// ------------------------------------------------------------- consent + code

const REDIRECT_URI = `http://127.0.0.1:${PORT}`;
const STATE = randomBytes(16).toString('hex');

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth' +
  `?response_type=code` +
  `&client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&scope=${encodeURIComponent(SCOPE)}` +
  `&state=${STATE}` +
  `&access_type=offline` +
  `&prompt=consent`;

const page = (title, body) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px/1.5 system-ui;margin:4rem auto;max-width:34rem">` +
  `<h1>${title}</h1><p>${body}</p></body>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  if (url.pathname === '/favicon.ico') {
    res.writeHead(404).end();
    return;
  }

  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const state = url.searchParams.get('state');

  if (error) {
    res.writeHead(400, { 'content-type': 'text/html' }).end(page('Consent refused', error));
    fail(`Google returned "${error}"`, 'If this was accidental, just run the script again.');
  }
  if (!code) {
    res.writeHead(400, { 'content-type': 'text/html' }).end(page('No code', 'Nothing to do.'));
    return;
  }
  if (state !== STATE) {
    res.writeHead(400, { 'content-type': 'text/html' }).end(page('State mismatch', 'Request discarded.'));
    fail('Callback state did not match — the request did not come from the URL this script opened.');
  }

  res.writeHead(200, { 'content-type': 'text/html' }).end(
    page('Authorized', 'You can close this tab and go back to the terminal.')
  );
  server.close();

  console.log('✓ Authorization code received; exchanging it for a refresh token…');

  let data;
  try {
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI,
      }),
    });
    data = await resp.json();
  } catch (e) {
    fail(`Could not reach oauth2.googleapis.com: ${e.message}`, 'Check your network and re-run.');
  }

  if (!data.refresh_token) {
    const why =
      data.error === 'invalid_client'
        ? 'CWS_CLIENT_ID / CWS_CLIENT_SECRET do not match a live OAuth client.'
        : data.error === 'invalid_grant'
          ? 'The authorization code was already used or expired. Re-run the script.'
          : 'Google returned no refresh_token. If you have authorized this client before, ' +
            'revoke it at myaccount.google.com/permissions and re-run.';
    fail(`Token exchange failed${data.error ? `: ${data.error}` : ''}`, why);
  }

  // Rewrite .env, preserving comments and any unrelated keys.
  const kept = envLines.filter((l) => !/^\s*(export\s+)?CWS_REFRESH_TOKEN=/.test(l));
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  kept.push(`CWS_REFRESH_TOKEN=${data.refresh_token}`);
  writeFileSync(ENV_PATH, kept.join('\n') + '\n');
  try {
    chmodSync(ENV_PATH, 0o600);
  } catch {
    /* best effort */
  }

  console.log('✓ CWS_REFRESH_TOKEN written to .env (not printed here, by design).');
  console.log('');
  console.log('  Still needed in .env before publishing:');
  console.log('    CWS_EXTENSION_ID — the Item ID. If the store item does not exist yet,');
  console.log('    run ./scripts/cws-create-item.sh and it will print one.');
  console.log('');
  console.log('  Then: ./scripts/publish-cws.sh --draft');
  process.exit(0);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    fail(
      `Port ${PORT} is already in use, so the OAuth callback has nowhere to land.`,
      `Stop whatever is on it, or re-run with a different port:\n\n` +
        `      node scripts/oauth-init.mjs --port ${PORT + 1}`
    );
  }
  fail(`Could not start the callback server: ${e.message}`);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Waiting on ${REDIRECT_URI} for the OAuth callback.`);
  console.log('');
  console.log('Opening Google consent in your browser. Sign in with the Google account that');
  console.log('owns (or will own) the Chrome Web Store developer account — that is yours to do.');
  console.log('');
  console.log('If the browser does not open, paste this URL into it:');
  console.log('');
  console.log(`  ${authUrl}`);
  console.log('');
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  const child = spawn(opener, [authUrl], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' });
  child.on('error', () => {});
  child.unref();
});
