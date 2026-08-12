# Chrome Web Store listing — Sartel

Every field below is copy-paste ready. Do not paraphrase the CAPTCHA wording (see the note at the
end); do not add claims the extension cannot back up.

---

## Item name

```
Sartel
```

(23 char limit; 6 used.)

> Noted once and then dropped: a bare brand name is not something anyone searches for, so this
> listing gets no organic discovery. A descriptor suffix such as "Sartel — Browser Control for AI
> Agents" would rank; the name was chosen deliberately anyway.

## Short description (132 char limit — this is 131)

```
Let your local Sartel agent drive your own logged-in Chrome: navigate, click, fill forms, read pages, screenshot. All on 127.0.0.1.
```

## Category

```
Developer Tools
```

The extension is a control surface for an automation tool, used by people who are running an agent
on their own machine. It is not a Productivity or Workflow item for general consumers.

## Language

```
English (United States)
```

## Single purpose

The store asks for one sentence. This is it:

```
Sartel lets an AI agent running locally on the user's own computer operate that user's Chrome browser on their behalf — navigating, clicking, filling forms, reading page content and taking screenshots — by relaying commands from a local process over a WebSocket on 127.0.0.1.
```

Everything the extension does serves that one purpose. There is no second feature, no content
injection of our own, no advertising, and no separate service.

## Detailed description

```
Sartel connects an AI agent running on your own machine to the Chrome you already use.

Most browser automation starts a fresh, empty browser: signed into nothing, trusted by nothing,
tripping every bot check on the way. Sartel does the opposite. The agent works inside your real
profile, with your sessions, your logins, your extensions and your history already in place — the
same browser you would have used yourself.

HOW IT WORKS

1. You install this extension.
2. You run the Sartel connector on your computer. It starts a small local server that listens on
   127.0.0.1, and nowhere else.
3. The extension connects to it over a WebSocket on your own machine.
4. When you ask your agent to do something in the browser, the request travels from the local
   process to this extension, which carries it out through Chrome's own APIs.

The extension does not work on its own. Without the local connector running there is nothing for it
to talk to, and it does nothing at all.

WHAT THE AGENT CAN DO

• Navigate, open, close and switch tabs, and read what is on the page
• Click, double-click, right-click, hover, scroll, type, and fill forms — including React and
  web-component controls that ignore ordinary scripted events
• Select options, set dates, drive comboboxes, upload files
• Take screenshots, read console logs, wait for a network request to settle
• Read and write cookies and localStorage, and copy to and from the clipboard
• Work across iframes and multiple tabs, grouped per agent session so you can see what is going on
• Stop and ask you a question, in an overlay on the page, when it needs a decision from you

WHERE YOUR DATA GOES: NOWHERE

The extension's only network connection is to 127.0.0.1 on your own computer. There is no server of
ours involved, no account inside the extension, no analytics, no tracking, no telemetry, no remote
configuration. Page content, cookies and screenshots go from your browser to the local process on
your machine and no further. We declare no data collection because there is none to declare.

The local server accepts a connection only from this extension. A web page you visit cannot open a
socket to it and take over your browser.

YOU STAY IN CONTROL

Reading or writing cookies, running script on a page, extracting an authentication token and
uploading a file each require your explicit approval at the moment they happen. Tabs the agent is
driving are grouped and labelled, so you can always see which browsing is yours and which is not.
Close the tab or quit the connector and it stops.

CAPTCHAS

Sartel does not solve CAPTCHAs, and it will not try. When the agent hits one it stops, tells you
which kind of challenge it is, and hands the browser back to you. You complete it yourself; the
agent picks up where it left off.

PERMISSIONS

This extension asks for broad permissions, including Chrome's debugger interface across all sites.
That is real, and it is the honest cost of driving a browser the way a person does rather than the
way a script does. Two things make it checkable rather than something you have to take on faith:

• The source is public and MIT-licensed: https://github.com/Soloprenuer-OS/sartel-browser-mcp
• The extension talks to 127.0.0.1 and to nothing else, which you can verify yourself.

Privacy policy: https://sartel.ai/privacy (section 5 covers this extension specifically)
```

## Support / homepage URLs

| Field | Value |
|---|---|
| Homepage URL | `https://sartel.ai` |
| Support URL | `https://github.com/Soloprenuer-OS/sartel-browser-mcp/issues` |
| Privacy policy URL | `https://sartel.ai/privacy` |

`https://sartel.ai/privacy` must be live and publicly reachable *before* you submit — the store
fetches it. Section 5 of that page is about this extension and is the section the reviewer will
read.

## Visibility and distribution

| Field | Value |
|---|---|
| Visibility | Public |
| Distribution | All regions |
| Pricing | Free |
| Contains ads | No |
| In-app purchases | No |

## Assets

| Asset | Requirement | Where |
|---|---|---|
| Store icon | 128×128 PNG | `store/assets/store-icon-128.png` |
| Screenshots | 1280×800 PNG, 1–5 | capture per `store/SCREENSHOTS.md` |
| Small promo tile | 440×280 (optional) | not prepared; skip unless you want featuring |
| Marquee tile | 1400×560 (optional) | not prepared |

---

## The one line to never change

The description says the extension **does not solve CAPTCHAs**. That is not defensive marketing
copy, it is the truth of the code: `browser_captcha_handoff` detects the challenge type and stops.
Any wording that says or implies solving, bypassing, defeating or automating a CAPTCHA — or
defeating bot detection — is both false and a rejection under the store's policy on facilitating
unauthorized access. Leave it as written.
