/** Stand-in for the team's actions in Shopify admin, for the browser walk-through. */
import { PrismaClient } from "@prisma/client";
import fixture from "../fixtures/dev-orders-2026-11-20.json";
import { saveOrder } from "../../app/lib/orders/sync.server";
import { enableVendor, addVendorUser, approveSignup } from "../../app/lib/vendors/vendors.server";
import { reviewBusinessChange } from "../../app/lib/vendors/team.server";
import { signUp, signIn } from "../../app/lib/portal/auth.server";
const db = new PrismaClient(); const shop = "seller-panel-dev.myshopify.com";
const [cmd, a, b] = process.argv.slice(2);
if (cmd === "seed" && /neon\.tech|q0zr1f/.test(process.env.DATABASE_URL ?? "")) throw new Error("Refusing to wipe a real database");
if (cmd === "seed") {
  await db.portalSession.deleteMany({}); await db.passwordReset.deleteMany({}); await db.vendorChangeRequest.deleteMany({});
  await db.vendorUser.deleteMany({}); await db.vendor.deleteMany({}); await db.loginAttempt.deleteMany({}); await db.vendorOrderLine.deleteMany({}); await db.auditLog.deleteMany({});
  for (const o of fixture.orders as any) await saveOrder(db, shop, o, "seed");
  const urban = await enableVendor(db, shop, "Urban Store", "admin:e2e");
  await addVendorUser(db, shop, urban.id, "owner@urban.example", "Harpreet", "admin:e2e");
  console.log("ok");
} else if (cmd === "approve-signup") {
  const u = await db.vendorUser.findFirstOrThrow({ where: { shop, email: a } });
  console.log(JSON.stringify(await approveSignup(db, shop, u.id, b, "admin:e2e")));
} else if (cmd === "review-change") {
  const v = await db.vendor.findFirstOrThrow({ where: { shop, vendorName: a } });
  const r = await db.vendorChangeRequest.findFirstOrThrow({ where: { vendorId: v.id, status: "pending" } });
  console.log(JSON.stringify(await reviewBusinessChange(db, shop, r.id, b === "approve" ? "approve" : "reject", b === "approve" ? null : "Please send proof of the new address.", "admin:e2e")));
} else if (cmd === "mkowner") {
  const r = await signUp(db, { name: "Harpreet", email: "owner@urban.example", password: "Demo-password-2026", phone: "+91 98140 12345", brandName: "Urban Store", city: "Ludhiana", state: "Punjab" }, { shop });
  console.log(JSON.stringify({ ok: r.ok }));
} else if (cmd === "signin") {
  const r = await signIn(db, a, b, { shop });
  console.log(JSON.stringify(r.ok ? { ok: true, status: r.status } : r));
} else if (cmd === "clear-logins") {
  await db.loginAttempt.deleteMany({});
} else if (cmd === "user") {
  const u = await db.vendorUser.findFirst({ where: { shop, email: a } });
  console.log(JSON.stringify(u && { status: u.status, role: u.role, access: u.access }));
} else if (cmd === "vendor") {
  const v = await db.vendor.findFirstOrThrow({ where: { shop, vendorName: a } });
  console.log(JSON.stringify({ displayName: v.displayName, city: v.city, description: v.description }));
}
await db.$disconnect();
