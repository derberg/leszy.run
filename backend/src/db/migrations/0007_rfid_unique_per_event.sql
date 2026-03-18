ALTER TABLE "participants" DROP CONSTRAINT IF EXISTS "participants_rfid_epc_unique";
--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_event_id_rfid_epc_unique" UNIQUE("event_id","rfid_epc");
