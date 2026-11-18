# DataX read-only integration

ETI provides an authenticated, read-only DataX intelligence view:

- Page: `/datax`
- API: `GET /api/datax/summary`
- DataX source endpoint: `GET /api/integrations/eti/summary`

The ETI Worker signs each request with HMAC-SHA256. The canonical message is:

```text
<unix-seconds>
<unique-nonce>
GET
/api/integrations/eti/summary
```

The same secret must be configured in both applications. The browser never receives this secret.

## Configure ETI

1. Set the Worker variable `DATAX_API_URL` to the DataX HTTPS origin only, such as `https://datax.pages.dev`.
2. Set the Worker secret with `npx wrangler secret put DATAX_INTEGRATION_SECRET`.
3. Set the matching DataX Pages secret as described in DataX's `docs/ETI_INTEGRATION.md`.
4. Deploy ETI and DataX, apply DataX migration 0006, sign in to ETI and open `/datax`.

## Isolation

The integration does not bind DataX D1 to ETI, copy member identities, import DTX wallet balances into ETI, or create a trading deposit. It cannot place orders, change risk limits, mutate ETI portfolio records or trigger redemptions. An unavailable DataX service returns a bounded error and does not interrupt ETI's trading services.

All imported amounts are source-reported aggregates. A reported reserve is not independently proven cash custody, and DTX reference value is not a guarantee of redemption.
