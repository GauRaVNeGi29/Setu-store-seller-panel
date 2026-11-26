import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { updateStoreListing } from "../lib/storefront/update.server";
import db from "../db.server";
import { vendorLines } from "../lib/orders/admin.server";
import { addVendorUser, enableVendor, getVendorByName, removeVendorUser, setVendorStatus } from "../lib/vendors/vendors.server";
import {
  adminUpdateDetails, adminUpdateUser, changeRequestState, listPeople, reviewBusinessChange, vendorDetails,
} from "../lib/vendors/team.server";
import { BUSINESS_FIELDS, BUSINESS_FILES, FIELD_LABEL } from "../lib/vendors/fields";
import { createTeamHandoff } from "../lib/portal/auth.server";
import { commissionHistory, setCommissionRate } from "../lib/commission/commission.server";
import { portalBaseUrl } from "../lib/portal/context.server";
import { setReviewHidden, vendorReviews, type ReviewRow } from "../lib/reviews/reviews.server";
import { HIDE_REASON_MAX, type ReviewSummary } from "../lib/reviews/rules";

/**
 * One vendor, team-only inside Shopify admin:
 *  - portal access (pause / reactivate the whole vendor)
 *  - business changes waiting for approval
 *  - people: status, role and staff access
 *  - brand and business details (the team edits directly, no approval step)
 *  - order lines
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const name = url.searchParams.get("name") ?? "";
  const reviewPage = Number(url.searchParams.get("reviews")) || 1;
  const [lines, vendor] = await Promise.all([vendorLines(db, session.shop, name), getVendorByName(db, session.shop, name)]);
  const [profile, people, change, commission, reviews] = vendor
    ? await Promise.all([
      vendorDetails(db, session.shop, vendor.id), listPeople(db, session.shop, vendor.id), changeRequestState(db, session.shop, vendor.id),
      commissionHistory(db, session.shop, vendor.id), vendorReviews(db, session.shop, vendor.id, reviewPage),
    ])
    : [null, [], null, [], null];
  return {
    name, lines, profile, people, change, commission: [...commission].reverse(), reviews, vendor: vendor && {
      id: vendor.id, status: vendor.status,
      store: { handle: vendor.storeEntryHandle, syncedAt: vendor.storeSyncedAt?.toISOString() ?? null, error: vendor.storeSyncError },
    },
    portalUrl: portalBaseUrl(request),
  };
};

export const action = async ({ request }: ActionFunctionArgs): Promise<{ ok: boolean; message?: string; error?: string; viewUrl?: string }> => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const actor = `admin:${session.onlineAccessInfo?.associated_user?.email ?? "staff"}`;
  const form = await request.formData();
  const f = (k: string) => String(form.get(k) ?? "");
  const intent = f("intent");
  const name = f("name");

  if (intent === "enable") {
    if (!name) return { ok: false, error: "Vendor name missing" };
    await enableVendor(db, shop, name, actor);
    return { ok: true, message: "Portal access set up" };
  }
  const vendor = await getVendorByName(db, shop, name);
  if (!vendor) return { ok: false, error: "Set up portal access first" };
  type Out = { ok: boolean; message?: string; error?: string };
  const done = (r: { ok: boolean; error?: string }, message: string): Out => (r.ok ? { ok: true, message } : { ok: false, error: r.error });

  switch (intent) {
    case "add_user": {
      const role = f("role") === "staff" ? "staff" : "owner";
      const access = f("access") === "view" ? "view" : "edit";
      return done(await addVendorUser(db, shop, vendor.id, f("email"), f("person"), actor, { role, access }), "Person added – they create their password at /portal/signup");
    }
    case "update_user":
      return done(await adminUpdateUser(db, shop, f("userId"), { status: f("status"), role: f("role"), access: f("access") }, actor), "Saved");
    case "remove_user":
      return done(await removeVendorUser(db, shop, f("userId"), actor), "Person removed");
    case "pause":
    case "activate":
      return done(await setVendorStatus(db, shop, vendor.id, intent === "pause" ? "paused" : "active", actor), intent === "pause" ? "Vendor paused – everyone signed out" : "Vendor active");
    case "approve_change":
    case "reject_change":
      return done(
        await reviewBusinessChange(db, shop, f("requestId"), intent === "approve_change" ? "approve" : "reject", f("note") || null, actor),
        intent === "approve_change" ? "Change approved – details updated" : "Change declined",
      );
    case "details": {
      const r = await adminUpdateDetails(db, shop, vendor.id, Object.fromEntries(form), actor);
      if (!r.ok) return done(r, "");
      const listing = await updateStoreListing(db, shop, vendor.id);
      return listing.ok
        ? { ok: true, message: "Details saved – store listing updated" }
        : { ok: true, message: "Details saved", error: `The store listing didn't update: ${listing.error}` };
    }
    case "store_listing": {
      const r = await updateStoreListing(db, shop, vendor.id);
      return r.ok
        ? { ok: true, message: r.changed.length ? "Store listing updated" : "Store listing already up to date" }
        : { ok: false, error: r.error };
    }
    case "commission": {
      const r = await setCommissionRate(db, shop, vendor.id, f("rate"), actor);
      return r.ok ? { ok: true, message: `Commission set to ${Number(r.rate)}%` } : r;
    }
    case "hide_review":
    case "show_review": {
      const hide = intent === "hide_review";
      const r = await setReviewHidden(db, shop, vendor.id, f("reviewId"), hide, actor, f("reason"));
      if (!r.ok) return r;
      // The rating on the store listing follows the published reviews.
      const listing = await updateStoreListing(db, shop, vendor.id);
      const message = hide ? "Review hidden – no longer counted in the rating" : "Review shown again";
      return listing.ok ? { ok: true, message } : { ok: true, message, error: `The rating on the store listing didn't update: ${listing.error}` };
    }
    case "team_view": {
      const r = await createTeamHandoff(db, shop, vendor.id, actor);
      return r.ok ? { ok: true, viewUrl: `${portalBaseUrl(request)}/portal/view?token=${encodeURIComponent(r.token)}` } : r;
    }
  }
  return { ok: false, error: "Unknown action" };
};

const inr = (v: string) => `₹${Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "never");
const cell = { padding: 6, borderBottom: "1px solid #eee", verticalAlign: "top" } as const;
const input = { padding: 6, border: "1px solid #ccc", borderRadius: 6, font: "inherit" } as const;
const STATUS = {
  unfulfilled: "To ship", partial: "Partly shipped", fulfilled: "Shipped", refunded: "Refunded", cancelled: "Cancelled",
} as Record<string, string>;

type AdminFile = { id: string; fileName: string; mimeType: string; size: number } | null;

/** Files are fetched with the admin session (App Bridge adds the token to fetch), then opened from memory. */
async function openFile(id: string) {
  const res = await fetch(`/app/files/${id}`);
  if (!res.ok) throw new Error(`Couldn't open the file (${res.status})`);
  const url = URL.createObjectURL(await res.blob());
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function FileButton({ file }: { file: AdminFile }) {
  const [error, setError] = useState<string | null>(null);
  if (!file) return <span style={{ color: "#666" }}>Not uploaded</span>;
  return (
    <span>
      <s-button variant="tertiary" onClick={() => openFile(file.id).catch((e: Error) => setError(e.message))}>{file.fileName}</s-button>
      <small style={{ color: "#666" }}> {(file.size / 1024).toFixed(0)} KB</small>
      {error && <small style={{ color: "#a63a32" }}> {error}</small>}
    </span>
  );
}

function ImagePreview({ file, wide }: { file: AdminFile; wide?: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!file) return;
    let url: string | null = null;
    fetch(`/app/files/${file.id}`).then((r) => (r.ok ? r.blob() : null)).then((b) => {
      if (b) { url = URL.createObjectURL(b); setSrc(url); }
    }).catch(() => undefined);
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [file]);
  if (!file) return <span style={{ color: "#666" }}>Not uploaded</span>;
  return src
    ? <img src={src} alt="" style={{ display: "block", width: wide ? 320 : 72, height: wide ? 100 : 72, objectFit: wide ? "cover" : "contain", border: "1px solid #e1e3dc", borderRadius: 8, background: "#f3f4f0" }} />
    : <span style={{ color: "#666" }}>Loading…</span>;
}

/**
 * Portal links. The app runs inside Shopify admin's frame and the portal never
 * loads in a frame, so both open in a new tab. "View portal" gets a one-time
 * link (60 s) from the server, opens it, and also shows it in case the browser
 * blocked the new tab.
 */
function PortalAccess({ name, portalUrl, canView, why }: { name: string; portalUrl: string; canView: boolean; why: string | null }) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const viewUrl = fetcher.data && "viewUrl" in fetcher.data ? fetcher.data.viewUrl : undefined;
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (viewUrl && opened.current !== viewUrl) {
      opened.current = viewUrl;
      window.open(viewUrl, "_blank", "noopener");
    }
  }, [viewUrl]);
  return (
    <s-section heading="Vendor portal">
      <s-paragraph>
        Sellers sign in at <b>{portalUrl}/portal/login</b>. The portal opens in a new tab: it doesn&apos;t work inside Shopify admin.
      </s-paragraph>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <s-button variant="primary" {...(busy || !canView ? { disabled: true } : {})}
          onClick={() => fetcher.submit({ name, intent: "team_view" }, { method: "POST" })}>View portal as {name}</s-button>
        <s-button href={`${portalUrl}/portal/login`} target="_blank">Open sign-in page</s-button>
      </div>
      {!canView && why && <s-paragraph>{why}</s-paragraph>}
      {fetcher.data && !fetcher.data.ok && fetcher.data.error && <s-banner tone="critical">{fetcher.data.error}</s-banner>}
      {viewUrl && (
        <s-banner tone="info">
          Opened in a new tab: a read-only view of {name}&apos;s portal for one hour. Nothing didn&apos;t open?{" "}
          <s-link href={viewUrl} target="_blank">Open {name}&apos;s portal</s-link> (this link works once, for 60 seconds).
        </s-banner>
      )}
      <s-paragraph>
        &ldquo;View portal&rdquo; shows exactly what {name}&apos;s owner sees, without their password. It can&apos;t change anything and is recorded in Recent activity.
      </s-paragraph>
    </s-section>
  );
}

type RateRow = { rate: string; effectiveFrom: string; setBy: string; createdAt: string; fromStart: boolean };

type StoreState = { handle: string | null; syncedAt: string | null; error: string | null };

/** The vendor's public listing (marketplace_seller entry): what the theme shows on product pages and the cart uses for the minimum. */
function StoreListingSection({ name, store }: { name: string; store: StoreState }) {
  const fetcher = useFetcher<{ ok: boolean; message?: string; error?: string }>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";
  useEffect(() => {
    if (fetcher.data?.ok && fetcher.data.message) shopify.toast.show(fetcher.data.message);
  }, [fetcher.data, shopify]);
  const error = fetcher.data && !fetcher.data.ok ? fetcher.data.error : fetcher.state === "idle" && !fetcher.data ? store.error : null;
  return (
    <s-section heading="Store listing">
      <s-paragraph>
        The logo, brand name, short description, description and minimum order value shown on this vendor&apos;s product pages.
        The cart uses the same minimum. It updates by itself when the vendor saves My brand or you save Details.
      </s-paragraph>
      {error && <s-banner tone="warning">Last update didn&apos;t go through: {error}</s-banner>}
      <s-paragraph>
        {store.syncedAt ? <>Last updated {when(store.syncedAt)}.</> : <>Not copied to the store yet.</>}
        {store.handle && <> Entry: <s-link href="shopify://admin/content/metaobjects/entries/marketplace_seller" target="_top">Marketplace seller</s-link> &ldquo;{store.handle}&rdquo;.</>}
      </s-paragraph>
      <fetcher.Form method="post">
        <input type="hidden" name="name" value={name} />
        <input type="hidden" name="intent" value="store_listing" />
        <s-button type="submit" {...(busy ? { loading: true } : {})}>Update store listing</s-button>
      </fetcher.Form>
    </s-section>
  );
}

function CommissionSection({ name, history }: { name: string; history: RateRow[] }) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const current = history[0] ?? null;
  const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
  return (
    <s-section heading="Commission">
      <s-paragraph>
        {current
          ? <>Setu Store takes <b>{Number(current.rate)}%</b> of {name}&apos;s sales after discounts and refunds. {name} sees this on their Earnings page.</>
          : <><b>No commission rate set.</b> {name} sees &ldquo;Commission rate not set yet&rdquo; on their Earnings page.</>}
      </s-paragraph>
      {fetcher.data && !fetcher.data.ok && fetcher.data.error && <s-banner tone="critical">{fetcher.data.error}</s-banner>}
      <fetcher.Form method="post" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input type="hidden" name="name" value={name} />
        <input type="hidden" name="intent" value="commission" />
        <label htmlFor="rate" style={{ fontSize: 13 }}>{current ? "Change rate to" : "Set rate"}</label>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <input id="rate" name="rate" inputMode="decimal" required placeholder={current ? String(Number(current.rate)) : "e.g. 15"}
            style={{ padding: 6, border: "1px solid #ccc", borderRadius: 6, width: 90, font: "inherit" }} />%
        </span>
        <s-button type="submit" {...(busy ? { loading: true } : {})}>{current ? "Change rate" : "Set rate"}</s-button>
      </fetcher.Form>
      <s-paragraph>
        {current
          ? "A new rate applies to orders placed from the moment you change it. Orders already placed keep the rate they were placed under."
          : "The first rate applies to all of their orders, including ones already placed. Later changes apply only to new orders."}
      </s-paragraph>
      {history.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr style={{ textAlign: "left" }}><th style={cell}>Rate</th><th style={cell}>Applies to orders placed</th><th style={cell}>Set by</th></tr></thead>
          <tbody>
            {history.map((h, i) => (
              <tr key={h.createdAt + h.rate}>
                <td style={cell}><b>{Number(h.rate)}%</b>{i === 0 ? " (current)" : ""}</td>
                <td style={cell}>{h.fromStart ? "From the start" : `From ${when(h.effectiveFrom)}`}{i > 0 ? ` until ${when(history[i - 1].effectiveFrom)}` : ""}</td>
                <td style={cell}>{h.setBy}<br /><small style={{ color: "#666" }}>{when(h.createdAt)}</small></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </s-section>
  );
}

type ReviewList = { summary: ReviewSummary; total: number; hidden: number; page: number; pages: number; reviews: ReviewRow[] };

function ReviewRowView({ r, name }: { r: ReviewRow; name: string }) {
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (fetcher.data?.ok && fetcher.data.message) shopify.toast.show(fetcher.data.message);
  }, [fetcher.data, shopify]);
  const reasonId = `reason-${r.id}`;
  return (
    <tr>
      <td style={{ ...cell, whiteSpace: "nowrap" }}><b>{r.rating}</b> / 5</td>
      <td style={cell}>
        {r.comment ? <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{r.comment}</span> : <span style={{ color: "#666" }}>No written review</span>}
        <br /><small style={{ color: "#666" }}>{r.authorName}{r.location ? ` (${r.location})` : ""}, {when(r.createdAt)}{r.edited ? " (edited)" : ""}, order {r.orderName}{r.items.length ? `, about ${r.items.join(", ")}` : ""}</small>
        {r.hidden && <><br /><small style={{ color: "#a63a32" }}>Hidden{r.hiddenBy ? ` by ${r.hiddenBy.replace(/^admin:/, "")}` : ""}{r.hiddenReason ? `: ${r.hiddenReason}` : ""}</small></>}
        {fetcher.data && !fetcher.data.ok && fetcher.data.error && <><br /><small style={{ color: "#a63a32" }}>{fetcher.data.error}</small></>}
        {fetcher.data && fetcher.data.ok && fetcher.data.error && <><br /><small style={{ color: "#8a5a12" }}>{fetcher.data.error}</small></>}
      </td>
      <td style={cell}>{r.hidden ? <s-badge tone="critical">Hidden</s-badge> : <s-badge tone="success">Published</s-badge>}</td>
      <td style={cell}>
        {r.hidden ? (
          <fetcher.Form method="post">
            <input type="hidden" name="name" value={name} />
            <input type="hidden" name="intent" value="show_review" />
            <input type="hidden" name="reviewId" value={r.id} />
            <s-button type="submit" {...(busy ? { loading: true } : {})}>Show again</s-button>
          </fetcher.Form>
        ) : asking ? (
          <fetcher.Form method="post" style={{ display: "grid", gap: 6, minWidth: 220 }} onSubmit={() => setAsking(false)}>
            <input type="hidden" name="name" value={name} />
            <input type="hidden" name="intent" value="hide_review" />
            <input type="hidden" name="reviewId" value={r.id} />
            <label htmlFor={reasonId} style={{ fontSize: 13 }}>Why hide it? The vendor sees this.</label>
            <input id={reasonId} name="reason" required maxLength={HIDE_REASON_MAX} placeholder="e.g. Abusive language" style={input} />
            <span style={{ display: "flex", gap: 6 }}>
              <s-button type="submit" tone="critical" {...(busy ? { loading: true } : {})}>Hide review</s-button>
              <s-button type="button" variant="tertiary" onClick={() => setAsking(false)}>Cancel</s-button>
            </span>
          </fetcher.Form>
        ) : (
          <s-button type="button" onClick={() => setAsking(true)} {...(busy ? { loading: true } : {})}>Hide</s-button>
        )}
      </td>
    </tr>
  );
}

/** Buyers' reviews of this vendor. The team can hide one (with a reason the vendor sees) or show it again. */
function ReviewsSection({ name, brand, list }: { name: string; brand: string; list: ReviewList }) {
  const s = list.summary;
  const link = (p: number) => `/app/vendor?name=${encodeURIComponent(name)}${p > 1 ? `&reviews=${p}` : ""}`;
  return (
    <s-section heading="Reviews">
      <s-paragraph>
        {s.average !== null
          ? <><b>{s.average} out of 5</b> from {s.count} review{s.count === 1 ? "" : "s"}{list.hidden ? `, plus ${list.hidden} hidden` : ""}. </>
          : list.total ? <>No rating: all {list.total} review{list.total === 1 ? " is" : "s are"} hidden. </> : <>No reviews yet. </>}
        Only buyers with a shipped order from {brand} can review them. {brand} sees these on their Reviews page but can&apos;t change them.
      </s-paragraph>
      {list.total > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr style={{ textAlign: "left" }}><th style={cell}>Rating</th><th style={cell}>Review</th><th style={cell}>Status</th><th style={cell}></th></tr></thead>
          <tbody>{list.reviews.map((r) => <ReviewRowView key={r.id + r.hidden} r={r} name={name} />)}</tbody>
        </table>
      )}
      {list.pages > 1 && (
        <s-paragraph>
          {list.page > 1 && <><s-link href={link(list.page - 1)}>Newer</s-link>{" "}</>}
          Page {list.page} of {list.pages}
          {list.page < list.pages && <>{" "}<s-link href={link(list.page + 1)}>Older</s-link></>}
        </s-paragraph>
      )}
    </s-section>
  );
}

type Person = { id: string; email: string; name: string | null; status: string; role: string; access: string; lastLoginAt: string | null };

function PersonRow({ p, name }: { p: Person; name: string }) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  // "Invited" and "Declined" aren't choices, but must show as the current value.
  const statusOptions: [string, string][] = [
    ...(p.status === "invited" ? [["invited", "Invited – no password yet"] as [string, string]] : []),
    ...(p.status === "rejected" ? [["rejected", "Declined sign-up"] as [string, string]] : []),
    ["active", "Active"], ["disabled", "Deactivated"], ["pending", "Requires approval"],
  ];
  return (
    <tr>
      <td style={cell}>{p.name && <b>{p.name}<br /></b>}{p.email}<br /><small style={{ color: "#666" }}>Last sign-in: {when(p.lastLoginAt)}</small></td>
      <td style={cell} colSpan={3}>
        <fetcher.Form method="post" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input type="hidden" name="name" value={name} />
          <input type="hidden" name="intent" value="update_user" />
          <input type="hidden" name="userId" value={p.id} />
          <select name="status" defaultValue={p.status} aria-label={`Status for ${p.email}`} style={input}>
            {statusOptions.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select name="role" defaultValue={p.role} aria-label={`Role for ${p.email}`} style={input}>
            <option value="owner">Owner – full access</option>
            <option value="staff">Staff</option>
          </select>
          <select name="access" defaultValue={p.access} aria-label={`Staff access for ${p.email}`} style={input}>
            <option value="view">Staff access: view only</option>
            <option value="edit">Staff access: view and edit</option>
          </select>
          <s-button type="submit" {...(busy ? { loading: true } : {})}>Save</s-button>
        </fetcher.Form>
        {fetcher.data && !fetcher.data.ok && <div style={{ color: "#a63a32", marginTop: 4 }}>{fetcher.data.error}</div>}
      </td>
      <td style={cell}>
        <fetcher.Form method="post" onSubmit={(e) => { if (!confirm(`Remove ${p.email}? They'll be signed out and lose access.`)) e.preventDefault(); }}>
          <input type="hidden" name="name" value={name} />
          <input type="hidden" name="intent" value="remove_user" />
          <input type="hidden" name="userId" value={p.id} />
          <s-button variant="tertiary" tone="critical" type="submit" {...(busy ? { disabled: true } : {})}>Remove</s-button>
        </fetcher.Form>
      </td>
    </tr>
  );
}

export default function Vendor() {
  const { name, lines, vendor, profile, people, change, portalUrl, commission, reviews } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    const r = fetcher.data;
    if (r && "message" in r && r.message) shopify.toast.show(r.message);
  }, [fetcher.data, shopify]);

  const submit = (fields: Record<string, string>) => fetcher.submit({ name, ...fields }, { method: "POST" });
  const pending = change?.pending;

  return (
    <s-page heading={profile?.displayName || name || "(no vendor)"}>
      <s-link slot="breadcrumb-actions" href="/app/vendors">All vendors</s-link>
      {fetcher.data && !fetcher.data.ok && fetcher.data.error && <s-banner tone="critical">{fetcher.data.error}</s-banner>}
      {fetcher.data && fetcher.data.ok && fetcher.data.error && <s-banner tone="warning">{fetcher.data.error}</s-banner>}

      {!vendor ? (
        <s-section heading="Vendor portal access">
          <s-paragraph>
            {name} can&apos;t sign in to the vendor portal yet. Setting up access lets you add the people who may sign in.
            They will only ever see order lines where the product vendor is exactly &ldquo;{name}&rdquo;.
          </s-paragraph>
          <s-button variant="primary" onClick={() => submit({ intent: "enable" })} {...(busy || !name ? { disabled: true } : {})}>Set up portal access</s-button>
        </s-section>
      ) : (
        <>
          <PortalAccess
            name={name} portalUrl={portalUrl}
            canView={vendor.status === "active" && people.some((p) => p.status === "active")}
            why={vendor.status !== "active" ? "This vendor is paused, so its portal can't be opened." : "No one from this vendor has an active account yet, so there's no portal to view."}
          />

          <CommissionSection name={profile?.displayName ?? name} history={commission} />

          <StoreListingSection name={name} store={vendor.store} />

          {reviews && <ReviewsSection name={name} brand={profile?.displayName ?? name} list={reviews} />}

          {pending && (
            <s-section heading="Business change waiting for approval">
              <s-paragraph>Requested {when(pending.createdAt)}{pending.by ? ` by ${pending.by}` : ""}. Nothing changes until you approve.</s-paragraph>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead><tr style={{ textAlign: "left" }}><th style={cell}>Detail</th><th style={cell}>Now</th><th style={cell}>Requested</th></tr></thead>
                <tbody>
                  {BUSINESS_FIELDS.filter((k) => pending.changes[k]).map((k) => {
                    const isFile = (BUSINESS_FILES as readonly string[]).includes(k);
                    const show = (v: string | null) => (isFile ? (v ? <FileButton file={change!.files[v] ?? null} /> : "–") : v ?? "–");
                    return (
                      <tr key={k}>
                        <td style={cell}>{FIELD_LABEL[k]}</td>
                        <td style={cell}>{show(pending.changes[k]!.from)}</td>
                        <td style={cell}><b>{pending.changes[k]!.to === null ? "(removed)" : show(pending.changes[k]!.to)}</b></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 12 }}>
                <fetcher.Form method="post">
                  <input type="hidden" name="name" value={name} />
                  <input type="hidden" name="intent" value="approve_change" />
                  <input type="hidden" name="requestId" value={pending.id} />
                  <s-button type="submit" variant="primary" {...(busy ? { disabled: true } : {})}>Approve and update details</s-button>
                </fetcher.Form>
                <fetcher.Form method="post" style={{ display: "flex", gap: 8, flex: 1, minWidth: 300 }}>
                  <input type="hidden" name="name" value={name} />
                  <input type="hidden" name="intent" value="reject_change" />
                  <input type="hidden" name="requestId" value={pending.id} />
                  <input name="note" placeholder="Reason for declining, shown to the vendor (optional)" aria-label="Reason for declining" style={{ ...input, flex: 1 }} />
                  <s-button type="submit" tone="critical" {...(busy ? { disabled: true } : {})}>Decline</s-button>
                </fetcher.Form>
              </div>
            </s-section>
          )}

          <s-section heading="People">
            <s-paragraph>
              <b>Owners</b> can do everything, including adding staff. <b>Staff</b> see orders; with &ldquo;view and edit&rdquo; they can also edit brand details and send
              business changes. Anyone not Active is signed out at once.
            </s-paragraph>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left" }}>
                  <th style={cell}>Person</th>
                  <th style={cell} colSpan={3}>Status · role · staff access</th>
                  <th style={cell} />
                </tr>
              </thead>
              <tbody>
                {people.length === 0 && <tr><td style={cell} colSpan={5}>No one added yet.</td></tr>}
                {people.map((p) => <PersonRow key={`${p.id}-${p.status}-${p.role}-${p.access}`} p={p} name={name} />)}
              </tbody>
            </table>
            <fetcher.Form method="post" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12, alignItems: "center" }}>
              <input type="hidden" name="name" value={name} />
              <input type="hidden" name="intent" value="add_user" />
              <input name="email" type="email" required placeholder="person@vendor.com" aria-label="Email" style={{ ...input, minWidth: 220 }} />
              <input name="person" placeholder="Name (optional)" aria-label="Name" style={input} />
              <select name="role" defaultValue="owner" aria-label="Role" style={input}>
                <option value="owner">Owner</option>
                <option value="staff">Staff</option>
              </select>
              <select name="access" defaultValue="edit" aria-label="Staff access" style={input}>
                <option value="view">View only (staff)</option>
                <option value="edit">View and edit (staff)</option>
              </select>
              <s-button type="submit" {...(busy ? { loading: true } : {})}>Add person</s-button>
            </fetcher.Form>
          </s-section>

          {profile && (
            <s-section heading="Details">
              {profile.missing.length > 0 && <s-banner tone="warning">Missing: {profile.missing.join(", ")}.</s-banner>}
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginBottom: 16 }}>
                <tbody>
                  {([
                    ["GST certificate", <FileButton key="g" file={profile.gstFile} />],
                    ["IEC certificate", <FileButton key="i" file={profile.iecFile} />],
                    ["AD code letter", <FileButton key="a" file={profile.adCodeFile} />],
                    ["Brand logo", <ImagePreview key="l" file={profile.logoFile} />],
                    ["Brand banner", <ImagePreview key="b" file={profile.bannerFile} wide />],
                  ] as [string, React.ReactNode][]).map(([k, v]) => (
                    <tr key={k}>
                      <td style={{ ...cell, color: "#666", width: 170 }}>{k}</td>
                      <td style={cell}>{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <s-paragraph>Documents, logo and banner come from the vendor. Text details you change here apply at once, without an approval step.</s-paragraph>
              <fetcher.Form method="post" key={JSON.stringify(profile)}>
                <input type="hidden" name="name" value={name} />
                <input type="hidden" name="intent" value="details" />
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                  {([
                    ["displayName", "Brand name (shown in the portal)", profile.displayName],
                    ["companyName", "Company name", profile.companyName],
                    ["addressLine", "Street address", profile.addressLine],
                    ["city", "City", profile.city],
                    ["state", "State", profile.state],
                    ["postalCode", "PIN code", profile.postalCode],
                    ["minimumOrderValue", "Minimum order value (₹)", profile.minimumOrderValue],
                    ["shortDescription", "Short description", profile.shortDescription],
                  ] as [string, string, string | null][]).map(([k, l, v]) => (
                    <label key={k} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span>{l}</span>
                      <input name={k} defaultValue={v ?? ""} style={input} />
                    </label>
                  ))}
                </div>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 12 }}>
                  <span>Brand values (up to 5 short tags, separated by commas; shown on the seller&apos;s page)</span>
                  <input name="brandValues" defaultValue={profile.brandValues.join(", ")} placeholder="e.g. Women owned, Eco-friendly" style={input} />
                </label>
                <fieldset style={{ border: 0, padding: 0, margin: "12px 0 0" }}>
                  <legend style={{ padding: 0, marginBottom: 4 }}>Processing time (days the vendor needs to make or ready an order)</legend>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input name="processingDaysMin" type="number" min={0} max={365} step={1} aria-label="Processing time: from, in days" defaultValue={profile.processingDaysMin ?? ""} style={{ ...input, width: 90 }} />
                    <span>to</span>
                    <input name="processingDaysMax" type="number" min={1} max={365} step={1} aria-label="Processing time: to, in days" defaultValue={profile.processingDaysMax ?? ""} style={{ ...input, width: 90 }} />
                    <span>days</span>
                  </div>
                </fieldset>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 12 }}>
                  <span>Description</span>
                  <textarea name="description" defaultValue={profile.description ?? ""} rows={4} style={input} />
                </label>
                <div style={{ marginTop: 12 }}>
                  <s-button type="submit" {...(busy ? { loading: true } : {})}>Save details</s-button>
                </div>
              </fetcher.Form>
              <s-paragraph>
                Shopify vendor name: <b>{name}</b> (fixed – this decides which order lines they see and which products show this listing).
              </s-paragraph>
            </s-section>
          )}

          <s-section heading="Portal access">
            <s-paragraph>
              Status: <b>{vendor.status === "active" ? "Active" : "Paused"}</b>.{" "}
              {vendor.status === "active" ? "Pausing signs everyone from this vendor out and stops new sign-ins." : "Nobody from this vendor can sign in."}
            </s-paragraph>
            {vendor.status === "active" ? (
              <s-button tone="critical" onClick={() => submit({ intent: "pause" })} {...(busy ? { disabled: true } : {})}>Pause vendor</s-button>
            ) : (
              <s-button onClick={() => submit({ intent: "activate" })} {...(busy ? { disabled: true } : {})}>Reactivate vendor</s-button>
            )}
          </s-section>
        </>
      )}

      <s-section heading={`Order lines (${lines.length})`}>
        {lines.length === 0 ? (
          <s-paragraph>No orders for this vendor.</s-paragraph>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
                <th style={cell}>Order</th>
                <th style={cell}>Date</th>
                <th style={cell}>Item</th>
                <th style={cell}>Qty</th>
                <th style={cell}>Shipped</th>
                <th style={cell}>Refunded</th>
                <th style={cell}>To ship</th>
                <th style={cell}>Line total</th>
                <th style={cell}>Net</th>
                <th style={cell}>Status</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.lineItemId}>
                  <td style={cell}>
                    <s-link href={`shopify://admin/orders/${l.orderId}`} target="_top">{l.orderName}</s-link>
                  </td>
                  <td style={cell}>{new Date(l.orderCreatedAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}</td>
                  <td style={cell}>{l.title}{l.sku ? <><br /><small>{l.sku}</small></> : null}</td>
                  <td style={cell}>{l.quantity}</td>
                  <td style={cell}>{l.fulfilledQuantity}</td>
                  <td style={cell}>{l.refundedQuantity}</td>
                  <td style={cell}>{l.toShip}</td>
                  <td style={cell}>{inr(l.lineTotal)}</td>
                  <td style={cell}>{inr(l.netAmount)}</td>
                  <td style={cell}>{STATUS[l.status] ?? l.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
