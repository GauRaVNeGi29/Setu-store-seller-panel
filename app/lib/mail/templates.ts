/**
 * Every mail the app sends: who it is for, when it goes out, and its words.
 *
 * A template turns the facts of an event (`data`) into a subject, a few lines
 * and at most one link. The greeting, the link and the sign-off are added
 * when the mail is put together (see `compose`), so every mail reads alike.
 * Mails are plain words: no order totals, no buyer names or addresses.
 *
 * `sample` is what the Mail page shows as a preview and sends as a test.
 */

export type Audience = "seller" | "admin";
export type MailLink = { label: string; url: string };

export type Words = { subject: string; lines: string[]; link?: MailLink };

export type Template<D> = {
  audience: Audience;
  group: "Account" | "Profile" | "Orders" | "Reviews" | "Team alerts";
  name: string;
  /** When it goes out, for the Mail page. */
  when: string;
  /** Who gets it, for the Mail page. */
  to: string;
  /** Can't be switched off: the person can't get in, or stay safe, without it. */
  required?: boolean;
  /** Carries a one-time link: sent at once, and the link is never kept in the log. */
  secret?: boolean;
  sample: D;
  /** `base` is the portal's address (no trailing slash), or "" when it isn't known. */
  words: (d: D, base: string) => Words;
};

const t = <D,>(template: Template<D>) => template;
/** As in "a 5-star review". */
const stars = (n: number) => `${n}-star`;
const list = (items: string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);
const portal = (base: string, path: string, label: string): MailLink | undefined => (base ? { label, url: `${base}${path}` } : undefined);
const quote = (text: string) => `“${text.length > 400 ? `${text.slice(0, 400)}…` : text}”`;
/** Where the team deals with something, in the app inside Shopify admin. */
const inApp = (where: string) => `Open the Setu Store Seller Panel app in Shopify admin and go to ${where}.`;

export const TEMPLATES = {
  // ------------------------------------------------------------------ sellers: account
  signup_received: t<Record<string, never>>({
    audience: "seller", group: "Account", name: "Sign-up received", when: "Someone signs up on the vendor portal", to: "The person who signed up",
    sample: {},
    words: (_d, base) => ({
      subject: "We've received your Setu Store seller sign-up",
      lines: ["Thank you for signing up to sell on Setu Store.", "Our team is reviewing your details. We'll email you as soon as there is a decision; you don't need to do anything until then."],
      link: portal(base, "/portal/login", "Open the vendor portal"),
    }),
  }),
  signup_approved: t<{ brand: string }>({
    audience: "seller", group: "Account", name: "Sign-up approved", when: "The team approves a sign-up", to: "The person who signed up",
    sample: { brand: "Ashnur" },
    words: (d, base) => ({
      subject: "You're approved to sell on Setu Store",
      lines: [`Your sign-up is approved. You can now sign in to the vendor portal and see the orders for ${d.brand}.`, "A good first step is to complete your brand details under My brand."],
      link: portal(base, "/portal/login", "Sign in"),
    }),
  }),
  signup_declined: t<Record<string, never>>({
    audience: "seller", group: "Account", name: "Sign-up declined", when: "The team declines a sign-up", to: "The person who signed up",
    sample: {},
    words: () => ({
      subject: "About your Setu Store seller sign-up",
      lines: ["Thank you for your interest in selling on Setu Store.", "We aren't able to approve your sign-up at this time. If you think this is a mistake, reply to this email and we'll take another look."],
    }),
  }),
  person_added: t<{ brand: string; role: "owner" | "staff" }>({
    audience: "seller", group: "Account", name: "Added to a vendor by the team", when: "The team adds a person to a vendor", to: "The person added", required: true,
    sample: { brand: "Ashnur", role: "owner" },
    words: (d, base) => ({
      subject: `You've been added to ${d.brand} on the Setu Store vendor portal`,
      lines: [`The Setu Store team added you to ${d.brand} as ${d.role === "owner" ? "an owner" : "a staff member"}.`, "To get in, create your password on the sign-up page using this email address."],
      link: portal(base, "/portal/signup", "Create your password"),
    }),
  }),
  staff_invite: t<{ brand: string; invitedBy: string; link: string }>({
    audience: "seller", group: "Account", name: "Staff invite", when: "An owner invites a staff member", to: "The person invited", required: true, secret: true,
    sample: { brand: "Ashnur", invitedBy: "Meera", link: "https://example.com/portal/reset?token=…" },
    words: (d) => ({
      subject: `Join ${d.brand} on the Setu Store vendor portal`,
      lines: [`${d.invitedBy} added you to ${d.brand}'s team on the Setu Store vendor portal.`, "Open the link to choose your password. It works once and expires in 7 days.", "After that, sign in with this email address. If the link expires, use “Forgot password” on the sign-in page."],
      link: { label: "Choose your password", url: d.link },
    }),
  }),
  password_reset: t<{ link: string }>({
    audience: "seller", group: "Account", name: "Password reset link", when: "Someone asks to reset their password", to: "That person", required: true, secret: true,
    sample: { link: "https://example.com/portal/reset?token=…" },
    words: (d) => ({
      subject: "Reset your Setu Store vendor portal password",
      lines: ["Someone asked to reset the password for your Setu Store vendor portal account.", "Open the link to choose a new password. It works once and expires in 30 minutes.", "If you didn't ask for this, you can ignore this email; your password stays the same."],
      link: { label: "Choose a new password", url: d.link },
    }),
  }),
  password_changed: t<Record<string, never>>({
    audience: "seller", group: "Account", name: "Password changed", when: "A password is changed with a reset link", to: "That person", required: true,
    sample: {},
    words: (_d, base) => ({
      subject: "Your Setu Store vendor portal password was changed",
      lines: ["The password for your vendor portal account was just changed, and you were signed out everywhere.", "If this was you, there is nothing to do. If it wasn't, reset your password now and reply to this email so we can help."],
      link: portal(base, "/portal/forgot", "Reset your password"),
    }),
  }),
  login_locked: t<{ minutes: number }>({
    audience: "seller", group: "Account", name: "Sign-in paused", when: "Too many wrong passwords for an account", to: "That person", required: true,
    sample: { minutes: 15 },
    words: (d, base) => ({
      subject: "Sign-in to your Setu Store vendor portal account is paused",
      lines: [`Someone entered the wrong password for your account several times, so sign-in is paused for about ${d.minutes} minutes.`, "If this was you, wait and try again, or reset your password. If it wasn't, your account is still safe; consider choosing a new password."],
      link: portal(base, "/portal/forgot", "Reset your password"),
    }),
  }),
  access_changed: t<{ brand: string; change: string }>({
    audience: "seller", group: "Account", name: "Your access changed", when: "A person's role or access is changed, deactivated or removed", to: "That person",
    sample: { brand: "Ashnur", change: "You can now view orders but not change anything." },
    words: (d) => ({
      subject: `Your access to ${d.brand} on the Setu Store vendor portal changed`,
      lines: [d.change, "If you weren't expecting this, speak to your account's owner or reply to this email."],
    }),
  }),
  vendor_paused: t<{ brand: string }>({
    audience: "seller", group: "Account", name: "Vendor paused", when: "The team pauses a vendor", to: "The vendor's owners",
    sample: { brand: "Ashnur" },
    words: (d) => ({
      subject: `${d.brand}'s vendor portal access is paused`,
      lines: [`The Setu Store team has paused portal access for ${d.brand}. Nobody on your team can sign in until it is made active again.`, "Reply to this email if you have questions."],
    }),
  }),
  vendor_active: t<{ brand: string }>({
    audience: "seller", group: "Account", name: "Vendor active again", when: "The team makes a paused vendor active", to: "The vendor's owners",
    sample: { brand: "Ashnur" },
    words: (d, base) => ({
      subject: `${d.brand}'s vendor portal access is active again`,
      lines: [`Portal access for ${d.brand} is active again. Your team can sign in as before.`],
      link: portal(base, "/portal/login", "Sign in"),
    }),
  }),

  // ------------------------------------------------------------------ sellers: profile
  change_submitted: t<{ brand: string; fields: string[] }>({
    audience: "seller", group: "Profile", name: "Business change sent", when: "An owner sends a business change for approval", to: "The owner who sent it",
    sample: { brand: "Ashnur", fields: ["Company name", "GST number"] },
    words: (d, base) => ({
      subject: "We've received your business details change",
      lines: [`Your change to ${list(d.fields) || "your business details"} for ${d.brand} is with the Setu Store team for approval.`, "Your current details stay in place until it is approved. We'll email you with the decision."],
      link: portal(base, "/portal/profile", "See the change"),
    }),
  }),
  change_approved: t<{ brand: string }>({
    audience: "seller", group: "Profile", name: "Business change approved", when: "The team approves a business change", to: "The vendor's owners",
    sample: { brand: "Ashnur" },
    words: (d, base) => ({
      subject: "Your business details change is approved",
      lines: [`The change to ${d.brand}'s business details is approved and now in place.`],
      link: portal(base, "/portal/profile", "See your details"),
    }),
  }),
  change_declined: t<{ brand: string; reason: string | null }>({
    audience: "seller", group: "Profile", name: "Business change declined", when: "The team declines a business change", to: "The vendor's owners",
    sample: { brand: "Ashnur", reason: "The GST certificate is not readable. Please upload a clearer copy." },
    words: (d, base) => ({
      subject: "Your business details change was not approved",
      lines: [`The change to ${d.brand}'s business details was not approved. Your earlier details stay in place.`, ...(d.reason ? [`Reason: ${d.reason}`] : []), "You can send a corrected change at any time."],
      link: portal(base, "/portal/profile", "Open your details"),
    }),
  }),
  details_changed_by_team: t<{ brand: string }>({
    audience: "seller", group: "Profile", name: "Details changed by the team", when: "The team edits a vendor's brand or business details", to: "The vendor's owners",
    sample: { brand: "Ashnur" },
    words: (d, base) => ({
      subject: `The Setu Store team updated ${d.brand}'s details`,
      lines: [`The Setu Store team made a change to ${d.brand}'s details on the vendor portal.`, "Please check that everything is right. Reply to this email if something needs correcting."],
      link: portal(base, "/portal/profile", "Check your details"),
    }),
  }),
  commission_set: t<{ brand: string; rate: string }>({
    audience: "seller", group: "Profile", name: "Commission rate set", when: "The team sets or changes a vendor's commission rate", to: "The vendor's owners",
    sample: { brand: "Ashnur", rate: "15" },
    words: (d, base) => ({
      subject: `Commission rate for ${d.brand}: ${d.rate}%`,
      lines: [`The commission rate for ${d.brand} on Setu Store is now ${d.rate}%. It applies to orders placed from now on.`, "Reply to this email if you have questions."],
      link: portal(base, "/portal/earnings", "See your earnings"),
    }),
  }),

  // ------------------------------------------------------------------ sellers: orders
  order_new: t<{ brand: string; orderName: string; orderId: string; items: { title: string; quantity: number }[] }>({
    audience: "seller", group: "Orders", name: "New order", when: "An order with the vendor's products is placed (one mail per order)", to: "Everyone active on the vendor's team",
    sample: { brand: "Ashnur", orderName: "#1042", orderId: "1", items: [{ title: "Pillar Candle – Rose", quantity: 24 }, { title: "Wax Sachet", quantity: 10 }] },
    words: (d, base) => ({
      subject: `New order ${d.orderName} for ${d.brand}`,
      lines: [`You have a new order on Setu Store: ${d.orderName}.`, ...d.items.slice(0, 20).map((i) => `• ${i.quantity} × ${i.title}`), ...(d.items.length > 20 ? [`…and ${d.items.length - 20} more items.`] : []), "Open the order in the vendor portal to see the details and mark it as shipped."],
      link: portal(base, `/portal/orders/${d.orderId}`, "Open the order"),
    }),
  }),
  order_changed: t<{ brand: string; orderName: string; orderId: string; change: string }>({
    audience: "seller", group: "Orders", name: "Order changed", when: "An order is cancelled, refunded or edited", to: "Everyone active on the vendor's team",
    sample: { brand: "Ashnur", orderName: "#1042", orderId: "1", change: "The order was cancelled. Please don't ship it." },
    words: (d, base) => ({
      subject: `Order ${d.orderName} changed`,
      lines: [`Order ${d.orderName} for ${d.brand} has changed.`, d.change, "The vendor portal shows the order as it stands now."],
      link: portal(base, `/portal/orders/${d.orderId}`, "Open the order"),
    }),
  }),
  order_overdue: t<{ brand: string; orderName: string; orderId: string; days: number; units: number }>({
    audience: "seller", group: "Orders", name: "Order not shipped in time", when: "An order still has units to ship after the vendor's processing time (checked once a day)", to: "Everyone active on the vendor's team",
    sample: { brand: "Ashnur", orderName: "#1042", orderId: "1", days: 17, units: 34 },
    words: (d, base) => ({
      subject: `Order ${d.orderName} is waiting to ship`,
      lines: [`Order ${d.orderName} was placed ${d.days} days ago and still has ${d.units} ${d.units === 1 ? "unit" : "units"} to ship, which is past the processing time you gave for ${d.brand}.`, "Please ship it and mark it as shipped in the vendor portal. If there is a delay, reply to this email so we can let the buyer know."],
      link: portal(base, `/portal/orders/${d.orderId}`, "Open the order"),
    }),
  }),

  // ------------------------------------------------------------------ sellers: reviews
  review_new: t<{ brand: string; rating: number; comment: string | null; author: string }>({
    audience: "seller", group: "Reviews", name: "New review", when: "A buyer leaves a review", to: "The vendor's owners",
    sample: { brand: "Ashnur", rating: 5, comment: "Beautiful candles, carefully packed.", author: "Meera" },
    words: (d, base) => ({
      subject: `New ${stars(d.rating)} review for ${d.brand}`,
      lines: [`${d.author} left ${d.brand} a ${stars(d.rating)} review on Setu Store.`, ...(d.comment ? [quote(d.comment)] : [])],
      link: portal(base, "/portal/reviews", "See your reviews"),
    }),
  }),
  review_hidden: t<{ brand: string; rating: number; reason: string | null }>({
    audience: "seller", group: "Reviews", name: "Review hidden", when: "The team hides a review", to: "The vendor's owners",
    sample: { brand: "Ashnur", rating: 1, reason: "Abusive language" },
    words: (d, base) => ({
      subject: `A review of ${d.brand} was hidden`,
      lines: [`The Setu Store team hid a ${stars(d.rating)} review of ${d.brand}. Buyers no longer see it and it isn't counted in your rating.`, ...(d.reason ? [`Reason: ${d.reason}`] : [])],
      link: portal(base, "/portal/reviews", "See your reviews"),
    }),
  }),
  review_shown: t<{ brand: string; rating: number }>({
    audience: "seller", group: "Reviews", name: "Review shown again", when: "The team shows a hidden review again", to: "The vendor's owners",
    sample: { brand: "Ashnur", rating: 4 },
    words: (d, base) => ({
      subject: `A review of ${d.brand} is shown again`,
      lines: [`A ${stars(d.rating)} review of ${d.brand} that was hidden is shown to buyers again and counts in your rating.`],
      link: portal(base, "/portal/reviews", "See your reviews"),
    }),
  }),

  // ------------------------------------------------------------------ the team
  admin_signup_waiting: t<{ name: string | null; email: string }>({
    audience: "admin", group: "Team alerts", name: "New sign-up waiting", when: "Someone signs up on the vendor portal", to: "Team addresses",
    sample: { name: "Harpreet", email: "owner@example.com" },
    words: (d) => ({
      subject: `New seller sign-up: ${d.name || d.email}`,
      lines: [`${d.name ? `${d.name} (${d.email})` : d.email} signed up on the vendor portal and is waiting for approval.`, inApp("Vendors → Sign-ups")],
    }),
  }),
  admin_change_waiting: t<{ brand: string; fields: string[] }>({
    audience: "admin", group: "Team alerts", name: "Business change waiting", when: "An owner sends a business change for approval", to: "Team addresses",
    sample: { brand: "Ashnur", fields: ["Company name", "GST number"] },
    words: (d) => ({
      subject: `${d.brand} asked to change business details`,
      lines: [`${d.brand} sent a change to ${list(d.fields) || "their business details"} for approval.`, inApp(`Vendors → ${d.brand}`)],
    }),
  }),
  admin_low_review: t<{ brand: string; rating: number; comment: string | null }>({
    audience: "admin", group: "Team alerts", name: "Low review", when: "A buyer leaves a review of 2 stars or fewer, or lowers theirs to that", to: "Team addresses",
    sample: { brand: "Ashnur", rating: 2, comment: "Two candles arrived broken." },
    words: (d) => ({
      subject: `${stars(d.rating)} review for ${d.brand}`,
      lines: [`A buyer left ${d.brand} a ${stars(d.rating)} review.`, ...(d.comment ? [quote(d.comment)] : []), inApp("Reviews")],
    }),
  }),
  admin_orders_overdue: t<{ rows: { brand: string; orderName: string; days: number; units: number }[] }>({
    audience: "admin", group: "Team alerts", name: "Orders past their processing time", when: "Once a day, when orders are still unshipped after the vendor's processing time", to: "Team addresses",
    sample: { rows: [{ brand: "Ashnur", orderName: "#1042", days: 17, units: 34 }, { brand: "Urban Store", orderName: "#1038", days: 21, units: 6 }] },
    words: (d) => ({
      subject: `${d.rows.length} ${d.rows.length === 1 ? "order is" : "orders are"} past the processing time`,
      lines: ["These orders still have units to ship after the processing time their vendor gave:", ...d.rows.slice(0, 50).map((r) => `• ${r.orderName}, ${r.brand}: placed ${r.days} days ago, ${r.units} to ship`), ...(d.rows.length > 50 ? [`…and ${d.rows.length - 50} more.`] : []), inApp("Shipping and orders")],
    }),
  }),
  admin_sync_failed: t<{ error: string }>({
    audience: "admin", group: "Team alerts", name: "Orders stopped copying", when: "Copying orders from Shopify fails (at most once a day)", to: "Team addresses",
    sample: { error: "Shopify didn't answer in time." },
    words: (d) => ({
      subject: "Orders stopped copying from Shopify",
      lines: ["The app couldn't copy orders from Shopify, so vendors may not see their latest orders.", `What went wrong: ${d.error}`, inApp("Shipping and orders → Order sync, and choose “Resync all orders”")],
    }),
  }),
  admin_store_copy_failed: t<{ what: string; error: string }>({
    audience: "admin", group: "Team alerts", name: "Store update failed", when: "A vendor's store listing or the delivery time fails to reach the store (at most once a day each)", to: "Team addresses",
    sample: { what: "Ashnur's store listing", error: "The app isn't allowed to change store entries." },
    words: (d) => ({
      subject: `${d.what.charAt(0).toUpperCase()}${d.what.slice(1)} didn't reach the store`,
      lines: [`The app saved a change but couldn't copy ${d.what} to the store, so buyers still see the old version.`, `What went wrong: ${d.error}`, inApp("the Dashboard, where it is listed under alerts")],
    }),
  }),
  admin_email_bouncing: t<{ email: string; brand: string | null; mail: string }>({
    audience: "admin", group: "Team alerts", name: "A seller's email is bouncing", when: "A mail to a seller is refused by their address", to: "Team addresses",
    sample: { email: "owner@example.com", brand: "Ashnur", mail: "New order" },
    words: (d) => ({
      subject: `Mail to ${d.email} is bouncing`,
      lines: [`A “${d.mail}” mail to ${d.email}${d.brand ? ` (${d.brand})` : ""} was refused by their mail server, so they aren't getting the app's mails.`, "Check the address with the seller and correct it on the vendor's page.", inApp("Mail → Log")],
    }),
  }),
} as const;

export type TemplateKey = keyof typeof TEMPLATES;
export type DataOf<K extends TemplateKey> = (typeof TEMPLATES)[K] extends Template<infer D> ? D : never;
export const TEMPLATE_KEYS = Object.keys(TEMPLATES) as TemplateKey[];
export const isTemplateKey = (v: unknown): v is TemplateKey => typeof v === "string" && v in TEMPLATES;

export function wordsFor<K extends TemplateKey>(key: K, data: DataOf<K>, base: string): Words {
  return (TEMPLATES[key] as unknown as Template<DataOf<K>>).words(data, base);
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The whole mail as it reaches the inbox: greeting, the template's lines, the
 * link, the sign-off. Text and a plain HTML version of the same words.
 */
export function compose(m: { toName?: string | null; audience: Audience | string; body: string; linkLabel?: string | null; linkUrl?: string | null }) {
  const hello = m.audience === "seller" && m.toName ? `Hello ${m.toName},` : "Hello,";
  const lines = m.body.split("\n");
  const sign = ["Setu Store", ...(m.audience === "seller" ? ["Reply to this email if you need help."] : [])];
  const text = [hello, "", ...lines.flatMap((l) => (l.startsWith("•") ? [l] : [l, ""])), ...(m.linkUrl ? [`${m.linkLabel ?? "Open"}: ${m.linkUrl}`, ""] : []), ...sign]
    .join("\n").replace(/\n{3,}/g, "\n\n");
  const p = (s: string) => `<p style="margin:0 0 14px">${escape(s)}</p>`;
  const html = [
    '<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a;max-width:560px">',
    p(hello),
    ...lines.map((l) => (l.startsWith("•") ? `<p style="margin:0 0 4px">${escape(l)}</p>` : p(l))),
    ...(m.linkUrl ? [`<p style="margin:18px 0"><a href="${escape(m.linkUrl)}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#1a1a1a;color:#ffffff;text-decoration:none">${escape(m.linkLabel ?? "Open")}</a></p>`] : []),
    `<p style="margin:22px 0 0;color:#616161">${sign.map(escape).join("<br>")}</p>`,
    "</div>",
  ].join("");
  return { text, html };
}
