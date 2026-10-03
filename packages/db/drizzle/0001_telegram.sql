CREATE TABLE "account_auth" (
	"account_id" uuid NOT NULL,
	"dc_id" integer NOT NULL,
	"auth_key_enc" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_auth_account_id_dc_id_pk" PRIMARY KEY("account_id","dc_id")
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tg_user_id" bigint NOT NULL,
	"phone" text,
	"username" text,
	"first_name" text,
	"last_name" text,
	"is_premium" boolean DEFAULT false NOT NULL,
	"dc_id" integer,
	"label" text,
	"note" text,
	"source" text NOT NULL,
	"client_profile" text NOT NULL,
	"device" jsonb NOT NULL,
	"connection_mode" text NOT NULL,
	"proxy_id" uuid,
	"status" text DEFAULT 'pending_check' NOT NULL,
	"status_reason" text,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_ok_at" timestamp with time zone,
	"frozen_until" timestamp with time zone,
	"session_import_enc" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "code_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"tg_message_id" integer NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"text" text NOT NULL,
	"code" text,
	"notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_id" uuid,
	"filename" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"path_in_archive" text NOT NULL,
	"account_index" integer NOT NULL,
	"tg_user_id" bigint NOT NULL,
	"dc_id" integer NOT NULL,
	"session_enc" text NOT NULL,
	"duplicate_of" uuid,
	"decision" text DEFAULT 'pending' NOT NULL,
	"account_id" uuid,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "proxies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"external_id" text,
	"type" text NOT NULL,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"username" text,
	"password_enc" text,
	"tag" text,
	"status" text DEFAULT 'unchecked' NOT NULL,
	"last_check_at" timestamp with time zone,
	"last_ok_at" timestamp with time zone,
	"latency_ms" integer,
	"tg_country" text,
	"last_error" text,
	"fail_streak" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"expiry_warned_at" timestamp with time zone,
	"provider_meta" jsonb,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proxies_endpoint_key" UNIQUE NULLS NOT DISTINCT("type","host","port","username")
);
--> statement-breakpoint
ALTER TABLE "account_auth" ADD CONSTRAINT "account_auth_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_proxy_id_proxies_id_fk" FOREIGN KEY ("proxy_id") REFERENCES "public"."proxies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_messages" ADD CONSTRAINT "code_messages_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_duplicate_of_accounts_id_fk" FOREIGN KEY ("duplicate_of") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_tg_user_id_key" ON "accounts" USING btree ("tg_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_proxy_id_key" ON "accounts" USING btree ("proxy_id");--> statement-breakpoint
CREATE INDEX "accounts_status_idx" ON "accounts" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "code_messages_account_message_key" ON "code_messages" USING btree ("account_id","tg_message_id");--> statement-breakpoint
CREATE INDEX "code_messages_date_idx" ON "code_messages" USING btree ("date");--> statement-breakpoint
CREATE INDEX "import_items_batch_id_idx" ON "import_items" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "proxies_source_external_key" ON "proxies" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "proxies_status_idx" ON "proxies" USING btree ("status");