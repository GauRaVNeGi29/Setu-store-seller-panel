import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { resendDeliveryTime, saveDeliveryTime, teamDashboard } from "../lib/settings/settings.server";
import { portalBaseUrl } from "../lib/portal/context.server";
import { daysText, totalDays } from "../lib/vendors/shipping";

/**
 * The app's home: what is waiting for the team, the store-wide settings
 * (delivery time), each seller's shipping times, and links to the other pages.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return { ...(await teamDashboard(db, session.shop)), portalUrl: portalBaseUrl(request) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  const actor = `admin:${session.onlineAccessInfo?.associated_user?.email ?? "staff"}`;
  if (intent === "delivery_time") {
    return saveDeliveryTime(db, admin.graphql, session.shop, { min: String(form.get("deliveryDaysMin") ?? ""), max: String(form.get("deliveryDaysMax") ?? "") }, actor);
  }
  if (intent === "delivery_resend") return resendDeliveryTime(db, admin.graphql, session.shop);
  return { ok: false as const, error: "Unknown action" };
};

const cell = { padding: 6, borderBottom: "1px solid #eee" } as const;
const input = { padding: 6, border: "1px solid #ccc", borderRadius: 6, font: "inherit", width: 90 } as const;
const vendorHref = (vendorName: string) => `/app/vendor?name=${encodeURIComponent(vendorName)}`;

type Named = { name: string; vendorName: string };

/** "3 vendors have …: A, B, C" with each name linked to the vendor. */
function Waiting({ list, one, many }: { list: Named[]; one: string; many: string }) {
  if (list.length === 0) return null;
  return (
    <li style={{ marginBottom: 6 }}>
      {list.length} {list.length === 1 ? one : many}:{" "}
      {list.map((v, i) => (
        <span key={v.vendorName}>
          {i > 0 && ", "}
          <s-link href={vendorHref(v.vendorName)}>{v.name}</s-link>
        </span>
      ))}
    </li>
  );
}

export default function Dashboard() {
  const { delivery, attention, numbers, vendors, portalUrl } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const busy = (intent: string) => fetcher.state !== "idle" && fetcher.formData?.get("intent") === intent;
  const result = fetcher.data;

  useEffect(() => {
    if (result?.ok && result.onStore) shopify.toast.show(result.range ? "Delivery time saved" : "Delivery time removed");
  }, [result, shopify]);

  const waiting = attention.signups + attention.businessChanges.length + attention.noCommission.length + attention.missingDetails.length
    + attention.noProcessingTime.length + attention.storeNotUpdated.length;
  const example = { min: 10, max: 15 };

  return (
    <s-page heading="Dashboard">
      <s-section heading="Needs your attention">
        {waiting === 0 ? (
          <s-paragraph>Nothing is waiting for you.</s-paragraph>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {attention.signups > 0 && (
              <li style={{ marginBottom: 6 }}>
                <s-link href="/app/signups">{attention.signups} {attention.signups === 1 ? "sign-up is" : "sign-ups are"} waiting for approval</s-link>
              </li>
            )}
            <Waiting list={attention.businessChanges} one="vendor has business changes to review" many="vendors have business changes to review" />
            <Waiting list={attention.noCommission} one="vendor has no commission rate" many="vendors have no commission rate" />
            <Waiting list={attention.noProcessingTime} one="vendor hasn't given a processing time" many="vendors haven't given a processing time" />
            <Waiting list={attention.missingDetails} one="vendor has details missing" many="vendors have details missing" />
            <Waiting list={attention.storeNotUpdated} one="vendor's store listing isn't up to date" many="vendors' store listings aren't up to date" />
          </ul>
        )}
      </s-section>

      <s-section heading="Delivery time">
        <s-paragraph>
          How many days a shipment takes to reach the buyer once the seller hands it over. It is one range for the whole store.
          It is added to each seller&apos;s processing time, and the seller page shows the result as dates: when an order placed today arrives.
        </s-paragraph>
        {result && !result.ok && <s-banner tone="critical">{result.error}</s-banner>}
        {delivery.error && !(result?.ok && result.onStore) && (
          <s-banner tone="warning">
            The delivery time is saved here, but the store doesn&apos;t show it yet. {delivery.error}
            <fetcher.Form method="post" style={{ marginTop: 8 }}>
              <input type="hidden" name="intent" value="delivery_resend" />
              <s-button type="submit" {...(busy("delivery_resend") ? { loading: true } : {})}>Send to the store again</s-button>
            </fetcher.Form>
          </s-banner>
        )}
        <fetcher.Form method="post" key={`${delivery.range?.min}-${delivery.range?.max}`}>
          <input type="hidden" name="intent" value="delivery_time" />
          <fieldset style={{ border: 0, padding: 0, margin: "8px 0" }}>
            <legend style={{ padding: 0, marginBottom: 4, fontWeight: 600 }}>Delivery time, in days</legend>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <input name="deliveryDaysMin" type="number" min={0} max={365} step={1} aria-label="Delivery time: from, in days" defaultValue={delivery.range?.min ?? ""} style={input} />
              <span>to</span>
              <input name="deliveryDaysMax" type="number" min={1} max={365} step={1} aria-label="Delivery time: to, in days" defaultValue={delivery.range?.max ?? ""} style={input} />
              <span>days</span>
              <s-button type="submit" variant="primary" {...(busy("delivery_time") ? { loading: true } : {})}>Save</s-button>
            </div>
          </fieldset>
        </fetcher.Form>
        <s-paragraph>
          {delivery.range ? (
            <>
              Now: <b>{daysText(delivery.range)}</b>
              {delivery.updatedBy && delivery.updatedAt && <> · set by {delivery.updatedBy} on {new Date(delivery.updatedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })}</>}
              . For a seller who needs {daysText(example)} to ready an order, buyers see the dates {daysText(totalDays(example, delivery.range)!)} from today, such as &ldquo;Arrives Dec 10 – Dec 17&rdquo;.
            </>
          ) : (
            <>Not set. Seller pages show no arrival dates until you set it. Leave both boxes empty and save to remove it again.</>
          )}
        </s-paragraph>
      </s-section>

      <s-section heading="Shipping times by seller">
        <s-paragraph>
          Each seller sets their processing time (days to make or ready an order) in the vendor portal, under My brand. You can change it on the vendor&apos;s page.
          Buyers don&apos;t see these numbers, only the arrival dates they add up to.
        </s-paragraph>
        {vendors.length === 0 ? (
          <s-paragraph>No vendor has portal access yet.</s-paragraph>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
                <th style={cell}>Seller</th>
                <th style={cell}>Processing time</th>
                <th style={cell}>Delivery time</th>
                <th style={cell}>Arrives after</th>
              </tr>
            </thead>
            <tbody>
              {vendors.map((v) => {
                const total = totalDays(v.processing, delivery.range);
                return (
                  <tr key={v.id}>
                    <td style={cell}><s-link href={vendorHref(v.vendorName)}>{v.name}</s-link></td>
                    <td style={cell}>{v.processing ? daysText(v.processing) : <span style={{ color: "#8a5a12" }}>Not given</span>}</td>
                    <td style={cell}>{delivery.range ? daysText(delivery.range) : <span style={{ color: "#666" }}>Not set</span>}</td>
                    <td style={cell}>{total ? <b>{daysText(total)}</b> : <span style={{ color: "#666" }}>–</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </s-section>

      <s-section heading="At a glance">
        <s-paragraph>
          {numbers.vendors} {numbers.vendors === 1 ? "vendor" : "vendors"} with portal access ({numbers.active} active{numbers.paused ? `, ${numbers.paused} paused` : ""})
          {" · "}{numbers.reviews} published {numbers.reviews === 1 ? "review" : "reviews"}{numbers.hiddenReviews ? `, ${numbers.hiddenReviews} hidden` : ""}
        </s-paragraph>
      </s-section>

      <s-section heading="Go to">
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li><s-link href="/app/orders">Vendors and orders</s-link> – sales and units to ship for each vendor, and the order sync</li>
          <li><s-link href="/app/vendors">All vendors</s-link> – people, commission, ratings and store listings</li>
          <li><s-link href="/app/signups">Sign-ups</s-link> – approve or decline new sellers</li>
          <li><s-link href={`${portalUrl}/portal/login`} target="_blank">Vendor portal sign-in page</s-link> – where sellers sign in</li>
        </ul>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
