DROP INDEX "accounts_proxy_id_key";--> statement-breakpoint
CREATE INDEX "accounts_proxy_id_idx" ON "accounts" USING btree ("proxy_id");