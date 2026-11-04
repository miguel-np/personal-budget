---
name: wealth-review
description: Review Personal Budget net-worth totals and their coverage status, including stale or missing valuations.
---

# Wealth review

Use `get_net_worth_summary`.

## Procedure

1. Read the valuation date, display currency and completeness status.
2. Report actual-account and external-asset/liability components separately.
3. Review coverage counts and warnings for unclassified accounts, unconvertible balances, stale assets and missing valuations.
4. Report a consolidated net worth only when the API marks the summary complete and supplies a non-null total.
5. Identify valuations or classifications the user may need to update.

## Constraints

- If the consolidated total is unavailable, do not derive a substitute from incomplete components.
- Do not infer market value, investment performance, tax treatment or liquidity guarantees.
- Do not recommend buying, selling or reallocating investments.
- Do not edit assets, valuations or account classifications.
