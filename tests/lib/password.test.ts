import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '@/lib/password';

describe('password', () => {
  it('hashPassword returns a bcrypt hash starting with $2b$12$', async () => {
    const hash = await hashPassword('testpassword');
    expect(hash).toMatch(/^\$2b\$12\$/);
  });

  it('verifyPassword returns true for correct password', async () => {
    const hash = await hashPassword('correctpassword');
    const result = await verifyPassword('correctpassword', hash);
    expect(result).toBe(true);
  });

  it('verifyPassword returns false for wrong password', async () => {
    const hash = await hashPassword('correctpassword');
    const result = await verifyPassword('wrongpassword', hash);
    expect(result).toBe(false);
  });

  it('hashPassword produces different hashes for same input (salt)', async () => {
    const hash1 = await hashPassword('samepassword');
    const hash2 = await hashPassword('samepassword');
    expect(hash1).not.toBe(hash2);
  });

  it('handles passwords at bcrypt 72-char limit', async () => {
    const longPassword = 'a'.repeat(72);
    const hash = await hashPassword(longPassword);
    expect(hash).toMatch(/^\$2b\$12\$/);
    const result = await verifyPassword(longPassword, hash);
    expect(result).toBe(true);
  });

  it('bcrypt silently truncates passwords > 72 chars', async () => {
    const base = 'a'.repeat(72);
    const longer = base + 'extra';
    const hash = await hashPassword(base);
    // bcrypt truncates at 72, so 'base' and 'longer' produce same comparison
    const result = await verifyPassword(longer, hash);
    expect(result).toBe(true);
  });
});
