import bcrypt from "bcryptjs";

const SALT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// Static cost-12 hash of a random throwaway value. Login compares against
// this when the account doesn't exist (or has no password) so the
// unknown-account path costs the same ~250ms bcrypt as a real wrong
// password — otherwise response timing is an account-enumeration oracle.
const DUMMY_PASSWORD_HASH =
  "$2b$12$.zyGuSXvfXW7jxnlFyRE6OwnF87cWCOmBJQak7zimoptc0rFsNAyq";

export async function burnPasswordVerification(password: string): Promise<void> {
  await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
}
