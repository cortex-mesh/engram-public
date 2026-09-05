export function buildSetPasswordUrl(origin: string, token: string, clientId: string | null | undefined): string {
  const params = new URLSearchParams({ token });
  if (clientId) {
    params.set("client_id", clientId);
  }
  return `${origin}/set-password?${params.toString()}`;
}
