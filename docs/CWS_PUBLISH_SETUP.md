# Chrome Web Store publish API — one-time setup

This wires `scripts/publish-cws.sh` up so that shipping a new version of the
Sartel extension is one command instead of a dashboard session.

---

## Read this before you spend an hour on it

**The Chrome Web Store API uploads a package and sets the publish state. That is
the whole surface. It cannot set listing metadata.**

No API exists — not deprecated, not undocumented, *absent* — for:

| Dashboard field | API? |
|---|---|
| Name, short description, detailed description | no |
| Screenshots, store icon, promo tiles | no |
| Category, language | no |
| Single-purpose statement | no |
| Per-permission justifications, host-permission justification | no |
| Remote-code answer | no |
| Data-collection declaration and certification checkboxes | no |
| Privacy policy URL | no |
| Distribution: regions, pricing, visibility | no |

So the **first submission is unavoidably manual**. This pipeline does not
shorten it, and trying to make it do so is the time sink this section exists to
prevent. The manual first pass is written up in **[`store/SUBMIT.md`](../store/SUBMIT.md)**
— follow that, not this file, for the first release.

What the pipeline is actually worth: **every version after the first**. Once
the listing exists, a release becomes

```sh
./scripts/publish-cws.sh
```

and the listing text you already entered stays as it was.

---

## What ends up in `.env`

Four values, in `.env` at the repo root. `.env` and `.env.*` are already in
`.gitignore`; `scripts/oauth-init.mjs` also chmods the file to `600`.

```
CWS_CLIENT_ID=...
CWS_CLIENT_SECRET=...
CWS_REFRESH_TOKEN=...
CWS_EXTENSION_ID=...
```

No script prints any of these. Credentials reach `curl` through a mode-0600
config file rather than as command-line arguments, so they do not show up in
`ps` output on a shared machine, and any error response printed by a script is
scrubbed of token-shaped fields first.

---

## Step 1 — Developer account **(yours to do)**

Requires your Google sign-in, your card, and your acceptance of Google's terms,
so it cannot be automated and should not be.

1. Sign in at <https://chrome.google.com/webstore/devconsole> with the Google
   account that should **own** the extension long-term.
2. Accept the developer agreement and pay the one-time **$5** fee.
3. Set the publisher name to `Sartel`, and verify the contact email. An
   unverified contact email blocks publishing.

This is step 0 of `store/SUBMIT.md`; if you have already done it there, skip.

## Step 2 — Enable the API in Google Cloud **(yours to do)**

1. <https://console.cloud.google.com/> — sign in with **the same Google
   account** as step 1. A mismatch here is the usual cause of a 403 on upload
   later: the token authorizes an account that does not own the item.
2. Create a project named `sartel-cws-publish` (or pick an existing one).
3. **APIs & Services → Library** → search *Chrome Web Store API* → **Enable**.
   Give it ~30 seconds to take effect.

## Step 3 — Create the OAuth client **(yours to do)**

1. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. If it asks you to configure the consent screen first:
   - User type **External** (or **Internal** if you have a Workspace org).
   - App name: `Sartel CWS Publish`. Support email: yours.
   - Scopes: skip; the script requests the one scope it needs.
   - Test users: add your own Google address. Leaving the app in *Testing* is
     fine — you are the only user. Note that a *Testing*-mode consent screen
     expires its refresh tokens after 7 days; publish the consent screen
     (**Publish app**, no verification needed for a single internal user) if you
     do not want to redo step 4 every week.
3. Application type: **Desktop app**. Name: `sartel-cws-cli`.
4. **Create** → the modal shows the client ID and client secret.

Put them in `.env`:

```sh
cd ~/sartel-browser-mcp
printf 'CWS_CLIENT_ID=%s\nCWS_CLIENT_SECRET=%s\n' '<client-id>' '<client-secret>' > .env
chmod 600 .env
```

## Step 4 — Refresh token

```sh
node scripts/oauth-init.mjs
```

The script starts a loopback listener on `127.0.0.1:8085`, opens Google's
consent screen, and waits. **You sign in and click Allow** — that part is yours.
It then exchanges the code and appends `CWS_REFRESH_TOKEN` to `.env`. The token
is deliberately never printed to the terminal.

Flags: `--port N` if 8085 is taken, `--force` to replace an existing token.

The refresh token lasts until it is revoked (or 7 days, if the consent screen is
still in *Testing* — see step 3). If it dies you get `invalid_grant`; delete the
line and re-run.

> Ignore any older guide — including upstream's — that tells you to use
> `redirect_uri=urn:ietf:wg:oauth:2.0:oob` and paste a code by hand. Google shut
> the out-of-band flow down; it now fails outright. The loopback flow above is
> what works.

## Step 5 — Item ID

If the store item **already exists**, copy the Item ID from the dashboard (the
item URL ends in it) and append it:

```sh
echo 'CWS_EXTENSION_ID=<32-char-id>' >> .env
```

If the item **does not exist yet**, create it:

```sh
./scripts/cws-create-item.sh
```

That uploads `dist/sartel-<version>-first-upload.zip` — the key-stripped
variant, because the store rejects a first upload whose manifest carries a `key`
field — and prints the Item ID the store assigns. Then **stop and go to
`store/SUBMIT.md` step 4**: the assigned ID and public key have to be written
back into `extension/manifest.json` and `mcp-server/index.js` before
`@sartel/browser-mcp` is published to npm, or every Web Store user gets a server
that rejects their extension's WebSocket with a 403.

---

## Releasing a version, once the listing exists

```sh
# bump "version" in extension/manifest.json first — the store rejects a re-upload
# of a version it already has
./scripts/publish-cws.sh            # build → upload → submit for public review
./scripts/publish-cws.sh --draft    # build → upload, leave as a draft
./scripts/publish-cws.sh --trusted  # build → upload → publish to trusted testers
./scripts/publish-cws.sh --help
```

`publish-cws.sh` shells out to `scripts/build-zip.sh --update` for the package,
so the two stay in step; that build refuses to produce a zip containing a
dotfile or a `.pem`, and `publish-cws.sh` additionally refuses to upload a
package whose manifest `key` is wrong for the endpoint it is calling.

Listing changes still mean the dashboard. Copy from `store/LISTING.md`,
`store/PERMISSIONS.md` and `store/DATA_DISCLOSURE.md` as `store/SUBMIT.md`
describes.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `OAuth token refresh failed: invalid_grant` | Refresh token revoked, or expired because the consent screen is still in *Testing*. Delete `CWS_REFRESH_TOKEN` from `.env`, re-run `node scripts/oauth-init.mjs`. |
| `OAuth token refresh failed: invalid_client` | Client ID/secret mismatch, or the OAuth client was deleted. Redo step 3. |
| Upload 403 | The authorizing Google account is not the developer account that owns the item. Redo steps 2–4 signed in as the owner. |
| `ITEM_NOT_UPDATABLE` | A previous version is still in review. Wait, or re-run with `--draft` to replace the queued package. |
| Upload rejected on version | The store already has that version. Bump `version` in `extension/manifest.json`. |
| `key field is not allowed in manifest` | A first upload carrying `key`. Use `scripts/cws-create-item.sh`, which uploads the stripped variant. |
| `Publish status: ITEM_PENDING_REVIEW` | Not an error. The item was already queued; your upload replaced the queued package. |
| Listing edits "not applying" | They are not being sent. The API cannot set listing metadata. Dashboard only. |

---

## CI, later

Only worth doing once the listing is stable, and only for updates.

```yaml
# .github/workflows/cws-publish.yml
name: CWS Publish
on:
  push:
    tags: ['v*']
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: ./scripts/publish-cws.sh
        env:
          CWS_CLIENT_ID:     ${{ secrets.CWS_CLIENT_ID }}
          CWS_CLIENT_SECRET: ${{ secrets.CWS_CLIENT_SECRET }}
          CWS_REFRESH_TOKEN: ${{ secrets.CWS_REFRESH_TOKEN }}
          CWS_EXTENSION_ID:  ${{ secrets.CWS_EXTENSION_ID }}
```

The scripts read the environment when there is no `.env`, and values already in
the environment win over `.env`, so this needs no changes. Adding the four
repository secrets is yours to do.
