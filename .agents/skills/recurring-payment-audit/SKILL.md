---
name: recurring-payment-audit
description: Review historical recurring-payment candidates from Personal Budget without claiming that a subscription or future charge is confirmed.
---

# Recurring-payment audit

Use `get_recurring_candidates` over an explicit historical period.

## Procedure

1. Confirm the historical start and end dates.
2. Group returned candidates by payee, observed occurrences, estimated interval, amount variability and last observed date.
3. Prioritize candidates for manual verification using recency, repetition and consistency.
4. Explain the evidence and the warning attached to each candidate.
5. Suggest checking the merchant, bank statement or contract before making a decision.

## Constraints

- Do not label a candidate as a confirmed subscription.
- Do not assume the next payment will occur.
- Do not recommend cancellation solely from the detected pattern.
- Do not edit transaction categories or recurring commitments.
