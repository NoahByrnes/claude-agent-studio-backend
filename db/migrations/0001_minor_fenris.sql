ALTER TYPE "connector_type" ADD VALUE 'google_workspace';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "google_email_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"thread_id" text NOT NULL,
	"subject" text,
	"participants" jsonb NOT NULL,
	"last_message_at" timestamp NOT NULL,
	"worker_id" text,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "google_email_threads_thread_id_unique" UNIQUE("thread_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "google_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"event_type" varchar(50) NOT NULL,
	"resource_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"processed" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "google_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"resource_type" varchar(50) NOT NULL,
	"resource_id" text NOT NULL,
	"permission_scope" varchar(50) NOT NULL,
	"granted_by" varchar(50) NOT NULL,
	"granted_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp,
	"context" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "google_watched_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"resource_type" varchar(50) NOT NULL,
	"resource_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"channel_token" text NOT NULL,
	"expiration" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
