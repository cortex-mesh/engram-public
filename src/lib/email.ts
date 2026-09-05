import { Resend } from "resend";
import { formatSuppressionForLog, getEmailSuppression } from "@/lib/email-suppression";

import { prisma } from "@/lib/prisma";
import { isValidNativeClientId } from "@/lib/native-auth";

const DEFAULT_FROM_NAME = "CORTEX";
const DEFAULT_FROM_ADDRESS = "noreply@ctxhost.com";
const DEFAULT_PRIMARY_COLOR = "#2563eb";

export type EmailTemplateTheme = "cortex" | "tradepost";

export interface EmailIdentity {
  clientId: string | null;
  brandName: string;
  fromName: string;
  fromAddress: string;
  from: string;
  primaryColor: string;
  templateTheme: EmailTemplateTheme;
  securedByEngram: boolean;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

interface EmailLayoutOptions {
  identity: EmailIdentity;
  subject: string;
  eyebrow: string;
  title: string;
  intro: string;
  ctaLabel: string;
  ctaUrl: string;
  secondary?: string;
  safety: string;
}

export function getResend(): Resend {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is required for sending email");
  return new Resend(key);
}

function parseEmailFrom(value: string | undefined): { name: string; address: string } {
  const trimmed = value?.trim();
  if (!trimmed) {
    return { name: DEFAULT_FROM_NAME, address: DEFAULT_FROM_ADDRESS };
  }

  const bracketMatch = trimmed.match(/^(.*?)<([^>]+)>$/);
  if (bracketMatch) {
    const name = bracketMatch[1].trim().replace(/^"|"$/g, "");
    const address = bracketMatch[2].trim();
    return {
      name: name || DEFAULT_FROM_NAME,
      address: address || DEFAULT_FROM_ADDRESS,
    };
  }

  if (trimmed.includes("@")) {
    return { name: DEFAULT_FROM_NAME, address: trimmed };
  }

  return { name: trimmed, address: DEFAULT_FROM_ADDRESS };
}

function emailDomain(address: string): string | null {
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1).toLowerCase() : null;
}

function verifiedEmailDomains(fallbackAddress: string): Set<string> {
  const fallbackDomain = emailDomain(fallbackAddress);
  const configured = (process.env.EMAIL_VERIFIED_DOMAINS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...(fallbackDomain ? [fallbackDomain] : []), ...configured]);
}

function formatEmailFrom(name: string, address: string): string {
  const cleanName = name.replace(/[<>\r\n"]/g, "").trim() || DEFAULT_FROM_NAME;
  return `${cleanName} <${address}>`;
}

function normalizeTheme(value: string | null | undefined): EmailTemplateTheme {
  return value === "tradepost" ? "tradepost" : "cortex";
}

export function getEmailFrom(): string {
  const fallback = parseEmailFrom(process.env.EMAIL_FROM);
  return formatEmailFrom(fallback.name, fallback.address);
}

export async function getEmailIdentityForClient(
  clientId: string | null | undefined,
): Promise<EmailIdentity> {
  const fallback = parseEmailFrom(process.env.EMAIL_FROM);
  const fallbackIdentity: EmailIdentity = {
    clientId: null,
    brandName: DEFAULT_FROM_NAME,
    fromName: fallback.name,
    fromAddress: fallback.address,
    from: formatEmailFrom(fallback.name, fallback.address),
    primaryColor: DEFAULT_PRIMARY_COLOR,
    templateTheme: "cortex",
    securedByEngram: false,
  };

  if (!clientId || !isValidNativeClientId(clientId)) {
    return fallbackIdentity;
  }

  const client = await prisma.nativeAuthClient.findUnique({
    where: { clientId },
    select: {
      clientId: true,
      displayName: true,
      brandName: true,
      brandPrimaryColor: true,
      emailFromName: true,
      emailFromAddress: true,
      emailTemplateTheme: true,
      enabled: true,
    },
  });

  if (!client?.enabled) {
    return fallbackIdentity;
  }

  const desiredAddress = client.emailFromAddress?.trim() || fallback.address;
  const desiredDomain = emailDomain(desiredAddress);
  const verifiedDomains = verifiedEmailDomains(fallback.address);
  const fromAddress =
    desiredDomain && verifiedDomains.has(desiredDomain)
      ? desiredAddress
      : fallback.address;
  const brandName = client.brandName || client.displayName;
  const fromName = client.emailFromName?.trim() || brandName;

  return {
    clientId: client.clientId,
    brandName,
    fromName,
    fromAddress,
    from: formatEmailFrom(fromName, fromAddress),
    primaryColor: client.brandPrimaryColor || DEFAULT_PRIMARY_COLOR,
    templateTheme: normalizeTheme(client.emailTemplateTheme),
    securedByEngram: true,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderLayout({
  identity,
  subject,
  eyebrow,
  title,
  intro,
  ctaLabel,
  ctaUrl,
  secondary,
  safety,
}: EmailLayoutOptions): RenderedEmail {
  const brand = escapeHtml(identity.brandName);
  const color = escapeHtml(identity.primaryColor);
  const footer = identity.securedByEngram
    ? `${identity.brandName} sign-in is secured by Engram.`
    : "CORTEX sign-in is secured by Engram.";
  const safeFooter = escapeHtml(footer);
  const secondaryHtml = secondary
    ? `<p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#475569;">${escapeHtml(secondary)}</p>`
    : "";

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f8fafc;color:#0f172a;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;margin:0;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e2e8f0;border-radius:18px;overflow:hidden;">
            <tr>
              <td style="padding:28px 28px 12px;">
                <p style="margin:0 0 12px;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#64748b;">${escapeHtml(eyebrow)}</p>
                <h1 style="margin:0;color:#0f172a;font-size:26px;line-height:1.25;font-weight:700;">${escapeHtml(title)}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:0 28px 28px;">
                <p style="margin:0 0 20px;font-size:16px;line-height:1.6;color:#334155;">${escapeHtml(intro)}</p>
                ${secondaryHtml}
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
                  <tr>
                    <td style="background:${color};border-radius:999px;">
                      <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;padding:13px 20px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;">${escapeHtml(ctaLabel)}</a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 18px;font-size:13px;line-height:1.6;color:#64748b;">${escapeHtml(safety)}</p>
                <p style="margin:0;font-size:13px;line-height:1.6;color:#64748b;">If the button does not work, paste this link into your browser:<br><span style="word-break:break-all;color:#334155;">${escapeHtml(ctaUrl)}</span></p>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 28px;background:#f1f5f9;border-top:1px solid #e2e8f0;">
                <p style="margin:0;font-size:12px;line-height:1.6;color:#64748b;">${safeFooter}</p>
              </td>
            </tr>
          </table>
          <p style="margin:18px 0 0;font-size:12px;color:#94a3b8;">${brand}</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = [
    title,
    "",
    intro,
    secondary || "",
    "",
    `${ctaLabel}: ${ctaUrl}`,
    "",
    safety,
    footer,
  ]
    .filter((line, index, lines) => line || lines[index - 1])
    .join("\n");

  return { subject, html, text };
}

export function renderWaitlistConfirmationEmail(
  identity: EmailIdentity,
  signInUrl: string,
): RenderedEmail {
  return renderLayout({
    identity,
    subject: `You're on the ${identity.brandName} waitlist`,
    eyebrow: "Waitlist request received",
    title: `You're on the ${identity.brandName} waitlist`,
    intro:
      "Thanks for requesting access. We invite people in batches so we can keep onboarding stable and useful.",
    secondary:
      "You do not need to do anything else right now. We will email you again when your account is ready.",
    ctaLabel: "Visit the sign-in page",
    ctaUrl: signInUrl,
    safety:
      "If you did not request access, you can safely ignore this email and no account will be activated.",
  });
}

export function renderApprovalSetPasswordEmail(
  identity: EmailIdentity,
  setUrl: string,
): RenderedEmail {
  return renderLayout({
    identity,
    subject: `You're in — set up your ${identity.brandName} account`,
    eyebrow: "Waitlist approved",
    title: `Set up your ${identity.brandName} account`,
    intro:
      "Your waitlist request has been approved. Set a password to verify your email and activate your account.",
    ctaLabel: "Set my password",
    ctaUrl: setUrl,
    safety:
      "If you did not request access, you can safely ignore this email and your account will remain unchanged.",
  });
}

export function renderSetPasswordEmail(identity: EmailIdentity, setUrl: string): RenderedEmail {
  return renderLayout({
    identity,
    subject: `Set your ${identity.brandName} password`,
    eyebrow: "Password setup",
    title: `Set your ${identity.brandName} password`,
    intro:
      "Use this verified email link to set a password for your account. This link expires in 15 minutes.",
    ctaLabel: "Set my password",
    ctaUrl: setUrl,
    safety:
      "If you did not request this, you can safely ignore this email and your account is unchanged.",
  });
}

export function renderVerifyEmail(identity: EmailIdentity, verifyUrl: string): RenderedEmail {
  return renderLayout({
    identity,
    subject: `Verify your ${identity.brandName} account`,
    eyebrow: "Email verification",
    title: `Verify your ${identity.brandName} account`,
    intro:
      "Click the link below to verify your email and activate your account. This link expires in 15 minutes.",
    ctaLabel: "Verify email",
    ctaUrl: verifyUrl,
    safety:
      "If you did not create this account, you can safely ignore this email.",
  });
}

export function renderMagicLinkEmail(identity: EmailIdentity, verifyUrl: string): RenderedEmail {
  return renderLayout({
    identity,
    subject: `Sign in to ${identity.brandName}`,
    eyebrow: "Sign-in link",
    title: `Sign in to ${identity.brandName}`,
    intro: "Click the link below to sign in. This link expires in 15 minutes.",
    ctaLabel: `Sign in to ${identity.brandName}`,
    ctaUrl: verifyUrl,
    safety:
      "If you did not request this, you can safely ignore this email.",
  });
}

// Every account-existence-branching response takes this long, no more and no
// less. A floor alone is not enough: if the provider round-trip could overrun
// it, the sending path would finish later than the non-sending path and the
// difference would enumerate accounts again. So callers derive the send's
// budget from the time remaining until the deadline (sendBudgetFor) and then
// pad back up to it (settleAfter) — a ceiling and a floor.
export const AUTH_RESPONSE_FLOOR_MS = 1500;

// A backstop against a hung provider stalling the invocation to the Lambda
// timeout (which would return a 504). It is deliberately far above the p99
// send so it never trims a healthy request: it is a liveness guard, NOT part
// of the timing defence. Deriving the send's budget from the response
// deadline was tried and reverted — on a cold start the pre-send work can eat
// most of the floor, leaving too little for DNS + TLS + HTTP to the provider,
// which silently dropped exactly the cold-start mail real users depend on.
export const EMAIL_SEND_HARD_CAP_MS = 10_000;

// Only tests may shrink the floor, and only to a finite number — a typo'd or
// malformed env var must not silently switch the enumeration defence off.
export function authResponseFloorMs(): number {
  if (process.env.NODE_ENV === "test") {
    const override = Number(process.env.ENGRAM_AUTH_RESPONSE_FLOOR_MS ?? 0);
    return Number.isFinite(override) ? override : AUTH_RESPONSE_FLOOR_MS;
  }
  return AUTH_RESPONSE_FLOOR_MS;
}

// Pads a response to a fixed wall-clock floor. Unknown-account paths do no
// email work and would otherwise return measurably faster than the paths that
// do — that difference is an account-enumeration oracle (audit N-2).
export async function settleAfter(startedAt: number, floorMs?: number): Promise<void> {
  const remaining = (floorMs ?? authResponseFloorMs()) - (Date.now() - startedAt);
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

// Must be awaited by callers. On Lambda the execution environment is frozen as
// soon as the response is returned, so a floating promise here is never
// delivered — the send is silently dropped with no error and no log.
export async function sendEmailBestEffort(payload: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from?: string;
  budgetMs?: number;
}): Promise<void> {
  const budgetMs = payload.budgetMs ?? EMAIL_SEND_HARD_CAP_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const suppression = await getEmailSuppression(payload.to);
    if (suppression) {
      console.warn("Suppressed email send skipped:", formatSuppressionForLog(suppression));
      return;
    }

    const send = getResend().emails.send({
      from: payload.from || getEmailFrom(),
      to: payload.to,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
    });
    const budget = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), budgetMs);
    });

    const result = await Promise.race([send, budget]);
    if (result === "timeout") {
      console.error(`Email send exceeded ${budgetMs}ms budget; abandoned:`, payload.subject);
      return;
    }
    if (result?.error) {
      console.error("Email send failed:", result.error);
    }
  } catch (error) {
    console.error("Failed to send email:", error);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function sendEmailRequired(payload: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from?: string;
}): Promise<void> {
  const suppression = await getEmailSuppression(payload.to);
  if (suppression) {
    console.warn("Suppressed required email blocked:", formatSuppressionForLog(suppression));
    throw new Error(`Email address is suppressed: ${suppression.reason}`);
  }

  const result = await getResend().emails.send({
    from: payload.from || getEmailFrom(),
    to: payload.to,
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
  });
  if (result?.error) {
    throw new Error(`Email send failed: ${result.error.message}`);
  }
}
