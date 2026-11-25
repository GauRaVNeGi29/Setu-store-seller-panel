import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { listAllVendors } from "../lib/vendors/team.server";
import { portalBaseUrl } from "../lib/portal/context.server";
import { updateAllStoreListings } from "../lib/storefront/update.server";

/**
 * All vendors with portal access: who owns each account, how many people,
 * who needs attention (approval, business changes). Team-only.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const vendors = await listAllVendors(db, session.shop);
  return {
    portalUrl: portalBaseUrl(request),
    vendors,
    totals: {
      vendors: vendors.length,
      changes: vendors.filter((v) => v.pendingChange).length,
      approvals: vendors.reduce((n, v) => n + v.needsApproval, 0),
      noCommission: vendors.filter((v) => v.commission === null).length,
      storeNotUpdated: vendors.filter((v) => v.store !== "ok").length,
    },
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

const cell = { padding: "8px 6px", borderBottom: "1px solid #eee", verticalAlign: "top" } as const;

export default function AllVendors() {
  const { vendors, totals, portalUrl } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  useEffect(() => {
    const r = fetcher.data;
    if (r?.ok && "message" in r && r.message) shopify.toast.show(r.message);
  }, [fetcher.data, shopify]);
  return (
    <s-page heading="All vendors">
      {fetcher.data && !fetcher.data.ok && "error" in fetcher.data && <s-banner tone="critical">{fetcher.data.error}</s-banner>}
      {(totals.changes > 0 || totals.approvals > 0 || totals.noCommission > 0) && (
        <s-banner tone="warning">
          {totals.changes > 0 && <>{totals.changes} {totals.changes === 1 ? "vendor has" : "vendors have"} business changes waiting for approval. </>}
          {totals.approvals > 0 && <>{totals.approvals} {totals.approvals === 1 ? "person requires" : "people require"} approval. </>}
          {totals.noCommission > 0 && <>{totals.noCommission} {totals.noCommission === 1 ? "vendor has" : "vendors have"} no commission rate. </>}
          Open the vendor to review.
        </s-banner>
      )}
      <s-section heading="Vendor portal">
        <s-paragraph>
          Sellers sign in at <b>{portalUrl}/portal/login</b>. To see what a vendor sees, open the vendor and choose &ldquo;View portal&rdquo;.
        </s-paragraph>
        <s-button href={`${portalUrl}/portal/login`} target="_blank">Open sign-in page</s-button>
      </s-section>
      <s-section heading="Store listings">
        <s-paragraph>
          Each vendor&apos;s logo, brand name, descriptions and minimum order value are copied to the store for product pages and the cart.
          This happens by itself when details are saved. {totals.storeNotUpdated > 0
            ? <>{totals.storeNotUpdated} {totals.storeNotUpdated === 1 ? "vendor's listing isn't" : "vendors' listings aren't"} up to date.</>
            : <>All listings are up to date.</>}
        </s-paragraph>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="store_listings" />
          <s-button type="submit" {...(fetcher.state !== "idle" ? { loading: true } : {})}>Update all store listings</s-button>
        </fetcher.Form>
      </s-section>
      <s-section heading={`Vendors with portal access (${totals.vendors})`}>
        {vendors.length === 0 ? (
          <s-paragraph>No vendor has portal access yet. Approve a sign-up, or open a vendor from &ldquo;Vendors and orders&rdquo; and set up access.</s-paragraph>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left" }}>
                <th style={cell}>Vendor</th>
                <th style={cell}>Owner</th>
                <th style={cell}>People</th>
                <th style={cell}>Commission</th>
                <th style={cell}>Rating</th>
                <th style={cell}>Status</th>
                <th style={cell}>Needs attention</th>
              </tr>
            </thead>
            <tbody>
              {vendors.map((v) => {
                const flags = [
                  v.pendingChange && "Business change to review",
                  v.needsApproval > 0 && `${v.needsApproval} requires approval`,
                  v.invited > 0 && `${v.invited} invited, no password yet`,
                  v.commission === null && "Commission not set",
                  v.store === "error" && "Store listing didn't update",
                  v.store === "never" && "Not on the store yet",
                ].filter(Boolean) as string[];
                return (
                  <tr key={v.id}>
                    <td style={cell}>
                      <s-link href={`/app/vendor?name=${encodeURIComponent(v.vendorName)}`}>{v.displayName}</s-link>
                      {v.missing.length > 0 && <><br /><small style={{ color: "#8a5a12" }}>Missing: {v.missing.join(", ")}</small></>}
                      {v.displayName !== v.vendorName && <><br /><small style={{ color: "#666" }}>Shopify vendor: {v.vendorName}</small></>}
                      {v.city && <><br /><small style={{ color: "#666" }}>{v.city}</small></>}
                    </td>
                    <td style={cell}>{v.owners.length ? v.owners.join(", ") : <span style={{ color: "#a63a32" }}>No owner</span>}</td>
                    <td style={cell}>
                      {v.people} ({v.people - v.staff} owner{v.people - v.staff === 1 ? "" : "s"}, {v.staff} staff)
                      <br /><small style={{ color: "#666" }}>{v.active} active{v.deactivated ? ` · ${v.deactivated} deactivated` : ""}</small>
                    </td>
                    <td style={cell}>{v.commission !== null ? `${Number(v.commission)}%` : <span style={{ color: "#8a5a12" }}>Not set</span>}</td>
                    <td style={cell}>{v.rating ? <>{v.rating.average} / 5<br /><small style={{ color: "#666" }}>{v.rating.count} review{v.rating.count === 1 ? "" : "s"}</small></> : <span style={{ color: "#666" }}>–</span>}</td>
                    <td style={cell}>{v.status === "active" ? "Active" : <b>Paused</b>}</td>
                    <td style={cell}>{flags.length ? flags.map((f) => <div key={f}><s-badge tone="warning">{f}</s-badge></div>) : <span style={{ color: "#666" }}>–</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
