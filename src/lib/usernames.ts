import { prisma } from "@/lib/prisma";

const USERNAME_MAX_LENGTH = 32;

function normalizeUsernameCandidate(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");

  return normalized || "user";
}

export async function generateUniqueUsername(email: string): Promise<string> {
  const localPart = email.split("@")[0] || "user";
  const baseUsername = normalizeUsernameCandidate(localPart).slice(0, USERNAME_MAX_LENGTH) || "user";

  let attempt = 0;
  while (attempt < 100) {
    const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
    const maxBaseLength = USERNAME_MAX_LENGTH - suffix.length;
    const username = `${baseUsername.slice(0, Math.max(maxBaseLength, 1))}${suffix}`;
    const existingUser = await prisma.user.findFirst({
      where: { username },
      select: { id: true },
    });

    if (!existingUser) {
      return username;
    }

    attempt += 1;
  }

  throw new Error("Failed to generate a unique username.");
}
