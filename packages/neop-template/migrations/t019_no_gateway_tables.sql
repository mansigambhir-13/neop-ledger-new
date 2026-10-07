-- t019 · template upgrade stream. V3-MIGRATION-PLAN S9 "delete the gateway".
-- contract: drop seen_tokens and outbox_acked, which only the deleted L3 surface wrote or read; expanded by t012_presence.sql (the app's own presence and its mirror cursor, presence_mirror, replaced the gateway's single-use tokens and the platform's outbox acknowledgements)
--   · seen_tokens  — the jti of every gateway token L3 accepted (single use, kept five minutes past expiry). No gateway
--                    token exists any more: nothing reaches this app over HTTP except the homeserver's appservice push
--                    (hs_token) and a person's signed download link (the files listener).
--   · outbox_acked — one row: how far the platform's outbox consumer had applied the outbox. The consumer is gone; the
--                    outbox is read only by this app's presence mirror (presence_mirror cursors, per company), which is
--                    what the runner's prune now waits for.
-- Neither holds a business row, a person's word or anything the desk reads: expired token ids and a cursor. Nothing
-- still read is lost (apps/ledger/tests/desk-no-gateway.test.ts › t019 proves it on a populated book).

drop table {{schema}}.seen_tokens;
drop table {{schema}}.outbox_acked;
