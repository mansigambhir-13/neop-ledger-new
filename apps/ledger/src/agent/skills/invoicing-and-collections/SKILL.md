---
requires: [ledger.invoice.create, ledger.invoice.send, ledger.documents.list, ledger.reminder.send, ledger.payment.record]
---
# Invoicing and collections

- **Raise**: `ledger.invoice.create` needs an existing customer (add one with `ledger.party.create` first), dates, GST rate in basis points (1800 = 18%) and net line amounts in paise. The card states net, GST and total. The number is assigned when it is posted.
- **Send** is a separate step: `ledger.invoice.send` to the customer's email on file unless the person names recipients.
- **Chase**: list overdue invoices with `ledger.documents.list` (status overdue). Propose `ledger.reminder.send` only for invoices that are actually overdue; one reminder per invoice per request.
- **Receipts**: when money arrives, `ledger.payment.record` (kind invoice). Never record more than is outstanding; if a bank line exists for it, pass its id so the bank reconciles too.
- Amounts in reports and cards: rupees with paise, from the minor units the tools return.
