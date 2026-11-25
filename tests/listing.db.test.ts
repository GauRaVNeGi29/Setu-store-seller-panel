import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminGraphql } from "../app/lib/orders/sync.server";

/**
 * The vendor's store listing (marketplace_seller entry), against a fake
 * Shopify that keeps a definition, entries and files in memory. The fake
 * starts as Setu Store's dev store is today: the definition has vendor_name,
 * minimum_order_value, collection and webkul_seller_id, and two entries.
 */
const store = vi.hoisted(() => ({ graphql: null as unknown }));
vi.mock("../app/shopify.server", () => ({
  unauthenticated: { admin: async () => ({ admin: { graphql: store.graphql } }) },
  authenticate: {
    admin: async () => ({ session: { shop: "seller-panel-dev.myshopify.com", onlineAccessInfo: { associated_user: { email: "team@setustore.test" } } }, admin: {} }),
  },
}));

const { syncListing, handleFor, resetDefinitionCache, SELLER_FIELDS } = await import("../app/lib/storefront/listing.server");
const { updateAllStoreListings } = await import("../app/lib/storefront/update.server");
const { enableVendor, addVendorUser } = await import("../app/lib/vendors/vendors.server");
const { signUp, COOKIE_NAME } = await import("../app/lib/portal/auth.server");
const { storeFile, checkUpload } = await import("../app/lib/files/files.server");
const profile = await import("../app/routes/portal.profile");
const vendorPage = await import("../app/routes/app.vendor");
const allVendors = await import("../app/routes/app.vendors");

const db = new PrismaClient();
const shop = "seller-panel-dev.myshopify.com";
afterAll(async () => {
  process.env.STORE_LISTING_SYNC = "off";
  await db.$disconnect();
});

// ---------------------------------------------------------------------------
// Fake Shopify
// ---------------------------------------------------------------------------

type Entry = { id: string; handle: string; fields: Record<string, string> };
function fakeStore(opts: { deny?: boolean } = {}) {
  const s = {
    definition: { id: "gid://shopify/MetaobjectDefinition/1", keys: ["vendor_name", "minimum_order_value", "collection", "webkul_seller_id"], publishable: false },
    entries: new Map<string, Entry>([
      ["pyramid-and-precious", { id: "gid://shopify/Metaobject/1", handle: "pyramid-and-precious", fields: { vendor_name: "Pyramid and Precious", minimum_order_value: "9574.0", collection: "gid://shopify/Collection/1", webkul_seller_id: "3027862" } }],
      ["urban-store", { id: "gid://shopify/Metaobject/2", handle: "urban-store", fields: { vendor_name: "Urban Store", minimum_order_value: "1000.0", collection: "gid://shopify/Collection/2", webkul_seller_id: "3027774" } }],
    ]),
    files: new Map<string, { status: string; polls: number }>(),
    uploads: [] as { url: string; fileName: string | null; size: number }[],
    ops: [] as string[],
    upserts: [] as { handle: string; fields: { key: string; value: string }[]; capabilities?: unknown }[],
    addedFields: [] as string[],
  };
  let next = 100;
  const graphql: AdminGraphql = async (query, o) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- GraphQL variables, shaped per operation below
    const v = (o?.variables ?? {}) as Record<string, any>;
    const op = /(?:query|mutation) (\w+)/.exec(query)?.[1] ?? "?";
    s.ops.push(op);
    const ok = (data: unknown) => ({ json: async () => ({ data }) });
    if (opts.deny && op !== "SetuSellerDefinition") return { json: async () => ({ errors: [{ message: "Access denied for metaobjectUpsert field. Required access: `write_metaobjects` access scope." }] }) };
    switch (op) {
      case "SetuSellerDefinition":
        return ok({ metaobjectDefinitionByType: { id: s.definition.id, capabilities: { publishable: { enabled: s.definition.publishable } }, fieldDefinitions: s.definition.keys.map((key) => ({ key })) } });
      case "SetuSellerDefinitionUpdate": {
        const created = v.definition.fieldDefinitions.map((f: { create: { key: string } }) => f.create.key);
        s.addedFields.push(...created);
        s.definition.keys.push(...created);
        return ok({ metaobjectDefinitionUpdate: { metaobjectDefinition: { id: s.definition.id }, userErrors: [] } });
      }
      case "SetuSellerEntries":
        return ok({ metaobjects: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [...s.entries.values()].map((e) => ({ handle: e.handle, field: { value: e.fields.vendor_name ?? null } })) } });
      case "SetuSellerEntry": {
        const e = s.entries.get(v.handle.handle);
        return ok({ metaobjectByHandle: e ? { id: e.id, handle: e.handle, fields: Object.entries(e.fields).map(([key, value]) => ({ key, value })) } : null });
      }
      case "SetuSellerUpsert": {
        const unknown = v.metaobject.fields.find((f: { key: string }) => !s.definition.keys.includes(f.key));
        if (unknown) return ok({ metaobjectUpsert: { metaobject: null, userErrors: [{ field: ["fields"], message: `Field definition "${unknown.key}" does not exist` }] } });
        s.upserts.push({ handle: v.handle.handle, fields: v.metaobject.fields, capabilities: v.metaobject.capabilities });
        const e: Entry = s.entries.get(v.handle.handle) ?? { id: `gid://shopify/Metaobject/${next++}`, handle: v.handle.handle, fields: {} };
        for (const f of v.metaobject.fields as { key: string; value: string }[]) {
          if (f.value === "") delete e.fields[f.key];
          else e.fields[f.key] = f.value;
        }
        s.entries.set(e.handle, e);
        return ok({ metaobjectUpsert: { metaobject: { id: e.id, handle: e.handle }, userErrors: [] } });
      }
      case "SetuStageUpload":
        return ok({ stagedUploadsCreate: { stagedTargets: [{ url: "https://uploads.test/bucket", resourceUrl: `https://uploads.test/tmp/${v.input[0].filename}`, parameters: [{ name: "key", value: "tmp/x" }] }], userErrors: [] } });
      case "SetuFileCreate": {
        const id = `gid://shopify/MediaImage/${next++}`;
        s.files.set(id, { status: "UPLOADED", polls: 0 });
        return ok({ fileCreate: { files: [{ id, fileStatus: "UPLOADED" }], userErrors: [] } });
      }
      case "SetuFileStatus": {
        const f = s.files.get(v.id);
        if (!f) return ok({ node: null });
        if (++f.polls >= 2) f.status = "READY"; // ready on the second look
        return ok({ node: { id: v.id, fileStatus: f.status, fileErrors: [] } });
      }
    }
    throw new Error(`unexpected operation ${op}`);
  };
  const deps = {
    sleep: async () => {},
    upload: async (url: string, body: FormData) => {
      const file = body.get("file") as File | null;
      s.uploads.push({ url, fileName: file?.name ?? null, size: file?.size ?? 0 });
      return { ok: true, status: 201 };
    },
  };
  return { s, graphql, deps };
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const PNG = () => Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const PDF = () => Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");
const file = (bytes: Buffer, name: string, type: string) => new File([new Uint8Array(bytes)], name, { type });

async function cleanup() {
  await db.portalSession.deleteMany({ where: { vendorUser: { shop } } });
  await db.vendorFile.deleteMany({ where: { shop } });
  await db.vendorUser.deleteMany({ where: { shop } });
  await db.vendor.deleteMany({ where: { shop } });
  await db.loginAttempt.deleteMany({ where: { shop } });
  await db.auditLog.deleteMany({ where: { shop } });
}
beforeEach(async () => {
  await cleanup();
  resetDefinitionCache();
  delete process.env.STORE_LISTING_SYNC;
});

async function vendorWith(name: string, data: Record<string, unknown> = {}) {
  const v = await enableVendor(db, shop, name, "test");
  await db.vendor.update({ where: { id: v.id }, data });
  return v;
}
async function attach(vendorId: string, kind: "logo" | "banner" | "gst", bytes: Buffer, name: string, type: string) {
  const checked = await checkUpload(kind, file(bytes, name, type));
  if (!checked.ok) throw new Error(checked.error);
  return storeFile(db, { shop, vendorId, kind, checked, uploadedById: null });
}

// ---------------------------------------------------------------------------

describe("handles", () => {
  it("match Liquid's handleize for ordinary names", () => {
    expect(handleFor("Pyramid and Precious")).toBe("pyramid-and-precious");
    expect(handleFor("Urban Store")).toBe("urban-store");
    expect(handleFor("  Café Déco & Co. ")).toBe("cafe-deco-co");
    expect(handleFor("!!!")).toBe("");
  });
});

describe("store listing", () => {
  it("adds only the missing fields to the definition, once", async () => {
    const { s, graphql, deps } = fakeStore();
    const v = await vendorWith("Urban Store");
    expect((await syncListing(db, graphql, shop, v.id, deps)).ok).toBe(true);
    expect(s.addedFields).toEqual(["display_name", "short_description", "description", "logo", "banner", "rating", "review_count"]);
    expect(SELLER_FIELDS.find((f) => f.key === "logo")?.validations).toEqual([{ name: "file_type_options", value: '["Image"]' }]);
    await syncListing(db, graphql, shop, v.id, deps);
    expect(s.ops.filter((o) => o === "SetuSellerDefinitionUpdate")).toHaveLength(1);
    expect(s.ops.filter((o) => o === "SetuSellerDefinition")).toHaveLength(1); // cached
  });

  it("updates the existing entry, keeps collection and Webkul id, and doesn't blank a minimum the app doesn't have", async () => {
    const { s, graphql, deps } = fakeStore();
    const v = await vendorWith("Pyramid and Precious", { displayName: "Pyramid & Precious", shortDescription: "Handmade gemstone rings", description: "Made in Jaipur.\nSince 1998." });
    const r = await syncListing(db, graphql, shop, v.id, deps);
    expect(r).toEqual({ ok: true, handle: "pyramid-and-precious", changed: ["display_name", "short_description", "description"] });
    expect(s.entries.get("pyramid-and-precious")?.fields).toEqual({
      vendor_name: "Pyramid and Precious", minimum_order_value: "9574.0", collection: "gid://shopify/Collection/1", webkul_seller_id: "3027862",
      display_name: "Pyramid & Precious", short_description: "Handmade gemstone rings", description: "Made in Jaipur.\nSince 1998.",
    });
    const saved = await db.vendor.findUniqueOrThrow({ where: { id: v.id } });
    expect([saved.storeEntryHandle, saved.storeSyncError, saved.storeSyncedAt instanceof Date]).toEqual(["pyramid-and-precious", null, true]);
  });

  it("writes the app's minimum, but not when it's the same amount written differently", async () => {
    const { s, graphql, deps } = fakeStore();
    const v = await vendorWith("Urban Store", { minimumOrderValue: "1000" });
    expect(await syncListing(db, graphql, shop, v.id, deps)).toMatchObject({ changed: ["display_name"] }); // 1000.0 = 1000.00
    await db.vendor.update({ where: { id: v.id }, data: { minimumOrderValue: "2500.5" } });
    expect(await syncListing(db, graphql, shop, v.id, deps)).toMatchObject({ changed: ["minimum_order_value"] });
    expect(s.entries.get("urban-store")?.fields.minimum_order_value).toBe("2500.50");
  });

  it("sends nothing when nothing changed", async () => {
    const { s, graphql, deps } = fakeStore();
    const v = await vendorWith("Urban Store", { description: "Brass and silver." });
    await syncListing(db, graphql, shop, v.id, deps);
    const before = s.upserts.length;
    expect(await syncListing(db, graphql, shop, v.id, deps)).toMatchObject({ ok: true, changed: [] });
    expect(s.upserts.length).toBe(before);
  });

  it("clears text the vendor removed", async () => {
    const { s, graphql, deps } = fakeStore();
    const v = await vendorWith("Urban Store", { description: "Old text", shortDescription: "Old line" });
    await syncListing(db, graphql, shop, v.id, deps);
    await db.vendor.update({ where: { id: v.id }, data: { description: null } });
    expect(await syncListing(db, graphql, shop, v.id, deps)).toMatchObject({ changed: ["description"] });
    expect(s.upserts.at(-1)?.fields).toEqual([{ key: "description", value: "" }]);
    expect(s.entries.get("urban-store")?.fields.description).toBeUndefined();
  });

  it("copies the logo and banner to Files once and reuses them; business documents never leave the app", async () => {
    const { s, graphql, deps } = fakeStore();
    const v = await vendorWith("Urban Store");
    const logo = await attach(v.id, "logo", PNG(), "logo.png", "image/png");
    const banner = await attach(v.id, "banner", PNG(), "banner.png", "image/png");
    const gst = await attach(v.id, "gst", PDF(), "gst.pdf", "application/pdf");
    await db.vendor.update({ where: { id: v.id }, data: { logoFileId: logo, bannerFileId: banner, gstFileId: gst } });

    const r = await syncListing(db, graphql, shop, v.id, deps);
    expect(r).toMatchObject({ ok: true, changed: ["display_name", "logo", "banner"] });
    expect(s.uploads.map((u) => u.fileName)).toEqual(["logo.png", "banner.png"]);
    const entry = { ...s.entries.get("urban-store")!.fields };
    expect(entry.logo).toMatch(/^gid:\/\/shopify\/MediaImage\//);
    expect((await db.vendorFile.findUniqueOrThrow({ where: { id: logo } })).shopifyFileId).toBe(entry.logo);
    expect((await db.vendorFile.findUniqueOrThrow({ where: { id: gst } })).shopifyFileId).toBeNull();

    await syncListing(db, graphql, shop, v.id, deps);
    expect(s.uploads).toHaveLength(2); // reused

    // A new logo replaces the old one; removing the banner clears it.
    const logo2 = await attach(v.id, "logo", PNG(), "logo-2.png", "image/png");
    await db.vendor.update({ where: { id: v.id }, data: { logoFileId: logo2, bannerFileId: null } });
    expect(await syncListing(db, graphql, shop, v.id, deps)).toMatchObject({ changed: ["logo", "banner"] });
    expect(s.entries.get("urban-store")!.fields.logo).not.toBe(entry.logo);
    expect(s.entries.get("urban-store")!.fields.banner).toBeUndefined();
  });

  it("re-uploads an image that was deleted from Files", async () => {
    const { s, graphql, deps } = fakeStore();
    const v = await vendorWith("Urban Store");
    const logo = await attach(v.id, "logo", PNG(), "logo.png", "image/png");
    await db.vendor.update({ where: { id: v.id }, data: { logoFileId: logo } });
    await syncListing(db, graphql, shop, v.id, deps);
    s.files.clear(); // someone deleted it in Shopify admin
    await syncListing(db, graphql, shop, v.id, deps);
    expect(s.uploads).toHaveLength(2);
  });

  it("creates an entry for a vendor the store doesn't list yet", async () => {
    const { s, graphql, deps } = fakeStore();
    const v = await vendorWith("Ashnur", { minimumOrderValue: "5000", shortDescription: "Silver from Jaipur" });
    const r = await syncListing(db, graphql, shop, v.id, deps);
    expect(r).toMatchObject({ ok: true, handle: "ashnur" });
    expect(s.entries.get("ashnur")?.fields).toEqual({ vendor_name: "Ashnur", display_name: "Ashnur", short_description: "Silver from Jaipur", minimum_order_value: "5000.00" });
    expect(s.upserts.at(-1)?.fields.map((f) => f.key)).not.toContain("description"); // empty values aren't sent for a new entry
  });

  it("marks new entries active when the definition has publishing switched on", async () => {
    const { s, graphql, deps } = fakeStore();
    s.definition.publishable = true;
    const v = await vendorWith("Ashnur");
    await syncListing(db, graphql, shop, v.id, deps);
    expect(s.upserts[0].capabilities).toEqual({ publishable: { status: "ACTIVE" } });
  });

  it("records a missing permission in words the team can act on, and clears it after a good update", async () => {
    const denied = fakeStore({ deny: true });
    const v = await vendorWith("Urban Store");
    const r = await syncListing(db, denied.graphql, shop, v.id, denied.deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/isn't allowed to update store content/);
    expect((await db.vendor.findUniqueOrThrow({ where: { id: v.id } })).storeSyncError).toMatch(/approve the new permissions/);

    resetDefinitionCache();
    const good = fakeStore();
    expect((await syncListing(db, good.graphql, shop, v.id, good.deps)).ok).toBe(true);
    expect((await db.vendor.findUniqueOrThrow({ where: { id: v.id } })).storeSyncError).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Through the pages
// ---------------------------------------------------------------------------

type Fn = (a: { request: Request; params: Record<string, string>; context: unknown }) => Promise<unknown>;
async function run(fn: unknown, request: Request) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loader/action data, checked field by field
    return { data: (await (fn as Fn)({ request, params: {}, context: {} })) as Record<string, any> };
  } catch (e) {
    if (e instanceof Response) return { location: e.headers.get("Location"), status: e.status };
    throw e;
  }
}
const admin = (path: string, fields?: Record<string, string>) =>
  new Request(`https://app.test${path}`, fields ? { method: "POST", body: new URLSearchParams(fields) } : undefined);

describe("pages", () => {
  it("a seller's brand save reaches the store listing", async () => {
    const { s, graphql } = fakeStore();
    store.graphql = graphql;
    const v = await vendorWith("Urban Store");
    await addVendorUser(db, shop, v.id, "owner@urban.example", "Owner", "test");
    const su = await signUp(db, { name: "Owner", email: "owner@urban.example", password: "Strong-test-password-1", phone: "+91 98765 43210" }, { shop });
    if (!su.ok) throw new Error("sign-up failed");
    const fd = new FormData();
    for (const [k, val] of Object.entries({ intent: "brand", minimumOrderValue: "1500", shortDescription: "Brass, made by hand", description: "We cast everything in Moradabad." })) fd.set(k, val);
    const r = await run(profile.action, new Request("https://portal.test/portal/profile", { method: "POST", headers: { Cookie: `${COOKIE_NAME}=${encodeURIComponent(su.token)}` }, body: fd }));
    expect(r.location).toBe("/portal/profile?saved=brand");
    expect(s.entries.get("urban-store")?.fields).toMatchObject({ minimum_order_value: "1500.00", short_description: "Brass, made by hand", description: "We cast everything in Moradabad." });
  });

  it("the team's details save updates the listing, and the vendor page shows its state", async () => {
    const { s, graphql } = fakeStore();
    store.graphql = graphql;
    const v = await vendorWith("Urban Store");
    const saved = await run(vendorPage.action, admin("/app/vendor", { name: "Urban Store", intent: "details", displayName: "Urban Store Co.", description: "Team wrote this." }));
    expect(saved.data).toEqual({ ok: true, message: "Details saved – store listing updated" });
    expect(s.entries.get("urban-store")?.fields.display_name).toBe("Urban Store Co.");

    const page = await run(vendorPage.loader, admin("/app/vendor?name=Urban%20Store"));
    expect(page.data?.vendor.store).toMatchObject({ handle: "urban-store", error: null, syncedAt: expect.any(String) });
    expect(await run(vendorPage.action, admin("/app/vendor", { name: "Urban Store", intent: "store_listing" }))).toEqual({ data: { ok: true, message: "Store listing already up to date" } });
    expect(v.id).toBeTruthy();
  });

  it("a failed listing update doesn't undo the save, and shows on the vendor and in All vendors", async () => {
    store.graphql = fakeStore({ deny: true }).graphql;
    await vendorWith("Urban Store");
    const saved = await run(vendorPage.action, admin("/app/vendor", { name: "Urban Store", intent: "details", displayName: "Urban Store", description: "Kept." }));
    expect(saved.data).toMatchObject({ ok: true, message: "Details saved", error: expect.stringMatching(/store listing didn't update/) });
    expect((await db.vendor.findFirstOrThrow({ where: { shop, vendorName: "Urban Store" } })).description).toBe("Kept.");
    const list = await run(allVendors.loader, admin("/app/vendors"));
    expect(list.data?.vendors[0].store).toBe("error");
    expect(list.data?.totals.storeNotUpdated).toBe(1);
  });

  it("'Update all store listings' updates every vendor, and stops at the first missing permission", async () => {
    const { s, graphql } = fakeStore();
    store.graphql = graphql;
    await vendorWith("Urban Store");
    await vendorWith("Pyramid and Precious");
    await vendorWith("Ashnur");
    expect((await run(allVendors.action, admin("/app/vendors", { intent: "store_listings" }))).data).toEqual({ ok: true, message: "Store listings updated (3 of 3)" });
    expect([...s.entries.keys()].sort()).toEqual(["ashnur", "pyramid-and-precious", "urban-store"]);

    resetDefinitionCache();
    const denied = fakeStore({ deny: true });
    store.graphql = denied.graphql;
    const r = await updateAllStoreListings(db, shop);
    expect(r).toMatchObject({ total: 3, updated: 0, stopped: true });
    expect(r.failed).toHaveLength(1);
  });

  it("can be switched off (STORE_LISTING_SYNC=off) without breaking saves", async () => {
    process.env.STORE_LISTING_SYNC = "off";
    const { s, graphql } = fakeStore();
    store.graphql = graphql;
    await vendorWith("Urban Store");
    const saved = await run(vendorPage.action, admin("/app/vendor", { name: "Urban Store", intent: "details", displayName: "Urban Store", description: "x" }));
    expect(saved.data).toMatchObject({ ok: true, message: "Details saved" });
    expect(s.ops).toEqual([]);
  });
});
