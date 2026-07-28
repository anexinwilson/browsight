# Roadmap

This file tracks work that is not part of the current implementation.

## Browser verification

- Add a repeatable local fixture site for Chrome smoke tests.
- Re-run the recorded YouTube, Reddit, LinkedIn, and Amazon benchmark after each perception or action change.
- Document behavior on representative React, web-component, and content-heavy sites.

## Safety

- Add user confirmation for high-risk actions such as send, delete, purchase, upload, and OAuth approval.
- Revoke expired Chrome host permissions immediately instead of waiting for the next access check.
- Add an optional local audit log for permission decisions and actions.
- Expand secret-filtering fixtures as new credential formats are encountered.

## Reliability

- Improve reference scoring for pages with several controls that share the same role and name.
- Continue tuning action settlement for applications with long-running DOM mutations.
- Add clearer handling for browser-restricted pages and extension injection failures.
- Decide whether URL input belongs on `browser_read`; it is currently not part of the documented MCP surface.
- Remove unused protocol fields if structured extraction is not implemented.

## Distribution

- Automate version synchronization across workspace packages and the extension manifest.
- Run the packed-artifact install and MCP initialization smoke test in CI.
- Evaluate Chrome Web Store distribution after the unpacked-extension workflow is stable.

## Deferred options

- Native Messaging as an alternative to the loopback WebSocket
- An explicit `chrome.debugger` mode for controls that require trusted input
- Structured extraction against a user-supplied schema
