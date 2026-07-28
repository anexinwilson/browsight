# Technical design

This document describes the current implementation of Browsight.

## Components

Browsight has three runtime components:

| Component | Runtime | Responsibility |
| --- | --- | --- |
| MCP server | Node.js | Exposes tools over stdio, hosts the local bridge, and filters output |
| Extension service worker | Chrome | Connects to the bridge, checks permissions, and routes requests |
| Content script | Browser tab | Builds semantic snapshots and performs browser actions |

The `shared` workspace contains the message schemas used by the server and extension. The `scripts` workspace contains installation and diagnostic commands.

## Connection lifecycle

`browsight setup` creates a random 32-byte token and selects a loopback port. It writes the server configuration to `~/.browsight/bridge.json` and the extension configuration to `~/.browsight/extension/connection.json`.

The server binds a WebSocket listener to `127.0.0.1`. The extension connects to that listener and sends an authentication message as its first frame. Authentication must complete within two seconds. Token comparison uses `timingSafeEqual`.

Only one authenticated extension connection is active. Requests use UUIDs so responses can be matched to pending MCP calls. Requests time out after 30 seconds, and pending requests fail immediately if the extension disconnects.

The server waits for the bridge socket to begin listening before it connects MCP stdio. A second server that encounters a busy bridge port exits with a clear error instead of remaining alive in a permanently unusable state.

The server follows the MCP transport lifetime while site access is active. The extension reports only its active-grant count after authentication and on its existing alarm; it never sends granted origins in this lifecycle signal. A positive count cancels shutdown, while zero grants or an extension disconnect starts the default 30-minute timer. `browsight serve --idle-timeout N` changes that no-access timeout, and zero disables it. Site grants have independent, per-origin inactivity windows; an authorized operation renews only the origin it uses.

## Protocol

All bridge frames are defined in `shared/src/protocol.ts`. Zod validates incoming frames at runtime, and TypeScript types are inferred from the same schemas.

Supported request pairs are:

- `read.request` and `read.response`
- `act.request` and `act.response`
- `tabs.request` and `tabs.response`

Expected failures use typed sentinels with a recovery hint. Examples include `not_whitelisted`, `ref_stale`, `ambiguous_target`, and `frame_unreachable`.

## Permission boundary

Permission grants are stored by origin in `chrome.storage.local`. A grant can be read-only or full-control and may include an expiry time.

Every read requires an active read grant. Every action requires an active full-control grant. Direct navigation also checks the destination origin before changing the tab URL.

The popup is the only interface that creates or changes grants. It requests the corresponding Chrome host permission from a user gesture. MCP messages cannot modify permission storage.

## Page snapshots

The content script walks the visible DOM in document order. It uses `dom-accessibility-api` to calculate roles and accessible names. Scripts, styles, hidden elements, and footer content are skipped.

Interactive elements are emitted as compact references:

```text
[button "Save" #3]
```

Each reference includes a recipe containing the role, accessible name, selected data attributes, text, ordinal, and optional ancestor path. Open shadow roots and same-origin frames are traversed. Cross-origin frames are represented as unreadable.

Snapshots have a fixed output budget and end with an explicit truncation marker when the page exceeds it. References are created only for controls present in the emitted snapshot.

The snapshot also records a compact state string for controls. State changes are used when calculating action results.

## Actions

The action path supports `click`, `fill`, `navigate`, and `scroll`.

Before acting, Browsight resolves the supplied reference. It first checks the element retained from the previous snapshot, then searches by its recipe. Missing and ambiguous targets return sentinels instead of selecting a candidate arbitrarily.

Fill supports inputs, text areas, select controls, and content-editable elements. It uses the control's owning document realm, the native value setter, focus and selection updates, `beforeinput`, `input`, `change`, and blur. This also allows controls in same-origin frames to be filled after rerender recovery.

Click sends pointer and mouse events using the target element's document realm. All generated events remain synthetic and have `isTrusted: false`.

Viewport scrolling accepts `up`, `down`, `top`, `bottom`, and `more`. Up and down move by 80% of the viewport so adjacent reads retain context and lazy-loading boundaries are not skipped.

After an action, a bounded mutation quiet-window allows the page to settle. Browsight builds a fresh snapshot and returns a verdict plus appeared, removed, and changed controls. MCP formatting caps each diff category and returns only references connected to appeared or changed controls.

## Output filtering

Before MCP content is returned, the server removes values from password input markup and masks common bearer tokens, API keys, access keys, Slack tokens, and JSON Web Tokens.

Filtering reduces accidental disclosure but is not a complete data-loss-prevention system. Permission grants remain the primary boundary.

## Tab handling

The tab tool lists HTTP and HTTPS tabs. For each tab it returns the title, origin, active state, and access level. It does not expose the full URL in the tab list.

Selecting a tab requires a single unambiguous match and at least read access. The chosen tab is recorded so later reads and actions do not depend on operating-system window focus.

## Build and tests

- `tsdown` builds the Node.js workspaces.
- `esbuild` builds the extension.
- `tsc` performs strict type checking without emitting files.
- `node:test` runs the unit and integration tests.
- Biome checks formatting and static rules.

Tests cover protocol validation, authentication, timeouts, permission decisions, tab selection, snapshot construction, reference resolution, actions, filtering, setup, and diagnostics.

Real-browser behavior still requires manual verification because jsdom cannot reproduce Chrome permissions, service-worker eviction, or every site framework.
