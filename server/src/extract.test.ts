import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateTokens, isLoginWall, stripSecrets } from "./extract.ts";

test("password field values are stripped", () => {
  const out = stripSecrets('<input type="password" value="hunter2">');
  assert.ok(!out.includes("hunter2"), "raw password must not survive");
  assert.match(out, /\[stripped\]/);
});

test("api keys and bearer tokens are masked", () => {
  assert.match(stripSecrets("my key is sk-ABCD1234ABCD1234 ok"), /\[secret\]/);
  assert.match(stripSecrets("Authorization: Bearer abc.def.ghi123"), /Bearer \[secret\]/);
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
