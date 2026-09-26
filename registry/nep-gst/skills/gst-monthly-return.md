---
requires: [ledger.report.vat_summary, gst.gstr3b.prepare, gst.gstr3b.file]
---
# Monthly GSTR-3B

1. Read the month's tax from the books with `ledger.report.vat_summary` (from the 1st to the last day of the month).
2. Prepare the draft with `gst.gstr3b.prepare` using the output and input tax exactly as the summary returned them.
3. Propose `gst.gstr3b.file` for the month. The card says the net payable (or the credit carried forward) and that filing is binding.
4. When woken with DONE, report the portal acknowledgement from the proof.
