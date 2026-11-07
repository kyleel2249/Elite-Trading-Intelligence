import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  ETI_CONTAINER: DurableObjectNamespace<EtiContainer>;
  SECRET_KEY?: string;
  API_KEY?: string;
  DATABASE_URL?: string;
  ALPACA_API_KEY?: string;
  ALPACA_SECRET_KEY?: string;
  BINANCE_API_KEY?: string;
  BINANCE_SECRET_KEY?: string;
  FRED_API_KEY?: string;
  NEWSAPI_KEY?: string;
  QUIVER_API_KEY?: string;
  LIQUID_API_KEY?: string;
  LIQUID_API_BASE_URL?: string;
  ALPACA_BASE_URL?: string;
  NEWS_API_KEY?: string;
}

// Secrets are set with `wrangler secret put NAME` and forwarded server-side only.
const FORWARDED = [
  "SECRET_KEY", "API_KEY", "DATABASE_URL", "ALPACA_API_KEY", "ALPACA_SECRET_KEY",
  "BINANCE_API_KEY", "BINANCE_SECRET_KEY", "FRED_API_KEY", "NEWSAPI_KEY", "QUIVER_API_KEY",
  "LIQUID_API_KEY", "LIQUID_API_BASE_URL", "ALPACA_BASE_URL", "NEWS_API_KEY",
] as const;

export class EtiContainer extends Container<Env> {
  defaultPort = 8000;
  sleepAfter = "30m";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const vars: Record<string, string> = {
      APP_ENV: "production",
      // Paper/testnet only. Live trading stays disabled.
      LIVE_TRADING_ENABLED: "false",
      BINANCE_LIVE_TRADING_ENABLED: "false",
      ALPACA_PAPER: "true",
      BINANCE_TESTNET_ENABLED: "true",
    };
    for (const k of FORWARDED) {
      const v = env[k];
      if (v) vars[k] = v;
    }
    this.envVars = vars;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return getContainer(env.ETI_CONTAINER).fetch(request);
  },
};
