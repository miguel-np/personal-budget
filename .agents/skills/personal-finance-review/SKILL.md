---
name: personal-finance-review
description: Review an explicit personal-finance period using Personal Budget's deterministic summaries and evidence-backed findings. Use when the user asks for a weekly/monthly financial review or period comparison.
---

# Personal finance review

Use Personal Budget as the source of truth. Prefer MCP tools `compare_periods`, `get_financial_findings` and `get_spending_by_category`.

## Procedure

1. Confirm the exact current and comparison date ranges. Do not assume partial months are complete.
2. Retrieve deterministic summaries and findings for those ranges.
3. Report income, spending, net savings and category changes only from tool results.
4. Separate observed results from estimates, recurring candidates and recommendations.
5. Explain each material finding with its evidence, rule and limitations.
6. End with a short list of review actions; do not change budgets or transactions.

## Constraints

- Never infer causes from a spending change unless the evidence establishes them.
- Never treat a dismissal rate as detector accuracy.
- Never add incompatible currencies or convert missing values to zero.
- Do not expose account identifiers or transaction descriptions unnecessarily.
- Do not present the output as regulated financial advice.
