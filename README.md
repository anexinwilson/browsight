<p align="center">
  <img src="https://raw.githubusercontent.com/anexinwilson/browsight/main/docs/logo.png" alt="browsight logo" width="128">
</p>

<h1 align="center">browsight</h1>

<p align="center">
  Your logged-in Chrome, available to any MCP client.
</p>

<p align="center">
  <code>MIT</code> · <code>TypeScript</code> · <code>Node 24</code> · <code>Chrome MV3</code>
</p>

Browser agents are far less useful when they open an empty profile and ask you to sign in everywhere again. Browsight connects an MCP client to a Chrome tab that is already open on your computer.

That means an agent can work with the same Gmail inbox, LinkedIn page, admin dashboard, or documentation site that you can see, without asking you to sign in again or launching another browser window.

Browsight is a local Node.js server paired with a Chrome extension. The extension reads approved pages and performs approved actions. The server exposes those capabilities as three small MCP tools.

### Why try it?

- **Use the session you already have.** Work with approved sites where you are already signed in.
- **Give the model useful context.** Pages become compact text with named controls, not screenshots or raw HTML.
- **Keep access visible.** Every site starts blocked, and only the extension UI can grant read or control access.
- **Bring your own MCP client.** The protocol is not tied to one model provider or chat application.

## Try it locally

Browsight requires Node.js 24 or later.

```sh
npx -y browsight setup
```

The setup command:

1. Generates a random authentication token.
2. Copies the extension to a stable folder on your computer.
3. Adds Browsight to supported MCP client configurations.

Then load the extension into Chrome:

1. Open `chrome://extensions`.
2. Enable **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Select the `.browsight/extension` folder inside your home directory.
5. Restart your MCP client.

On Windows, the default extension path is:

```text
C:\Users\<your-name>\.browsight\extension
```

Run the diagnostic command if you want to verify the installation:

```sh
npx browsight doctor
```

Browsight follows the MCP client's lifetime while any site access is active. If the extension reports zero active site grants for 30 minutes, the local server shuts down; allowing a site cancels that countdown. The status signal contains only a count, never site names or URLs.

Change the no-access timeout when starting the server manually:

```sh
npx browsight serve --idle-timeout 60
```

Use `--idle-timeout 0` to disable no-access shutdown. Temporary site grants use a sliding inactivity window: an approved read or action on that site renews its timer, so access expires after you stop using it rather than in the middle of a task.

If an older or crashed server still owns the configured port and no MCP application is using Browsight, move the installation to a fresh loopback port:

```sh
npx browsight setup --new-port
```

Then reload the Browsight extension on `chrome://extensions` and restart the MCP client. This recovery changes only Browsight's local configuration and does not terminate an unknown process.

## What it can do

```text
browser_read { mode? }               Read the selected tab (`full` or `main`)
browser_act { ref, action, value? }  Click, fill, navigate, or scroll
browser_tabs { select? }             List tabs or select an approved tab
```

The tools are intentionally small. There is no arbitrary JavaScript execution and no tool that can grant itself more access.

A normal loop looks like this:

```text
1. browser_tabs                 Find an approved tab
2. browser_read                 Get the page text and control references
3. browser_act { ref: "5",
                 action: "click" }
4. browser_act result           dom_changed: compose window appeared
```

## How page reading works

Sending raw HTML to a model is expensive and noisy. A real application page can contain thousands of DOM nodes, scripts, styles, tracking markup, and hidden controls that are irrelevant to the task.

Browsight walks the live page and rebuilds a compact semantic view using accessibility roles and accessible names. A Gmail-style inbox can look like this:

```text
# Inbox
3 unread messages
[button "Compose" #5]
[textbox "Search mail" #6]
[link "Stripe receipt" #7]
```

Readable text stays readable. Interactive controls receive numbered references. The agent can click `#5` or fill `#6` without relying on screen coordinates or fragile CSS class names.

Each reference also carries a small fingerprint containing its role, accessible name, selected attributes, text, and position among similar controls. If React, Vue, or another framework rerenders the page before the action arrives, Browsight uses that fingerprint to find the control again. If the match is missing or ambiguous, it returns a clear error instead of guessing.

After an action, Browsight waits for a bounded DOM quiet period and returns a verdict plus a capped list of what appeared, disappeared, or changed. Only relevant new references are returned. The agent usually does not need to read the whole page again just to check whether a click worked.

On dense applications, `browser_read { mode: "main" }` focuses on the page's primary landmark. When a dialog is open, Browsight automatically reads that active dialog first instead of spending tokens on the background page. Actions reuse the preceding snapshot, so a click or fill can run immediately rather than rescanning a large inbox or feed before acting.

### The snapshot pipeline

For each read, Browsight:

1. Finds the tab selected through Browsight.
2. Checks the tab's origin against the extension's active grants.
3. Injects the content script if it is not already present.
4. Walks visible DOM nodes, open shadow roots, and same-origin frames.
5. Calculates accessibility roles, names, control states, and durable reference recipes.
6. Sends the compact snapshot through the authenticated local bridge, where common secret patterns are masked before MCP output is returned.

Very large snapshots are capped with an explicit truncation marker. The agent can switch to `main` mode or scroll instead of paying for an unbounded page dump.

Scrolling is DOM-aware. Browsight chooses the visible scroll surface around the active control or the center of the page, including inner application panes, and moves by 80% of that surface so adjacent reads overlap. The `more` action watches the composed DOM for new text, controls, or scroll range across open shadow roots and same-origin frames.

### True Keyboard & Mouse Simulation

Basic DOM clicks often fail on modern Single Page Applications (like Gmail, YouTube, or Amazon) because React and Vue ignore programmatic changes that lack real user interaction events. 

Browsight solves this by injecting **True Keyboard and Mouse Simulation** directly into the page. 

Filling uses the control's native value setter, focus and selection updates, then dispatches a full `KeyboardEvent` chain (`keydown`, `keypress`, `keyup`, including `Enter` key simulation) and `beforeinput`, `input`, and `change` events. This is the exact path modern frameworks observe. 

Clicks inject a synthetic `MouseEvent` chain that combines pointer events with the element's native activation behavior, which preserves links, labels, forms, and delegated framework handlers—all without requesting Chrome's invasive `debugger` permission.

This is closer to giving an agent a small, text-based accessibility view with true human simulation than streaming a screenshot or dumping the page's HTML.

## How the pieces connect

```text
MCP client
    | MCP over stdio
    v
Browsight server on your computer
    | authenticated WebSocket on 127.0.0.1
    v
Browsight Chrome extension
    | permission check and content script
    v
Your approved browser tab
```

The extension is the only component that touches a page. The server cannot bypass extension permissions or change the site allowlist.

The WebSocket listens only on the local loopback interface and requires a random per-install token. Messages are checked against shared Zod schemas before they are handled. Before page content is returned to the MCP client, the server masks common password, API key, bearer token, access key, Slack token, and JSON Web Token patterns.

## Site permissions

Every site starts blocked. Open the Browsight extension popup while visiting a site and choose one of two access levels:

- **Read-only** lets the agent read the page.
- **Full control** lets the agent read and interact with the page.

Grants can expire after a selected period of inactivity or remain active until you revoke them. An authorized operation renews only the grant for the site being used. Grants are stored in `chrome.storage.local` and backed by Chrome's native host-permission prompt.

Tabs without a grant are still listed by title and origin so the agent can tell you which site needs approval. Their page content is not read.

## Why an extension instead of Playwright or CDP?

Playwright and Chrome DevTools Protocol automation normally use a separate browser process or profile. That is useful for repeatable testing, but it does not naturally provide the everyday browser session where you are already signed in.

Browsight runs inside Chrome as a Manifest V3 extension, so it can work with the session you chose while still enforcing access one site at a time.

## Where Browsight fits

Browsight provides secure browser access as a small, inspectable MCP capability. It works across different clients, stays on the local machine, does not request Chrome's `debugger` permission, and only interacts with sites you explicitly approve.

While tools like [Firecrawl](https://docs.firecrawl.dev/introduction) are designed for hosted web scraping, and Playwright is built for full browser test automation, Browsight focuses on one specific job: safely connecting any MCP client to an approved tab in the browser session you already use, completely free of vendor lock-in.

## Current limitations

- Cross-origin iframes cannot be read from the content script.
- Closed shadow roots cannot be inspected.
- Synthetic events have `isTrusted: false`, so some hardened controls may ignore them.
- Chrome internal pages and other restricted URLs do not allow content-script injection.
- Only one MCP client can control the local bridge at a time.

## Development

```sh
git clone https://github.com/anexinwilson/browsight.git
cd browsight
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

After rebuilding the extension, open `chrome://extensions` and click the reload button on its extension card.

See [CONTRIBUTING.md](CONTRIBUTING.md) for repository conventions and [docs/DESIGN.md](docs/DESIGN.md) for implementation details.

## License

MIT
