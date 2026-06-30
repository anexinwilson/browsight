## 2026-06-30T04:41:32Z
You are a test developer worker. Your working directory is c:\Users\aen\Music\browsight-mcp\.agents\teamwork_preview_worker_test_implementation_1/.
Your task is to write and update unit tests for the following 5 target files to achieve >= 80% code coverage:
1. extension/src/content.ts (currently 0% covered)
2. extension/src/messaging/act.ts (currently 33.33% covered)
3. extension/src/messaging/common.ts (currently 96.77% covered)
4. extension/src/messaging/tabs.ts (currently 62.07% covered)
5. extension/src/acting/act.ts (currently 96.92% covered)

You must implement the following test coverage expansions:
- extension/src/acting/act.test.ts:
  - Add test for performAct with a select element (should call fillSelect through tryPerformFill).
  - Add test for performAct with a contenteditable element (should call fillEditable through tryPerformFill).
  - Add test for performAct with value: undefined for fill (should cover line 251-252 where tryPerformFill returns { kind: 'ignored' }).
  - Add test for performAct where viewport scroll result returns a DOM change (hits line 237-238).
  - Add test for fillValue fallback when prototype setter descriptor for "value" is missing (hits line 28-29).
- extension/src/messaging/common.test.ts:
  - Create a new unit test file at extension/src/messaging/common.test.ts.
  - Add a test that calls originOf with an invalid URL string to verify it catches the error and returns the original string (hits line 53-54).
- extension/src/messaging/act.test.ts:
  - Create a new unit test file at extension/src/messaging/act.test.ts.
  - Mock global chrome API (like chrome.tabs.reload, chrome.tabs.update, chrome.scripting.executeScript, chrome.tabs.sendMessage).
  - Mock currentTab(), listGrants() (from common/permissions).
  - Write test cases for:
    - Tab is null/undefined (verifies frame_unreachable sentinel is sent).
    - Origin not whitelisted (verifies not_whitelisted sentinel is sent).
    - Navigate action: reload/refresh case (calls chrome.tabs.reload and replies with navigated verdict).
    - Navigate action: missing url case (replies with not_actionable sentinel).
    - Navigate action: unwhitelisted destination case (replies with not_whitelisted sentinel).
    - Navigate action: whitelisted destination case (calls chrome.tabs.update and replies with navigated verdict).
    - Non-navigation actions (calls executeScript and sendMessage).
    - sendMessage error scenarios:
      - navigatedAway check: when new tab is whitelisted vs not whitelisted.
      - General error: replies with frame_unreachable sentinel.
- extension/src/messaging/tabs.test.ts:
  - Create a new unit test file at extension/src/messaging/tabs.test.ts.
  - Mock global chrome API (like chrome.tabs.query, chrome.tabs.update, chrome.windows.update).
  - Mock listGrants(), currentTab(), setCurrentTab(), readTabContent(), resolveTabSelection(), etc.
  - Write test cases for:
    - Listing tabs (when no select is provided): verifies HTTP/HTTPS tabs are filtered, active status matched, and labels resolved.
    - Selecting a tab:
      - resolveTabSelection returns a sentinel (sentinel returned in response).
      - resolveTabSelection returns a valid tab (calls chrome.tabs.update, chrome.windows.update, setCurrentTab, readTabContent and returns full response).
      - resolveTabSelection/readTabContent throws error (returns frame_unreachable sentinel with error message).
- extension/src/content.test.ts:
  - Create a new unit test file at extension/src/content.test.ts.
  - Mock global chrome.runtime.onMessage.addListener.
  - Mock performance.timeOrigin.
  - Mock buildSnapshot and rememberSnapshot and performAct.
  - Trigger listener callbacks to test:
    - Double-injection guard.
    - "read" message handling (returns false, page-load formatting).
    - "act" message handling (returns true, calls performAct, sends response when resolved).
    - Default/unknown message handling.

Ensure that:
1. All tests are written using node:test, assert and jsdom.
2. Do not use external libraries beyond what is installed (jsdom).
3. Running npm run test executes your tests successfully.
4. Running node --experimental-test-coverage --test "**/*.test.ts" verifies that the coverage for the 5 files is >= 80%.
5. Do NOT perform any git commits.
6. Write a detailed handoff report in your working directory under handoff.md showing:
   - Your test implementations and coverage metrics.
   - Command runs and output verifying >= 80% coverage.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.
