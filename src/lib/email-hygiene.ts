import { promises as dns } from "node:dns";
import { readFileSync } from "node:fs";

export type EmailHygieneResult =
  | { status: "accepted"; reason: null }
  | { status: "rejected_disposable"; reason: string }
  | { status: "rejected_no_dns"; reason: string };

const DNS_LOOKUP_TIMEOUT_MS = 1_200;
let disposableDomains: Set<string> | null = null;

function getDisposableDomains(): Set<string> {
  if (disposableDomains) return disposableDomains;
  const source = readFileSync(new URL("../data/disposable-email-domains.txt", import.meta.url), "utf8");
  disposableDomains = new Set(
    source
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line && !line.startsWith("#")),
  );
  return disposableDomains;
}

export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

function isDnsTransient(error: unknown): boolean {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
  return code === "ETIMEOUT" || code === "ESERVFAIL" || code === "EAI_AGAIN" || code === "ECONNREFUSED";
}

async function withDnsTimeout<T>(lookup: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookup,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error("DNS lookup timed out"), { code: "ETIMEOUT" })),
          DNS_LOOKUP_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function hasAddressFallback(domain: string): Promise<boolean | "unknown"> {
  try {
    const records = await withDnsTimeout(dns.resolve4(domain));
    if (records.length > 0) return true;
  } catch (error) {
    if (isDnsTransient(error)) return "unknown";
  }

  try {
    const records = await withDnsTimeout(dns.resolve6(domain));
    if (records.length > 0) return true;
  } catch (error) {
    if (isDnsTransient(error)) return "unknown";
  }

  return false;
}

export async function validateSignupEmail(email: string): Promise<EmailHygieneResult> {
  const domain = emailDomain(email);
  if (!domain) {
    return { status: "rejected_no_dns", reason: "Email domain is missing." };
  }

  if (getDisposableDomains().has(domain)) {
    return { status: "rejected_disposable", reason: `${domain} is a disposable email domain.` };
  }

  try {
    const mx = await withDnsTimeout(dns.resolveMx(domain));
    if (mx.length > 0) {
      return { status: "accepted", reason: null };
    }
  } catch (error) {
    if (isDnsTransient(error)) {
      console.warn("Email domain DNS check failed open:", { domain, error });
      return { status: "accepted", reason: null };
    }
  }

  const fallback = await hasAddressFallback(domain);
  if (fallback === true || fallback === "unknown") {
    if (fallback === "unknown") {
      console.warn("Email domain address fallback check failed open:", { domain });
    }
    return { status: "accepted", reason: null };
  }

  return { status: "rejected_no_dns", reason: `${domain} has no MX record and no address fallback.` };
}
