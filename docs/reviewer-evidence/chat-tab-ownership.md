# Two-session browser ownership check

[Watch the 14-second browser recording](./chat-tab-ownership.mp4) and inspect its [raw MCP result](./chat-tab-ownership-result.json). The recording switches between `CHAT A • RED` in the `Claude 1` tab group and `CHAT B • BLUE` in the `Claude 2` group, then opens the raw MCP result with the denied cross-session read highlighted. It replaces an earlier static blue-tab clip that did not show the interaction.

The check used an isolated Chrome for Testing profile, the unpacked extension from this PR, and two real `mcp-server/index.js` processes speaking MCP over stdio. A temporary copy of the extension scanned ports 9976–9995 instead of 9876–9895 to keep the test isolated from the user's regular Chrome; no product source was changed for that port override. Each process called `browser_navigate`, `browser_list_tabs`, and `browser_get_page_content`. The observed results were:

| Call | Result |
| --- | --- |
| Session A navigates | `CHAT A • RED`, tab 1926984646 |
| Session B navigates | `CHAT B • BLUE`, tab 1926984647 |
| A lists tabs | Only tab 1926984646 |
| B lists tabs | Only tab 1926984647 |
| A reads its tab | `CHAT A • RED` content |
| B reads its tab | `CHAT B • BLUE` content |
| B reads A's explicit `tab_id` | MCP `isError: true`: `Tab 1926984646 does not belong to this session` |

The colored pages are local test fixtures. The final browser tab displays the actual saved MCP result, not a Sartel product UI. This is an extension/MCP integration check, not a pass through the installed Sartel desktop relay or two Sartel chat UIs. The coordinated release and installed-app check remain release gates.
