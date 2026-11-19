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

The scheduled monitor updates the ETI internal-paper ledger and checks its event/fill consistency. When both
Bybit and Bitget read-only API credentials are configured, the same 120-second reconciliation job also runs the
existing cross-exchange snapshot comparison against the exchange-testnet ledger and persists the latest result.
If either venue's credentials are absent, the exchange comparison is explicitly marked as skipped; incomplete or
stale venue data is never reported as a successful reconciliation.

The current multi-agent scheduled autopilot remains internal-paper only. The freshness policy does not activate live
execution or bypass the existing execution, authentication, risk, or kill-switch controls.

Bitget live-order freshness gate: when fresh data is required, the order request must include
`referencePriceTimestamp` in Unix milliseconds (Unix seconds are also accepted). The caller must
populate it from the original exchange market-data event timestamp, not from the time the order is
constructed. The Worker rejects missing, future, or older-than-configured timestamps before contacting
Bitget. This timestamp check is a freshness assertion, not cryptographic proof of the upstream feed.
