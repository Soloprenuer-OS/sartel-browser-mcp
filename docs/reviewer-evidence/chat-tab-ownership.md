# Two-session browser ownership check

[Window-only recording](./chat-tab-ownership.mp4) shows Chrome for Testing with two tab groups: `Claude 1` containing `CHAT A • RED`, and `Claude 2` containing `CHAT B • BLUE`. The recording is of the actual browser window during the check, without the surrounding desktop.

The check used an isolated Chrome for Testing profile, the unpacked extension from this PR, and two real `mcp-server/index.js` processes speaking MCP over stdio. A temporary copy of the extension scanned ports 9976–9995 instead of 9876–9895 to keep the test isolated from the user's regular Chrome; no product source was changed for that port override. Each process called `browser_navigate`, `browser_list_tabs`, and `browser_get_page_content`. The observed results were:

| Call | Result |
| --- | --- |
| Session A navigates | `CHAT A • RED`, tab 1926984570 |
| Session B navigates | `CHAT B • BLUE`, tab 1926984571 |
| A lists tabs | Only tab 1926984570 |
| B lists tabs | Only tab 1926984571 |
| A reads its tab | `CHAT A • RED` content |
| B reads its tab | `CHAT B • BLUE` content |
| B reads A's explicit `tab_id` | MCP `isError: true`: `Tab 1926984570 does not belong to this session` |

The recording establishes the two visible tab groups; the MCP result establishes the access denial. This is an extension/MCP integration check, not a pass through the installed Sartel desktop relay or two Sartel chat UIs. The coordinated release and installed-app check remain release gates.
