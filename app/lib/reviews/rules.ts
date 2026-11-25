/** Review rules shared by the server and the pages (safe to import in the browser). */
export const COMMENT_MAX = 1000;
export const AUTHOR_MAX = 40;
export const ANONYMOUS_AUTHOR = "Verified buyer";
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
