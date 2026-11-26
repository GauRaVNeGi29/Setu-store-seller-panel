import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { Link, useLoaderData } from "react-router";
import db from "../db.server";
import { requireVendor } from "../lib/portal/context.server";
import { vendorReviews } from "../lib/reviews/reviews.server";
import { STARS } from "../lib/reviews/rules";
import { day } from "../lib/portal/format";
import { plural } from "../lib/portal/ui";
import { Stars } from "../lib/portal/stars";

/**
 * Reviews: what buyers said about this vendor. Read-only. The vendor sees the
 * name the buyer chose to show and the order number, never who the buyer is.
 * Reviews hidden by the Setu Store team are listed, marked, with the reason.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const me = await requireVendor(request);
  const page = Number(new URL(request.url).searchParams.get("page")) || 1;
  return vendorReviews(db, me.shop, me.vendor.id, page);
};

export const meta: MetaFunction = () => [{ title: "Reviews · Setu Store vendor portal" }];

const pageLink = (p: number) => (p > 1 ? `/portal/reviews?page=${p}` : "/portal/reviews");

export default function Reviews() {
  const d = useLoaderData<typeof loader>();
  const s = d.summary;
  const most = Math.max(1, ...STARS.map((n) => s.breakdown[n]));

  return (
    <>
      <div className="vp-pagehead">
        <div>
          <h1 className="vp-h1">Reviews</h1>
          <p className="vp-lead">What buyers say about your brand. Only buyers who have received an order from you can leave a review.</p>
        </div>
      </div>

      {d.total === 0 ? (
        <section className="vp-panel vp-empty">
          <h2 className="vp-h2">No reviews yet</h2>
          <p>After an order from you has shipped, the buyer can rate your brand. Their reviews will show here.</p>
        </section>
      ) : (
        <>
          <section className="vp-panel vp-panel-body vp-rating" aria-labelledby="rating-title">
            <div className="vp-rating-score">
              <h2 className="vp-small" id="rating-title">Your rating</h2>
              {s.average !== null ? (
                <>
                  <p className="vp-rating-number">{s.average}<span> out of 5</span></p>
                  <Stars value={Number(s.average)} size={22} />
                  <p className="vp-small">From {plural(s.count, "review", "reviews")}</p>
                </>
              ) : (
                <p className="vp-rating-none">No rating yet</p>
              )}
            </div>
            <table className="vp-rating-bars">
              <caption className="vp-sr">Reviews by number of stars</caption>
              <tbody>
                {STARS.map((n) => (
                  <tr key={n}>
                    <th scope="row">{plural(n, "star", "stars")}</th>
                    <td className="vp-rating-track"><span style={{ width: `${(s.breakdown[n] / most) * 100}%` }} /></td>
                    <td className="vp-rating-count">{s.breakdown[n]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="vp-panel" aria-labelledby="list-title">
            <div className="vp-panel-head">
              <h2 className="vp-h2" id="list-title">{plural(d.total, "review", "reviews")}</h2>
              {d.hidden > 0 && <span className="vp-small">{d.hidden} hidden by Setu Store, not counted in your rating</span>}
            </div>
            <ul className="vp-reviews">
              {d.reviews.map((r) => (
                <li key={r.id} className={r.hidden ? "vp-review vp-review--hidden" : "vp-review"}>
                  <div className="vp-review-top">
                    <Stars value={r.rating} />
                    {r.hidden && <span className="vp-badge vp-badge--off">Hidden by Setu Store</span>}
                  </div>
                  {r.comment
                    ? <p className="vp-review-text">{r.comment}</p>
                    : <p className="vp-review-text vp-review-text--none">No written review.</p>}
                  <p className="vp-review-meta">
                    {r.items.length > 0 && <span>About: {r.items.join(", ")}</span>}
                    <span>{r.authorName}{r.location ? `, ${r.location}` : ""}</span>
                    <span>{day(r.createdAt)}{r.edited ? " (edited)" : ""}</span>
                    <Link to={`/portal/orders/${r.orderId}`}>Order {r.orderName}</Link>
                  </p>
                  {r.hidden && (
                    <p className="vp-review-why">
                      Buyers can&apos;t see this review and it isn&apos;t counted in your rating.{r.hiddenReason ? ` Reason: ${r.hiddenReason}` : ""}
                    </p>
                  )}
                </li>
              ))}
            </ul>
            {d.pages > 1 && (
              <div className="vp-pager">
                {d.page > 1 ? <Link to={pageLink(d.page - 1)}>Newer reviews</Link> : <span />}
                <span className="vp-small">Page {d.page} of {d.pages}</span>
                {d.page < d.pages ? <Link to={pageLink(d.page + 1)}>Older reviews</Link> : <span />}
              </div>
            )}
          </section>
          <p className="vp-small" style={{ marginTop: 14 }}>
            Reviews can&apos;t be edited or removed from here. If one breaks the rules or isn&apos;t about your order, contact the Setu Store team.
          </p>
        </>
      )}
    </>
  );
}
