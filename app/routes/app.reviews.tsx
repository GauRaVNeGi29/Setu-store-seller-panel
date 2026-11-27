import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { reviewNumbers, teamReviews } from "../lib/reviews/reviews.server";
import { changeReviewVisibility } from "../lib/reviews/team.server";
import { cell, headRow, input, muted, plural, ReviewRowView, Stats, table, Tabs, vendorHref } from "../lib/admin/ui";

/**
 * Reviews: buyers' reviews of every seller in one place.
 *  - All reviews: newest first, narrowed by seller, by published or hidden,
 *    or by stars. The team can hide a review (with a reason the vendor sees)
 *    or show it again.
 *  - By seller: each seller's rating and how many reviews they have.
 */
const STATUSES = ["published", "hidden"] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const q = new URL(request.url).searchParams;
  const view = q.get("view") === "sellers" ? "sellers" as const : "all" as const;
  const numbers = await reviewNumbers(db, session.shop);
  const seller = numbers.vendors.find((v) => v.id === q.get("seller"))?.id ?? "";
  const status = (STATUSES as readonly string[]).includes(q.get("status") ?? "") ? (q.get("status") as (typeof STATUSES)[number]) : "";
  const stars = /^[1-5]$/.test(q.get("stars") ?? "") ? Number(q.get("stars")) : 0;
  const list = await teamReviews(db, session.shop, { vendorId: seller || undefined, status: status || undefined, rating: stars || undefined, page: Number(q.get("page")) || 1 });
  return { view, numbers, list, filter: { seller, status, stars } };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const actor = `admin:${session.onlineAccessInfo?.associated_user?.email ?? "staff"}`;
  const form = await request.formData();
  const f = (k: string) => String(form.get(k) ?? "");
  const intent = f("intent");
  if (intent !== "hide_review" && intent !== "show_review") return { ok: false, error: "Unknown action" };
  return changeReviewVisibility(db, session.shop, f("vendorId"), f("reviewId"), intent === "hide_review", actor, f("reason"));
};

export default function Reviews() {
  const { view, numbers, list, filter } = useLoaderData<typeof loader>();
  const filtered = !!(filter.seller || filter.status || filter.stars);
  const link = (page: number) => {
    const q = new URLSearchParams();
    if (filter.seller) q.set("seller", filter.seller);
    if (filter.status) q.set("status", filter.status);
    if (filter.stars) q.set("stars", String(filter.stars));
    if (page > 1) q.set("page", String(page));
    const s = q.toString();
    return `/app/reviews${s ? `?${s}` : ""}`;
  };

  return (
    <s-page heading="Reviews">
      <Tabs label="Reviews" current={view} tabs={[
        { id: "all", label: "All reviews", to: "/app/reviews", count: numbers.published + numbers.hidden },
        { id: "sellers", label: "By seller", to: "/app/reviews?view=sellers", count: numbers.vendors.length },
      ]} />
      <s-section>
        <Stats items={[
          { label: "Average rating", value: numbers.average ? `${numbers.average} / 5` : "–", note: "Across all sellers, published reviews only" },
          { label: "Published", value: String(numbers.published), note: "Shown on the store" },
          { label: "Hidden", value: String(numbers.hidden), note: "Not shown, not counted", to: numbers.hidden ? "/app/reviews?status=hidden" : undefined, linkLabel: "See hidden reviews" },
          { label: "Last 30 days", value: String(numbers.last30Days), note: "New reviews" },
        ]} />
      </s-section>

      {view === "sellers" ? (
        <s-section heading="Ratings by seller">
          {numbers.vendors.length === 0 ? (
            <s-paragraph>No seller has a review yet.</s-paragraph>
          ) : (
            <table style={table}>
              <thead>
                <tr style={headRow}>
                  <th style={cell}>Seller</th>
                  <th style={cell}>Rating</th>
                  <th style={cell}>Published</th>
                  <th style={cell}>Hidden</th>
                  <th style={cell}></th>
                </tr>
              </thead>
              <tbody>
                {numbers.vendors.map((v) => (
                  <tr key={v.id}>
                    <td style={cell}><s-link href={vendorHref(v.vendorName)}>{v.name}</s-link></td>
                    <td style={cell}>{v.average ? <><b>{v.average}</b> / 5</> : <span style={muted}>–</span>}</td>
                    <td style={cell}>{v.published}</td>
                    <td style={cell}>{v.hidden || <span style={muted}>0</span>}</td>
                    <td style={cell}><s-link href={`/app/reviews?seller=${v.id}`}>See their reviews</s-link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <s-paragraph>Only published reviews count towards a rating. Sellers without any review aren&apos;t listed.</s-paragraph>
        </s-section>
      ) : (
        <s-section heading="All reviews">
          <Form method="get" style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "end", margin: "0 0 14px" }}>
            <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
              Seller
              <select name="seller" defaultValue={filter.seller} style={{ ...input, minWidth: 200 }}>
                <option value="">All sellers</option>
                {numbers.vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </label>
            <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
              Status
              <select name="status" defaultValue={filter.status} style={input}>
                <option value="">Published and hidden</option>
                <option value="published">Published</option>
                <option value="hidden">Hidden</option>
              </select>
            </label>
            <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
              Stars
              <select name="stars" defaultValue={filter.stars ? String(filter.stars) : ""} style={input}>
                <option value="">Any</option>
                {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <s-button type="submit">Show</s-button>
            {filtered && <s-link href="/app/reviews">Clear</s-link>}
          </Form>
          {list.total === 0 ? (
            <s-paragraph>{filtered ? "No reviews match." : "No reviews yet. Buyers can review a seller once an order from them has shipped."}</s-paragraph>
          ) : (
            <>
              <s-paragraph>{plural(list.total, "review")}{filtered ? " match" : ""}, newest first.</s-paragraph>
              <div style={{ overflowX: "auto" }}>
                <table style={table}>
                  <thead>
                    <tr style={headRow}>
                      <th style={cell}>Seller</th>
                      <th style={cell}>Rating</th>
                      <th style={cell}>Review</th>
                      <th style={cell}>Status</th>
                      <th style={cell}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.reviews.map((r) => <ReviewRowView key={r.id + r.hidden} r={r} fields={{ vendorId: r.vendor.id }} />)}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {list.pages > 1 && (
            <s-paragraph>
              {list.page > 1 && <><s-link href={link(list.page - 1)}>Newer</s-link>{" "}</>}
              Page {list.page} of {list.pages}
              {list.page < list.pages && <>{" "}<s-link href={link(list.page + 1)}>Older</s-link></>}
            </s-paragraph>
          )}
          <s-paragraph>
            Hiding a review takes it off the store and out of the seller&apos;s rating. The seller still sees it, marked as hidden, with your reason.
          </s-paragraph>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
