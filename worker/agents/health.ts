/**
 * Truthful runtime inventory for ETI's multi-agent stack.
 * Distinguishes deterministic specialist agents, optional LLM assistance,
 * scheduled paper automation, and the separately gated Bitget order gateway.
 */
import { AGENT_ROSTER } from "./types.ts";

type RuntimeEnv = {
  ANTHROPIC_API_KEY?: string;
  ETI_AGENT_AUTOPILOT_ENABLED?: string;
  ETI_EXECUTION_TOKEN?: string;
  ETI_EXECUTION_LOG?: unknown;
  ETI_PORTFOLIO_DB?: unknown;
  ETI_KILL_SWITCH?: string;
  ETI_BITGET_LIVE_ENABLED?: string;
  ETI_BITGET_EGRESS_VERIFIED?: string;
  BITGET_API_KEY?: string;
  BITGET_API_SECRET?: string;
  BITGET_API_PASSPHRASE?: string;
  MARKET_PROVIDER_ORDER?: string;
};

export function agentRuntimeStatus(env: RuntimeEnv) {
  const killSwitch = env.ETI_KILL_SWITCH === "true";
  const bitgetCredentialsConfigured = !!((env.BITGET_API_KEY || (env as any).BITGET_KEY || (env as any).BITGET_ACCESS_KEY) && (env.BITGET_API_SECRET || (env as any).BITGET_SECRET_KEY || (env as any).BITGET_SECRET) && (env.BITGET_API_PASSPHRASE || (env as any).BITGET_PASSPHRASE));
  const bitgetGatewayConfigured = env.ETI_BITGET_LIVE_ENABLED === "true"
    && env.ETI_BITGET_EGRESS_VERIFIED === "true"
    && bitgetCredentialsConfigured
    && !!env.ETI_EXECUTION_LOG
    && !killSwitch;
  const autopilotEnabled = env.ETI_AGENT_AUTOPILOT_ENABLED === "true";
  const marketProviderOrder = String(env.MARKET_PROVIDER_ORDER || "bybit")
    .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);

  return {
    schema: "eti.agent.runtime/1",
    generatedAt: new Date().toISOString(),
    orchestration: {
      status: "available",
      agentCount: AGENT_ROSTER.length,
      decisionModel: "deterministic_specialist_modules",
      llmAssistance: env.ANTHROPIC_API_KEY ? "configured_advisory_only" : "not_configured",
      llmReviewReady: !!env.ANTHROPIC_API_KEY && !!env.ETI_EXECUTION_TOKEN && !!env.ETI_EXECUTION_LOG,
      llmReviewBlockers: [ ...(!env.ANTHROPIC_API_KEY ? ["anthropic_api_key_missing"] : []), ...(!env.ETI_EXECUTION_TOKEN ? ["execution_token_missing"] : []), ...(!env.ETI_EXECUTION_LOG ? ["execution_kv_binding_missing"] : []) ],
      note: "The specialist council is deterministic. Optional LLM review is advisory and does not replace the risk engine.",
    },
    agents: AGENT_ROSTER.map((agent) => ({
      id: agent.id,
      name: agent.name,
      status: "registered",
      mode: "deterministic",
      mandate: agent.mandate,
      externalDataRequired: agent.externalDataRequired,
    })),
    persistence: {
      durableD1: !!env.ETI_PORTFOLIO_DB,
      executionKv: !!env.ETI_EXECUTION_LOG,
    },
    marketData: {
      workerProviderOrder: marketProviderOrder,
      bitgetPublicTransport: "browser_direct_uta_v3_v2_demo_and_sbe_websockets",
      bitgetPrivateWebSocket: "worker_relay_uta_v3_demo_and_classic_v2",
      bitgetWebSocketMatrix: { productionUtaV3: true, productionUtaSbePublic: true, demoUtaV3: true, productionClassicV2: true, demoClassicV2: false },
      bitgetServerSideScheduledAnalysis: false,
      note: "Bitget public market data supports production/demo UTA V3 JSON, production UTA SBE and production Classic V2. Private UTA V3 and Classic V2 sessions are relayed through the authenticated Worker. Demo Classic V2 is not documented by Bitget and is rejected. This reports implemented transports, not live account connectivity.",
    },
    autopilot: {
      enabled: autopilotEnabled,
      mode: "internal_paper_only",
      liveOrdersAllowed: false,
      blockers: [
        ...(!autopilotEnabled ? ["autopilot_disabled"] : []),
        ...(killSwitch ? ["kill_switch_active"] : []),
        ...(!env.ETI_EXECUTION_TOKEN ? ["execution_token_missing"] : []),
        ...(!env.ETI_EXECUTION_LOG ? ["execution_audit_log_missing"] : []),
        ...(!env.ETI_PORTFOLIO_DB && !env.ETI_EXECUTION_LOG ? ["paper_portfolio_storage_missing"] : []),
      ],
    },
    bitget: {
      credentialsConfigured: bitgetCredentialsConfigured,
      liveEnabled: env.ETI_BITGET_LIVE_ENABLED === "true",
      workerEgressVerified: env.ETI_BITGET_EGRESS_VERIFIED === "true",
      gatewayPreflightReady: bitgetGatewayConfigured,
      agentCouncilExecutionIntegrated: false,
      agentCouncilExecutionStatus: "not_wired",
      liveOrdersAllowedFromAgentAutopilot: false,
      blockers: [
        ...(env.ETI_BITGET_LIVE_ENABLED !== "true" ? ["bitget_live_disabled"] : []),
        ...(env.ETI_BITGET_EGRESS_VERIFIED !== "true" ? ["bitget_worker_egress_unverified"] : []),
        ...(!bitgetCredentialsConfigured ? ["bitget_credentials_missing"] : []),
        ...(!env.ETI_EXECUTION_LOG ? ["execution_audit_log_missing"] : []),
        ...(killSwitch ? ["kill_switch_active"] : []),
        "agent_council_bitget_order_route_not_integrated",
      ],
    },
    safety: {
      riskManagerVetoIsBinding: true,
      killSwitchActive: killSwitch,
      missingMarketOrAccountDataFailsClosed: true,
      noAutomaticCredentialOrRiskLimitChanges: true,
    },
  };
}
