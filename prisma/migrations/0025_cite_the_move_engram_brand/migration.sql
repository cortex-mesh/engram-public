-- Cite the Move is the public presentation for the existing axon-web
-- first-party PKCE client. Keep clientId, the axon app binding, redirect URIs,
-- enabled state, providers, and waitlist policy unchanged.
--
-- EMAIL_FROM remains the verified sender address until a separately approved
-- Cite the Move sender domain is configured. The display/from name lets the
-- confirmation and approval templates identify the product truthfully now.
UPDATE "NativeAuthClient"
SET
  "displayName" = 'Cite the Move',
  "brandName" = 'Cite the Move',
  "emailFromName" = 'Cite the Move',
  "updatedAt" = NOW()
WHERE "clientId" = 'axon-web';
