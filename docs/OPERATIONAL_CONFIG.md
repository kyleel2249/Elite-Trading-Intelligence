# ETI operational configuration

ETI's operational monitoring defaults are version-controlled in `worker/operational-config.ts`.
They do not need six separate Cloudflare Runtime Variables and work on the Workers Free plan.

Defaults:
- MTM: 60 seconds
- Internal portfolio reconciliation: 120 seconds
- Investor monitoring snapshot: 1800 seconds
- Maximum accepted market-data age: 300 seconds
- Require fresh data for live orders: enabled as a policy setting
- Reporting timezone: Africa/Accra

All timestamps remain UTC in storage. Investor monitoring snapshots include a localized display timestamp.
The optional `ETI_OPERATIONAL_CONFIG` single JSON binding is supported for future operator overrides, but is not required.

The scheduled monitor currently updates the ETI internal-paper ledger and checks its own event/fill consistency.
This is not an exchange-account reconciliation and must not be represented as one. Exchange account verification remains
separate and requires supported venue credentials and a complete exchange snapshot.

The current multi-agent scheduled autopilot remains internal-paper only. The freshness policy does not activate live
execution or bypass the existing execution, authentication, risk, or kill-switch controls.
