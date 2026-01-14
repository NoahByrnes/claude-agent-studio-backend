CREATE TABLE IF NOT EXISTS "conductor_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conductor_id" varchar(255) NOT NULL,
	"memory_data" text NOT NULL,
	"size_bytes" varchar(50) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "conductor_memory_conductor_id_unique" UNIQUE("conductor_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conductor_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conductor_id" varchar(255) NOT NULL,
	"sandbox_id" varchar(255) NOT NULL,
	"session_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_activity_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	CONSTRAINT "conductor_sessions_conductor_id_unique" UNIQUE("conductor_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "template_configurations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"config_key" varchar(50) DEFAULT 'default' NOT NULL,
	"conductor_template" varchar(255) NOT NULL,
	"worker_template" varchar(255) NOT NULL,
	"infrastructure_template" varchar(255) NOT NULL,
	"updated_by" varchar(100) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "template_configurations_config_key_unique" UNIQUE("config_key")
);
