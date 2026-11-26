DROP INDEX `site_disabled_models_site_account_model_unique` ON `site_disabled_models`;
ALTER TABLE `probe_logs` ADD COLUMN `token_id` INT;
ALTER TABLE `probe_logs` ADD COLUMN `run_id` TEXT;
ALTER TABLE `probe_logs` ADD COLUMN `estimated_cost` DOUBLE;
ALTER TABLE `site_disabled_models` ADD COLUMN `token_id` INT NOT NULL DEFAULT 0;
ALTER TABLE `probe_logs` ADD CONSTRAINT `probe_logs_token_id_fk` FOREIGN KEY (`token_id`) REFERENCES `account_tokens`(`id`) ON DELETE SET NULL;
CREATE UNIQUE INDEX `site_disabled_models_site_account_token_model_unique` ON `site_disabled_models` (`site_id`, `account_id`, `token_id`, `model_name`(191));
CREATE INDEX `probe_logs_run_idx` ON `probe_logs` (`run_id`(191));
CREATE INDEX `probe_logs_token_created_at_idx` ON `probe_logs` (`token_id`, `created_at`);
