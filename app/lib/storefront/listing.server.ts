import type { PrismaClient } from "@prisma/client";
import type { AdminGraphql } from "../orders/sync.server";
import { reviewSummary } from "../reviews/reviews.server";

/**
 * The vendor's public listing on the store.
 *
 * Each vendor has one entry of the store's `marketplace_seller` metaobject.
 * The theme reads it: the cart applies the minimum order value, and the
 * product page shows the logo, name, minimum and description (through the
 * app's theme extension). The app keeps the entry in step with the portal:
 *
 *  - vendor_name, display_name, short_description, description, logo and
 *    banner are written from the app. An empty value in the app clears it on
 *    the store.
 *  - rating and review_count come from the vendor's published reviews, and
 *    are empty until there is one.
 *  - minimum_order_value is written only when the app has one, so a value
 *    already set on the store is never blanked by a vendor who hasn't filled
 *    in their brand details yet.
 *  - collection and webkul_seller_id are never touched.
 *
 * Only public brand images (logo, banner) are copied to the store's Files.
 * Business documents (GST, IEC, AD code) never leave the app.
 */

export const SELLER_TYPE = "marketplace_seller";

type FieldDef = { key: string; name: string; type: string; description?: string; validations?: { name: string; value: string }[] };
const IMAGE_ONLY = [{ name: "file_type_options", value: JSON.stringify(["Image"]) }];

/** Fields the listing needs. The first three already exist on Setu Store's definition. */
export const SELLER_FIELDS: FieldDef[] = [
  { key: "vendor_name", name: "Vendor name", type: "single_line_text_field", description: "Must match the product Vendor exactly." },
  { key: "minimum_order_value", name: "Minimum order value (INR)", type: "number_decimal" },
  { key: "collection", name: "Seller collection", type: "collection_reference" },
  { key: "display_name", name: "Brand name", type: "single_line_text_field", description: "Set by the Setu Store Seller Panel app." },
  { key: "short_description", name: "Short description", type: "single_line_text_field", description: "Set by the Setu Store Seller Panel app." },
  { key: "description", name: "Description", type: "multi_line_text_field", description: "Set by the Setu Store Seller Panel app." },
  { key: "logo", name: "Logo", type: "file_reference", validations: IMAGE_ONLY, description: "Set by the Setu Store Seller Panel app." },
  { key: "banner", name: "Banner", type: "file_reference", validations: IMAGE_ONLY, description: "Set by the Setu Store Seller Panel app." },
  { key: "rating", name: "Rating (out of 5)", type: "number_decimal", description: "Average of buyers' reviews. Set by the Setu Store Seller Panel app." },
  { key: "review_count", name: "Number of reviews", type: "number_integer", description: "Set by the Setu Store Seller Panel app." },
];

export type ListingDeps = {
  /** Sends the multipart upload to Shopify's staged upload target. */
  upload?: (url: string, body: FormData) => Promise<{ ok: boolean; status: number }>;
  sleep?: (ms: number) => Promise<void>;
};
export type ListingResult = { ok: true; handle: string; changed: string[] } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

export const DEFINITION_QUERY = `#graphql
  query SetuSellerDefinition($type: String!) {
    metaobjectDefinitionByType(type: $type) {
      id
      capabilities { publishable { enabled } }
      fieldDefinitions { key }
    }
  }`;

const DEFINITION_CREATE = `#graphql
  mutation SetuSellerDefinitionCreate($definition: MetaobjectDefinitionCreateInput!) {
    metaobjectDefinitionCreate(definition: $definition) {
      metaobjectDefinition { id }
      userErrors { field message code }
    }
  }`;

const DEFINITION_UPDATE = `#graphql
  mutation SetuSellerDefinitionUpdate($id: ID!, $definition: MetaobjectDefinitionUpdateInput!) {
    metaobjectDefinitionUpdate(id: $id, definition: $definition) {
      metaobjectDefinition { id }
      userErrors { field message code }
    }
  }`;

export const ENTRIES_QUERY = `#graphql
  query SetuSellerEntries($type: String!, $cursor: String) {
    metaobjects(type: $type, first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { handle field(key: "vendor_name") { value } }
    }
  }`;

export const ENTRY_QUERY = `#graphql
  query SetuSellerEntry($handle: MetaobjectHandleInput!) {
    metaobjectByHandle(handle: $handle) { id handle fields { key value } }
  }`;

const UPSERT = `#graphql
  mutation SetuSellerUpsert($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
    metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
      metaobject { id handle }
      userErrors { field message code }
    }
  }`;

const STAGE = `#graphql
  mutation SetuStageUpload($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets { url resourceUrl parameters { name value } }
      userErrors { field message }
    }
  }`;

const FILE_CREATE = `#graphql
  mutation SetuFileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files { id fileStatus }
      userErrors { field message code }
    }
  }`;

export const FILE_STATUS = `#graphql
  query SetuFileStatus($id: ID!) {
    node(id: $id) { ... on MediaImage { id fileStatus fileErrors { message } } }
  }`;

type UserError = { field?: string[] | null; message: string; code?: string | null };

export class ListingError extends Error {}

async function call<T>(graphql: AdminGraphql, query: string, variables: Record<string, unknown>): Promise<T> {
  let body: { data?: T; errors?: unknown };
  try {
    body = (await (await graphql(query, { variables })).json()) as { data?: T; errors?: unknown };
  } catch (e) {
    throw new ListingError(friendly(e));
  }
  if (body.errors) throw new ListingError(friendly(body.errors));
  if (!body.data) throw new ListingError("Shopify returned no data.");
  return body.data;
}

function userErrors(errors: UserError[] | undefined, what: string) {
  if (errors?.length) throw new ListingError(`${what}: ${errors.map((e) => e.message).join("; ")}`);
}

/** Turns Shopify's errors into something the team can act on. */
export function friendly(e: unknown): string {
  const text = e instanceof Error ? `${e.message} ${JSON.stringify((e as { body?: unknown }).body ?? "")}` : JSON.stringify(e);
  if (/access denied|ACCESS_DENIED|requires? .*scope|write_metaobject|write_files/i.test(text)) {
    return "The app isn't allowed to update store content yet. Open the app in Shopify admin and approve the new permissions, then try again.";
  }
  if (/could not find a session|no session/i.test(text)) return "The app has no saved Shopify sign-in for this store. Open the app in Shopify admin once, then try again.";
  return `Shopify said: ${text.slice(0, 300)}`;
}

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

const checked = new Map<string, { until: number; publishable: boolean }>();
export const resetDefinitionCache = () => checked.clear();

/**
 * Makes sure the definition exists and has every field the listing needs.
 * Existing fields are left exactly as they are; missing ones are added.
 * Checked at most every 10 minutes per store.
 */
export async function ensureSellerDefinition(graphql: AdminGraphql, shop: string): Promise<{ publishable: boolean }> {
  const hit = checked.get(shop);
  if (hit && hit.until > Date.now()) return hit;
  const { metaobjectDefinitionByType: def } = await call<{
    metaobjectDefinitionByType: { id: string; capabilities: { publishable: { enabled: boolean } }; fieldDefinitions: { key: string }[] } | null;
  }>(graphql, DEFINITION_QUERY, { type: SELLER_TYPE });

  let publishable = false;
  if (!def) {
    const r = await call<{ metaobjectDefinitionCreate: { userErrors: UserError[] } }>(graphql, DEFINITION_CREATE, {
      definition: {
        type: SELLER_TYPE, name: "Marketplace seller", displayNameKey: "vendor_name",
        access: { storefront: "PUBLIC_READ" },
        fieldDefinitions: SELLER_FIELDS,
      },
    });
    userErrors(r.metaobjectDefinitionCreate.userErrors, "Couldn't create the seller definition");
  } else {
    publishable = def.capabilities.publishable.enabled;
    const have = new Set(def.fieldDefinitions.map((f) => f.key));
    const missing = SELLER_FIELDS.filter((f) => !have.has(f.key));
    if (missing.length) {
      const r = await call<{ metaobjectDefinitionUpdate: { userErrors: UserError[] } }>(graphql, DEFINITION_UPDATE, {
        id: def.id,
        definition: { fieldDefinitions: missing.map((f) => ({ create: f })) },
      });
      userErrors(r.metaobjectDefinitionUpdate.userErrors, "Couldn't add the listing fields");
    }
  }
  const state = { until: Date.now() + 10 * 60 * 1000, publishable };
  checked.set(shop, state);
  return state;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/** Close to Liquid's `handleize`, so the theme can find the entry by `product.vendor | handleize`. */
export function handleFor(vendorName: string): string {
  return vendorName
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/['"]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 200);
}

/** The handle of the entry whose vendor_name matches, if one exists. */
export async function findEntryHandle(graphql: AdminGraphql, vendorName: string): Promise<string | null> {
  let cursor: string | null = null;
  for (let page = 0; page < 40; page++) {
    const { metaobjects }: {
      metaobjects: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { handle: string; field: { value: string | null } | null }[] };
    } = await call(graphql, ENTRIES_QUERY, { type: SELLER_TYPE, cursor });
    const hit = metaobjects.nodes.find((n) => (n.field?.value ?? "").trim() === vendorName.trim());
    if (hit) return hit.handle;
    if (!metaobjects.pageInfo.hasNextPage) return null;
    cursor = metaobjects.pageInfo.endCursor;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

type StoredImage = { id: string; fileName: string; mimeType: string; size: number; data: Uint8Array; shopifyFileId: string | null };

async function fileState(graphql: AdminGraphql, id: string) {
  const { node } = await call<{ node: { id: string; fileStatus: string; fileErrors: { message: string }[] } | null }>(graphql, FILE_STATUS, { id });
  return node;
}

/** Copies a brand image to the store's Files once, and returns its id. Reuses the copy while it still exists. */
export async function ensureStoreImage(
  db: PrismaClient, graphql: AdminGraphql, image: StoredImage, alt: string, deps: Required<ListingDeps>,
): Promise<string> {
  if (image.shopifyFileId) {
    const node = await fileState(graphql, image.shopifyFileId);
    if (node && node.fileStatus !== "FAILED") return image.shopifyFileId;
  }
  const staged = await call<{ stagedUploadsCreate: { stagedTargets: { url: string; resourceUrl: string; parameters: { name: string; value: string }[] }[]; userErrors: UserError[] } }>(
    graphql, STAGE,
    { input: [{ filename: image.fileName, mimeType: image.mimeType, resource: "IMAGE", httpMethod: "POST", fileSize: String(image.size) }] },
  );
  userErrors(staged.stagedUploadsCreate.userErrors, "Couldn't start the image upload");
  const target = staged.stagedUploadsCreate.stagedTargets[0];
  if (!target) throw new ListingError("Shopify gave no upload target for the image.");

  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append("file", new Blob([new Uint8Array(image.data)], { type: image.mimeType }), image.fileName);
  const sent = await deps.upload(target.url, form);
  if (!sent.ok) throw new ListingError(`The image upload to Shopify failed (HTTP ${sent.status}).`);

  const created = await call<{ fileCreate: { files: { id: string; fileStatus: string }[]; userErrors: UserError[] } }>(graphql, FILE_CREATE, {
    files: [{ originalSource: target.resourceUrl, contentType: "IMAGE", alt: alt.slice(0, 512), filename: image.fileName }],
  });
  userErrors(created.fileCreate.userErrors, "Shopify didn't accept the image");
  const id = created.fileCreate.files[0]?.id;
  if (!id) throw new ListingError("Shopify didn't return the new image.");

  // Images are processed in the background; usually ready in a second or two.
  for (let i = 0; i < 8; i++) {
    const node = await fileState(graphql, id);
    if (node?.fileStatus === "READY") break;
    if (node?.fileStatus === "FAILED") throw new ListingError(`Shopify couldn't process the image: ${node.fileErrors.map((e) => e.message).join("; ") || "unknown reason"}`);
    await deps.sleep(750);
  }
  await db.vendorFile.update({ where: { id: image.id }, data: { shopifyFileId: id } });
  return id;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

const sameDecimal = (a: string, b: string) => a !== "" && b !== "" && Number(a) === Number(b);
const NUMBERS = new Set(["minimum_order_value", "rating", "review_count"]);

/**
 * Brings the vendor's store entry in line with the app. Writes only fields
 * that differ, so saving unchanged details sends nothing but two reads.
 * Never throws: the outcome is returned and recorded on the vendor.
 */
export async function syncListing(
  db: PrismaClient, graphql: AdminGraphql, shop: string, vendorId: string, deps: ListingDeps = {},
): Promise<ListingResult> {
  const d: Required<ListingDeps> = {
    upload: deps.upload ?? (async (url, body) => fetch(url, { method: "POST", body })),
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
  };
  const vendor = await db.vendor.findFirst({ where: { id: vendorId, shop } });
  if (!vendor) return { ok: false, error: "Vendor not found" };
  try {
    const { publishable } = await ensureSellerDefinition(graphql, shop);
    const handle = vendor.storeEntryHandle ?? (await findEntryHandle(graphql, vendor.vendorName)) ?? (handleFor(vendor.vendorName) || `seller-${vendor.id}`);

    const imageId = async (fileId: string | null, what: string) => {
      if (!fileId) return "";
      const file = await db.vendorFile.findFirst({ where: { id: fileId, vendorId: vendor.id } });
      return file ? ensureStoreImage(db, graphql, file, `${vendor.displayName} ${what}`, d) : "";
    };
    const want: Record<string, string> = {
      vendor_name: vendor.vendorName,
      display_name: vendor.displayName,
      short_description: vendor.shortDescription ?? "",
      description: vendor.description ?? "",
      logo: await imageId(vendor.logoFileId, "logo"),
      banner: await imageId(vendor.bannerFileId, "banner"),
    };
    if (vendor.minimumOrderValue != null) want.minimum_order_value = vendor.minimumOrderValue.toFixed(2);
    const reviews = await reviewSummary(db, shop, vendor.id);
    want.rating = reviews.average ?? "";
    want.review_count = reviews.count ? String(reviews.count) : "";

    const { metaobjectByHandle: entry } = await call<{ metaobjectByHandle: { id: string; fields: { key: string; value: string | null }[] } | null }>(
      graphql, ENTRY_QUERY, { handle: { type: SELLER_TYPE, handle } },
    );
    const have = Object.fromEntries((entry?.fields ?? []).map((f) => [f.key, f.value ?? ""]));
    const changed = Object.keys(want).filter((k) => {
      const now = have[k] ?? "";
      if (NUMBERS.has(k) && sameDecimal(now, want[k])) return false;
      return now !== want[k] && !(entry === null && want[k] === "");
    });

    if (changed.length || !entry) {
      const r = await call<{ metaobjectUpsert: { metaobject: { handle: string } | null; userErrors: UserError[] } }>(graphql, UPSERT, {
        handle: { type: SELLER_TYPE, handle },
        metaobject: {
          fields: changed.map((key) => ({ key, value: want[key] })),
          ...(publishable && !entry ? { capabilities: { publishable: { status: "ACTIVE" } } } : {}),
        },
      });
      userErrors(r.metaobjectUpsert.userErrors, "Shopify didn't accept the listing");
    }
    await db.vendor.update({ where: { id: vendor.id }, data: { storeEntryHandle: handle, storeSyncedAt: new Date(), storeSyncError: null } });
    return { ok: true, handle, changed };
  } catch (e) {
    const error = e instanceof ListingError ? e.message : friendly(e);
    await db.vendor.update({ where: { id: vendor.id }, data: { storeSyncError: error } }).catch(() => {});
    return { ok: false, error };
  }
}
