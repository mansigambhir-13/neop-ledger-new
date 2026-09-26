---
requires: [ledger.settings.get, ledger.opening_balances.set, ledger.account.create]
---
# Company setup

1. Read `ledger.settings.get` first. Settings are presentation and policy (tax regime, aging buckets, forecast horizon, cash buffer, chase interval); change them with `ledger.settings.update` only as the person says, and show old → new.
2. Opening balances: read the chart (`ledger.accounts.list`), map the person's plain words to account codes yourself ("in the bank" → the bank account, "customers owe us" → receivable, "we owe suppliers" → payable), and propose `ledger.opening_balances.set` dated on or before the first entry. Amounts are positive on the account's natural side; the difference goes to equity. It can be set once; later corrections are journal entries.
3. A new account: propose `ledger.account.create` with the name and type the person gave; leave the code out unless they named one — Ledger picks the next free code in the type's range and the card shows it. Choose the subtype that reports correctly (stock bought to resell is `cogs`, a laptop is `fixed_asset`) and say which you chose.
