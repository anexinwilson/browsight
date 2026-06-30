# Context — Extension Messaging & Content Unit Testing

We are tasked with writing unit tests to achieve >= 80% coverage for:
1. `extension/src/content.ts`
2. `extension/src/messaging/act.ts`
3. `extension/src/messaging/common.ts`
4. `extension/src/messaging/tabs.ts`
5. `extension/src/acting/act.ts`

## Requirements
- Framework: `node:test` (Node's built-in test runner), `assert`, and `jsdom`.
- DOM mocking using `jsdom`.
- Chrome API mocking/stubbing (global `chrome` object).
- Coverage check via `npm run test` or experimental coverage flag.
- Do NOT perform git commits.
