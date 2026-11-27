/**
 * Hands one mail to the mail service (Resend), or decides it must not really
 * go out.
 *
 * The values come from Mail → Settings in the app, or from the server's
 * environment where the app has none (see config.server.ts, which puts the
 * two together into the `env` these functions are given):
 *
 *  - No Resend key or sender address (RESEND_API_KEY, PORTAL_EMAIL_FROM):
 *    nothing can be sent. The mail is kept in the log only.
 *  - Test list (MAIL_ONLY_TO: addresses or @domains): only these really get
 *    mail; everything else is kept in the log only. Outside production this
 *    list is required, so a development store can never mail real sellers by
 *    accident. "Production" is the server's NODE_ENV and can't be set in the app.
 *  - Reply address (PORTAL_EMAIL_REPLY_TO): where replies go (defaults to the sender).
 */

export type Env = Record<string, string | undefined>;

export type Outgoing = { id: string; to: string; subject: string; text: string; html: string };
export type Handed =
  | { status: "sent"; providerId: string | null }
  | { status: "logged"; note: string }
  | { status: "error"; note: string; again: boolean };

export const mailConfigured = (env: Env = process.env) => Boolean(env.RESEND_API_KEY && env.PORTAL_EMAIL_FROM);

/** The portal's own address, for links in mails. "" when it isn't configured. */
export const mailBaseUrl = (env: Env = process.env) => (env.PORTAL_URL || env.SHOPIFY_APP_URL || "").replace(/\/+$/, "");

const onlyTo = (env: Env) => (env.MAIL_ONLY_TO ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

/** Why this address must not really be mailed here, or null when it may be. */
export function heldBack(to: string, env: Env = process.env): string | null {
  if (!mailConfigured(env)) return "No mail service is set up, so this was not sent.";
  const allowed = onlyTo(env);
  const email = to.toLowerCase();
  if (allowed.length) {
    return allowed.some((a) => (a.startsWith("@") ? email.endsWith(a) : email === a)) ? null : "Not sent: this address isn't on the test list (Mail → Settings).";
  }
  return env.NODE_ENV === "production" ? null : "Not sent: this is a development copy, which only mails addresses on the test list (Mail → Settings), and the list is empty.";
}

/** What the Mail page says about sending in this environment. */
export function sendingMode(env: Env = process.env): { real: boolean; text: string } {
  if (!mailConfigured(env)) return { real: false, text: "No mail service is set up. Mails are kept in the log but not sent." };
  const allowed = onlyTo(env);
  if (allowed.length) return { real: true, text: `Test mode: mails are really sent only to ${allowed.join(", ")}. All others are kept in the log.` };
  if (env.NODE_ENV !== "production") return { real: false, text: "A mail service is set up, but this is a development copy: it only mails addresses on the test list, and the list is empty. Mails are kept in the log." };
  return { real: true, text: `Mails are sent from ${env.PORTAL_EMAIL_FROM}.` };
}

export async function hand(mail: Outgoing, env: Env = process.env, fetcher: typeof fetch = fetch): Promise<Handed> {
  const held = heldBack(mail.to, env);
  if (held) return { status: "logged", note: held };
  try {
    const res = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      // The same id on a retry tells the service it has seen this mail before.
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": mail.id, "User-Agent": "setu-store-seller-panel" },
      body: JSON.stringify({
        from: env.PORTAL_EMAIL_FROM, to: [mail.to], reply_to: env.PORTAL_EMAIL_REPLY_TO || undefined,
        subject: mail.subject, text: mail.text, html: mail.html,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { id?: string } | null;
      return { status: "sent", providerId: body?.id ?? null };
    }
    const detail = ((await res.json().catch(() => null)) as { message?: string } | null)?.message;
    // 429 and 5xx pass with time; other refusals (bad address, bad key) won't.
    return { status: "error", note: `The mail service refused it (${res.status})${detail ? `: ${detail}` : ""}`, again: res.status === 429 || res.status >= 500 };
  } catch (e) {
    return { status: "error", note: `Couldn't reach the mail service: ${e instanceof Error ? e.message : String(e)}`, again: true };
  }
}
