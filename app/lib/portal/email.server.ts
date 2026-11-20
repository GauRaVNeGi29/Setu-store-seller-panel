/**
 * Emails from the vendor portal.
 *
 * - With RESEND_API_KEY and PORTAL_EMAIL_FROM set: sent through Resend (https://resend.com).
 * - Without them, outside production: printed in the `npm run dev` output, and
 *   (with PORTAL_DEV_SHOW_EMAILS=true) also shown on the page that sent them,
 *   because the Shopify CLI terminal doesn't always display app output.
 * - Without them in production: refused, so links are never only logged in production.
 *
 * Emails carry no order or customer data.
 */

type Env = Record<string, string | undefined>;

export function showDevEmailsOnPage(env: Env = process.env) {
  return env.NODE_ENV !== "production" && env.PORTAL_DEV_SHOW_EMAILS === "true" && !(env.RESEND_API_KEY && env.PORTAL_EMAIL_FROM);
}

export type Sent = { delivered: "email" | "console"; devPreview?: { subject: string; link?: string } };

async function send(to: string, subject: string, text: string, link: string | undefined, env: Env): Promise<Sent> {
  if (env.RESEND_API_KEY && env.PORTAL_EMAIL_FROM) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.PORTAL_EMAIL_FROM, to: [to], subject, text }),
    });
    if (!res.ok) throw new Error(`Email provider refused the message (${res.status})`);
    return { delivered: "email" };
  }
  if (env.NODE_ENV === "production") throw new Error("No email provider configured (RESEND_API_KEY, PORTAL_EMAIL_FROM)");
  console.log(`\n[vendor-portal] DEV ONLY – email to ${to}: ${subject}${link ? `\n  ${link}` : ""}\n`);
  return { delivered: "console", ...(showDevEmailsOnPage(env) ? { devPreview: { subject, link } } : {}) };
}

export function sendPasswordReset(to: string, name: string | null, link: string, env: Env = process.env) {
  const text = [
    `Hello${name ? ` ${name}` : ""},`,
    "",
    "Someone asked to reset the password for your Setu Store vendor portal account.",
    "Open this link to choose a new password. It works once and expires in 30 minutes:",
    "",
    link,
    "",
    "If you didn't ask for this, you can ignore this email; your password stays the same.",
  ].join("\n");
  return send(to, "Reset your Setu vendor portal password", text, link, env);
}
