--> statement-breakpoint
CREATE TABLE "events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "date" text,
  "location" text,
  "rfid_mode" text DEFAULT 'single' NOT NULL,
  "rfid_topic_main" text DEFAULT 'leszyrun' NOT NULL,
  "rfid_topic_finish" text DEFAULT 'leszyrun/finish' NOT NULL,
  "rssi_threshold" integer DEFAULT -5000 NOT NULL,
  "lockout_seconds" integer DEFAULT 60 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  "synced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "categories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "event_id" uuid NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "distance_meters" integer,
  "created_at" timestamp with time zone DEFAULT now(),
  "synced_at" timestamp with time zone,
  CONSTRAINT "categories_event_id_slug_unique" UNIQUE("event_id","slug")
);
--> statement-breakpoint
CREATE TABLE "participants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "event_id" uuid NOT NULL,
  "category_id" uuid,
  "first_name" text NOT NULL,
  "last_name" text NOT NULL,
  "email" text,
  "gender" text,
  "birth_year" integer,
  "club" text,
  "bib_number" integer,
  "rfid_epc" text,
  "checked_in" boolean DEFAULT false NOT NULL,
  "checked_in_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now(),
  "synced_at" timestamp with time zone,
  CONSTRAINT "participants_rfid_epc_unique" UNIQUE("rfid_epc"),
  CONSTRAINT "participants_event_id_bib_number_unique" UNIQUE("event_id","bib_number")
);
--> statement-breakpoint
CREATE TABLE "race_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "category_id" uuid NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "status" text DEFAULT 'pending' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  "synced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "gate_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "race_run_id" uuid,
  "topic" text NOT NULL,
  "epc" text NOT NULL,
  "antenna_port" integer NOT NULL,
  "rssi_cdbm" integer NOT NULL,
  "frequency" integer,
  "raw" jsonb NOT NULL,
  "received_at" timestamp with time zone NOT NULL,
  "crossing_id" uuid
);
--> statement-breakpoint
CREATE TABLE "gate_crossings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "race_run_id" uuid NOT NULL,
  "participant_id" uuid NOT NULL,
  "gate" text NOT NULL,
  "crossing_number" integer NOT NULL,
  "confirmed_at" timestamp with time zone NOT NULL,
  "peak_rssi_cdbm" integer,
  "antenna_port" integer,
  "synced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "results" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "race_run_id" uuid NOT NULL,
  "participant_id" uuid NOT NULL,
  "start_time" timestamp with time zone,
  "finish_time" timestamp with time zone,
  "duration_ms" bigint,
  "start_crossing_id" uuid,
  "finish_crossing_id" uuid,
  "position" integer,
  "status" text DEFAULT 'registered' NOT NULL,
  "status_note" text,
  "manual_override" boolean DEFAULT false NOT NULL,
  "synced_at" timestamp with time zone,
  CONSTRAINT "results_race_run_id_participant_id_unique" UNIQUE("race_run_id","participant_id")
);
--> statement-breakpoint
CREATE TABLE "checkpoint_imports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "race_run_id" uuid NOT NULL,
  "label" text NOT NULL,
  "imported_at" timestamp with time zone DEFAULT now(),
  "file_name" text
);
--> statement-breakpoint
CREATE TABLE "checkpoint_readings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "import_id" uuid NOT NULL,
  "epc" text NOT NULL,
  "participant_id" uuid,
  "recorded_at" timestamp with time zone NOT NULL,
  "rssi_cdbm" integer
);
--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "race_runs" ADD CONSTRAINT "race_runs_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gate_events" ADD CONSTRAINT "gate_events_race_run_id_race_runs_id_fk" FOREIGN KEY ("race_run_id") REFERENCES "public"."race_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gate_crossings" ADD CONSTRAINT "gate_crossings_race_run_id_race_runs_id_fk" FOREIGN KEY ("race_run_id") REFERENCES "public"."race_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gate_crossings" ADD CONSTRAINT "gate_crossings_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_race_run_id_race_runs_id_fk" FOREIGN KEY ("race_run_id") REFERENCES "public"."race_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "checkpoint_imports" ADD CONSTRAINT "checkpoint_imports_race_run_id_race_runs_id_fk" FOREIGN KEY ("race_run_id") REFERENCES "public"."race_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "checkpoint_readings" ADD CONSTRAINT "checkpoint_readings_import_id_checkpoint_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."checkpoint_imports"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "checkpoint_readings" ADD CONSTRAINT "checkpoint_readings_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "gate_events_epc_idx" ON "gate_events" ("epc");
--> statement-breakpoint
CREATE INDEX "gate_events_received_at_idx" ON "gate_events" ("received_at");
--> statement-breakpoint
CREATE INDEX "results_race_run_id_idx" ON "results" ("race_run_id");
--> statement-breakpoint
CREATE INDEX "results_position_idx" ON "results" ("race_run_id", "position");
