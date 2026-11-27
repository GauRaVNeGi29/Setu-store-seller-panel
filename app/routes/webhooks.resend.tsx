import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { webhookSecrets } from "../lib/mail/config.server";
import { applyReport, signedByResend } from "../lib/mail/webhook.server";

/**
 * POST /webhooks/resend – the mail service reports what happened to a mail
 * (delivered, bounced, failed). Set this address in Resend under Webhooks and
 * save the signing secret it shows under Mail → Settings in the app (or in
 * RESEND_WEBHOOK_SECRET on the server).
 *
 * Unsigned or wrongly signed reports get 401 and change nothing.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const body = (await request.text()).slice(0, 200_000);
  const secrets = await webhookSecrets(db);
  if (!secrets.some((secret) => signedByResend(secret, request.headers, body))) return new Response(null, { status: 401 });
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
