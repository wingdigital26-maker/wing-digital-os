// Run: node --test tests/clientBrands.test.mjs
// Proves the per-client review copy: business name first, real link, STOP
// line, unsubscribe line, no dashes, no leftover tokens, clean fallback.
import test from "node:test";
import assert from "node:assert/strict";
import {
  CLIENT_BRANDS, brandFor, reviewMessage, renderTemplate, paceFor, inSendWindow, TemplateError,
} from "../lib/clientBrands.ts";

const UNSUB = "https://example.test/api/email/unsubscribe?email=a%40b.co&token=abc";

for (const slug of Object.keys(CLIENT_BRANDS)) {
  test(`${slug}: SMS and email are branded, linked and compliant`, () => {
    const b = CLIENT_BRANDS[slug];
    const m = reviewMessage(slug, "Jane", UNSUB);
    assert.equal(m.ok, true, m.reason);
    assert.ok(m.sms.startsWith(`Hi Jane, this is ${b.name}.`), m.sms);
    assert.ok(m.sms.includes(b.reviewUrl));
    assert.match(m.sms, /Reply STOP to opt out\.$/);
    assert.ok(m.emailSubject.includes(b.name));
    assert.ok(m.emailBody.includes(b.reviewUrl));
    assert.ok(m.emailBody.includes(`Unsubscribe here: ${UNSUB}`));
    assert.equal(m.fromName, b.name);
    for (const t of [m.sms, m.emailSubject, m.emailBody]) {
      assert.doesNotMatch(t, /[—–]/);
      assert.doesNotMatch(t, /\{[a-z_]+\}/);
    }
    if (b.phoneDisplay) assert.ok(m.emailBody.includes(b.phoneDisplay));
    if (!b.postalAddress) assert.doesNotMatch(m.emailBody, /\n\n\n/);
    assert.ok(b.logo && b.logo.src.startsWith("/brands/"));
  });
}

test("unknown client: clean page fallback, and review sends are refused", () => {
  const b = brandFor("acme-plumbing", "Acme Plumbing Co");
  assert.equal(b.name, "Acme Plumbing Co");
  assert.equal(b.initials, "AP");
  assert.equal(b.logo, undefined);
  assert.equal(brandFor("x-y", null).name, "Your business");
  const m = reviewMessage("acme-plumbing", "Jane", UNSUB);
  assert.equal(m.ok, false);
});

test("no unsubscribe link: SMS still renders, email is withheld", () => {
  const m = reviewMessage("heros-junk", "Jane", null);
  assert.equal(m.ok, true);
  assert.equal(m.emailBody, "");
});

test("renderTemplate drops optional lines and refuses bad copy", () => {
  assert.equal(renderTemplate("A {business}\nCall {phone}\nB", { business: "X", phone: "" }), "A X\nB");
  assert.throws(() => renderTemplate("Hi {first}", { first: "" }), TemplateError);
  assert.throws(() => renderTemplate("Hi — {first}", { first: "a" }), TemplateError);
});

test("pace defaults to a slow drip", () => {
  assert.deepEqual(paceFor("heros-junk"), { perDay: 1, perWeek: 3 });
});

test("send window is Central time, 10am to 7pm, noon on Sunday", () => {
  // 2026-09-28 is a Monday. CDT = UTC-5.
  assert.equal(inSendWindow(new Date("2026-09-28T14:59:00Z")), false); // 9:59am
  assert.equal(inSendWindow(new Date("2026-09-28T15:00:00Z")), true); // 10:00am
  assert.equal(inSendWindow(new Date("2026-09-29T00:00:00Z")), false); // 7:00pm
  assert.equal(inSendWindow(new Date("2026-09-27T16:30:00Z")), false); // Sun 11:30am
  assert.equal(inSendWindow(new Date("2026-09-27T17:30:00Z")), true); // Sun 12:30pm
});
