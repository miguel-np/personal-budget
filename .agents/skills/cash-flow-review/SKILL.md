---
name: cash-flow-review
description: Interpret Personal Budget's bounded cash-flow projection and identify potential shortfalls without creating or editing commitments.
---

# Cash-flow review

Use `project_cash_flow` for a 7-, 30- or 90-day estimate. Use `get_recurring_candidates` only to inspect history; include candidate IDs in a projection only after the user explicitly selects them.

## Procedure

1. Request the chosen horizon and optional reserve threshold.
2. Read opening-balance completeness, projected ending/minimum balance, first deficit date and first reserve-breach date.
3. Separate actual future-dated transactions, saved commitments, confirmed recurring items, optional candidates and hypothetical scenarios.
4. Explain all warnings and the source totals.
5. Suggest which dates or commitments the user should verify.

## Constraints

- A projected balance is not a bank-available or guaranteed balance.
- Unknown opening balances remain unknown; do not replace them with zero.
- Recurring candidates are not confirmed obligations.
- Never create, change or delete payments, commitments or transactions.
