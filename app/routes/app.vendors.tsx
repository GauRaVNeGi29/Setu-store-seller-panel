import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { flagsOf, vendorCounts } from "../lib/admin/vendors.server";
import { portalBaseUrl } from "../lib/portal/context.server";
import { updateAllStoreListings } from "../lib/storefront/update.server";
import { daysText } from "../lib/vendors/shipping";
import { cell, headRow, inr, input, muted, plural, table, Tabs, vendorHref, vendorTabs } from "../lib/admin/ui";

/**
 * Vendors: everything about sellers in one place.
 *  - All vendors: every vendor with portal access, with owner, people,
 *    commission, minimum order, processing time, rating, sales and status.
 *  - Needs attention: only the vendors with something for the team to do.
 *  - Sign-ups: new sellers waiting for approval (its own page, same tabs).
 *  - Without portal access: Shopify vendors that have orders but no account.
 */
const VIEWS = ["all", "attention", "no-access"] as const;
type View = (typeof VIEWS)[number];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const asked = new URL(request.url).searchParams.get("view");
  const view: View = (VIEWS as readonly string[]).includes(asked ?? "") ? (asked as View) : "all";
  const { vendors, overview, noAccess, counts } = await vendorCounts(db, session.shop);
  const sales = new Map(overview.vendors.map((v) => [v.vendorName, v]));
  const rows = vendors.map((v) => {
    const s = sales.get(v.vendorName);
    return { ...v, flags: flagsOf(v), net: s?.net ?? null, orders: s?.orders ?? 0, unitsToShip: s?.unitsToShip ?? 0 };
  });
  return {
    view, counts, portalUrl: portalBaseUrl(request),
    vendors: view === "attention" ? rows.filter((v) => v.flags.length > 0) : rows,
    noAccess,
    storeNotUpdated: vendors.filter((v) => v.store !== "ok").length,
  };
};

/** Copies every vendor's brand details to its store listing (marketplace_seller entry). */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  if (form.get("intent") !== "store_listings") return { ok: false, error: "Unknown action" };
  const r = await updateAllStoreListings(db, session.shop);
  if (!r.failed.length) return { ok: true, message: `Store listings updated (${r.updated} of ${r.total})` };
  const first = r.failed[0];
  return {
    ok: false,
    error: r.stopped
      ? first.error
      : `${r.updated} of ${r.total} updated. Not updated: ${r.failed.map((f) => `${f.name} (${f.error})`).join("; ")}`,
  };
};

type Row = ReturnType<typeof useLoaderData<typeof loader>>["vendors"][number];

function VendorTable({ vendors }: { vendors: Row[] }) {
  const [find, setFind] = useState("");
  const q = find.trim().toLowerCase();
  const shown = q ? vendors.filter((v) => [v.displayName, v.vendorName, v.city, ...v.owners].some((t) => t.toLowerCase().includes(q))) : vendors;
  return (
    <>
      {vendors.length > 8 && (
        <div style={{ margin: "0 0 12px" }}>
          <input type="search" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Search by vendor, owner or city" aria-label="Search vendors" style={{ ...input, width: "min(360px, 100%)" }} />
          {q && <span style={{ marginLeft: 10, fontSize: 13, ...muted }}>{plural(shown.length, "vendor")} found</span>}
        </div>
      )}
      <div style={{ overflowX: "auto" }}>
        <table style={table}>
          <thead>
            <tr style={headRow}>
              <th style={cell}>Vendor</th>
              <th style={cell}>Owner and people</th>
              <th style={cell}>Commission</th>
              <th style={cell}>Minimum order</th>
              <th style={cell}>Processing time</th>
              <th style={cell}>Rating</th>
              <th style={cell}>Net sales</th>
              <th style={cell}>Status</th>
              <th style={cell}>Needs attention</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((v) => (
              <tr key={v.id}>
                <td style={cell}>
                  <s-link href={vendorHref(v.vendorName)}>{v.displayName}</s-link>
                  {v.displayName !== v.vendorName && <><br /><small style={muted}>Shopify vendor: {v.vendorName}</small></>}
                  {v.city && <><br /><small style={muted}>{v.city}</small></>}
                </td>
                <td style={cell}>
                  {v.owners.length ? v.owners.join(", ") : <span style={{ color: "#a63a32" }}>No owner</span>}
                  <br /><small style={muted}>{plural(v.people, "person", "people")} · {v.active} active{v.deactivated ? ` · ${v.deactivated} deactivated` : ""}</small>
                </td>
                <td style={cell}>{v.commission !== null ? `${Number(v.commission)}%` : <span style={{ color: "#8a5a12" }}>Not set</span>}</td>
                <td style={cell}>{v.minimumOrderValue ? inr(v.minimumOrderValue) : <span style={muted}>–</span>}</td>
                <td style={cell}>{v.processing ? daysText(v.processing) : <span style={{ color: "#8a5a12" }}>Not given</span>}</td>
                <td style={cell}>{v.rating ? <>{v.rating.average} / 5<br /><small style={muted}>{plural(v.rating.count, "review")}</small></> : <span style={muted}>–</span>}</td>
                <td style={cell}>
                  {v.net !== null ? inr(v.net) : <span style={muted}>–</span>}
                  {v.orders > 0 && <><br /><small style={muted}>{plural(v.orders, "order")}{v.unitsToShip ? ` · ${v.unitsToShip} to ship` : ""}</small></>}
                </td>
                <td style={cell}>{v.status === "active" ? "Active" : <b>Paused</b>}</td>
                <td style={cell}>{v.flags.length ? v.flags.map((f) => <div key={f} style={{ marginBottom: 2 }}><s-badge tone="warning">{f}</s-badge></div>) : <span style={muted}>–</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default function Vendors() {
  const { view, counts, vendors, noAccess, storeNotUpdated, portalUrl } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  useEffect(() => {
    const r = fetcher.data;
    if (r?.ok && "message" in r && r.message) shopify.toast.show(r.message);
  }, [fetcher.data, shopify]);

  return (
    <s-page heading="Vendors">
      <Tabs label="Vendors" current={view} tabs={vendorTabs(counts)} />
      {fetcher.data && !fetcher.data.ok && "error" in fetcher.data && <s-banner tone="critical">{fetcher.data.error}</s-banner>}

      {view === "no-access" ? (
        <s-section heading="Shopify vendors without portal access">
          <s-paragraph>
            These vendor names appear on orders, but nobody can sign in to the vendor portal for them yet. Open one to set up access, or approve a sign-up for it.
          </s-paragraph>
          {noAccess.length === 0 ? (
            <s-paragraph>Every vendor with an order has portal access.</s-paragraph>
          ) : (
            <table style={table}>
              <thead>
                <tr style={headRow}>
                  <th style={cell}>Shopify vendor</th>
                  <th style={cell}>Orders</th>
                  <th style={cell}>Net sales</th>
                  <th style={cell}>Units to ship</th>
                </tr>
              </thead>
              <tbody>
                {noAccess.map((v) => (
                  <tr key={v.vendorName}>
                    <td style={cell}><s-link href={vendorHref(v.vendorName)}>{v.vendorName}</s-link></td>
                    <td style={cell}>{v.orders}</td>
                    <td style={cell}>{inr(v.net)}</td>
                    <td style={cell}>{v.unitsToShip}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </s-section>
      ) : (
        <s-section heading={view === "attention" ? "Vendors that need something from you" : "Vendors with portal access"}>
          {vendors.length === 0 ? (
            <s-paragraph>
              {view === "attention"
                ? "No vendor needs anything from you."
                : "No vendor has portal access yet. Approve a sign-up, or set up access for a vendor under “Without portal access”."}
            </s-paragraph>
          ) : (
            <VendorTable vendors={vendors} />
          )}
          <s-paragraph>Open a vendor to change its people, commission, details, store listing and reviews, or to see its portal as the vendor does.</s-paragraph>
        </s-section>
      )}

      {view === "all" && (
        <s-section heading="Tools">
          <s-paragraph>
            <b>Store listings.</b> Each vendor&apos;s logo, brand name, descriptions, minimum order value, processing time and brand values are copied to the store
            whenever details are saved. {storeNotUpdated > 0
              ? <>{storeNotUpdated} {storeNotUpdated === 1 ? "vendor's listing isn't" : "vendors' listings aren't"} up to date.</>
              : <>All listings are up to date.</>}
          </s-paragraph>
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="store_listings" />
            <s-button type="submit" {...(fetcher.state !== "idle" ? { loading: true } : {})}>Update all store listings</s-button>
          </fetcher.Form>
          <s-paragraph>
            <b>Vendor portal.</b> Sellers sign in at {portalUrl}/portal/login. To see what a vendor sees, open the vendor and choose &ldquo;View portal&rdquo;.
          </s-paragraph>
          <s-button href={`${portalUrl}/portal/login`} target="_blank">Open the sign-in page</s-button>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
