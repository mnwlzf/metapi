DROP INDEX IF EXISTS "site_disabled_models_site_account_model_unique";
ALTER TABLE "probe_logs" ADD COLUMN "token_id" INTEGER REFERENCES "account_tokens"("id") ON DELETE SET NULL;
ALTER TABLE "probe_logs" ADD COLUMN "run_id" TEXT;
ALTER TABLE "probe_logs" ADD COLUMN "estimated_cost" DOUBLE PRECISION;
ALTER TABLE "site_disabled_models" ADD COLUMN "token_id" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "site_disabled_models_site_account_token_model_unique" ON "site_disabled_models" ("site_id", "account_id", "token_id", "model_name");
CREATE INDEX "probe_logs_run_idx" ON "probe_logs" ("run_id");
CREATE INDEX "probe_logs_token_created_at_idx" ON "probe_logs" ("token_id", "created_at");
