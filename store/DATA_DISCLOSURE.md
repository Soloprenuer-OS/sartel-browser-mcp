# Data disclosure — Chrome Web Store "Privacy practices"

**Answer: the extension collects nothing.** Not "collects little", not "collects anonymised" —
nothing. Its only network connection is a WebSocket to `127.0.0.1` on the user's own machine. There
is no server of ours in the picture, no account inside the extension, no analytics SDK, no error
reporting, no telemetry, no remote configuration, and no remote code.

Declare accordingly. Getting this wrong in the generous direction ("we might as well tick a box in
case") is not the safe option — the store treats a disclosure that does not match the code as a
misrepresentation either way.

---

## The data-type checkboxes

Tick **none** of them.

| Category | Collected? | Why not |
|---|---|---|
| Personally identifiable information | **No** | No account, no sign-in, no name/email/address, no ID of any kind is read or sent. |
| Health information | **No** | Not read, not sent. |
| Financial and payment information | **No** | The extension is free, has no payments, and sends nothing anywhere. |
| Authentication information | **No** | It can read cookies and extract a token *on the user's explicit per-call approval*, and hands them to the local process on the same machine. Nothing is transmitted off the device, so nothing is collected in the store's sense. |
| Personal communications | **No** | Not read as a category; a page the user directs the agent to may contain anything, and it still never leaves the machine. |
| Location | **No** | No geolocation API use, no IP-based location, no location inference. |
| Web history | **No** | No `history` permission is requested. Tab URLs are used to carry out the current action; nothing is recorded, profiled, or transmitted. |
| User activity | **No** | No analytics, no click/keystroke tracking, no usage metrics. The local action log in the popup stays in `chrome.storage.local` and is never sent anywhere. |
| Website content | **No** | Page text, screenshots and console output are produced on request and passed to the local process on `127.0.0.1`. They do not reach us or any third party. |

## The three certifications

All three are **checked**, and all three are true:

- [x] **I do not sell or transfer user data to third parties, apart from the approved use cases.**
      There is no transfer at all. No data leaves the user's machine through this extension.
- [x] **I do not use or transfer user data for purposes that are unrelated to my item's single
      purpose.** There is no use beyond carrying out the user's own instruction in their own
      browser.
- [x] **I do not use or transfer user data to determine creditworthiness or for lending
      purposes.** Not applicable, and not done.

## Privacy policy URL

```
https://sartel.ai/privacy
```

Section 5, "The Sartel Chrome extension", is written about this extension specifically and states
the same thing this file does: the extension's only connection is to `127.0.0.1`, it contains no
analytics or telemetry, and no data collection is declared for it. Confirm that page is live before
submitting — the store fetches it.

---

## The distinction a reviewer may probe

*"It reads cookies, screenshots pages and can extract auth tokens, and you are declaring no
collection?"*

Yes, and the two are not in tension. "Collection" in the store's sense means **transmitting data
off the user's device**. This extension transmits nothing off the device. Data flows:

```
Chrome (user's own profile)
   ↓  local WebSocket, 127.0.0.1 only, refused unless the Origin is this extension
Sartel MCP server (a process on the same machine, started by the user)
   ↓  stdio
Sartel connector (same machine)
```

and stops there as far as the extension is concerned. There is no fourth hop the extension can
take: the manifest's `content_security_policy` restricts `connect-src` to `127.0.0.1`, so it could
not reach a remote host even if the code tried to.

What the *user* does afterwards is separate and is covered by the Sartel privacy policy, not by
this disclosure: if they ask their agent to summarise a page, the page text becomes part of their
chat and goes to their AI provider — because they asked, through the app, not because the
extension sent it. That distinction is stated plainly in section 5 of the privacy policy rather
than hidden, which is the honest way to hold both facts at once.

## Sensitive actions are gated, which is a separate protection

Reading and writing cookies, running script in a page, extracting an authentication token and
uploading a file each require the user's explicit approval at the moment of the call, enforced by
the connector before the request reaches the extension. This does not change the disclosure — the
answer is still "no collection" — but it is worth saying in a reply if a reviewer asks how the
sensitive capabilities are controlled.
