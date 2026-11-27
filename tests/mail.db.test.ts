import { createHmac } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ShopifyOrder } from "../app/lib/orders/map";
import fixture from "./fixtures/dev-orders-2026-11-20.json";
import { fakeShopify } from "./helpers/fake-shopify";
import { compose, TEMPLATE_KEYS, TEMPLATES, wordsFor } from "../app/lib/mail/templates";
import { hand, heldBack, sendingMode } from "../app/lib/mail/transport.server";
import { deliverDue, queueMail, sendAgain, sendSecret } from "../app/lib/mail/queue.server";
import { overdueOrders, runDailyChecks } from "../app/lib/mail/daily.server";
import { applyReport, signedByResend } from "../app/lib/mail/webhook.server";
import { cleanAddresses, mailLog, mailNumbers, mailTemplates, saveTeamAddresses, sendTest, setTemplateEnabled } from "../app/lib/mail/admin.server";
import { checkMailSettings, cleanTestList, mailEnv, mailSettings, saveMailSettings, seal, unseal, webhookSecrets } from "../app/lib/mail/config.server";
import { accessSentence, mailStoreCopyFailed } from "../app/lib/mail/notify.server";
import { fullSync, saveOrder, syncOrder } from "../app/lib/orders/sync.server";
import { addVendorUser, approveSignup, enableVendor, rejectSignup, removeVendorUser, setVendorStatus } from "../app/lib/vendors/vendors.server";
import { createInviteLink, getIdentity, requestPasswordReset, resetPassword, signIn, signUp, LOCK_FAILS } from "../app/lib/portal/auth.server";
import { addStaff, adminUpdateDetails, adminUpdateUser, ownerRemoveStaff, ownerUpdateStaff, requestBusinessChange, reviewBusinessChange, type Me } from "../app/lib/vendors/team.server";
import { setCommissionRate } from "../app/lib/commission/commission.server";
import { setReviewHidden, submitReview } from "../app/lib/reviews/reviews.server";
import { sendPasswordReset, sendStaffInvite } from "../app/lib/portal/email.server";
import { dashboard } from "../app/lib/admin/dashboard.server";

/**
 * The mail system: what each event mails and to whom, the queue and its
 * retries, the rules that keep a development store from mailing real people,
 * the mail service's reports, and the Mail page's actions.
 */
const db = new PrismaClient();
const shop = "mail-test.myshopify.com";
const PW = "Strong-test-password-1";
const ADMIN = "admin:team@setustore.test";
const TEAM = "alerts@setustore.test";
const LIVE = { RESEND_API_KEY: "re_test", PORTAL_EMAIL_FROM: "Setu Store <support@setustore.test>", PORTAL_EMAIL_REPLY_TO: "support@setustore.test", NODE_ENV: "production", PORTAL_URL: "https://vendors.setustore.test" };
const orders = () => {
  const list = structuredClone(fixture.orders) as ShopifyOrder[];
  // Placed "today", so a new order is recent enough to be announced.
  for (const o of list) o.createdAt = new Date(Date.now() - 60_000).toISOString();
  return list;
};

async function cleanup() {
  // The queue is one for the whole app, so mails other test files left waiting are cleared too.
  await db.mailMessage.deleteMany({});
  await db.mailTemplateSetting.deleteMany({ where: { shop } });
  await db.mailSetting.deleteMany({ where: { shop } });
  await db.shopSetting.deleteMany({ where: { shop } });
  await db.portalSession.deleteMany({ where: { vendorUser: { shop } } });
  await db.passwordReset.deleteMany({ where: { vendorUser: { shop } } });
  await db.vendorChangeRequest.deleteMany({ where: { shop } });
  await db.vendorUser.deleteMany({ where: { shop } });
  await db.vendor.deleteMany({ where: { shop } });
  await db.vendorOrderLine.deleteMany({ where: { shop } });
  await db.loginAttempt.deleteMany({ where: { shop } });
  await db.syncState.deleteMany({ where: { shop } });
  await db.auditLog.deleteMany({ where: { shop } });
}
beforeAll(() => { process.env.PORTAL_URL = "https://vendors.setustore.test"; });
beforeEach(async () => {
  await cleanup();
  await db.shopSetting.create({ data: { shop, adminEmails: [TEAM] } });
});
afterAll(async () => {
  delete process.env.PORTAL_URL;
  await cleanup();
  await db.$disconnect();
});

/** The mails written so far, oldest first, as "template → address". */
const mails = async () => (await db.mailMessage.findMany({ where: { shop }, orderBy: [{ createdAt: "asc" }, { template: "asc" }] })).map((m) => `${m.template} → ${m.toEmail}`).sort();
const mail = (template: string, to?: string) => db.mailMessage.findFirst({ where: { shop, template, ...(to ? { toEmail: to } : {}) }, orderBy: { createdAt: "desc" } });
const forget = () => db.mailMessage.deleteMany({ where: { shop } });

/** A vendor with an owner who has signed up and is active. */
async function vendorWithOwner(vendorName: string, email: string, name = "Owner") {
  const v = await enableVendor(db, shop, vendorName, "test");
  await addVendorUser(db, shop, v.id, email, name, ADMIN);
  const r = await signUp(db, { name, email, password: PW, phone: "+91 98765 43210" }, { shop });
  if (!r.ok) throw new Error("sign-up failed");
  const id = await getIdentity(db, shop, r.token);
  const me: Me = { shop, user: id!.user, vendor: id!.vendor! };
  return { id: v.id, me };
}

/** A stand-in for the mail service: records what it was sent and answers as told. */
function service(answers: (number | "down")[] = []) {
  const calls: { headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetcher = (async (_url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ headers: init.headers, body: JSON.parse(init.body) });
    const a = answers.shift() ?? 200;
    if (a === "down") throw new Error("connect ETIMEDOUT");
    return new Response(JSON.stringify(a === 200 ? { id: `re_${calls.length}` } : { message: a === 422 ? "Invalid `to` field" : "Try later" }), { status: a });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

describe("the mails themselves", () => {
  it("every mail has a subject, words, and reads properly with its example", () => {
    expect(TEMPLATE_KEYS.length).toBe(29);
    for (const key of TEMPLATE_KEYS) {
      const t = TEMPLATES[key] as unknown as { sample: never; audience: string; name: string; when: string; to: string };
      const w = wordsFor(key, t.sample, "https://vendors.setustore.test");
      const full = compose({ toName: "Meera", audience: t.audience, body: w.lines.join("\n"), linkLabel: w.link?.label, linkUrl: w.link?.url });
      const all = `${w.subject}\n${full.text}\n${full.html}`;
      expect(w.subject.length, key).toBeGreaterThan(5);
      expect(w.subject.length, key).toBeLessThanOrEqual(90);
      expect(w.lines.length, key).toBeGreaterThan(0);
      expect(all, key).not.toMatch(/undefined|null|NaN|\[object/);
      // The store's name is always "Setu Store".
      expect(all.replace(/Setu Store/g, ""), key).not.toMatch(/\bSetu\b/);
      expect(full.text.startsWith(t.audience === "seller" ? "Hello Meera," : "Hello,"), key).toBe(true);
      expect([t.name, t.when, t.to].every(Boolean), key).toBe(true);
    }
  });

  it("the two mails the owner didn't want are not there", () => {
    const names = TEMPLATE_KEYS.map((k) => (TEMPLATES[k] as { name: string }).name.toLowerCase()).join("|");
    expect(names).not.toMatch(/summary|incomplete|reminder/);
  });

  it("a mail's words are escaped in the HTML version", () => {
    const w = wordsFor("review_new", { brand: "A<b>", rating: 1, comment: `<script>alert("x")</script>`, author: "M & M" }, "");
    const { html, text } = compose({ toName: "<i>x</i>", audience: "seller", body: w.lines.join("\n") });
    expect(html).not.toMatch(/<script|<i>|<b>/);
    expect(html).toContain("&lt;script&gt;");
    expect(text).toContain("<script>");
  });

  it("order mails carry items and quantities but no money and no buyer", () => {
    const w = wordsFor("order_new", { brand: "Ashnur", orderName: "#1042", orderId: "77", items: [{ title: "Pillar Candle – Rose", quantity: 24 }] }, "https://v.test");
    expect(w.lines.join("\n")).toContain("• 24 × Pillar Candle – Rose");
    expect(w.link).toEqual({ label: "Open the order", url: "https://v.test/portal/orders/77" });
    expect(`${w.subject} ${w.lines.join(" ")}`).not.toMatch(/₹|Rs|\d+\.\d\d/);
  });
});

describe("what really goes out", () => {
  it("nothing without a mail service; outside production only to the test list", () => {
    expect(heldBack("a@b.example", {})).toMatch(/No mail service/);
    const dev = { RESEND_API_KEY: "k", PORTAL_EMAIL_FROM: "x@y.example", NODE_ENV: "development" };
    expect(heldBack("a@b.example", dev)).toMatch(/development copy/);
    expect(heldBack("a@b.example", { ...dev, MAIL_ONLY_TO: "A@b.example, @setustore.test" })).toBeNull();
    expect(heldBack("someone@setustore.test", { ...dev, MAIL_ONLY_TO: "a@b.example, @setustore.test" })).toBeNull();
    expect(heldBack("seller@gmail.example", { ...dev, MAIL_ONLY_TO: "a@b.example, @setustore.test" })).toMatch(/test list/);
    // A domain on the list doesn't let a look-alike through.
    expect(heldBack("x@evilsetustore.test", { ...dev, MAIL_ONLY_TO: "@setustore.test" })).toMatch(/test list/);
    expect(heldBack("a@b.example", LIVE)).toBeNull();
    expect(heldBack("seller@gmail.example", { ...LIVE, MAIL_ONLY_TO: "a@b.example" })).toMatch(/test list/);
    expect(sendingMode({}).real).toBe(false);
    expect(sendingMode(dev).real).toBe(false);
    expect(sendingMode({ ...dev, MAIL_ONLY_TO: "a@b.example" })).toMatchObject({ real: true, text: expect.stringContaining("a@b.example") });
    expect(sendingMode(LIVE)).toMatchObject({ real: true });
  });

  it("the mail service gets the from and reply address, both versions, and an id that stays the same on a retry", async () => {
    const s = service([200]);
    const r = await hand({ id: "m1", to: "a@b.example", subject: "Hi", text: "t", html: "<p>t</p>" }, LIVE, s.fetcher);
    expect(r).toEqual({ status: "sent", providerId: "re_1" });
    expect(s.calls[0].body).toEqual({ from: LIVE.PORTAL_EMAIL_FROM, to: ["a@b.example"], reply_to: "support@setustore.test", subject: "Hi", text: "t", html: "<p>t</p>" });
    expect(s.calls[0].headers).toMatchObject({ Authorization: "Bearer re_test", "Idempotency-Key": "m1" });
  });

  it("a busy or unreachable service is tried again; a refusal is not", async () => {
    const m = { id: "m1", to: "a@b.example", subject: "Hi", text: "t", html: "t" };
    expect(await hand(m, LIVE, service([503]).fetcher)).toMatchObject({ status: "error", again: true });
    expect(await hand(m, LIVE, service([429]).fetcher)).toMatchObject({ status: "error", again: true });
    expect(await hand(m, LIVE, service(["down"]).fetcher)).toMatchObject({ status: "error", again: true, note: expect.stringContaining("ETIMEDOUT") });
    expect(await hand(m, LIVE, service([422]).fetcher)).toMatchObject({ status: "error", again: false, note: expect.stringContaining("Invalid `to` field") });
    const held = service();
    expect(await hand(m, {}, held.fetcher)).toMatchObject({ status: "logged" });
    expect(held.calls).toHaveLength(0);
  });
});

describe("the queue", () => {
  it("writes one mail per address, once, and never the same event twice", async () => {
    const to = [{ email: "A@b.example", name: "A" }, { email: "a@b.example" }, { email: "c@d.example" }];
    expect(await queueMail(db, shop, "signup_approved", to, { brand: "Ashnur" }, { dedupe: "x:1" })).toBe(2);
    expect(await queueMail(db, shop, "signup_approved", to, { brand: "Ashnur" }, { dedupe: "x:1" })).toBe(0);
    expect(await queueMail(db, shop, "signup_approved", to, { brand: "Ashnur" }, { dedupe: "x:2" })).toBe(2);
    expect(await queueMail(db, shop, "signup_approved", [], { brand: "Ashnur" })).toBe(0);
    const first = await mail("signup_approved", "a@b.example");
    expect(first).toMatchObject({ status: "queued", audience: "seller", toName: "A", subject: "You're approved to sell on Setu Store" });
    expect(await db.mailMessage.count({ where: { shop } })).toBe(4);
  });

  it("a mail that is switched off isn't written; a required one can't be switched off", async () => {
    expect(await setTemplateEnabled(db, shop, "review_new", false, ADMIN)).toMatchObject({ ok: true });
    expect(await queueMail(db, shop, "review_new", [{ email: "a@b.example" }], { brand: "A", rating: 5, comment: null, author: "M" })).toBe(0);
    expect(await setTemplateEnabled(db, shop, "review_new", true, ADMIN)).toMatchObject({ ok: true });
    expect(await queueMail(db, shop, "review_new", [{ email: "a@b.example" }], { brand: "A", rating: 5, comment: null, author: "M" })).toBe(1);
    for (const key of ["password_reset", "password_changed", "staff_invite", "login_locked", "person_added"]) {
      expect(await setTemplateEnabled(db, shop, key, false, ADMIN), key).toMatchObject({ ok: false, error: expect.stringContaining("can't be switched off") });
    }
    expect(await setTemplateEnabled(db, shop, "nope", false, ADMIN)).toEqual({ ok: false, error: "Unknown mail" });
    expect((await db.auditLog.findMany({ where: { shop, action: { startsWith: "mail." } } })).map((a) => a.action).sort()).toEqual(["mail.template_off", "mail.template_on"]);
  });

  it("sends what is due and records the service's id", async () => {
    await queueMail(db, shop, "signup_approved", [{ email: "a@b.example", name: "Asha" }], { brand: "Ashnur" }, { env: LIVE });
    const s = service();
    expect(await deliverDue(db, LIVE, new Date(), s.fetcher)).toEqual({ sent: 1, logged: 0, failed: 0, later: 0 });
    expect(await mail("signup_approved")).toMatchObject({ status: "sent", providerId: "re_1", attempts: 1 });
    expect(String(s.calls[0].body.text)).toContain("Hello Asha,");
    expect(String(s.calls[0].body.text)).toContain("Sign in: https://vendors.setustore.test/portal/login");
    // Nothing is sent twice.
    expect(await deliverDue(db, LIVE, new Date(), s.fetcher)).toEqual({ sent: 0, logged: 0, failed: 0, later: 0 });
    expect(s.calls).toHaveLength(1);
  });

  it("without a mail service the mail is kept in the log, marked not sent", async () => {
    await queueMail(db, shop, "signup_approved", [{ email: "a@b.example" }], { brand: "Ashnur" });
    const s = service();
    expect(await deliverDue(db, {}, new Date(), s.fetcher)).toMatchObject({ logged: 1, sent: 0 });
    expect(await mail("signup_approved")).toMatchObject({ status: "logged", note: expect.stringContaining("No mail service") });
    expect(s.calls).toHaveLength(0);
  });

  it("tries again after 1, 5, 30 and 120 minutes, then gives up", async () => {
    await queueMail(db, shop, "signup_approved", [{ email: "a@b.example" }], { brand: "Ashnur" });
    const s = service([503, 503, 503, 503, 503]);
    let now = new Date();
    for (const wait of [1, 5, 30, 120]) {
      expect(await deliverDue(db, LIVE, now, s.fetcher)).toMatchObject({ later: 1 });
      const m = (await mail("signup_approved"))!;
      expect(m.status).toBe("queued");
      expect(Math.round((m.nextAttemptAt.getTime() - now.getTime()) / 60000)).toBe(wait);
      // Not due yet a moment before.
      expect(await deliverDue(db, LIVE, new Date(m.nextAttemptAt.getTime() - 1000), s.fetcher)).toMatchObject({ later: 0, sent: 0, failed: 0 });
      now = m.nextAttemptAt;
    }
    expect(await deliverDue(db, LIVE, now, s.fetcher)).toMatchObject({ failed: 1 });
    expect(await mail("signup_approved")).toMatchObject({ status: "failed", attempts: 5, note: expect.stringContaining("503") });
    expect(s.calls.map((c) => c.headers["Idempotency-Key"]).every((k) => k === s.calls[0].headers["Idempotency-Key"])).toBe(true);
  });

  it("a refusal fails at once; “Send again” puts it back", async () => {
    await queueMail(db, shop, "signup_approved", [{ email: "a@b.example" }], { brand: "Ashnur" });
    expect(await deliverDue(db, LIVE, new Date(), service([422]).fetcher)).toMatchObject({ failed: 1 });
    const failed = (await mail("signup_approved"))!;
    expect(failed.status).toBe("failed");
    expect(await sendAgain(db, shop, failed.id, LIVE)).toEqual({ ok: true });
    expect(await sendAgain(db, shop, failed.id, LIVE)).toMatchObject({ ok: false, error: expect.stringContaining("already waiting") });
    expect(await sendAgain(db, "other.myshopify.com", failed.id, LIVE)).toMatchObject({ ok: false });
    expect(await deliverDue(db, LIVE, new Date(), service().fetcher)).toMatchObject({ sent: 1 });
  });

  it("a mail with a one-time link is sent at once and its link is never kept", async () => {
    const s = service();
    const link = "https://vendors.setustore.test/portal/reset?token=SECRET-TOKEN-123";
    const r = await sendSecret(db, shop, "password_reset", { email: "a@b.example", name: "Asha" }, { link }, { env: LIVE, fetcher: s.fetcher });
    expect(r).toMatchObject({ delivered: true, link });
    expect(String(s.calls[0].body.text)).toContain(link);
    const row = (await mail("password_reset"))!;
    expect(row).toMatchObject({ status: "sent", linkUrl: null });
    expect(JSON.stringify(row)).not.toContain("SECRET-TOKEN-123");
    expect(await sendAgain(db, shop, row.id, LIVE)).toMatchObject({ ok: false, error: expect.stringContaining("one-time link") });
    await expect(sendSecret(db, shop, "password_reset", { email: "a@b.example" }, { link }, { env: LIVE, fetcher: service([422]).fetcher })).rejects.toThrow(/refused/);
    expect(await mail("password_reset")).toMatchObject({ status: "failed" });
  });

  it("reset and invite links: shown on the page only in development, refused in production when they can't be mailed", async () => {
    const link = "https://x.test/portal/reset?token=T";
    const dev = await sendPasswordReset(db, { shop, to: "a@b.example", name: null }, link, { NODE_ENV: "development", PORTAL_DEV_SHOW_EMAILS: "true" });
    expect(dev).toEqual({ delivered: "console", devPreview: { subject: "Reset your Setu Store vendor portal password", link } });
    expect(await sendStaffInvite(db, { shop, to: "a@b.example", name: null }, "Ashnur", "Meera", link, { NODE_ENV: "development" })).toEqual({ delivered: "console" });
    await expect(sendPasswordReset(db, { shop, to: "a@b.example", name: null }, link, { NODE_ENV: "production" })).rejects.toThrow(/No mail service/);
    await expect(sendPasswordReset(db, { shop, to: "a@b.example", name: null }, link, { ...LIVE, MAIL_ONLY_TO: "other@b.example" })).rejects.toThrow(/test list/);
    expect((await db.mailMessage.findMany({ where: { shop } })).every((m) => m.linkUrl === null)).toBe(true);
  });
});

describe("what each event mails", () => {
  it("sign-up: the person and the team; approval and decline: the person", async () => {
    await signUp(db, { name: "Harpreet", email: "h@urban.example", password: PW, phone: "+91 98140 12345" }, { shop });
    expect(await mails()).toEqual([`admin_signup_waiting → ${TEAM}`, "signup_received → h@urban.example"]);
    expect((await mail("admin_signup_waiting"))!.body).toContain("h@urban.example");
    await forget();
    const user = await db.vendorUser.findFirstOrThrow({ where: { shop, email: "h@urban.example" } });
    await approveSignup(db, shop, user.id, "Urban Store", ADMIN);
    expect(await mails()).toEqual(["signup_approved → h@urban.example"]);
    expect(await mail("signup_approved")).toMatchObject({ toName: "Harpreet", vendorId: expect.any(String) });

    await forget();
    await signUp(db, { name: "Spam", email: "s@nowhere.example", password: PW, phone: "+91 90000 00000" }, { shop });
    const spam = await db.vendorUser.findFirstOrThrow({ where: { shop, email: "s@nowhere.example" } });
    await forget();
    await rejectSignup(db, shop, spam.id, ADMIN);
    expect(await mails()).toEqual(["signup_declined → s@nowhere.example"]);
  });

  it("a person the team adds is told how to get in, and isn't mailed again when they create their password", async () => {
    const v = await enableVendor(db, shop, "Ashnur", "test");
    await addVendorUser(db, shop, v.id, "o@ashnur.example", "Asha", ADMIN);
    expect(await mails()).toEqual(["person_added → o@ashnur.example"]);
    expect((await mail("person_added"))!.body).toMatch(/Ashnur/);
    await signUp(db, { name: "Asha", email: "o@ashnur.example", password: PW, phone: "+91 98765 43210" }, { shop });
    expect(await mails()).toEqual(["person_added → o@ashnur.example"]);
  });

  it("no team address: team mails go to nobody, seller mails still go", async () => {
    await db.shopSetting.update({ where: { shop }, data: { adminEmails: [] } });
    await signUp(db, { name: "Harpreet", email: "h@urban.example", password: PW, phone: "+91 98140 12345" }, { shop });
    expect(await mails()).toEqual(["signup_received → h@urban.example"]);
  });

  it("pausing and reactivating a vendor tells its owners, once", async () => {
    const { id } = await vendorWithOwner("Ashnur", "o@ashnur.example");
    await forget();
    await setVendorStatus(db, shop, id, "paused", ADMIN);
    await setVendorStatus(db, shop, id, "paused", ADMIN);
    expect(await mails()).toEqual(["vendor_paused → o@ashnur.example"]);
    await setVendorStatus(db, shop, id, "active", ADMIN);
    expect(await mails()).toEqual(["vendor_active → o@ashnur.example", "vendor_paused → o@ashnur.example"]);
  });

  it("business change: the vendor and the team when it is sent, the owners when it is decided", async () => {
    const { id, me } = await vendorWithOwner("Ashnur", "o@ashnur.example");
    await forget();
    const form = { companyName: "Ashnur Crafts LLP", addressLine: "5 Mall Road", city: "Jaipur", state: "Rajasthan", postalCode: "302001" };
    expect(await requestBusinessChange(db, me, form)).toEqual({ ok: true });
    expect(await mails()).toEqual([`admin_change_waiting → ${TEAM}`, "change_submitted → o@ashnur.example"]);
    expect((await mail("admin_change_waiting"))!.body).toMatch(/Ashnur/);
    // Editing the waiting request mails nobody again.
    await requestBusinessChange(db, me, { ...form, city: "Udaipur" });
    expect(await mails()).toHaveLength(2);
    await forget();
    const req = await db.vendorChangeRequest.findFirstOrThrow({ where: { shop, vendorId: id, status: "pending" } });
    await reviewBusinessChange(db, shop, req.id, "reject", "The GST certificate is unreadable.", ADMIN);
    expect(await mails()).toEqual(["change_declined → o@ashnur.example"]);
    expect((await mail("change_declined"))!.body).toContain("The GST certificate is unreadable.");
    await forget();
    await requestBusinessChange(db, me, form);
    await forget();
    const again = await db.vendorChangeRequest.findFirstOrThrow({ where: { shop, vendorId: id, status: "pending" } });
    await reviewBusinessChange(db, shop, again.id, "approve", null, ADMIN);
    expect(await mails()).toEqual(["change_approved → o@ashnur.example"]);
  });

  it("the team changing a vendor's details or commission tells the owners; saving without a change doesn't", async () => {
    const { id } = await vendorWithOwner("Ashnur", "o@ashnur.example");
    await forget();
    expect(await adminUpdateDetails(db, shop, id, { displayName: "Ashnur" }, ADMIN)).toEqual({ ok: true });
    expect(await mails()).toEqual([]);
    await adminUpdateDetails(db, shop, id, { displayName: "Ashnur Home" }, ADMIN);
    expect(await mails()).toEqual(["details_changed_by_team → o@ashnur.example"]);
    await forget();
    await setCommissionRate(db, shop, id, "12.5", ADMIN);
    expect(await mails()).toEqual(["commission_set → o@ashnur.example"]);
    expect((await mail("commission_set"))!.body).toContain("12.5%");
  });

  it("staff: told when their access changes or ends, in words that fit", async () => {
    const { id, me } = await vendorWithOwner("Ashnur", "o@ashnur.example");
    const added = await addStaff(db, me, { email: "helper@ashnur.example", name: "Helper", access: "view" });
    if (!added.ok) throw new Error("not added");
    await resetPassword(db, await createInviteLink(db, added.userId, { shop }), PW, { shop });
    await forget();
    await ownerUpdateStaff(db, me, added.userId, { access: "edit" });
    expect((await mail("access_changed", "helper@ashnur.example"))!.body).toContain("You can now view and change things for Ashnur");
    await ownerUpdateStaff(db, me, added.userId, { status: "disabled" });
    expect((await mail("access_changed", "helper@ashnur.example"))!.body).toContain("was deactivated");
    await adminUpdateUser(db, shop, added.userId, { status: "active" }, ADMIN);
    expect((await mail("access_changed", "helper@ashnur.example"))!.body).toContain("is active again");
    await adminUpdateUser(db, shop, added.userId, { role: "owner" }, ADMIN);
    expect((await mail("access_changed", "helper@ashnur.example"))!.body).toContain("You are now an owner of Ashnur");
    await adminUpdateUser(db, shop, added.userId, { role: "staff" }, ADMIN);
    await forget();
    await ownerRemoveStaff(db, me, added.userId);
    expect((await mail("access_changed", "helper@ashnur.example"))!.body).toContain("was removed");
    await forget();
    const owner = await db.vendorUser.findFirstOrThrow({ where: { shop, vendorId: id, role: "owner" } });
    await removeVendorUser(db, shop, owner.id, ADMIN);
    expect(await mails()).toEqual(["access_changed → o@ashnur.example"]);
    expect(accessSentence("Ashnur", { status: "active", role: "staff", access: "view" }, { access: "view" })).toBeNull();
    expect(accessSentence("Ashnur", { status: "active", role: "owner", access: "view" }, { access: "edit" })).toBeNull();
  });

  it("a first password from an invite mails nothing; a real password change does; a locked sign-in mails once", async () => {
    await vendorWithOwner("Ashnur", "o@ashnur.example");
    await forget();
    const r = await requestPasswordReset(db, "o@ashnur.example", { shop });
    if (r.status !== "sent") throw new Error("no reset");
    expect(await resetPassword(db, r.token, "Another-strong-password-2", { shop })).toEqual({ ok: true });
    expect(await mails()).toEqual(["password_changed → o@ashnur.example"]);
    await forget();
    for (let i = 0; i < LOCK_FAILS + 3; i++) await signIn(db, "o@ashnur.example", "wrong-password", { shop });
    expect(await mails()).toEqual(["login_locked → o@ashnur.example"]);
    expect((await mail("login_locked"))!.body).toContain("15 minutes");
    // An address without an account is never mailed.
    for (let i = 0; i < LOCK_FAILS + 2; i++) await signIn(db, "nobody@nowhere.example", "wrong-password", { shop });
    expect(await mails()).toEqual(["login_locked → o@ashnur.example"]);
  });

  it("a new order mails everyone active on each vendor's team, one mail per order, with only that vendor's items", async () => {
    const { me } = await vendorWithOwner("Ashnur", "o@ashnur.example");
    await vendorWithOwner("Urban Store", "o@urban.example");
    const staff = await addStaff(db, me, { email: "packer@ashnur.example", name: "Packer", access: "view" });
    if (!staff.ok) throw new Error("not added");
    await resetPassword(db, await createInviteLink(db, staff.userId, { shop }), PW, { shop });
    await forget();
    const list = orders();
    const o = list[2]; // #1003: both vendors
    await syncOrder(db, fakeShopify(list), shop, o.id, "webhook:orders/create");
    expect(await mails()).toEqual(["order_new → o@ashnur.example", "order_new → o@urban.example", "order_new → packer@ashnur.example"]);
    const ashnur = (await mail("order_new", "o@ashnur.example"))!;
    expect(ashnur.subject).toBe("New order #1003 for Ashnur");
    expect(ashnur.body.split("\n").filter((l) => l.startsWith("•"))).toHaveLength(2);
    expect(ashnur.linkUrl).toBe("https://vendors.setustore.test/portal/orders/19043720298605");
    const urban = (await mail("order_new", "o@urban.example"))!;
    expect(urban.body).not.toMatch(new RegExp(ashnur.body.split("\n").find((l) => l.startsWith("•"))!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    // Shopify reports the same order again (orders/updated right after orders/create): no second mail.
    await syncOrder(db, fakeShopify(list), shop, o.id, "webhook:orders/updated");
    expect(await mails()).toHaveLength(3);
  });

  it("no order mail for: a vendor without portal access, a paused vendor, an old order, a cancelled order, or a full resync", async () => {
    const { id } = await vendorWithOwner("Ashnur", "o@ashnur.example");
    await forget();
    const list = orders();
    // Urban Store has no portal access: only Ashnur is mailed.
    await syncOrder(db, fakeShopify(list), shop, list[3].id, "webhook:orders/create");
    expect(await mails()).toEqual(["order_new → o@ashnur.example"]);
    await forget();
    // Cancelled before the app ever saw it.
    await syncOrder(db, fakeShopify(list), shop, list[4].id, "webhook:orders/create");
    expect(await mails()).toEqual([]);
    // An order from last month arriving late.
    const old = structuredClone(list[2]);
    old.createdAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await syncOrder(db, fakeShopify([old]), shop, old.id, "webhook:orders/updated");
    expect(await mails()).toEqual([]);
    // Paused vendor.
    await db.vendorOrderLine.deleteMany({ where: { shop } });
    await setVendorStatus(db, shop, id, "paused", ADMIN);
    await forget();
    await syncOrder(db, fakeShopify(list), shop, list[2].id, "webhook:orders/create");
    expect(await mails()).toEqual([]);
    // The full resync copies every order and mails nobody.
    await setVendorStatus(db, shop, id, "active", ADMIN);
    await db.vendorOrderLine.deleteMany({ where: { shop } });
    await forget();
    await fullSync(db, fakeShopify(list), shop, "test");
    expect(await db.vendorOrderLine.count({ where: { shop } })).toBe(12);
    expect(await mails()).toEqual([]);
  });

  it("an order that changes mails the vendor once for each real change; shipping it mails nobody", async () => {
    await vendorWithOwner("Ashnur", "o@ashnur.example");
    const list = orders();
    const o = list[2]; // #1003, Ashnur: 5 + 2 units
    await saveOrder(db, shop, o, "test");
    await forget();
    // Shipped: nothing.
    o.lineItems.nodes[2].unfulfilledQuantity = 0;
    await syncOrder(db, fakeShopify([o]), shop, o.id, "webhook:orders/fulfilled");
    expect(await mails()).toEqual([]);

    // A quantity edited down, without a refund.
    o.lineItems.nodes[3].currentQuantity = 1;
    o.lineItems.nodes[3].unfulfilledQuantity = 1;
    await syncOrder(db, fakeShopify([o]), shop, o.id, "webhook:orders/updated");
    await syncOrder(db, fakeShopify([o]), shop, o.id, "webhook:orders/updated");
    expect(await mails()).toEqual(["order_changed → o@ashnur.example"]);
    expect((await mail("order_changed"))!.body).toContain("items or quantities on this order were changed");

    // Cancelled.
    o.cancelledAt = new Date().toISOString();
    for (const l of o.lineItems.nodes) { l.currentQuantity = 0; l.unfulfilledQuantity = 0; }
    await syncOrder(db, fakeShopify([o]), shop, o.id, "webhook:orders/cancelled");
    await syncOrder(db, fakeShopify([o]), shop, o.id, "webhook:orders/updated");
    expect(await mails()).toEqual(["order_changed → o@ashnur.example", "order_changed → o@ashnur.example"]);
    expect((await mail("order_changed"))!.body).toContain("was cancelled");
  });

  it("a vendor whose item is added to an older order hears of it as a new order", async () => {
    await vendorWithOwner("Ashnur", "o@ashnur.example");
    const o = orders()[2];
    o.createdAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    const ashnurLines = o.lineItems.nodes.filter((l) => l.vendor === "Ashnur");
    o.lineItems.nodes = o.lineItems.nodes.filter((l) => l.vendor !== "Ashnur");
    await saveOrder(db, shop, o, "test");
    await forget();
    o.lineItems.nodes.push(ashnurLines[0]);
    await syncOrder(db, fakeShopify([o]), shop, o.id, "webhook:orders/edited");
    expect(await mails()).toEqual(["order_new → o@ashnur.example"]);
  });

  it("a vendor's items removed from an order tells that vendor", async () => {
    await vendorWithOwner("Ashnur", "o@ashnur.example");
    const o = orders()[2];
    await saveOrder(db, shop, o, "test");
    await forget();
    o.lineItems.nodes = o.lineItems.nodes.filter((l) => l.vendor !== "Ashnur");
    await syncOrder(db, fakeShopify([o]), shop, o.id, "webhook:orders/updated");
    expect(await mails()).toEqual(["order_changed → o@ashnur.example"]);
    expect((await mail("order_changed"))!.body).toContain("Your items were removed");
  });

  it("a review mails the owners; a low one also the team; changing it mails nobody; hiding and showing tell the owners", async () => {
    const { id } = await vendorWithOwner("Urban Store", "o@urban.example");
    for (const o of orders()) await saveOrder(db, shop, o, "test");
    await forget();
    const O1004 = 19043720364141n;
    const first = await submitReview(db, shop, { vendorId: id, customerId: 501n, orderIds: [O1004], rating: 5, comment: "Lovely finish.", authorName: "Meera" });
    expect(first.ok).toBe(true);
    expect(await mails()).toEqual(["review_new → o@urban.example"]);
    expect((await mail("review_new"))!.body).toContain("Lovely finish.");
    // Changed to another good rating: nobody is mailed. Lowered to 1 star: the team is told, the vendor isn't mailed again.
    await submitReview(db, shop, { vendorId: id, customerId: 501n, orderIds: [O1004], rating: 4, comment: "Still good.", authorName: "Meera" });
    expect(await mails()).toEqual(["review_new → o@urban.example"]);
    await submitReview(db, shop, { vendorId: id, customerId: 501n, orderIds: [O1004], rating: 1, comment: "Changed my mind.", authorName: "Meera" });
    await submitReview(db, shop, { vendorId: id, customerId: 501n, orderIds: [O1004], rating: 2, comment: "Changed my mind again.", authorName: "Meera" });
    expect(await mails()).toEqual([`admin_low_review → ${TEAM}`, "review_new → o@urban.example"]);
    await forget();
    await submitReview(db, shop, { vendorId: id, customerId: 502n, orderIds: [O1004], rating: 2, comment: "Arrived scratched.", authorName: "Dev" });
    expect(await mails()).toEqual([`admin_low_review → ${TEAM}`, "review_new → o@urban.example"]);
    await forget();
    const review = await db.vendorReview.findFirstOrThrow({ where: { shop, vendorId: id, customerId: 502n } });
    await setReviewHidden(db, shop, id, review.id, true, ADMIN, "Abusive language");
    await setReviewHidden(db, shop, id, review.id, true, ADMIN, "Abusive language");
    expect(await mails()).toEqual(["review_hidden → o@urban.example"]);
    expect((await mail("review_hidden"))!.body).toContain("Abusive language");
    await setReviewHidden(db, shop, id, review.id, false, ADMIN);
    expect(await mails()).toEqual(["review_hidden → o@urban.example", "review_shown → o@urban.example"]);
  });

  it("things that break mail the team at most once a day each", async () => {
    const broken = (async () => { throw new Error("Shopify is unreachable"); }) as never;
    await expect(fullSync(db, broken, shop, "test")).rejects.toThrow();
    await expect(fullSync(db, broken, shop, "test")).rejects.toThrow();
    expect(await mails()).toEqual([`admin_sync_failed → ${TEAM}`]);
    expect((await mail("admin_sync_failed"))!.body).toContain("Shopify is unreachable");
    await mailStoreCopyFailed(db, shop, "the store listing of Ashnur", "Access denied");
    await mailStoreCopyFailed(db, shop, "the store listing of Ashnur", "Access denied");
    await mailStoreCopyFailed(db, shop, "the store listing of Urban Store", "Access denied");
    expect((await mails()).filter((m) => m.startsWith("admin_store_copy_failed"))).toHaveLength(2);
    // Tomorrow it may be said again.
    await mailStoreCopyFailed(db, shop, "the store listing of Ashnur", "Access denied", new Date(Date.now() + 24 * 60 * 60 * 1000));
    expect((await mails()).filter((m) => m.startsWith("admin_store_copy_failed"))).toHaveLength(3);
  });

  it("a mail that can't be written never undoes what was done", async () => {
    // The mail table is unreachable; everything else works.
    let tried = 0;
    const noMail = new Proxy(db, {
      get: (target, key) => (key === "mailMessage" ? { createMany: async () => { tried++; throw new Error("mail table is down"); } } : Reflect.get(target, key)),
    });
    const quiet = console.error;
    console.error = () => {};
    try {
      const r = await signUp(noMail, { name: "Harpreet", email: "h@urban.example", password: PW, phone: "+91 98140 12345" }, { shop });
      expect(r.ok).toBe(true);
    } finally {
      console.error = quiet;
    }
    expect(tried).toBeGreaterThan(0);
    expect(await db.vendorUser.count({ where: { shop, email: "h@urban.example" } })).toBe(1);
    expect(await mails()).toEqual([]);
  });
});

describe("orders not shipped in time", () => {
  const DAY = 24 * 60 * 60 * 1000;
  it("reminds the vendor once per order and sends the team one list, once a day", async () => {
    const { id } = await vendorWithOwner("Ashnur", "o@ashnur.example");
    await vendorWithOwner("Urban Store", "o@urban.example"); // no processing time given: never late
    await db.vendor.update({ where: { id }, data: { processingDaysMin: 2, processingDaysMax: 3 } });
    const list = orders();
    for (const o of list) o.createdAt = new Date(Date.now() - 5 * DAY).toISOString();
    for (const o of list) await saveOrder(db, shop, o, "test");
    await forget();
    const nine = new Date(`${new Date().toISOString().slice(0, 10)}T04:00:00Z`); // 9:30 in India

    const late = await overdueOrders(db, shop, nine);
    // #1003 (7 units) and #1004 (3 units) are Ashnur's and unshipped; #1005 is cancelled.
    expect(late.map((o) => `${o.orderName}:${o.units}`).sort()).toEqual(["#1003:7", "#1004:3"]);

    expect(await runDailyChecks(db, shop, new Date(nine.getTime() - 2 * 60 * 60 * 1000))).toBe(false); // before 9 in India
    expect(await runDailyChecks(db, shop, nine)).toBe(true);
    expect(await runDailyChecks(db, shop, new Date(nine.getTime() + 60 * 60 * 1000))).toBe(false);
    expect(await mails()).toEqual([`admin_orders_overdue → ${TEAM}`, "order_overdue → o@ashnur.example", "order_overdue → o@ashnur.example"]);
    const team = (await mail("admin_orders_overdue"))!;
    expect(team.subject).toBe("2 orders are past the processing time");
    expect(team.body).toMatch(/#1003, Ashnur: placed [45] days ago, 7 to ship/);

    // Next day: the team gets a new list, the vendor isn't reminded about the same orders again.
    expect(await runDailyChecks(db, shop, new Date(nine.getTime() + DAY))).toBe(true);
    expect((await mails()).filter((m) => m.startsWith("order_overdue"))).toHaveLength(2);
    expect((await mails()).filter((m) => m.startsWith("admin_orders_overdue"))).toHaveLength(2);
  });

  it("the daily run clears mails older than half a year from the log", async () => {
    const row = { shop, template: "signup_approved", audience: "seller", toEmail: "a@b.example", subject: "s", body: "b", status: "sent" as const };
    await db.mailMessage.create({ data: { ...row, createdAt: new Date(Date.now() - 181 * DAY) } });
    await db.mailMessage.create({ data: { ...row, createdAt: new Date(Date.now() - 179 * DAY) } });
    await runDailyChecks(db, shop, new Date(), { anyHour: true });
    expect(await db.mailMessage.count({ where: { shop } })).toBe(1);
  });

  it("nothing late: nothing is mailed", async () => {
    const { id } = await vendorWithOwner("Ashnur", "o@ashnur.example");
    await db.vendor.update({ where: { id }, data: { processingDaysMin: 2, processingDaysMax: 3 } });
    for (const o of orders()) await saveOrder(db, shop, o, "test");
    await forget();
    expect(await runDailyChecks(db, shop, new Date(), { anyHour: true })).toBe(true);
    expect(await mails()).toEqual([]);
  });
});

describe("what the mail service reports back", () => {
  const secret = `whsec_${Buffer.from("a-test-signing-secret").toString("base64")}`;
  const sign = (body: string, at = Math.floor(Date.now() / 1000), id = "msg_1", key = secret) => {
    const sig = createHmac("sha256", Buffer.from(key.replace("whsec_", ""), "base64")).update(`${id}.${at}.${body}`).digest("base64");
    return new Headers({ "svix-id": id, "svix-timestamp": String(at), "svix-signature": `v1,${sig}` });
  };

  it("only a correctly signed, recent report is believed", () => {
    const body = JSON.stringify({ type: "email.delivered", data: { email_id: "re_1" } });
    expect(signedByResend(secret, sign(body), body)).toBe(true);
    expect(signedByResend(secret, sign(body), `${body} `)).toBe(false);
    expect(signedByResend(secret, sign(body, Math.floor(Date.now() / 1000) - 600), body)).toBe(false);
    expect(signedByResend(secret, sign(body, undefined, "msg_1", `whsec_${Buffer.from("another-secret").toString("base64")}`), body)).toBe(false);
    expect(signedByResend(undefined, sign(body), body)).toBe(false);
    expect(signedByResend(secret, new Headers(), body)).toBe(false);
    // Several signatures in the header (after the secret was rotated): one good one is enough.
    const h = sign(body);
    h.set("svix-signature", `v1,AAAA ${h.get("svix-signature")}`);
    expect(signedByResend(secret, h, body)).toBe(true);
  });

  it("the route refuses an unsigned report and applies a signed one", async () => {
    const { action } = await import("../app/routes/webhooks.resend");
    await queueMail(db, shop, "signup_approved", [{ email: "a@b.example" }], { brand: "Ashnur" });
    await deliverDue(db, LIVE, new Date(), service().fetcher);
    const body = JSON.stringify({ type: "email.delivered", data: { email_id: "re_1" } });
    const post = (headers: Headers) => action({ request: new Request("https://app.test/webhooks/resend", { method: "POST", body, headers }), params: {}, context: {} } as never);
    process.env.RESEND_WEBHOOK_SECRET = secret;
    try {
      expect(((await post(new Headers())) as Response).status).toBe(401);
      expect(await mail("signup_approved")).toMatchObject({ status: "sent" });
      expect(((await post(sign(body))) as Response).status).toBe(200);
      expect(await mail("signup_approved")).toMatchObject({ status: "delivered" });
    } finally {
      delete process.env.RESEND_WEBHOOK_SECRET;
    }
  });

  it("a seller's address that refuses mail is marked and the team is told, once a day for that address", async () => {
    const { id } = await vendorWithOwner("Ashnur", "o@ashnur.example");
    await forget();
    await queueMail(db, shop, "vendor_paused", [{ email: "o@ashnur.example" }], { brand: "Ashnur" }, { vendorId: id });
    await queueMail(db, shop, "vendor_active", [{ email: "o@ashnur.example" }], { brand: "Ashnur" }, { vendorId: id });
    await deliverDue(db, LIVE, new Date(), service().fetcher);
    expect(await applyReport(db, { type: "email.bounced", data: { email_id: "re_1", bounce: { message: "Mailbox does not exist" } } })).toBe("bounced");
    expect(await applyReport(db, { type: "email.bounced", data: { email_id: "re_2" } })).toBe("bounced");
    expect(await applyReport(db, { type: "email.bounced", data: { email_id: "re_2" } })).toBe("ignored");
    expect(await mail("vendor_paused")).toMatchObject({ status: "bounced", note: "The address refused it: Mailbox does not exist" });
    // A late "delivered" doesn't undo a bounce.
    expect(await applyReport(db, { type: "email.delivered", data: { email_id: "re_1" } })).toBe("ignored");
    expect((await mails()).filter((m) => m.startsWith("admin_email_bouncing"))).toEqual([`admin_email_bouncing → ${TEAM}`]);
    expect((await mail("admin_email_bouncing"))!.body).toMatch(/o@ashnur\.example/);
    expect(await applyReport(db, { type: "email.delivered", data: { email_id: "re_unknown" } })).toBe("ignored");
    expect(await applyReport(db, { type: "email.opened", data: { email_id: "re_1" } })).toBe("ignored");
    expect(await applyReport(db, {})).toBe("ignored");
  });

  it("a bouncing team address doesn't mail the team about itself", async () => {
    await queueMail(db, shop, "admin_sync_failed", [{ email: TEAM }], { error: "x" });
    await deliverDue(db, LIVE, new Date(), service().fetcher);
    await applyReport(db, { type: "email.bounced", data: { email_id: "re_1" } });
    expect(await mails()).toEqual([`admin_sync_failed → ${TEAM}`]);
  });
});

describe("the Mail page", () => {
  it("lists every mail with its example, grouped for sellers and for the team", async () => {
    await setTemplateEnabled(db, shop, "review_new", false, ADMIN);
    const list = await mailTemplates(db, shop, LIVE);
    expect(list).toHaveLength(TEMPLATE_KEYS.length);
    expect(list.filter((t) => t.audience === "admin").map((t) => t.key)).toEqual(TEMPLATE_KEYS.filter((k) => k.startsWith("admin_")));
    expect(list.find((t) => t.key === "review_new")).toMatchObject({ enabled: false, required: false });
    expect(list.find((t) => t.key === "password_reset")).toMatchObject({ enabled: true, required: true, secret: true });
    expect(list.find((t) => t.key === "order_new")!.preview.text).toContain("https://vendors.setustore.test/portal/orders/1");
    expect(new Set(list.map((t) => t.group))).toEqual(new Set(["Account", "Profile", "Orders", "Reviews", "Team alerts"]));
  });

  it("team addresses: cleaned, checked, limited, and recorded", async () => {
    expect(cleanAddresses(" A@b.example,\n c@d.example ; a@b.example ")).toEqual({ list: ["a@b.example", "c@d.example"] });
    expect(cleanAddresses("not-an-address").error).toMatch(/isn't a valid email address/);
    expect(cleanAddresses(Array.from({ length: 11 }, (_, i) => `t${i}@b.example`).join("\n")).error).toMatch(/Up to 10/);
    expect(await saveTeamAddresses(db, shop, "bad", ADMIN)).toMatchObject({ ok: false });
    expect(await saveTeamAddresses(db, shop, "one@setustore.test\nTwo@setustore.test", ADMIN)).toMatchObject({ ok: true });
    expect((await mailNumbers(db, shop)).team).toEqual(["one@setustore.test", "two@setustore.test"]);
    expect(await saveTeamAddresses(db, shop, "", ADMIN)).toMatchObject({ ok: true, message: expect.stringContaining("nobody") });
    expect((await mailNumbers(db, shop)).team).toEqual([]);
    // The delivery time saved on the same row is left alone.
    await db.shopSetting.update({ where: { shop }, data: { deliveryDaysMin: 3, deliveryDaysMax: 5 } });
    await saveTeamAddresses(db, shop, "one@setustore.test", ADMIN);
    expect(await db.shopSetting.findUnique({ where: { shop } })).toMatchObject({ deliveryDaysMin: 3, deliveryDaysMax: 5, adminEmails: ["one@setustore.test"] });
  });

  it("a test is sent at once, says “Test” in the subject, works for a switched-off mail, and says when it wasn't really sent", async () => {
    await setTemplateEnabled(db, shop, "review_new", false, ADMIN);
    const s = service();
    expect(await sendTest(db, shop, "review_new", "Me@setustore.test", LIVE, s.fetcher)).toEqual({ ok: true, message: "Test of “New review” sent to me@setustore.test." });
    expect(s.calls[0].body).toMatchObject({ to: ["me@setustore.test"], subject: expect.stringMatching(/^Test: /) });
    expect(await sendTest(db, shop, "review_new", "me@setustore.test", {}, s.fetcher)).toMatchObject({ ok: false, error: expect.stringContaining("wasn't really sent") });
    expect(await sendTest(db, shop, "review_new", "me@setustore.test", { ...LIVE, NODE_ENV: "development" }, s.fetcher)).toMatchObject({ ok: false, error: expect.stringContaining("the list is empty") });
    expect(await sendTest(db, shop, "review_new", "me@setustore.test", LIVE, service([422]).fetcher)).toMatchObject({ ok: false, error: expect.stringContaining("couldn't be sent") });
    expect(await sendTest(db, shop, "review_new", "nope", LIVE, s.fetcher)).toMatchObject({ ok: false });
    expect(await sendTest(db, shop, "nope", "me@setustore.test", LIVE, s.fetcher)).toMatchObject({ ok: false });
    expect(s.calls).toHaveLength(1);
  });

  it("the log filters by status, mail and address, and only this shop's mails", async () => {
    await queueMail(db, shop, "signup_approved", [{ email: "a@b.example" }, { email: "c@d.example" }], { brand: "Ashnur" });
    await deliverDue(db, LIVE, new Date(), service([200, 422]).fetcher);
    await queueMail(db, shop, "vendor_paused", [{ email: "a@b.example" }], { brand: "Ashnur" });
    await queueMail(db, "other-mail-test.myshopify.com", "vendor_paused", [{ email: "a@b.example" }], { brand: "Other" });
    try {
      const all = await mailLog(db, shop);
      expect(all.total).toBe(3);
      expect(all.rows.map((r) => r.status).sort()).toEqual(["failed", "queued", "sent"]);
      expect((await mailLog(db, shop, { status: "failed" })).rows.map((r) => [r.to, r.canSendAgain])).toEqual([["c@d.example", true]]);
      expect((await mailLog(db, shop, { status: "sent" })).rows[0]).toMatchObject({ to: "a@b.example", canSendAgain: false, mail: "Sign-up approved" });
      expect((await mailLog(db, shop, { template: "vendor_paused" })).total).toBe(1);
      expect((await mailLog(db, shop, { to: "C@D" })).total).toBe(1);
      expect((await mailLog(db, shop, { status: "nonsense", template: "nonsense" })).total).toBe(3);
      expect(await mailNumbers(db, shop)).toMatchObject({ sent: 1, waiting: 1, failed: 1, bounced: 0 });
    } finally {
      await db.mailMessage.deleteMany({ where: { shop: "other-mail-test.myshopify.com" } });
    }
  });

  it("the dashboard warns about mails that failed and about a missing team address", async () => {
    await queueMail(db, shop, "signup_approved", [{ email: "a@b.example" }], { brand: "Ashnur" });
    await deliverDue(db, LIVE, new Date(), service([422]).fetcher);
    let d = await dashboard(db, shop);
    expect(d.alerts.find((a) => a.key === "mail_failed")).toMatchObject({ tone: "critical", href: "/app/mail?view=log&status=failed", text: "1 mail couldn't be sent in the last 7 days" });
    expect(d.alerts.find((a) => a.key === "mail_no_team")).toBeUndefined();
    expect(d.numbers.mail).toEqual({ sent: 0, waiting: 0, failed: 1, bounced: 0 });
    await saveTeamAddresses(db, shop, "", ADMIN);
    d = await dashboard(db, shop);
    expect(d.alerts.find((a) => a.key === "mail_no_team")).toMatchObject({ tone: "warning", href: "/app/mail?view=team" });
  });
});

describe("mail settings saved in the app", () => {
  // What the server itself has: a secret to protect saved keys with, and nothing about mail.
  const SERVER = { SHOPIFY_API_SECRET: "server-secret-for-tests", NODE_ENV: "production", PORTAL_URL: "https://vendors.setustore.test" };
  const KEY = "re_AbCdEfGh_123456789";
  const full = { apiKey: KEY, fromName: "Setu Store", fromAddress: "Support@SetuStore.test", replyTo: "help@setustore.test", onlyTo: "" };
  /** Resend's answer to "which domains does this key have?" */
  const resend = (status: number, body: unknown) => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetcher = (async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      if (status === -1) throw new Error("connect ETIMEDOUT");
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { calls, fetcher };
  };
  const domains = (...list: [string, string][]) => ({ object: "list", has_more: false, data: list.map(([name, status]) => ({ id: name, name, status })) });
  const item = (list: Awaited<ReturnType<typeof checkMailSettings>>, what: string) => list.find((c) => c.what === what);

  it("a secret is stored sealed: unreadable without the server's secret, and useless if altered", () => {
    const sealed = seal(KEY, SERVER)!;
    expect(sealed).not.toContain(KEY);
    expect(sealed).not.toBe(seal(KEY, SERVER)); // a fresh seal every time
    expect(unseal(sealed, SERVER)).toBe(KEY);
    expect(unseal(sealed, { SHOPIFY_API_SECRET: "another-secret" })).toBeNull();
    expect(unseal(sealed.slice(0, -4) + "AAAA", SERVER)).toBeNull();
    expect(unseal("nonsense", SERVER)).toBeNull();
    expect(unseal(null, SERVER)).toBeNull();
    expect(seal(KEY, {})).toBeNull();
  });

  it("saves the key, sender, reply address and test list; the key never comes back out", async () => {
    expect(await saveMailSettings(db, shop, { ...full, onlyTo: "Me@SetuStore.test\n@setustore.test" }, ADMIN, SERVER)).toEqual({ ok: true, message: "Saved: key, sender, reply address, test list." });
    const row = await db.mailSetting.findUniqueOrThrow({ where: { shop } });
    expect(row).toMatchObject({ apiKeyHint: "6789", fromName: "Setu Store", fromAddress: "support@setustore.test", replyTo: "help@setustore.test", onlyTo: ["me@setustore.test", "@setustore.test"], updatedBy: ADMIN });
    expect(JSON.stringify(row)).not.toContain(KEY);
    const shown = await mailSettings(db, shop, SERVER);
    expect(JSON.stringify(shown)).not.toContain(KEY);
    expect(shown).toMatchObject({
      key: { source: "app", hint: "6789", unreadable: false }, fromName: "Setu Store", fromAddress: "support@setustore.test", fromSource: "app",
      replyTo: "help@setustore.test", onlyTo: ["me@setustore.test", "@setustore.test"], onlyToSource: "app", webhook: { source: "none" },
      webhookUrl: "https://vendors.setustore.test/webhooks/resend", production: true, canStoreSecrets: true, updatedBy: "team@setustore.test",
    });
    // What the sender works with.
    expect(await mailEnv(db, shop, SERVER)).toMatchObject({
      RESEND_API_KEY: KEY, PORTAL_EMAIL_FROM: "Setu Store <support@setustore.test>", PORTAL_EMAIL_REPLY_TO: "help@setustore.test", MAIL_ONLY_TO: "me@setustore.test,@setustore.test", NODE_ENV: "production",
    });
    // The record says what changed, never the values.
    const said = await db.auditLog.findFirstOrThrow({ where: { shop, action: "mail.settings_updated" } });
    expect(said.detail).toEqual({ changed: ["key", "sender", "reply address", "test list"] });
    expect(JSON.stringify(said.detail)).not.toContain(KEY);
  });

  it("an empty key keeps the saved one; ticking “remove” deletes it; saving the same again changes nothing", async () => {
    await saveMailSettings(db, shop, full, ADMIN, SERVER);
    const rest = { ...full, apiKey: "" };
    expect(await saveMailSettings(db, shop, rest, ADMIN, SERVER)).toEqual({ ok: true, message: "Nothing was changed." });
    expect((await mailEnv(db, shop, SERVER)).RESEND_API_KEY).toBe(KEY);
    expect(await saveMailSettings(db, shop, { ...rest, fromName: "Setu Store Sellers" }, ADMIN, SERVER)).toEqual({ ok: true, message: "Saved: sender." });
    expect((await mailEnv(db, shop, SERVER)).PORTAL_EMAIL_FROM).toBe("Setu Store Sellers <support@setustore.test>");
    expect(await saveMailSettings(db, shop, { ...rest, removeApiKey: true }, ADMIN, SERVER)).toMatchObject({ ok: true, message: expect.stringContaining("key removed") });
    expect((await mailEnv(db, shop, SERVER)).RESEND_API_KEY).toBeUndefined();
    expect((await mailSettings(db, shop, SERVER)).key).toEqual({ source: "none", hint: null, unreadable: false });
  });

  it("a value saved here wins over the server's; an empty one goes back to the server's", async () => {
    const server = { ...SERVER, RESEND_API_KEY: "re_from_the_server_1", PORTAL_EMAIL_FROM: "Old Name <old@setustore.test>", PORTAL_EMAIL_REPLY_TO: "old-reply@setustore.test", MAIL_ONLY_TO: "x@setustore.test" };
    expect(await mailSettings(db, shop, server)).toMatchObject({
      key: { source: "server", hint: null }, fromName: "Old Name", fromAddress: "old@setustore.test", fromSource: "server", replyTo: "old-reply@setustore.test", replySource: "server", onlyTo: ["x@setustore.test"], onlyToSource: "server",
    });
    expect(await mailEnv(db, shop, server)).toBe(server); // nothing saved: the server's values as they are
    await saveMailSettings(db, shop, { ...full, onlyTo: "y@setustore.test" }, ADMIN, server);
    expect(await mailEnv(db, shop, server)).toMatchObject({ RESEND_API_KEY: KEY, PORTAL_EMAIL_FROM: "Setu Store <support@setustore.test>", PORTAL_EMAIL_REPLY_TO: "help@setustore.test", MAIL_ONLY_TO: "y@setustore.test" });
    await saveMailSettings(db, shop, { removeApiKey: true, fromName: "", fromAddress: "", replyTo: "", onlyTo: "" }, ADMIN, server);
    expect(await mailEnv(db, shop, server)).toMatchObject({ RESEND_API_KEY: "re_from_the_server_1", PORTAL_EMAIL_FROM: "Old Name <old@setustore.test>", PORTAL_EMAIL_REPLY_TO: "old-reply@setustore.test", MAIL_ONLY_TO: "x@setustore.test" });
  });

  it("wrong values are refused with a reason for each, and nothing is saved", async () => {
    const r = await saveMailSettings(db, shop, { apiKey: "my key", fromName: "Setu <Store>", fromAddress: "not-an-address", replyTo: "also wrong", onlyTo: "ok@setustore.test, setustore.test, @bad", webhookSecret: "secret" }, ADMIN, SERVER);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("Nothing was saved") });
    if (r.ok) throw new Error("should have been refused");
    expect(Object.keys(r.errors).sort()).toEqual(["apiKey", "fromAddress", "fromName", "onlyTo", "replyTo", "webhookSecret"]);
    expect(r.errors.onlyTo).toContain("“setustore.test”, “@bad” aren't");
    expect(await db.mailSetting.count({ where: { shop } })).toBe(0);
    expect(await saveMailSettings(db, shop, { fromName: "Setu Store" }, ADMIN, SERVER)).toMatchObject({ ok: false, errors: { fromAddress: expect.any(String) } });
    expect(await saveMailSettings(db, shop, { onlyTo: Array.from({ length: 21 }, (_, i) => `t${i}@setustore.test`).join(" ") }, ADMIN, SERVER)).toMatchObject({ ok: false, errors: { onlyTo: "Up to 20 entries." } });
    // A server with no secret can't keep a key safely, so it refuses to keep one at all.
    expect(await saveMailSettings(db, shop, full, ADMIN, { NODE_ENV: "production" })).toMatchObject({ ok: false, errors: { apiKey: expect.stringContaining("can't store secrets safely") } });
    expect(await db.mailSetting.count({ where: { shop } })).toBe(0);
    expect(cleanTestList(" A@b.example ; @Setustore.test\na@b.example ")).toEqual({ list: ["a@b.example", "@setustore.test"], bad: [] });
  });

  it("mails go out with the key and sender saved in the app, without anything in the server's settings", async () => {
    await saveMailSettings(db, shop, full, ADMIN, SERVER);
    await queueMail(db, shop, "signup_approved", [{ email: "seller@gmail.example" }], { brand: "Ashnur" });
    const s = service();
    expect(await deliverDue(db, SERVER, new Date(), s.fetcher)).toMatchObject({ sent: 1 });
    expect(s.calls[0].headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(s.calls[0].body).toMatchObject({ from: "Setu Store <support@setustore.test>", reply_to: "help@setustore.test", to: ["seller@gmail.example"] });
    // The one-time-link mails use them too.
    const r = await sendSecret(db, shop, "password_reset", { email: "seller@gmail.example" }, { link: "https://x.test/r?token=T" }, { env: SERVER, fetcher: s.fetcher });
    expect(r.delivered).toBe(true);
    expect(s.calls[1].headers.Authorization).toBe(`Bearer ${KEY}`);
    // Another shop's mails don't borrow these settings.
    await queueMail(db, "other-mail-test.myshopify.com", "signup_approved", [{ email: "z@gmail.example" }], { brand: "Other" });
    try {
      expect(await deliverDue(db, SERVER, new Date(), s.fetcher)).toMatchObject({ sent: 0, logged: 1 });
      expect(s.calls).toHaveLength(2);
    } finally {
      await db.mailMessage.deleteMany({ where: { shop: "other-mail-test.myshopify.com" } });
    }
  });

  it("the page can't turn a development copy into one that mails everyone", async () => {
    const dev = { ...SERVER, NODE_ENV: "development" };
    await saveMailSettings(db, shop, full, ADMIN, dev); // key and sender, empty test list
    await queueMail(db, shop, "signup_approved", [{ email: "seller@gmail.example" }], { brand: "Ashnur" });
    const s = service();
    expect(await deliverDue(db, dev, new Date(), s.fetcher)).toMatchObject({ sent: 0, logged: 1 });
    expect(await mail("signup_approved")).toMatchObject({ status: "logged", note: expect.stringContaining("the list is empty") });
    expect((await mailSettings(db, shop, dev)).mode).toMatchObject({ real: false });
    // With a test list, only the list.
    await saveMailSettings(db, shop, { ...full, apiKey: "", onlyTo: "me@setustore.test" }, ADMIN, dev);
    await queueMail(db, shop, "vendor_paused", [{ email: "seller@gmail.example" }, { email: "me@setustore.test" }], { brand: "Ashnur" });
    expect(await deliverDue(db, dev, new Date(), s.fetcher)).toMatchObject({ sent: 1, logged: 1 });
    expect(s.calls.map((c) => (c.body.to as string[])[0])).toEqual(["me@setustore.test"]);
    expect((await mailSettings(db, shop, dev)).mode).toMatchObject({ real: true, text: expect.stringContaining("me@setustore.test") });
  });

  it("a key saved under a server secret that has since changed is reported, not used", async () => {
    await saveMailSettings(db, shop, full, ADMIN, SERVER);
    const rotated = { ...SERVER, SHOPIFY_API_SECRET: "a-new-server-secret" };
    expect((await mailEnv(db, shop, rotated)).RESEND_API_KEY).toBeUndefined();
    expect((await mailSettings(db, shop, rotated)).key).toEqual({ source: "none", hint: null, unreadable: true });
    const none = resend(200, domains());
    expect(item(await checkMailSettings(db, shop, rotated, none.fetcher), "Resend key")).toMatchObject({ tone: "bad", text: expect.stringContaining("Enter the key again") });
    expect(none.calls).toHaveLength(0);
  });

  it("the check: a working key and a verified domain are good; it sends nothing", async () => {
    await saveMailSettings(db, shop, full, ADMIN, SERVER);
    const ok = resend(200, domains(["other.example", "verified"], ["SetuStore.test", "verified"]));
    const list = await checkMailSettings(db, shop, SERVER, ok.fetcher);
    expect(ok.calls).toEqual([{ url: "https://api.resend.com/domains", headers: expect.objectContaining({ Authorization: `Bearer ${KEY}` }) }]);
    expect(item(list, "Resend key")).toMatchObject({ tone: "ok" });
    expect(item(list, "Sender's domain")).toMatchObject({ tone: "ok", text: "setustore.test is verified in Resend, so mail from this address will be accepted." });
    expect(item(list, "Reply address")).toMatchObject({ tone: "ok", text: "A reply to a mail goes to help@setustore.test." });
    expect(item(list, "Who really gets mail")).toMatchObject({ tone: "ok", text: "Everyone: sellers and the team." });
    expect(item(list, "Delivery reports")).toMatchObject({ tone: "warn" });
    expect(item(list, "Team addresses")).toMatchObject({ tone: "ok", text: expect.stringContaining(TEAM) });
    expect(JSON.stringify(list)).not.toContain(KEY);
    expect(await db.mailMessage.count({ where: { shop } })).toBe(0);
  });

  it("the check says what is wrong: domain not verified or not added, key refused, Resend unreachable, nothing set", async () => {
    await saveMailSettings(db, shop, full, ADMIN, SERVER);
    const check = (status: number, body: unknown, env: Record<string, string> = SERVER) => checkMailSettings(db, shop, env, resend(status, body).fetcher);
    expect(item(await check(200, domains(["setustore.test", "pending"])), "Sender's domain")).toMatchObject({ tone: "warn", text: expect.stringContaining("not verified yet") });
    expect(item(await check(200, domains(["setustore.test", "failed"])), "Sender's domain")).toMatchObject({ tone: "bad" });
    expect(item(await check(200, domains(["mail.setustore.test", "verified"])), "Sender's domain")).toMatchObject({ tone: "bad", text: expect.stringContaining("isn't added in this Resend account (it has: mail.setustore.test)") });
    // A key that can only send can't list domains, but Resend's answer shows the key is real.
    const restricted = await check(401, { statusCode: 401, name: "restricted_api_key", message: "This API key is restricted to only send emails" });
    expect(item(restricted, "Resend key")).toMatchObject({ tone: "ok", text: expect.stringContaining("Sending access") });
    expect(item(restricted, "Sender's domain")).toMatchObject({ tone: "warn", text: expect.stringContaining("Send a test") });
    expect(item(await check(403, { statusCode: 403, name: "validation_error", message: "API key is invalid" }), "Resend key")).toMatchObject({ tone: "bad", text: expect.stringContaining("API key is invalid") });
    expect(item(await check(-1, null), "Resend key")).toMatchObject({ tone: "warn", text: expect.stringContaining("Couldn't reach Resend") });
    expect(item(await check(500, null), "Resend key")).toMatchObject({ tone: "warn" });

    // A development copy with an empty test list mails nobody; a live one with a test list is limited to it.
    const dev = { ...SERVER, NODE_ENV: "development" };
    expect(item(await check(200, domains(["setustore.test", "verified"]), dev), "Who really gets mail")).toMatchObject({ tone: "warn", text: expect.stringContaining("Nobody") });
    await saveMailSettings(db, shop, { ...full, apiKey: "", onlyTo: "me@setustore.test" }, ADMIN, SERVER);
    expect(item(await check(200, domains(["setustore.test", "verified"])), "Who really gets mail")).toMatchObject({ tone: "warn", text: expect.stringContaining("Only the test list: me@setustore.test") });

    // Nothing set at all: says so, and doesn't call Resend.
    await db.mailSetting.deleteMany({ where: { shop } });
    await db.shopSetting.update({ where: { shop }, data: { adminEmails: [] } });
    const none = resend(200, domains());
    const empty = await checkMailSettings(db, shop, SERVER, none.fetcher);
    expect(none.calls).toHaveLength(0);
    expect(empty.filter((c) => c.tone === "bad").map((c) => c.what).sort()).toEqual(["Resend key", "Sender", "Who really gets mail"]);
    expect(item(empty, "Team addresses")).toMatchObject({ tone: "warn" });
  });

  it("a webhook secret saved in the app is accepted for Resend's reports", async () => {
    const secret = `whsec_${Buffer.from("saved-in-the-app").toString("base64")}`;
    expect(await saveMailSettings(db, shop, { ...full, webhookSecret: secret }, ADMIN, SERVER)).toMatchObject({ ok: true, message: expect.stringContaining("webhook secret") });
    expect(JSON.stringify(await db.mailSetting.findUniqueOrThrow({ where: { shop } }))).not.toContain(secret);
    expect(await webhookSecrets(db, SERVER)).toEqual([secret]);
    expect(await webhookSecrets(db, { ...SERVER, RESEND_WEBHOOK_SECRET: "whsec_server" })).toEqual(["whsec_server", secret]);
    expect((await mailSettings(db, shop, SERVER)).webhook).toMatchObject({ source: "app", unreadable: false });
    expect(item(await checkMailSettings(db, shop, SERVER, resend(200, domains(["setustore.test", "verified"])).fetcher), "Delivery reports")).toMatchObject({ tone: "ok", text: expect.stringContaining("/webhooks/resend") });

    // The route itself, signed with the saved secret.
    const { action } = await import("../app/routes/webhooks.resend");
    await queueMail(db, shop, "signup_approved", [{ email: "a@b.example" }], { brand: "Ashnur" });
    await deliverDue(db, SERVER, new Date(), service().fetcher);
    const body = JSON.stringify({ type: "email.delivered", data: { email_id: "re_1" } });
    const at = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", Buffer.from(secret.replace("whsec_", ""), "base64")).update(`msg_9.${at}.${body}`).digest("base64");
    const post = (signature: string) => action({ request: new Request("https://app.test/webhooks/resend", { method: "POST", body, headers: { "svix-id": "msg_9", "svix-timestamp": String(at), "svix-signature": signature } }), params: {}, context: {} } as never);
    process.env.SHOPIFY_API_SECRET = SERVER.SHOPIFY_API_SECRET;
    try {
      expect(((await post("v1,AAAA")) as Response).status).toBe(401);
      expect(((await post(`v1,${sig}`)) as Response).status).toBe(200);
      expect(await mail("signup_approved")).toMatchObject({ status: "delivered" });
    } finally {
      delete process.env.SHOPIFY_API_SECRET;
    }
  });
});
