/** Review rules shared by the server and the pages (safe to import in the browser). */
export const COMMENT_MAX = 1000;
export const AUTHOR_MAX = 40;
export const ANONYMOUS_AUTHOR = "Verified buyer";
/** How many of the products they bought a buyer can attach to one review. */
export const REVIEW_ITEMS_MAX = 20;
export const LOCATION_MAX = 80;
export const HIDE_REASON_MAX = 300;
export const REVIEWS_PER_PAGE = 20;
/** Reviews loaded at a time on the store's seller page. */
export const PUBLIC_PAGE = 10;
export const STARS = [5, 4, 3, 2, 1] as const;

export type ReviewSummary = {
  count: number;
  /** One decimal ("4.5"), or null when there are no published reviews. */
  average: string | null;
  /** How many published reviews gave each number of stars. */
  breakdown: Record<1 | 2 | 3 | 4 | 5, number>;
};

/** The orders a buyer can read a seller's reviews in on the store. */
export const REVIEW_SORTS = ["newest", "highest", "lowest"] as const;
export type ReviewSort = (typeof REVIEW_SORTS)[number];
export const reviewSort = (v: unknown): ReviewSort => (REVIEW_SORTS as readonly unknown[]).includes(v) ? (v as ReviewSort) : "newest";
