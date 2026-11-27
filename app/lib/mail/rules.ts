/** Limits and lists the Mail page shares between the server and the browser. */
export const TEAM_ADDRESSES_MAX = 10;
export const LOG_PAGE_SIZE = 50;
export const LOG_STATUSES = ["queued", "sent", "delivered", "bounced", "failed", "logged"] as const;
/** How long a mail stays in the log. */
export const LOG_KEPT_DAYS = 180;
