import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { mailLog, mailNumbers, mailSetup, mailTemplates, saveTeamAddresses, sendLogMailAgain, sendTest, setTemplateEnabled } from "../lib/mail/admin.server";
import { checkMailSettings, mailSettings, saveMailSettings, type CheckItem } from "../lib/mail/config.server";
import { LOG_KEPT_DAYS, LOG_STATUSES, TEAM_ADDRESSES_MAX, TEST_LIST_MAX } from "../lib/mail/rules";
import { cell, headRow, input, muted, plural, Stats, table, Tabs, when } from "../lib/admin/ui";

/**
 * Mail: every mail the app sends to sellers and to the team.
 *  - Mails: what each one says, when it goes out and to whom; switch one off
 *    or on, read it, send yourself a test.
 *  - Log: every mail that went out or didn't, and why; send one again.
 *  - Team addresses: who on the team gets the team's mails.
 *  - Settings: the Resend key, the sender, the reply address and the test
 *    list, with a check of them against Resend.
 */
type Template = Awaited<ReturnType<typeof mailTemplates>>[number];
type ActionResult = { ok: true; message: string; checks?: CheckItem[] } | { ok: false; error: string; errors?: Record<string, string> };
type Settings = Awaited<ReturnType<typeof mailSettings>>;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const q = new URL(request.url).searchParams;
  const wanted = q.get("view");
  const view = wanted === "log" || wanted === "team" || wanted === "settings" ? wanted : "mails" as const;
  const [numbers, templates, log, settings, mode] = await Promise.all([
    mailNumbers(db, session.shop),
    view === "mails" ? mailTemplates(db, session.shop) : Promise.resolve([] as Template[]),
    view === "log" ? mailLog(db, session.shop, { status: q.get("status") ?? "", template: q.get("mail") ?? "", to: q.get("to") ?? "", page: Number(q.get("page")) || 1 }) : Promise.resolve(null),
    view === "settings" ? mailSettings(db, session.shop) : Promise.resolve(null),
    mailSetup(db, session.shop),
  ]);
  const names = view === "log" ? (await mailTemplates(db, session.shop)).map((t) => ({ key: t.key, name: t.name })) : [];
  return { view, numbers, templates, log, names, settings, mode, me: session.onlineAccessInfo?.associated_user?.email ?? "" };
};

export const action = async ({ request }: ActionFunctionArgs): Promise<ActionResult & { intent: string; key?: string }> => {
  const { session } = await authenticate.admin(request);
  const actor = `admin:${session.onlineAccessInfo?.associated_user?.email ?? "staff"}`;
  const form = await request.formData();
  const f = (k: string) => String(form.get(k) ?? "");
  const intent = f("intent");
  const key = f("template");
  if (intent === "template_on" || intent === "template_off") return { intent, key, ...(await setTemplateEnabled(db, session.shop, key, intent === "template_on", actor)) };
  if (intent === "test") return { intent, key, ...(await sendTest(db, session.shop, key, f("to"))) };
  if (intent === "send_again") return { intent, key: f("id"), ...(await sendLogMailAgain(db, session.shop, f("id"))) };
  if (intent === "team_addresses") return { intent, ...(await saveTeamAddresses(db, session.shop, f("addresses"), actor)) };
  if (intent === "settings_save") {
    return {
      intent,
      ...(await saveMailSettings(db, session.shop, {
        apiKey: f("apiKey"), removeApiKey: f("removeApiKey") === "on", fromName: f("fromName"), fromAddress: f("fromAddress"), replyTo: f("replyTo"),
        onlyTo: f("onlyTo"), webhookSecret: f("webhookSecret"), removeWebhookSecret: f("removeWebhookSecret") === "on",
      }, actor)),
    };
  }
  if (intent === "settings_check") return { intent, ok: true, message: "Checked just now.", checks: await checkMailSettings(db, session.shop) };
  return { intent, ok: false, error: "Unknown action" };
};

const STATUS_TEXT: Record<string, { label: string; tone?: "success" | "critical" | "warning" | "info" }> = {
  queued: { label: "Waiting", tone: "info" },
  sent: { label: "Sent", tone: "success" },
  delivered: { label: "Delivered", tone: "success" },
  bounced: { label: "Bounced", tone: "critical" },
  failed: { label: "Failed", tone: "critical" },
  logged: { label: "Not sent", tone: "warning" },
};

export default function Mail() {
  const { view, numbers, templates, log, names, settings, mode, me } = useLoaderData<typeof loader>();
  const noTeam = numbers.team.length === 0;
  return (
    <s-page heading="Mail">
      <s-banner tone={mode.real ? "info" : "warning"}>
        {mode.text}{view !== "settings" && !mode.real && <> <s-link href="/app/mail?view=settings">Open Settings</s-link></>}
      </s-banner>
      {noTeam && view !== "team" && (
        <s-banner tone="warning">
          No team address is set, so the team&apos;s mails go to nobody. <s-link href="/app/mail?view=team">Add an address</s-link>
        </s-banner>
      )}
      <Tabs label="Mail" current={view} tabs={[
        { id: "mails", label: "Mails", to: "/app/mail" },
        { id: "log", label: "Log", to: "/app/mail?view=log" },
        { id: "team", label: "Team addresses", to: "/app/mail?view=team", count: numbers.team.length },
        { id: "settings", label: "Settings", to: "/app/mail?view=settings" },
      ]} />
      <s-section>
        <Stats items={[
          { label: "Sent", value: String(numbers.sent), note: "Last 7 days" },
          { label: "Waiting", value: String(numbers.waiting), note: "Going out within a minute, or being retried" },
          { label: "Failed", value: String(numbers.failed), note: "Last 7 days", to: numbers.failed ? "/app/mail?view=log&status=failed" : undefined, linkLabel: "See them" },
          { label: "Bounced", value: String(numbers.bounced), note: "The address refused it", to: numbers.bounced ? "/app/mail?view=log&status=bounced" : undefined, linkLabel: "See them" },
          { label: "Not sent", value: String(numbers.logged), note: "Kept in the log only", to: numbers.logged ? "/app/mail?view=log&status=logged" : undefined, linkLabel: "See them" },
        ]} />
      </s-section>
      {view === "mails" && <Mails templates={templates} testTo={numbers.team[0] ?? me} replyTo={mode.replyTo} />}
      {view === "log" && log && <Log log={log} names={names} />}
      {view === "team" && <Team addresses={numbers.team} />}
      {view === "settings" && settings && <SettingsTab s={settings} />}
    </s-page>
  );
}

function Mails({ templates, testTo, replyTo }: { templates: Template[]; testTo: string; replyTo: string | null }) {
  const groups = (audience: "seller" | "admin") => {
    const out = new Map<string, Template[]>();
    for (const t of templates.filter((x) => x.audience === audience)) out.set(t.group, [...(out.get(t.group) ?? []), t]);
    return [...out];
  };
  const off = templates.filter((t) => !t.enabled).length;
  return (
    <>
      <s-section heading="Mails to sellers">
        <s-paragraph>
          {templates.filter((t) => t.audience === "seller").length} mails. {replyTo ? `A seller who replies to one reaches ${replyTo}.` : "No reply address is set yet."}
          {off > 0 && <> {plural(off, "mail")} in total {off === 1 ? "is" : "are"} switched off.</>}
        </s-paragraph>
        {groups("seller").map(([group, list]) => <Group key={group} name={group} list={list} testTo={testTo} />)}
      </s-section>
      <s-section heading="Mails to the team">
        <s-paragraph>These go to the addresses under <s-link href="/app/mail?view=team">Team addresses</s-link>. An alert about something that broke is sent at most once a day.</s-paragraph>
        {groups("admin").map(([group, list]) => <Group key={group} name={group} list={list} testTo={testTo} />)}
      </s-section>
    </>
  );
}

function Group({ name, list, testTo }: { name: string; list: Template[]; testTo: string }) {
  return (
    <div style={{ margin: "14px 0 22px" }}>
      <h3 style={{ margin: "0 0 6px", fontSize: 14, fontWeight: 600 }}>{name}</h3>
      <div style={{ overflowX: "auto" }}>
        <table style={table}>
          <thead>
            <tr style={headRow}>
              <th style={{ ...cell, width: "34%" }}>Mail</th>
              <th style={{ ...cell, width: "24%" }}>Goes to</th>
              <th style={cell}>Status</th>
              <th style={cell}></th>
            </tr>
          </thead>
          <tbody>{list.map((t) => <TemplateRow key={t.key} t={t} testTo={testTo} />)}</tbody>
        </table>
      </div>
    </div>
  );
}

function TemplateRow({ t, testTo }: { t: Template; testTo: string }) {
  const fetcher = useFetcher<typeof action>();
  const busy = (intent: string) => fetcher.state !== "idle" && fetcher.formData?.get("intent") === intent;
  const result = fetcher.data && fetcher.data.key === t.key ? fetcher.data : null;
  return (
    <>
      <tr>
        <td style={{ ...cell, borderBottom: 0 }}>
          <b style={{ fontWeight: 600 }}>{t.name}</b>
          <div style={muted}>{t.when}</div>
        </td>
        <td style={{ ...cell, borderBottom: 0 }}>{t.to}</td>
        <td style={{ ...cell, borderBottom: 0 }}>
          {t.required ? <s-badge>Always on</s-badge> : t.enabled ? <s-badge tone="success">On</s-badge> : <s-badge tone="warning">Off</s-badge>}
        </td>
        <td style={{ ...cell, borderBottom: 0, textAlign: "right", whiteSpace: "nowrap" }}>
          {!t.required && (
            <fetcher.Form method="post" style={{ display: "inline" }}>
              <input type="hidden" name="intent" value={t.enabled ? "template_off" : "template_on"} />
              <input type="hidden" name="template" value={t.key} />
              <s-button type="submit" variant="tertiary" {...(busy("template_on") || busy("template_off") ? { loading: true } : {})}>{t.enabled ? "Switch off" : "Switch on"}</s-button>
            </fetcher.Form>
          )}
        </td>
      </tr>
      <tr>
        <td style={{ ...cell, paddingTop: 0 }} colSpan={4}>
          {result && !result.ok && <s-banner tone="critical">{result.error}</s-banner>}
          {result && result.ok && result.intent === "test" && <s-banner tone="success">{result.message}</s-banner>}
          <details>
            <summary style={{ cursor: "pointer", fontSize: 13, color: "#005bd3" }}>Read it, or send a test</summary>
            <div style={{ margin: "8px 0 4px", padding: 14, border: "1px solid #e3e3e3", borderRadius: 8, background: "#fafafa", maxWidth: 640 }}>
              <div style={{ fontSize: 12, ...muted }}>Subject</div>
              <div style={{ fontWeight: 600, margin: "0 0 10px" }}>{t.preview.subject}</div>
              <div style={{ whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.5 }}>{t.preview.text}</div>
              <p style={{ margin: "10px 0 0", fontSize: 12, ...muted }}>
                This is an example with made-up names.{t.secret ? " The real mail carries a one-time link, which is never kept in the log." : ""}
              </p>
            </div>
            <fetcher.Form method="post" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "end", margin: "10px 0 6px" }}>
              <input type="hidden" name="intent" value="test" />
              <input type="hidden" name="template" value={t.key} />
              <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
                Send this example to
                <input name="to" type="email" required defaultValue={testTo} style={{ ...input, minWidth: 260 }} />
              </label>
              <s-button type="submit" {...(busy("test") ? { loading: true } : {})}>Send test</s-button>
            </fetcher.Form>
          </details>
        </td>
      </tr>
    </>
  );
}

function Log({ log, names }: { log: NonNullable<Awaited<ReturnType<typeof mailLog>>>; names: { key: string; name: string }[] }) {
  const f = log.filter;
  const filtered = !!(f.status || f.template || f.to);
  const link = (page: number) => {
    const q = new URLSearchParams({ view: "log" });
    if (f.status) q.set("status", f.status);
    if (f.template) q.set("mail", f.template);
    if (f.to) q.set("to", f.to);
    if (page > 1) q.set("page", String(page));
    return `/app/mail?${q}`;
  };
  return (
    <s-section heading="Log">
      <Form method="get" style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "end", margin: "0 0 14px" }}>
        <input type="hidden" name="view" value="log" />
        <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
          Status
          <select name="status" defaultValue={f.status} style={input}>
            <option value="">Any</option>
            {LOG_STATUSES.map((s) => <option key={s} value={s}>{STATUS_TEXT[s].label}</option>)}
          </select>
        </label>
        <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
          Mail
          <select name="mail" defaultValue={f.template} style={{ ...input, maxWidth: 240 }}>
            <option value="">Any</option>
            {names.map((n) => <option key={n.key} value={n.key}>{n.name}</option>)}
          </select>
        </label>
        <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
          Sent to
          <input name="to" type="search" defaultValue={f.to} placeholder="Part of an address" style={{ ...input, minWidth: 200 }} />
        </label>
        <s-button type="submit">Show</s-button>
        {filtered && <s-link href="/app/mail?view=log">Clear</s-link>}
      </Form>
      {log.total === 0 ? (
        <s-paragraph>{filtered ? "No mails match." : "No mail has been sent yet."}</s-paragraph>
      ) : (
        <>
          <s-paragraph>{plural(log.total, "mail")}{filtered ? " match" : ""}, newest first.</s-paragraph>
          <div style={{ overflowX: "auto" }}>
            <table style={table}>
              <thead>
                <tr style={headRow}>
                  <th style={cell}>When</th>
                  <th style={cell}>To</th>
                  <th style={cell}>Mail</th>
                  <th style={cell}>Status</th>
                  <th style={cell}></th>
                </tr>
              </thead>
              <tbody>{log.rows.map((m) => <LogRow key={m.id} m={m} />)}</tbody>
            </table>
          </div>
          {log.pages > 1 && (
            <div style={{ display: "flex", gap: 14, alignItems: "center", marginTop: 12, fontSize: 13 }}>
              {log.page > 1 ? <s-link href={link(log.page - 1)}>Newer</s-link> : <span style={muted}>Newer</span>}
              <span>Page {log.page} of {log.pages}</span>
              {log.page < log.pages ? <s-link href={link(log.page + 1)}>Older</s-link> : <span style={muted}>Older</span>}
            </div>
          )}
        </>
      )}
      <s-paragraph>
        “Not sent” means the mail was written but held back: no mail service is set up, or the address isn&apos;t on the test list.
        “Delivered” and “Bounced” appear once the mail service reports back. Mails stay in the log for {LOG_KEPT_DAYS} days.
      </s-paragraph>
    </s-section>
  );
}

function LogRow({ m }: { m: NonNullable<Awaited<ReturnType<typeof mailLog>>>["rows"][number] }) {
  const fetcher = useFetcher<typeof action>();
  const s = STATUS_TEXT[m.status] ?? { label: m.status };
  const result = fetcher.data;
  return (
    <tr>
      <td style={{ ...cell, whiteSpace: "nowrap" }}>{when(m.createdAt)}</td>
      <td style={cell}>
        {m.to}
        <div style={muted}>{m.audience === "admin" ? "Team" : "Seller"}</div>
      </td>
      <td style={cell}>
        {m.subject}
        <div style={muted}>{m.mail}</div>
      </td>
      <td style={cell}>
        <s-badge {...(s.tone ? { tone: s.tone } : {})}>{s.label}</s-badge>
        {m.note && <div style={{ ...muted, marginTop: 4, maxWidth: 320 }}>{m.note}</div>}
        {m.status === "queued" && m.attempts > 0 && <div style={{ ...muted, marginTop: 4 }}>Tried {plural(m.attempts, "time")}; trying again</div>}
      </td>
      <td style={{ ...cell, textAlign: "right", whiteSpace: "nowrap" }}>
        {result && !result.ok && <div style={{ color: "#8e1f0b", maxWidth: 260, whiteSpace: "normal", textAlign: "left" }}>{result.error}</div>}
        {result?.ok ? <span style={muted}>Queued again</span> : m.canSendAgain && (
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="send_again" />
            <input type="hidden" name="id" value={m.id} />
            <s-button type="submit" variant="tertiary" {...(fetcher.state !== "idle" ? { loading: true } : {})}>Send again</s-button>
          </fetcher.Form>
        )}
      </td>
    </tr>
  );
}

function Team({ addresses }: { addresses: string[] }) {
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data?.intent === "team_addresses" ? fetcher.data : null;
  return (
    <s-section heading="Team addresses">
      <s-paragraph>
        Who on the Setu Store team gets the team&apos;s mails: a new sign-up or a business change waiting for approval, a low review,
        orders that are late to ship, and anything that broke. Sellers never see these addresses.
      </s-paragraph>
      {result && !result.ok && <s-banner tone="critical">{result.error}</s-banner>}
      {result?.ok && <s-banner tone="success">{result.message}</s-banner>}
      <fetcher.Form method="post" key={addresses.join(",")} style={{ display: "grid", gap: 8, maxWidth: 460, marginTop: 8 }}>
        <input type="hidden" name="intent" value="team_addresses" />
        <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
          Email addresses, one on each line (up to {TEAM_ADDRESSES_MAX})
          <textarea name="addresses" rows={Math.max(3, addresses.length + 1)} defaultValue={addresses.join("\n")} style={{ ...input, resize: "vertical" }} />
        </label>
        <div><s-button type="submit" variant="primary" {...(fetcher.state !== "idle" ? { loading: true } : {})}>Save</s-button></div>
      </fetcher.Form>
      <s-paragraph>Leave it empty and save to stop all team mails.</s-paragraph>
    </s-section>
  );
}

const SOURCE_TEXT = { app: "Saved here", server: "From the server's .env file", none: "Not set" } as const;
const CHECK_TONE = { ok: { label: "Good", tone: "success" }, warn: { label: "Look at this", tone: "warning" }, bad: { label: "Fix this", tone: "critical" } } as const;
const fieldLabel = { display: "grid", gap: 4, fontSize: 13, maxWidth: 460 } as const;
const help = { fontSize: 12, color: "#616161" } as const;
const problem = { fontSize: 12, color: "#8e1f0b" } as const;

function SettingsTab({ s }: { s: Settings }) {
  const fetcher = useFetcher<typeof action>();
  const busy = (intent: string) => fetcher.state !== "idle" && fetcher.formData?.get("intent") === intent;
  const result = fetcher.data;
  const saved = result?.intent === "settings_save" ? result : null;
  const errors = (saved && !saved.ok && saved.errors) || {};
  const checks = result?.intent === "settings_check" && result.ok ? result.checks ?? [] : null;
  const secretNote = (x: Settings["key"]) =>
    x.unreadable ? "One is saved but can't be read any more. Enter it again."
      : x.source === "app" ? `One is saved here, ending in ${x.hint}. Leave this empty to keep it.`
        : x.source === "server" ? "One is set in the server's .env file. Enter one here to use it instead."
          : "None is set.";
  return (
    <>
      <s-section heading="Settings">
        <s-paragraph>
          How the app sends mail. What you save here is used straight away, in place of the same value in the server&apos;s .env file; a field you leave empty goes back to the server&apos;s value.
          {s.updatedAt && <> Last changed {when(s.updatedAt)}{s.updatedBy ? ` by ${s.updatedBy}` : ""}.</>}
        </s-paragraph>
        {saved && !saved.ok && <s-banner tone="critical">{saved.error}</s-banner>}
        {saved?.ok && <s-banner tone="success">{saved.message} Press “Check these settings” to make sure they work.</s-banner>}
        {!s.canStoreSecrets && <s-banner tone="warning">This server has no secret to protect a saved key with, so the key and the signing secret can&apos;t be saved here yet.</s-banner>}
        <fetcher.Form method="post" key={s.updatedAt ?? "new"} style={{ display: "grid", gap: 18, marginTop: 12 }} autoComplete="off">
          <input type="hidden" name="intent" value="settings_save" />

          <div style={fieldLabel}>
            <label htmlFor="apiKey" style={{ fontWeight: 600 }}>Resend API key</label>
            <input id="apiKey" name="apiKey" type="password" autoComplete="new-password" placeholder={s.key.source === "app" ? `••••••••${s.key.hint}` : "re_…"} style={input} />
            <span style={help}>{secretNote(s.key)} Create it in Resend under API Keys. It is stored encrypted and never shown again.</span>
            {errors.apiKey && <span style={problem}>{errors.apiKey}</span>}
            {s.key.source === "app" && <span style={{ fontSize: 13 }}><input type="checkbox" name="removeApiKey" id="removeApiKey" /> <label htmlFor="removeApiKey">Remove the saved key</label></span>}
          </div>

          <div style={{ display: "grid", gap: 4, maxWidth: 460 }}>
            <b style={{ fontWeight: 600, fontSize: 13 }}>Sender</b>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 8 }}>
              <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
                Name
                <input name="fromName" defaultValue={s.fromName} maxLength={60} placeholder="Setu Store" style={input} />
              </label>
              <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
                Address
                <input name="fromAddress" type="email" defaultValue={s.fromAddress} placeholder="support@your-domain" style={input} />
              </label>
            </div>
            <span style={help}>Who a mail comes from. The address&apos;s domain must be verified in Resend. {SOURCE_TEXT[s.fromSource]}.</span>
            {errors.fromName && <span style={problem}>{errors.fromName}</span>}
            {errors.fromAddress && <span style={problem}>{errors.fromAddress}</span>}
          </div>

          <label style={fieldLabel}>
            <b style={{ fontWeight: 600 }}>Reply address</b>
            <input name="replyTo" type="email" defaultValue={s.replyTo} placeholder="Same as the sender" style={input} />
            <span style={help}>Where a seller&apos;s reply to a mail goes. Empty means the sender address. {SOURCE_TEXT[s.replySource]}.</span>
            {errors.replyTo && <span style={problem}>{errors.replyTo}</span>}
          </label>

          <label style={fieldLabel}>
            <b style={{ fontWeight: 600 }}>Test list</b>
            <textarea name="onlyTo" rows={Math.max(2, s.onlyTo.length + 1)} defaultValue={s.onlyTo.join("\n")} placeholder={"you@your-domain\n@your-domain"} style={{ ...input, resize: "vertical" }} />
            <span style={help}>
              Only these really get mail; every other mail is kept in the log. One address on each line, or a whole domain written as @domain (up to {TEST_LIST_MAX}).{" "}
              {s.production
                ? "This is the live app: leave the list empty to mail everyone."
                : "This is a development copy: with an empty list it mails nobody, so real sellers can't be mailed by accident."}{" "}
              {SOURCE_TEXT[s.onlyToSource]}.
            </span>
            {errors.onlyTo && <span style={problem}>{errors.onlyTo}</span>}
          </label>

          <div style={fieldLabel}>
            <label htmlFor="webhookSecret" style={{ fontWeight: 600 }}>Webhook signing secret</label>
            <input id="webhookSecret" name="webhookSecret" type="password" autoComplete="new-password" placeholder={s.webhook.source === "app" ? `••••••••${s.webhook.hint}` : "whsec_…"} style={input} />
            <span style={help}>
              {secretNote(s.webhook)} Needed only for “Delivered” and “Bounced” in the log, once the app is hosted: in Resend, add a webhook
              {s.webhookUrl ? <> to <code>{s.webhookUrl}</code></> : " to this app's address followed by /webhooks/resend"} and paste the secret it shows.
            </span>
            {errors.webhookSecret && <span style={problem}>{errors.webhookSecret}</span>}
            {s.webhook.source === "app" && <span style={{ fontSize: 13 }}><input type="checkbox" name="removeWebhookSecret" id="removeWebhookSecret" /> <label htmlFor="removeWebhookSecret">Remove the saved secret</label></span>}
          </div>

          <div><s-button type="submit" variant="primary" {...(busy("settings_save") ? { loading: true } : {})}>Save</s-button></div>
        </fetcher.Form>
      </s-section>

      <s-section heading="Check these settings">
        <s-paragraph>Checks the saved settings: what is filled in, whether Resend accepts the key, whether the sender&apos;s domain is verified, and who would really get mail. It sends nothing.</s-paragraph>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="settings_check" />
          <s-button type="submit" {...(busy("settings_check") ? { loading: true } : {})}>Check these settings</s-button>
        </fetcher.Form>
        {checks && (
          <table style={{ ...table, marginTop: 12 }}>
            <tbody>
              {checks.map((c, i) => (
                <tr key={i}>
                  <td style={{ ...cell, width: 170, fontWeight: 600 }}>{c.what}</td>
                  <td style={{ ...cell, width: 120 }}><s-badge tone={CHECK_TONE[c.tone].tone}>{CHECK_TONE[c.tone].label}</s-badge></td>
                  <td style={cell}>{c.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {checks && <s-paragraph>The surest check is a real mail: open <s-link href="/app/mail">Mails</s-link>, pick one and press “Send test”.</s-paragraph>}
      </s-section>
    </>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
