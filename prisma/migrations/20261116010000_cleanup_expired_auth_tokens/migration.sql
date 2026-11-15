-- Add indexed expiry lookups for bounded cleanup of authentication records.
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

CREATE INDEX "refresh_tokens_expiresAt_idx" ON "refresh_tokens"("expiresAt");
