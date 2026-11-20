/**
 * Sends the sign-in code.
 *
 * - With RESEND_API_KEY and PORTAL_EMAIL_FROM set: sends through Resend (https://resend.com).
 * - Without them, outside production: prints the code in the `npm run dev`
 *   terminal, so sign-in can be tested on the dev store without an email service.
 * - Without them in production: refuses, so codes are never only logged in production.
 *
 * The email contains the code only: no order or customer data.
 */

/**
 * Development aid: with PORTAL_DEV_SHOW_CODE=true, no email provider and
 * NODE_ENV not "production", the login page also shows the code (the Shopify
 * CLI terminal does not always display app output). Never in production.
 */
export function showDevCodeOnPage(env: Record<string, string | undefined> = process.env) {
  return env.NODE_ENV !== "production" && env.PORTAL_DEV_SHOW_CODE === "true" && !(env.RESEND_API_KEY && env.PORTAL_EMAIL_FROM);
}
export async function sendLoginCode(to: string, code: string, vendorName: string, env: Record<string, string | undefined> = process.env) {
  const subject = `Your Setu vendor portal code: ${code}`;
  const text = [
    `Your sign-in code for the Setu Store vendor portal (${vendorName}) is:`,
    "",
    `    ${code}`,
    "",
    "It works once and expires in 10 minutes.",
    "If you didn't ask for it, you can ignore this email.",
  ].join("\n");

  if (env.RESEND_API_KEY && env.PORTAL_EMAIL_FROM) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.PORTAL_EMAIL_FROM, to: [to], subject, text }),
    });
    if (!res.ok) throw new Error(`Email provider refused the message (${res.status})`);
    return { delivered: "email" as const };
  }

  if (env.NODE_ENV === "production") {
    throw new Error("No email provider configured (RESEND_API_KEY, PORTAL_EMAIL_FROM)");
  }

  console.log(`\n[vendor-portal] DEV ONLY – sign-in code for ${to} (${vendorName}): ${code}\n`);
  return { delivered: "console" as const, devCode: showDevCodeOnPage(env) ? code : undefined };
}
