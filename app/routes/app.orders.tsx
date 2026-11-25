import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { recentActivity, vendorOverview } from "../lib/orders/admin.server";
import { fullSync } from "../lib/orders/sync.server";
import { portalStatusByVendor } from "../lib/vendors/vendors.server";
import { portalBaseUrl } from "../lib/portal/context.server";

/**
 * Vendors and orders: every vendor that appears on an order, with totals worked out
 * from the app's own copy of the order lines. The team uses this to check the
 * data matches Shopify before any vendor gets access.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [overview, activity, portal] = await Promise.all([
    vendorOverview(db, session.shop),
    recentActivity(db, session.shop),
    portalStatusByVendor(db, session.shop),
  ]);
  const vendors = overview.vendors.map((v) => {
    const p = portal.get(v.vendorName);
    return { ...v, portal: p ? `${p.status === "active" ? "Active" : "Paused"} · ${p.users} ${p.users === 1 ? "person" : "people"}` : "Not set up" };
  });
  return { ...overview, vendors, activity, portalUrl: portalBaseUrl(request) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();
  if (form.get("intent") !== "resync") return { error: "Unknown action" };
  const actor = `admin:${session.onlineAccessInfo?.associated_user?.email ?? "staff"}`;
  try {
    const result = await fullSync(db, admin.graphql, session.shop, actor);
    return { ok: true, orders: result.orders };
  } catch (e) {
    return { error: (e as Error).message };
  }
};

const inr = (v: string) => `₹${Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "never");
const cell = { padding: 6, borderBottom: "1px solid #eee" } as const;

export default function Index() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    const r = fetcher.data;
    if (r && "ok" in r) shopify.toast.show(`Resynced ${r.orders} orders`);
  }, [fetcher.data, shopify]);

  return (
    <s-page heading="Vendors and orders">
      <s-section heading="Sync status">
        <s-paragraph>
          {data.orderCount} orders copied · last full sync {when(data.lastFullSyncAt)}. New and changed orders arrive automatically within a few seconds.
        </s-paragraph>
        {data.lastError && <s-banner tone="critical">Last sync error: {data.lastError}</s-banner>}
        {fetcher.data && "error" in fetcher.data && <s-banner tone="critical">{fetcher.data.error}</s-banner>}
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="resync" />
          <s-button type="submit" {...(busy ? { loading: true } : {})}>Resync all orders</s-button>
        </fetcher.Form>
      </s-section>

      <s-section heading="Vendor portal">
        <s-paragraph>
          Sellers sign in at <b>{data.portalUrl}/portal/login</b>. Open a vendor below to view their portal as they see it.
        </s-paragraph>
        <s-button href={`${data.portalUrl}/portal/login`} target="_blank">Open sign-in page</s-button>
      </s-section>

      <s-section heading="Vendors">
        {data.vendors.length === 0 ? (
          <s-paragraph>No orders yet.</s-paragraph>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
                <th style={cell}>Vendor</th>
                <th style={cell}>Orders</th>
                <th style={cell}>Units sold</th>
                <th style={cell}>Gross (₹)</th>
                <th style={cell}>Refunded (₹)</th>
                <th style={cell}>Net (₹)</th>
                <th style={cell}>Units to ship</th>
                <th style={cell}>Open orders</th>
                <th style={cell}>Portal access</th>
              </tr>
            </thead>
            <tbody>
              {data.vendors.map((v) => (
                <tr key={v.vendorName || "__none__"}>
                  <td style={cell}>
                    <s-link href={`/app/vendor?name=${encodeURIComponent(v.vendorName)}`}>{v.vendorName || "(no vendor)"}</s-link>
                  </td>
                  <td style={cell}>{v.orders}</td>
                  <td style={cell}>{v.units}</td>
                  <td style={cell}>{inr(v.gross)}</td>
                  <td style={cell}>{inr(v.refunded)}</td>
                  <td style={cell}>{inr(v.net)}</td>
                  <td style={cell}>{v.unitsToShip}</td>
                  <td style={cell}>{v.openOrders}</td>
                  <td style={cell}>{v.portal}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <s-paragraph>
          Gross is after discounts and before refunds; cancelled orders add nothing. Shipping and taxes are not split by vendor yet.
        </s-paragraph>
      </s-section>

      <s-section heading="Recent activity">
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <tbody>
            {data.activity.map((a) => (
              <tr key={a.id}>
                <td style={cell}>{when(a.at)}</td>
                <td style={cell}>{a.action}</td>
                <td style={cell}>{a.target ?? ""}</td>
                <td style={cell}>{a.actor}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
