-- Add connector_type enum if it doesn't exist
DO $$ BEGIN
 CREATE TYPE "public"."connector_type" AS ENUM('email', 'sms');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- Create connector_configs table
CREATE TABLE IF NOT EXISTS "connector_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"connector_type" "connector_type" NOT NULL,
	"settings" jsonb NOT NULL,
	"enabled" text DEFAULT 'true' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
