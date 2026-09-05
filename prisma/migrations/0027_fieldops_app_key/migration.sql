-- FieldOps: add the `fieldops` AppKey enum value so the fieldops-web native
-- client (registered in 0026) can be bound to an app in
-- NATIVE_CLIENT_APP_BINDINGS and pass /authorize's app validation.
-- Additive enum value only — no data loss, so the suite migration-guard
-- auto-passes (cortex ADR-128).
ALTER TYPE "AppKey" ADD VALUE IF NOT EXISTS 'fieldops';
