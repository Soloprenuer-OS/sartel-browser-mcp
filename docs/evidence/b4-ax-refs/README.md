# B4 accessibility-reference E2E evidence

The [before](before.png) and [after](after.png) images were captured by Chrome's `Page.captureScreenshot` through the unpacked Sartel extension on 2026-10-06. The same run used `Accessibility.getFullAXTree` to obtain opaque references, filled the Name textbox with `Eden`, clicked Save, observed `Saved 1`, and clicked the shadow-root button. It also rejected stale, foreign-session, and obscured references, then clicked a moved button using fresh geometry and rejected a reference after navigation.

Run from the repository root with Chrome for Testing installed:

```sh
SARTEL_BROWSER_AX_LIVE=1 \
SARTEL_CHROME_FOR_TESTING='/absolute/path/to/Google Chrome for Testing' \
SARTEL_BROWSER_AX_EVIDENCE_DIR=/absolute/path/to/evidence \
node --test mcp-server/test/live-ax.test.js
```

The test connects directly to the unpacked extension service worker over Chrome DevTools Protocol. This makes the extension and debugger behavior reproducible in an isolated browser profile without a Mac Local Network permission prompt. `mcp-server/test/origin-gate.test.js` separately verifies each new tool's stdio-to-WebSocket mapping and origin gate. A real Sartel connector-to-MCP run remains the release gate after publishing both the extension and MCP server versions.
