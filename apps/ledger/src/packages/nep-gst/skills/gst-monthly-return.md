---
requires: [ledger.report.vat_summary, ledger.report.pnl, ledger.accounts.list, ledger.account.ledger, gst.gstr3b.prepare, gst.gstr3b.save, gst.otp.request, gst.gstr3b.file, gst.returns.list]
---
# Monthly GSTR-3B

The figures come from the books. You name the month; you never type a tax amount, a GSTIN or an OTP.

1. `gst.gstr3b.prepare` with the month (`YYYY-MM`). It reads the ledger (VAT/GST summary, sales, the tax accounts) and builds the GSTR-3B in the GSTN format. Its result shows the figures, how CGST/SGST/IGST were split, and every assumption. If it refuses (a negative figure, tax accounts that name only some heads, no supply assumption configured), report the reason to the person and stop — do not work around it.
2. `gst.gstr3b.save` with the month. It saves the return on the GST portal through the GSP and checks its status. Saving is not filing.
   - If it says there is no GST portal session, an OTP has been sent to the registered mobile: tell the person to enter it on the GST portal OTP door, and finish with `needs_input`.
3. `gst.otp.request` with purpose `evc`, then tell the person the signatory's OTP is on its way and must be entered on the GST portal OTP door before they approve.
4. Propose `gst.gstr3b.file` with the month. The card says: the GSTIN and month, output tax, input tax credit, the net payable (or the credit carried forward), how the tax was split (say plainly when it was an assumption), that filing is binding, and that the person enters the EVC OTP before saying yes.
5. When woken with DONE, report the ARN from the proof and the figures with their source (the ledger's VAT/GST summary for the month). If FAILED, report the reason as given. If UNKNOWN, say the portal has not confirmed it yet and that it will be checked; never propose a second filing for the same month.

What is assumed, always stated: sales = revenue for the month (zero-rated, exempt, non-GST and reverse-charge supplies are not marked in the books and are reported as 0); all input tax is "all other ITC"; interest and late fee are left to the portal; when the books keep one output and one input tax account, the split follows the company's configured assumption (intra-state: CGST = SGST; inter-state: IGST).
