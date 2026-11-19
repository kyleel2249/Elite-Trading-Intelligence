# ETI MetaTrader 5: Windows PC bridge

ETI's Cloudflare Worker remains the public dashboard and analytics host. MT5 itself runs on the user's Windows PC because the official MetaTrader5 Python integration requires a supported local Windows terminal environment.

## Current delivery

The `mt5-bridge/` directory provides a loopback-only Windows service. It supports demo and live account authentication, account/symbol/tick/position/order/deal snapshots and guarded market/pending order execution. Credentials stay on the Windows machine and are not accepted by ETI's public Worker.

## Bring-up

Follow [the bridge README](../mt5-bridge/README.md). Keep live trading disabled while validating the demo account, broker symbol naming, volume steps, filling modes, and SL/TP behavior.

## Integration status

The local adapter is implemented as a separately hosted connector. Cloud-to-PC pairing, cloud account persistence and the integrated ETI terminal account UI are not included in this delivery. They require a signed outbound bridge session and a durable command queue; do not tunnel or publicly expose the local HTTP service as a shortcut.
