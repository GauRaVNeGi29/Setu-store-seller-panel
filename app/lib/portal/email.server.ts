import type { PrismaClient } from "@prisma/client";
import { sendSecret } from "../mail/queue.server";
import type { Env } from "../mail/transport.server";

/**
 * The two portal mails that carry a one-time link: password reset and staff
 * invite. They go out at once (the person is waiting) through the same mail
 * service and log as every other mail (app/lib/mail), but the log never keeps
 * the link.
 *
 * When the mail can't really be sent (no mail service, or the address isn't
 * on the test list):
 *  - outside production the link is printed in the `npm run dev` output, and
 *    with PORTAL_DEV_SHOW_EMAILS=true also shown on the page that sent it,
 *    because the Shopify CLI terminal doesn't always display app output;
 *  - in production it is refused, so a link is never only logged in production.
 */

/** Whether a link that wasn't really mailed may be shown on the page. Never in production. */
export function showDevEmailsOnPage(env: Env = process.env) {
  return env.NODE_ENV !== "production" && env.PORTAL_DEV_SHOW_EMAILS === "true";
}

export type Sent = { delivered: "email" | "console"; devPreview?: { subject: string; link?: string } };

type Target = { shop: string; to: string; name: string | null; vendorId?: string | null };

async function finish(r: { delivered: boolean; note: string | null; subject: string; link: string | null }, to: string, env: Env): Promise<Sent> {
  if (r.delivered) return { delivered: "email" };
  if (env.NODE_ENV === "production") throw new Error(r.note ?? "The mail couldn't be sent");
  console.log(`\n[vendor-portal] DEV ONLY – email to ${to}: ${r.subject}${r.link ? `\n  ${r.link}` : ""}\n`);
  return { delivered: "console", ...(showDevEmailsOnPage(env) ? { devPreview: { subject: r.subject, link: r.link ?? undefined } } : {}) };
}

export async function sendPasswordReset(db: PrismaClient, t: Target, link: string, env: Env = process.env) {
  return finish(await sendSecret(db, t.shop, "password_reset", { email: t.to, name: t.name }, { link }, { vendorId: t.vendorId, env }), t.to, env);
}

export async function sendStaffInvite(db: PrismaClient, t: Target, brand: string, invitedBy: string, link: string, env: Env = process.env) {
  return finish(await sendSecret(db, t.shop, "staff_invite", { email: t.to, name: t.name }, { brand, invitedBy, link }, { vendorId: t.vendorId, env }), t.to, env);
}
