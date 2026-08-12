# Submitting Sartel — the hand-over

Everything in this repo is prepared. What is left is account creation, uploads, and clicking
Submit, which only you can do.

**Read the ordering section first.** The steps are not independent: the extension's published ID
does not exist until step 3, and three later things depend on it. Doing them in the wrong order
ships a broken npm package to every user.

---

## Why the order matters

The Chrome Web Store **rejects a first upload whose `manifest.json` contains a `key` field**
("key field is not allowed"). The store generates its own keypair at that upload and assigns the
extension ID from it. The manifest `key` field exists to put the store's *public* key back into
the manifest afterwards, so that unpacked development builds load under the same ID as the
published extension.

Our MCP server's origin gate accepts exactly one `chrome-extension://<id>` origin. So:

- The ID currently compiled into the server, `mjnnkmbiaoheconngckmilheckmepnam`, is the
  **development** ID derived from the local `key.pem`. It is **not** the published ID.
- If `@sartel/browser-mcp` is published to npm before the real ID is known and baked in, then
  every user who installs from the Web Store gets a server that **refuses their extension's
  WebSocket with a 403**, and nothing works for anyone.

Hence: draft upload first, real ID second, npm publish third. Never the other way round.

```
create item → upload first-upload.zip as DRAFT → read the assigned ID + public key
   → write both back into the repo → rebuild → upload the real zip → npm publish → Submit
```

---

## Step 0 — Developer account ($5, one time)

1. Go to <https://chrome.google.com/webstore/devconsole> and sign in with the Google account that
   should **own** the extension long-term. Getting this wrong is painful to undo — a personal
   account you might lose access to is the wrong choice.
2. Accept the developer agreement and pay the one-time **$5** registration fee.
3. Fill in the publisher details. The **publisher name is shown on the listing**; set it to
   `Sartel` rather than leaving your personal name.
4. Verify the contact email when Google asks. An unverified contact email blocks publishing.

## Step 1 — Preconditions

- [ ] `https://sartel.ai/privacy` is live and publicly reachable, with section 5 (the extension
      section) present. The store fetches this URL.
- [ ] Screenshots captured per `store/SCREENSHOTS.md` — five 1280×800 PNGs.
- [ ] `store/assets/store-icon-128.png` exists (it does; it is the Sartel mark on transparency).

## Step 2 — Build both zips

```sh
cd ~/sartel-browser-mcp
./scripts/build-zip.sh
```

Produces, and prints the contents of, both:

| File | Manifest `key` | Use |
|---|---|---|
| `dist/sartel-1.0.0-first-upload.zip` | stripped | **the first upload only** |
| `dist/sartel-1.0.0.zip` | present | every upload after the first |

The script refuses to produce a zip containing a dotfile or a `.pem`, so `key.pem` cannot end up in
either.

## Step 3 — Create the item and upload the FIRST-UPLOAD zip as a draft

1. Developer Dashboard → **Add new item**.
2. Upload **`dist/sartel-1.0.0-first-upload.zip`**. Using the other zip here fails with a
   `key field is not allowed in manifest` error.
3. The item is created as a **draft**. **Do not publish, do not submit for review yet.**

## Step 4 — Read the assigned identity

On the item's **Package** tab (or the item URL, which ends in the ID):

- **Item ID** — a 32-character lowercase string. This is the published extension ID.
- **Public key** — the base64 blob shown under "View public key" / the Package tab.

Write both down. If the public key is offered as a `.pem`, take only the base64 body between the
`-----BEGIN PUBLIC KEY-----` markers, with the newlines removed — that is the form the manifest
`key` field takes.

## Step 5 — Write the real identity back into the repo

1. `extension/manifest.json` — replace the value of `"key"` with the public key from step 4.
2. `mcp-server/index.js` — replace the value of `DEV_EXTENSION_ID` with the Item ID from step 4,
   and update the comment above it to say it is now the published ID. (`SARTEL_BROWSER_MCP_EXTENSION_ID`
   still overrides it at runtime, but the published package must not rely on the user setting an
   env var.)
3. `mcp-server/test/origin-gate.test.js` — update `DEV_EXTENSION_ID` to match, so the test that
   ties the manifest and the server together still means something.
4. Re-run the tests:

   ```sh
   cd mcp-server && npm test
   ```

5. Reload the unpacked extension at `chrome://extensions` and confirm it now loads under the store
   ID, and that the popup shows connected against a locally running server. This is the single
   check that proves the gate and the new ID agree before anything is published.
6. Commit.

## Step 6 — Upload the real zip as the version to publish

```sh
./scripts/build-zip.sh --update
```

Upload **`dist/sartel-1.0.0.zip`** to the same draft item, replacing the package.

## Step 7 — Fill in the listing

From `store/LISTING.md`, paste into the dashboard:

| Dashboard field | Source |
|---|---|
| Name | `Sartel` |
| Short description | the 131-character line in `LISTING.md` |
| Detailed description | the fenced description block |
| Category | Developer Tools |
| Language | English (United States) |
| Store icon | `store/assets/store-icon-128.png` |
| Screenshots | the five 1280×800 PNGs |
| Homepage / Support URL | see the URL table in `LISTING.md` |

Then the **Privacy practices** tab:

| Dashboard field | Source |
|---|---|
| Single purpose | the single-purpose paragraph in `LISTING.md` |
| Justification, one per permission | the matching block in `store/PERMISSIONS.md` |
| Host permission justification | the `<all_urls>` block in `store/PERMISSIONS.md` |
| Remote code | "No, I am not using remote code" — see `PERMISSIONS.md` |
| Data usage checkboxes | **none ticked** — see `store/DATA_DISCLOSURE.md` |
| Three certification checkboxes | all three ticked |
| Privacy policy URL | `https://sartel.ai/privacy` |

Distribution tab: Public, all regions, free.

## Step 8 — Publish the npm package (only now)

The server must carry the real extension ID before it goes to npm. Confirm it does:

```sh
grep -n "DEV_EXTENSION_ID = " mcp-server/index.js   # must show the CWS Item ID, not mjnnkm…
```

Then:

```sh
cd ~/sartel-browser-mcp/mcp-server
npm login
npm publish --access public          # @sartel is a scope; without --access public it publishes private
```

Verify:

```sh
npx -y @sartel/browser-mcp@1.0.0     # should print "listening on ws://127.0.0.1:9876"
```

The monorepo seed pins `@sartel/browser-mcp@1.0.0`, so the version must be exactly `1.0.0` — or the
pin in `packages/ai/src/default-connectors.ts` must be bumped to match whatever you publish.

## Step 9 — Create the public repo

The listing and the permission justifications both point at a public repository. It has to exist
before review, or the strongest argument in the justifications is a dead link.

```sh
cd ~/sartel-browser-mcp
gh repo create Soloprenuer-OS/sartel-browser-mcp --public \
  --source . --remote origin --description "Sartel Browser — Chrome extension + local MCP server. Fork of Agent360dk/browser-mcp (MIT)."
git push -u origin master
```

Check afterwards that `key.pem` is **not** in the pushed tree:

```sh
git ls-files | grep -i pem   # must print nothing
```

## Step 10 — Submit for review

Dashboard → **Submit for review**. Reviews typically take a few days; an extension requesting
`debugger` over `<all_urls>` should be expected to take longer and to draw a follow-up question.

If a question comes back, `store/PERMISSIONS.md` ends with the two answers that cover nearly all of
them. Reply with the mechanism, not with reassurance.

---

## About `key.pem`

`key.pem` sits at the repo root, is gitignored, and is the **development** identity only — it is
what makes the unpacked build load under a stable ID during development. Once the store assigns the
real keypair at step 3, the published extension's identity belongs to Google, not to this file.
Losing `key.pem` costs a stable unpacked ID and nothing more. Keep it; do not treat it as a secret
whose loss is unrecoverable, and never commit it.

## Not done here, deliberately

`npm publish`, `gh repo create`, `git push`, the developer account, and Submit were all left for
you. Nothing in this repository has been pushed anywhere, and no package has been published.
