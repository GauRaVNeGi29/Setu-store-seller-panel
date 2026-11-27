import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { applyReport, signedByResend } from "../lib/mail/webhook.server";

/**
 * POST /webhooks/resend – the mail service reports what happened to a mail
 * (delivered, bounced, failed). Set this address in Resend under Webhooks and
 * put the signing secret it shows in RESEND_WEBHOOK_SECRET.
 *
 * Unsigned or wrongly signed reports get 401 and change nothing.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const body = (await request.text()).slice(0, 200_000);
  // eslint-disable-next-line no-undef
  if (!signedByResend(process.env.RESEND_WEBHOOK_SECRET, request.headers, body)) return new Response(null, { status: 401 });
  let report: unknown;
  try {
    report = JSON.parse(body);
  } catch {
    return new Response(null, { status: 400 });
  }
  if (report && typeof report === "object") await applyReport(db, report as Parameters<typeof applyReport>[1]);
  return new Response(null, { status: 200 });
};

export const loader = () => new Response(null, { status: 405 });
