# Screenshot capture brief

Five screenshots, **1280×800 PNG**, in this order. The store shows them as a carousel and most
people look at the first one and stop, so shot 1 carries the listing.

Nothing here is generated. These are captures of the real thing, taken by you, of your own browser
doing real work. A store screenshot that shows UI the extension does not have is a rejection under
the "misleading representation" rule and, more to the point, is a lie about the product.

## How to capture

- Set the Chrome window so the **page viewport is 1280×800** and screenshot the window, then crop
  to exactly 1280×800. On a Retina Mac, `Cmd-Shift-4` then Space captures at 2×; downscale the
  result to 1280×800 rather than capturing at 1280×800 directly — the text stays sharp.
  `sips -Z` will not do this correctly on a non-square crop; use
  `sips --resampleHeightWidth 800 1280 shot.png`.
- Use a clean Chrome profile appearance: no unrelated extensions in the toolbar, no bookmark bar
  clutter, no personal tabs, no real names or email addresses anywhere in frame.
- **Every account, name, address and piece of content in frame must be fake or yours.** Do not
  screenshot a real customer's data, a real inbox, or a logged-in third-party account that is not
  yours to show.
- Keep Chrome's own "Sartel is debugging this browser" banner visible where it appears naturally.
  Hiding it would be dishonest, and showing it reads as confidence.
- Dark or light is fine, but pick one and keep all five consistent.
- Text overlays are optional. If you add any, one short line per shot, sentence case, high
  contrast, not covering the UI it describes.

---

## Shot 1 — the agent driving the real, logged-in browser

**What to have on screen:** Chrome, with the Sartel tab group visible in the tab strip (coloured,
labelled with the session name), on a page where the agent has clearly just done something —
mid-flow on a form, or a search result it navigated to. The Chrome debugger banner visible at the
top. Ideally the Sartel app or connector window is *not* in this frame; this shot is about the
browser.

**What it must demonstrate:** this is the user's own Chrome, already signed in, with their own
session — not a blank automated browser. The tab group is the visual proof that the agent's tabs
are labelled and separated from the user's.

**Suggested caption:** "Your agent works in the Chrome you already use."

---

## Shot 2 — a form being filled

**What to have on screen:** a real form part-way through being filled by the agent: a multi-field
form on a modern React or web-component-based app (a dev tool's settings page, a demo checkout, a
form on your own site). Several fields populated, one field focused with the caret in it. Use fake
data.

**What it must demonstrate:** that it actually fills real forms — the specific thing that
distinguishes trusted input events from scripted ones, and the reason `debugger` is requested.
Choose a form that a naive `element.value = ...` would *not* work on, because that is the honest
version of this claim.

**Suggested caption:** "Real clicks and keystrokes — the kind React accepts."

---

## Shot 3 — the extension popup

**What to have on screen:** the Sartel toolbar popup open over a page, showing connected status,
the active session(s) with their tabs, and the action log with a handful of recent entries — with
at least one entry marked sensitive so the safe/sensitive distinction is visible.

**What it must demonstrate:** the user can see what the agent did. This is the transparency shot,
and it is the one a cautious installer looks for after reading the permission list.

**Suggested caption:** "See every action the agent took."

---

## Shot 4 — the agent stopping to ask

**What to have on screen:** the in-page overlay asking the user a question, with a real question in
it — a choice the agent should not make alone ("Which of these two addresses should I use?"), or
the CAPTCHA hand-off ("A CAPTCHA is blocking this page. Complete it and I'll continue."). The
Chrome notification for the same prompt visible in the corner if you can catch both in one frame.

**What it must demonstrate:** the human is in the loop and the agent stops rather than guessing.
The shipped shot uses a cookie-approval prompt, which makes the point without raising a separate
question in the reviewer's mind. A CAPTCHA hand-off works too, but keep the wording to what is on
screen — the agent asking you to clear a challenge.

**Suggested caption:** "It stops and asks instead of guessing."

---

## Shot 5 — where the data goes

**What to have on screen:** the honest option, not a diagram: a terminal showing the Sartel MCP
server running and logging `listening on ws://127.0.0.1:9876`, next to (or over) the browser. If
you want it sharper, `lsof -iTCP -sTCP:LISTEN -n -P | grep 9876` in the same terminal shows the
listener bound to `127.0.0.1` and nothing else.

**What it must demonstrate:** the whole connection is local. This is the answer to the permission
list, and showing the actual bound socket is worth more than any wording.

**Suggested caption:** "Nothing leaves your machine. One socket, 127.0.0.1."

---

## Before you upload

- [ ] All five are exactly 1280×800 (`sips -g pixelWidth -g pixelHeight *.png`).
- [ ] No real personal data, no third-party account you do not own, no customer information.
- [ ] No screenshot shows a CAPTCHA mid-solve. The hand-off is fine to show; a half-completed
      challenge is a distraction that invites a question the image cannot answer.
- [ ] No UI in any shot that the shipped extension does not actually have.
- [ ] Consistent theme and window chrome across all five.
