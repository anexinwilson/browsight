# Product requirements

## Summary

Browsight connects an MCP client to a user's existing Chrome session. It provides a small set of browser tools while keeping page access behind user-managed extension permissions.

## Problem

Most browser automation starts a separate browser profile. That profile does not include the user's normal sessions, cookies, or extensions. Direct browser debugging also grants broad control that is difficult to restrict per site.

Browsight uses an extension inside the user's normal browser and makes that extension the permission boundary.

## Goals

- Read useful page content without sending raw HTML or screenshots.
- Identify interactive controls with stable, compact references.
- Support common browser actions on approved sites.
- Work with standard MCP clients over stdio.
- Deny page access until the user grants it by origin.
- Keep the bridge local and authenticated.
- Return actionable errors when an operation cannot continue.

## Non-goals

- Arbitrary JavaScript execution in a page
- Hidden access to sites without a user grant
- Reading cross-origin frames or closed shadow roots
- Replacing full browser-testing frameworks
- Guaranteeing interaction with controls that require trusted input events

## User workflow

1. The user runs `browsight setup`.
2. The user loads the generated unpacked extension.
3. The user grants read-only or full-control access for a site.
4. An MCP client reads the selected tab.
5. The client acts using references from the latest snapshot.
6. The user can change or revoke a grant from the extension UI.

## Tool requirements

### `browser_read`

- Read the selected approved tab.
- Return compact text and references for interactive controls.
- Detect likely login walls.
- Mask common secret patterns before returning content.
- Return a clear sentinel when the tab is unavailable or not approved.

### `browser_act`

- Support click, fill, navigation, and scroll actions.
- Require full-control access for the current origin.
- Require full-control access for a direct navigation destination.
- Re-resolve references after common page rerenders.
- Return a verdict and a small structural diff.

### `browser_tabs`

- List open HTTP and HTTPS tabs with their access level.
- Avoid exposing full URLs for unapproved tabs.
- Select only one unambiguous approved tab.
- Read the selected tab after switching.

## Security requirements

- Bind the bridge to loopback only.
- Authenticate the extension before accepting responses.
- Validate bridge frames against shared schemas.
- Store grants outside the MCP interface.
- Request Chrome host permissions from a user gesture.
- Fail closed when a grant is missing or expired.
- Prevent one MCP request from increasing its own permissions.

## Acceptance criteria

- Type checking, linting, tests, and builds pass in CI.
- Setup preserves existing MCP client configuration.
- Re-running setup preserves the existing bridge token and port.
- Read-only access cannot perform actions.
- A full-control grant cannot authorize an unapproved navigation destination.
- Invalid or unauthenticated bridge messages do not reach request handlers.
- Generated package contents include the built server, extension, shared code, and setup command.
