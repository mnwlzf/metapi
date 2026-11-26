-- Probe verdicts become per-token: a model is served by the token's upstream
-- group, so a disable written from one key's answer must not apply to the
-- account's other keys. 0 = whole account (rows written before this change).
ALTER TABLE site_disabled_models ADD COLUMN token_id integer NOT NULL DEFAULT 0;
--> statement-breakpoint
-- The old uniqueness ignored token_id and would forbid two keys of one account
-- from having independent verdicts for the same model.
DROP INDEX IF EXISTS site_disabled_models_site_account_model_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS site_disabled_models_site_account_token_model_unique
  ON site_disabled_models (site_id, account_id, token_id, model_name);
--> statement-breakpoint
-- Probe logs gain the key that was probed, the run (batch) they belong to, and
-- what the single probe cost: every probe is a real billed upstream call.
ALTER TABLE probe_logs ADD COLUMN token_id integer REFERENCES account_tokens(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE probe_logs ADD COLUMN run_id text;
--> statement-breakpoint
ALTER TABLE probe_logs ADD COLUMN estimated_cost real;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS probe_logs_token_created_at_idx ON probe_logs (token_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS probe_logs_run_idx ON probe_logs (run_id);
