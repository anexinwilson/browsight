import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateTokens, isLoginWall, stripSecrets } from "../../../server/src/page/extract.ts";

test("password field values are stripped", () => {
  const out = stripSecrets('<input type="password" value="hunter2">');
  assert.ok(!out.includes("hunter2"), "raw password must not survive");
  assert.match(out, /\[stripped\]/);
});

test("api keys and bearer tokens are masked", () => {
  assert.match(stripSecrets("my key is sk-ABCD1234ABCD1234 ok"), /\[secret\]/);
  assert.match(stripSecrets("Authorization: Bearer abc.def.ghi123"), /Bearer \[secret\]/);
});

test("more secret formats are masked", () => {
  assert.match(stripSecrets("key sk_live_ABCDEFGHIJ1234567890 here"), /\[secret\]/);
  assert.match(stripSecrets("aws AKIAIOSFODNN7EXAMPLE done"), /\[secret\]/);
  assert.match(stripSecrets("token eyJhbGci.eyJzdWIi.SflKxwRJ end"), /\[secret\]/);
});

test("token estimate is far smaller for clean text than raw html", () => {
  const noise = '<div class="x" data-y="z">'.repeat(500);
  const raw = `${noise}Hello world`;
  assert.ok(estimateTokens("Hello world") < estimateTokens(raw));
});

test("a login wall is detected; a normal logged-in page is not", () => {
  assert.equal(
    isLoginWall({ title: "Sign in", text: "enter your password", hasPasswordField: true }),
    true,
  );
  assert.equal(
    isLoginWall({ title: "Inbox", text: "3 new messages", hasPasswordField: false }),
    false,
  );
});

test("a large authenticated page with a password field is not a login wall", () => {
  const big = `Account settings\n${"Some account content here. ".repeat(200)}\nChange password\nSign in`;
  assert.equal(isLoginWall({ title: "Account", text: big, hasPasswordField: true }), false);
});

test("a federated sign-in wall is detected without any password field", () => {
  // Verbatim from a Glassdoor salary page, which returned only this. It has no password
  // input at all, so requiring one made the wall read as ordinary page content.
  const text = [
    "Salary: Cloud Engineer in Toronto, ON 2026 | Glassdoor",
    "See more Cloud Engineer salaries for free",
    "Streamline your research and get better job matches across Glassdoor and Indeed with one login.",
    "Continue with Google",
    "Continue with Apple or email",
  ].join("\n");

  assert.equal(isLoginWall({ title: "", text, hasPasswordField: false }), true);
});

test("a federated button inside a full page of content is not a wall", () => {
  const text = `Continue with Google\n${"real article content ".repeat(300)}`;
  assert.equal(isLoginWall({ title: "", text, hasPasswordField: false }), false);
});

test("a page with neither a password field nor federated sign-in is not a wall", () => {
  assert.equal(
    isLoginWall({
      title: "Dashboard",
      text: "Welcome back to your dashboard",
      hasPasswordField: false,
    }),
    false,
  );
});
