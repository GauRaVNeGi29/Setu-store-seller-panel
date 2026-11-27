import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { isValidEmail, normaliseEmail } from "../vendors/vendors.server";
import { TEST_LIST_MAX } from "./rules";
import { mailBaseUrl, sendingMode, type Env } from "./transport.server";

/**
 * Mail settings entered in the app (Mail → Settings): the Resend key, the
 * sender, the reply address, the test list and the webhook secret.
 *
 * A value saved here is used in place of the same value in the server's
 * environment; a value left empty falls back to the environment. Whether the
 * app is "in production" is NOT a setting: it comes from the server, so the
 * page can't switch off the rule that a development store only mails its
 * test list.
 *
 * The key and the webhook secret are encrypted before they are stored, with a
 * key derived from a server secret, and never leave the server again.
 */

const cipherKey = (env: Env) => {
  const secret = env.MAIL_SETTINGS_KEY || env.SHOPIFY_API_SECRET;
  return secret ? createHash("sha256").update(`setu-mail-settings:${secret}`).digest() : null;
};

export function seal(plain: string, env: Env = process.env): string | null {
  const key = cipherKey(env);
  if (!key) return null;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

/** The stored secret, or null when it can't be read (the server secret changed, or the value was altered). */
export function unseal(sealed: string | null | undefined, env: Env = process.env): string | null {
  const key = cipherKey(env);
  const [v, iv, tag, data] = (sealed ?? "").split(":");
  if (!key || v !== "v1" || !iv || !tag || !data) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

const fromLine = (name: string | null, address: string) => (name ? `${name} <${address}>` : address);
const addressIn = (from: string) => (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
const nameIn = (from: string) => (from.includes("<") ? from.slice(0, from.indexOf("<")).trim().replace(/^"|"$/g, "") : "");

/** The environment the mail code works with for this shop: the server's, with the app's saved values on top. */
export async function mailEnv(db: PrismaClient, shop: string, env: Env = process.env): Promise<Env> {
  const s = await db.mailSetting.findUnique({ where: { shop } });
  if (!s) return env;
  const key = unseal(s.apiKeyEnc, env);
  return {
    ...env,
    ...(key ? { RESEND_API_KEY: key } : {}),
    ...(s.fromAddress ? { PORTAL_EMAIL_FROM: fromLine(s.fromName, s.fromAddress) } : {}),
    ...(s.replyTo ? { PORTAL_EMAIL_REPLY_TO: s.replyTo } : {}),
    ...(s.onlyTo.length ? { MAIL_ONLY_TO: s.onlyTo.join(",") } : {}),
  };
}

/** Every signing secret a report from the mail service may be signed with: the server's and each shop's. */
export async function webhookSecrets(db: PrismaClient, env: Env = process.env): Promise<string[]> {
  const rows = await db.mailSetting.findMany({ where: { webhookSecretEnc: { not: null } }, select: { webhookSecretEnc: true } });
  return [...new Set([env.RESEND_WEBHOOK_SECRET, ...rows.map((r) => unseal(r.webhookSecretEnc, env))].filter((s): s is string => !!s))];
}

type Source = "app" | "server" | "none";
const source = (app: unknown, server: unknown): Source => (app ? "app" : server ? "server" : "none");

/** What the Settings tab shows. Secrets are never included: only whether one is saved and its last four characters. */
export async function mailSettings(db: PrismaClient, shop: string, env: Env = process.env) {
  const s = await db.mailSetting.findUnique({ where: { shop } });
  const keyReadable = s?.apiKeyEnc ? unseal(s.apiKeyEnc, env) !== null : false;
  const hookReadable = s?.webhookSecretEnc ? unseal(s.webhookSecretEnc, env) !== null : false;
  const serverFrom = env.PORTAL_EMAIL_FROM ?? "";
  const serverList = (env.MAIL_ONLY_TO ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  const merged = await mailEnv(db, shop, env);
  const base = mailBaseUrl(env);
  return {
    key: { source: source(keyReadable, env.RESEND_API_KEY), hint: keyReadable ? s!.apiKeyHint : null, unreadable: !!s?.apiKeyEnc && !keyReadable },
    fromName: s?.fromAddress ? (s.fromName ?? "") : nameIn(serverFrom),
    fromAddress: s?.fromAddress ?? (serverFrom ? addressIn(serverFrom) : ""),
    fromSource: source(s?.fromAddress, serverFrom),
    replyTo: s?.replyTo ?? env.PORTAL_EMAIL_REPLY_TO ?? "",
    replySource: source(s?.replyTo, env.PORTAL_EMAIL_REPLY_TO),
    onlyTo: s?.onlyTo.length ? s.onlyTo : serverList,
    onlyToSource: source(s?.onlyTo.length, serverList.length),
    webhook: { source: source(hookReadable, env.RESEND_WEBHOOK_SECRET), hint: hookReadable ? s!.webhookSecretHint : null, unreadable: !!s?.webhookSecretEnc && !hookReadable },
    webhookUrl: base ? `${base}/webhooks/resend` : null,
    production: env.NODE_ENV === "production",
    canStoreSecrets: cipherKey(env) !== null,
    mode: sendingMode(merged),
    updatedBy: s?.updatedBy?.replace(/^admin:/, "") ?? null,
    updatedAt: s?.updatedAt.toISOString() ?? null,
  };
}

export type SettingsInput = {
  apiKey?: string; removeApiKey?: boolean;
  fromName?: string; fromAddress?: string; replyTo?: string; onlyTo?: string;
  webhookSecret?: string; removeWebhookSecret?: boolean;
};
type SaveResult = { ok: true; message: string } | { ok: false; error: string; errors: Record<string, string> };

/** Entries of the test list: addresses, or whole domains written as @domain. */
export function cleanTestList(raw: string): { list: string[]; bad: string[] } {
  const list = [...new Set(String(raw ?? "").split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
  const ok = (x: string) => (x.startsWith("@") ? /^@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(x) : isValidEmail(x));
  return { list, bad: list.filter((x) => !ok(x)) };
}

/**
 * Saves the settings. An empty key or webhook secret keeps the saved one
 * (tick "remove" to delete it); every other field is saved as given, and an
 * empty one goes back to the server's value.
 */
export async function saveMailSettings(db: PrismaClient, shop: string, input: SettingsInput, actor: string, env: Env = process.env): Promise<SaveResult> {
  const errors: Record<string, string> = {};
  const text = (v: string | undefined, max: number) => String(v ?? "").trim().slice(0, max);
  const apiKey = text(input.apiKey, 200);
  const webhookSecret = text(input.webhookSecret, 200);
  const fromName = text(input.fromName, 60);
  const fromAddress = normaliseEmail(text(input.fromAddress, 254));
  const replyTo = normaliseEmail(text(input.replyTo, 254));
  const test = cleanTestList(input.onlyTo ?? "");

  if (apiKey && !/^re_[A-Za-z0-9_-]{8,}$/.test(apiKey)) errors.apiKey = "That doesn't look like a Resend key. They start with “re_” and have no spaces.";
  if (webhookSecret && !/^whsec_[A-Za-z0-9+/=_-]{8,}$/.test(webhookSecret)) errors.webhookSecret = "That doesn't look like a signing secret. They start with “whsec_”.";
  if ((apiKey || webhookSecret) && !cipherKey(env)) errors[apiKey ? "apiKey" : "webhookSecret"] = "This server can't store secrets safely yet (no SHOPIFY_API_SECRET). Nothing was saved.";
  if (/[<>"\r\n]/.test(fromName)) errors.fromName = "The sender name can't contain < > or quotes.";
  if (fromAddress && !isValidEmail(fromAddress)) errors.fromAddress = "Enter a valid email address.";
  if (fromName && !fromAddress) errors.fromAddress = "Enter the address mails come from.";
  if (replyTo && !isValidEmail(replyTo)) errors.replyTo = "Enter a valid email address.";
  if (test.bad.length) errors.onlyTo = `${test.bad.map((b) => `“${b.slice(0, 60)}”`).join(", ")} ${test.bad.length === 1 ? "isn't" : "aren't"} an email address or an @domain.`;
  else if (test.list.length > TEST_LIST_MAX) errors.onlyTo = `Up to ${TEST_LIST_MAX} entries.`;
  if (Object.keys(errors).length) return { ok: false, error: "Check the highlighted fields. Nothing was saved.", errors };

  const before = await db.mailSetting.findUnique({ where: { shop } });
  const data = {
    ...(apiKey ? { apiKeyEnc: seal(apiKey, env), apiKeyHint: apiKey.slice(-4) } : input.removeApiKey ? { apiKeyEnc: null, apiKeyHint: null } : {}),
    ...(webhookSecret ? { webhookSecretEnc: seal(webhookSecret, env), webhookSecretHint: webhookSecret.slice(-4) } : input.removeWebhookSecret ? { webhookSecretEnc: null, webhookSecretHint: null } : {}),
    fromName: fromAddress ? fromName || null : null, fromAddress: fromAddress || null, replyTo: replyTo || null, onlyTo: test.list, updatedBy: actor,
  };
  await db.mailSetting.upsert({ where: { shop }, create: { shop, ...data }, update: data });

  // The record says which settings changed, never their values.
  const changed = [
    ...(apiKey ? ["key"] : input.removeApiKey && before?.apiKeyEnc ? ["key removed"] : []),
    ...(webhookSecret ? ["webhook secret"] : input.removeWebhookSecret && before?.webhookSecretEnc ? ["webhook secret removed"] : []),
    ...((before?.fromAddress ?? "") !== fromAddress || (before?.fromName ?? "") !== (fromAddress ? fromName : "") ? ["sender"] : []),
    ...((before?.replyTo ?? "") !== replyTo ? ["reply address"] : []),
    ...((before?.onlyTo ?? []).join(",") !== test.list.join(",") ? ["test list"] : []),
  ];
  if (changed.length) await db.auditLog.create({ data: { shop, actor, action: "mail.settings_updated", target: "mail", detail: { changed } } });
  return { ok: true, message: changed.length ? `Saved: ${changed.join(", ")}.` : "Nothing was changed." };
}

type ResendAnswer = { name?: string; message?: string; data?: { name?: string; status?: string }[] } | null;

/** Asks Resend which domains the key's account has: tells us whether the key works and whether the sender's domain is verified. */
async function askResend(key: string, fetcher: typeof fetch): Promise<{ status: number; body: ResendAnswer }> {
  try {
    const res = await fetcher("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${key}`, "User-Agent": "setu-store-seller-panel" }, signal: AbortSignal.timeout(10000),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as ResendAnswer };
  } catch {
    return { status: -1, body: null };
  }
}

export type CheckItem = { what: string; tone: "ok" | "warn" | "bad"; text: string };

const DOMAIN_STATUS: Record<string, { tone: CheckItem["tone"]; text: string }> = {
  verified: { tone: "ok", text: "is verified in Resend, so mail from this address will be accepted." },
  pending: { tone: "warn", text: "is added in Resend but not verified yet. Add the DNS records Resend shows, then press “Verify DNS Records” there." },
  not_started: { tone: "warn", text: "is added in Resend but verification hasn't been started. Add the DNS records Resend shows, then press “Verify DNS Records” there." },
  failed: { tone: "bad", text: "failed verification in Resend: the DNS records weren't found. Check them against what Resend shows." },
  temporary_failure: { tone: "bad", text: "was verified, but Resend can no longer find its DNS records. Check that they are still in place." },
};

/**
 * Checks the settings as they are used now: what is filled in, what Resend
 * says about the key and the sender's domain, and whether mail will really
 * go out from here. Sends no mail.
 */
export async function checkMailSettings(db: PrismaClient, shop: string, env: Env = process.env, fetcher: typeof fetch = fetch): Promise<CheckItem[]> {
  const merged = await mailEnv(db, shop, env);
  const s = await mailSettings(db, shop, env);
  const out: CheckItem[] = [];
  const key = merged.RESEND_API_KEY;
  const from = merged.PORTAL_EMAIL_FROM ? addressIn(merged.PORTAL_EMAIL_FROM) : "";
  const domain = from.split("@")[1] ?? "";

  if (s.key.unreadable) out.push({ what: "Resend key", tone: "bad", text: "A key is saved but can no longer be read, because the server's secret changed. Enter the key again." });
  if (!from) out.push({ what: "Sender", tone: "bad", text: "No sender address is set, so nothing can be sent." });
  else if (!isValidEmail(from)) out.push({ what: "Sender", tone: "bad", text: `“${from}” isn't a valid email address.` });

  if (!key) {
    if (!s.key.unreadable) out.push({ what: "Resend key", tone: "bad", text: "No Resend key is set, so nothing can be sent." });
  } else {
    const { status, body } = await askResend(key, fetcher);
    if (status === 200) {
      out.push({ what: "Resend key", tone: "ok", text: "Resend accepts this key." });
      if (domain) {
        const domains = (body?.data ?? []).filter((d) => d.name);
        const found = domains.find((d) => d.name!.toLowerCase() === domain);
        if (found) {
          const st = DOMAIN_STATUS[found.status ?? ""] ?? { tone: "warn" as const, text: `has the status “${found.status}” in Resend.` };
          out.push({ what: "Sender's domain", tone: st.tone, text: `${domain} ${st.text}` });
        } else {
          const have = domains.map((d) => d.name).join(", ");
          out.push({ what: "Sender's domain", tone: "bad", text: `${domain} isn't added in this Resend account${have ? ` (it has: ${have})` : ""}. Add it under Domains in Resend, or change the sender address.` });
        }
      }
    } else if (status === 401 && body?.name === "restricted_api_key") {
      out.push({ what: "Resend key", tone: "ok", text: "Resend accepts this key. It is a “Sending access” key, which is all the app needs." });
      if (domain) out.push({ what: "Sender's domain", tone: "warn", text: `With this kind of key the app can't see whether ${domain} is verified. Send a test from the Mails tab to be sure.` });
    } else if (status === 400 || status === 401 || status === 403) {
      out.push({ what: "Resend key", tone: "bad", text: `Resend doesn't accept this key${body?.message ? ` (“${String(body.message).slice(0, 120)}”)` : ""}. Create a new one under API Keys in Resend and save it here.` });
    } else {
      out.push({ what: "Resend key", tone: "warn", text: "Couldn't reach Resend just now, so the key wasn't checked. Try again in a minute." });
    }
  }

  if (from) out.push({ what: "Reply address", tone: "ok", text: `A reply to a mail goes to ${merged.PORTAL_EMAIL_REPLY_TO || from}.` });

  const list = s.onlyTo;
  if (s.production) {
    out.push(list.length
      ? { what: "Who really gets mail", tone: "warn", text: `Only the test list: ${list.join(", ")}. Every other mail is kept in the log. Empty the list to mail everyone.` }
      : { what: "Who really gets mail", tone: key && from ? "ok" : "bad", text: key && from ? "Everyone: sellers and the team." : "Nobody, until the key and the sender are set." });
  } else {
    out.push(list.length
      ? { what: "Who really gets mail", tone: key && from ? "ok" : "bad", text: key && from ? `This is a development copy, so only the test list: ${list.join(", ")}. Every other mail is kept in the log.` : "Nobody, until the key and the sender are set." }
      : { what: "Who really gets mail", tone: "warn", text: "Nobody. This is a development copy, and it only mails addresses on the test list, which is empty. Every mail is kept in the log." });
  }

  out.push(s.webhook.unreadable
    ? { what: "Delivery reports", tone: "bad", text: "A signing secret is saved but can no longer be read. Enter it again." }
    : s.webhook.source === "none"
      ? { what: "Delivery reports", tone: "warn", text: "No webhook signing secret is set, so the log stops at “Sent” and never shows “Delivered” or “Bounced”. This can wait until the app is hosted." }
      : { what: "Delivery reports", tone: "ok", text: `A signing secret is set.${s.webhookUrl ? ` Resend's webhook should point at ${s.webhookUrl}.` : ""}` });

  const team = (await db.shopSetting.findUnique({ where: { shop }, select: { adminEmails: true } }))?.adminEmails ?? [];
  out.push(team.length
    ? { what: "Team addresses", tone: "ok", text: `The team's mails go to ${team.join(", ")}.` }
    : { what: "Team addresses", tone: "warn", text: "No team address is set, so the team's mails go to nobody. Add one under Team addresses." });
  return out;
}
