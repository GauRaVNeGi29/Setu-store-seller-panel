import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { saveOrder } from "../app/lib/orders/sync.server";
import { commissionHistory, rateAt, setCommissionRate, vendorEarnings } from "../app/lib/commission/commission.server";
import { COOKIE_NAME, createTeamHandoff, redeemTeamHandoff, signUp } from "../app/lib/portal/auth.server";
import { addVendorUser, enableVendor } from "../app/lib/vendors/vendors.server";
import type { ShopifyOrder } from "../app/lib/orders/map";
import fixture from "./fixtures/dev-orders-2026-11-20.json";
import * as earningsPage from "../app/routes/portal.earnings";
import * as dashboard from "../app/routes/portal._index";

/**
 * Commission, worked out by hand from the dev store's orders (all placed 20 Nov 2026, 13:xx IST):
 *   Urban Store at 15%: #1001 ₹120 → 18.00 · #1002 ₹1,025 → 153.75 · #1003 ₹1,250 → 187.50 ·
 *   #1004 ₹1,080 → 162.00 · #1005 cancelled → 0  ⇒ commission ₹521.25, earns ₹2,953.75
 *   Ashnur at 12%: #1003 ₹1,350 → 162.00 · #1004 ₹525 → 63.00 ⇒ ₹225.00, earns ₹1,650.00
 * Shop = PORTAL_SHOP so the real page loaders can be used.
 */
const db = new PrismaClient();
const shop = "seller-panel-dev.myshopify.com";
const PW = "Strong-test-password-1";
const ADMIN = "admin:team@setustore.test";
const BEFORE = new Date("2026-11-19T00:00:00Z");
const AFTER = new Date("2026-11-21T00:00:00Z");
afterAll(() => db.$disconnect());

async function cleanup() {
  await db.portalHandoff.deleteMany({ where: { vendorUser: { shop } } });
  await db.portalSession.deleteMany({ where: { vendorUser: { shop } } });
  await db.vendorCommission.deleteMany({ where: { shop } });
  await db.vendorUser.deleteMany({ where: { shop } });
  await db.vendor.deleteMany({ where: { shop } });
  await db.vendorOrderLine.deleteMany({ where: { shop } });
  await db.loginAttempt.deleteMany({ where: { shop } });
  await db.auditLog.deleteMany({ where: { shop } });
}

let urban: { id: string }, ashnur: { id: string };
const scope = (v: { id: string }, vendorName: string) => ({ shop, vendorName, vendorId: v.id });

beforeEach(async () => {
  await cleanup();
  for (const o of structuredClone(fixture.orders) as ShopifyOrder[]) await saveOrder(db, shop, o, "test");
  urban = await enableVendor(db, shop, "Urban Store", "test");
  ashnur = await enableVendor(db, shop, "Ashnur", "test");
});

async function cookieFor(vendorId: string, email: string) {
  await addVendorUser(db, shop, vendorId, email, "Owner", "test");
  const r = await signUp(db, { name: "Owner", email, password: PW, phone: "+91 98765 43210" }, { shop });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return `${COOKIE_NAME}=${encodeURIComponent(r.token)}`;
}
type Fn = (a: { request: Request; params: Record<string, string>; context: unknown }) => Promise<unknown>;
const load = async (mod: { loader: unknown }, path: string, cookie: string) =>
  (await (mod.loader as Fn)({ request: new Request("https://portal.test" + path, { headers: { Cookie: cookie } }), params: {}, context: {} })) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("commission rates", () => {
  it("takes each vendor's own rate from sales after refunds, order by order, rounded to the paisa", async () => {
    await setCommissionRate(db, shop, urban.id, "15", ADMIN);
    await setCommissionRate(db, shop, ashnur.id, "12", ADMIN);
    const u = await vendorEarnings(db, scope(urban, "Urban Store"), "all");
    expect(u.totals).toEqual({ net: "3475.00", commission: "521.25", earnings: "2953.75", ordersWithoutRate: 0 });
    expect(Object.fromEntries(u.rows.map((r) => [r.orderName, [r.net, r.commission, r.earnings]]))).toEqual({
      "#1001": ["120.00", "18.00", "102.00"], "#1002": ["1025.00", "153.75", "871.25"], "#1003": ["1250.00", "187.50", "1062.50"],
      "#1004": ["1080.00", "162.00", "918.00"], "#1005": ["0.00", "0.00", "0.00"],
    });
    const a = await vendorEarnings(db, scope(ashnur, "Ashnur"), "all");
    expect(a.totals).toEqual({ net: "1875.00", commission: "225.00", earnings: "1650.00", ordersWithoutRate: 0 });
    expect(a.rate).toBe("12.00");
  });

  it("rounds half up per order (12.5% of ₹1,025 = ₹128.125 → ₹128.13)", async () => {
    await setCommissionRate(db, shop, urban.id, "12.5", ADMIN);
    const u = await vendorEarnings(db, scope(urban, "Urban Store"), "all");
    expect(u.rows.find((r) => r.orderName === "#1002")?.commission).toBe("128.13");
  });

  it("the first rate covers orders already placed; a change applies only to orders placed after it", async () => {
    expect(await setCommissionRate(db, shop, urban.id, "15", ADMIN, BEFORE)).toEqual({ ok: true, rate: "15.00" });
    expect(await setCommissionRate(db, shop, urban.id, "20", ADMIN, AFTER)).toEqual({ ok: true, rate: "20.00" });
    const u = await vendorEarnings(db, scope(urban, "Urban Store"), "all");
    expect(u.rate).toBe("20.00");
    expect(u.totals.commission).toBe("521.25"); // the 20 Nov orders keep 15%
    expect(u.rows.every((r) => r.rate === "15.00")).toBe(true);
    const h = await commissionHistory(db, shop, urban.id);
    expect(h.map((x) => [x.rate, x.fromStart])).toEqual([["15.00", true], ["20.00", false]]);
    expect(rateAt(h, new Date("2026-11-22T00:00:00Z"))).toBe("20.00");
    expect(await db.auditLog.count({ where: { shop, action: "vendor.commission_set" } })).toBe(2);
  });

  it("a rate changed before the orders were placed applies to them", async () => {
    await setCommissionRate(db, shop, urban.id, "15", ADMIN, BEFORE);
    await setCommissionRate(db, shop, urban.id, "10", ADMIN, new Date("2026-11-19T12:00:00Z"));
    expect((await vendorEarnings(db, scope(urban, "Urban Store"), "all")).totals.commission).toBe("347.50");
  });

  it("refuses bad rates, an unchanged rate, and another store's vendor", async () => {
    for (const bad of ["", "abc", "-5", "100.01", "150", "12.345"]) {
      expect((await setCommissionRate(db, shop, urban.id, bad, ADMIN)).ok).toBe(false);
    }
    expect((await setCommissionRate(db, shop, urban.id, "0", ADMIN)).ok).toBe(true); // 0% is allowed
    expect((await setCommissionRate(db, shop, urban.id, "0.00%", ADMIN)).ok).toBe(false); // same as now
    expect((await setCommissionRate(db, shop, urban.id, "100", ADMIN)).ok).toBe(true);
    expect((await setCommissionRate(db, "someone-else.myshopify.com", urban.id, "10", ADMIN)).ok).toBe(false);
  });

  it("with no rate yet, commission and earnings stay empty", async () => {
    const u = await vendorEarnings(db, scope(urban, "Urban Store"), "all");
    expect(u.rate).toBeNull();
    expect(u.totals).toEqual({ net: "3475.00", commission: "0.00", earnings: "0.00", ordersWithoutRate: 4 });
    expect(u.rows.every((r) => r.commission === null && r.earnings === null)).toBe(true);
  });
});

describe("in the portal", () => {
  it("each vendor sees only their own rate and orders on Earnings and the dashboard", async () => {
    await setCommissionRate(db, shop, urban.id, "15", ADMIN);
    await setCommissionRate(db, shop, ashnur.id, "12", ADMIN);
    const ash = await cookieFor(ashnur.id, "o@ashnur.example");
    const e = await load(earningsPage, "/portal/earnings?range=all&vendor=Urban%20Store", ash);
    expect(e.rate).toBe("12.00");
    expect(e.totals.commission).toBe("225.00");
    expect(e.rows.map((r: { orderName: string }) => r.orderName).sort()).toEqual(["#1003", "#1004", "#1005"]);
    expect(JSON.stringify(e)).not.toMatch(/Urban Store|15\.00|521\.25/);
    const d = await load(dashboard, "/portal?range=all", ash);
    expect(d.earn).toMatchObject({ rate: "12.00", net: "1875.00", commission: "225.00", earnings: "1650.00" });
  });

  it("the Setu Store team view can see Earnings (read-only)", async () => {
    await setCommissionRate(db, shop, urban.id, "15", ADMIN);
    await cookieFor(urban.id, "o@urban.example");
    const h = await createTeamHandoff(db, shop, urban.id, ADMIN);
    if (!h.ok) throw new Error();
    const s = await redeemTeamHandoff(db, h.token, { shop });
    const e = await load(earningsPage, "/portal/earnings?range=all", `${COOKIE_NAME}=${encodeURIComponent(s!.token)}`);
    expect(e.totals.earnings).toBe("2953.75");
  });
});
