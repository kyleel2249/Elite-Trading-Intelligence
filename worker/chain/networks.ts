/**
 * EVM networks shown on the wallet dashboard. Mirrors app/chain/networks.py so both sides agree on chain ids and native coins.
 * RPC endpoints are never hard-coded except the one the backend already ships (Sepolia public node): set CHAIN_RPC_<KEY> to enable another.
 */
export interface ChainNet { key: string; label: string; chainId: number; native: string; mainnet: boolean; explorer: string; defaultRpc?: string; infura?: string }
export const CHAIN_NETS: ChainNet[] = [
  { key: "sepolia", label: "Ethereum Sepolia (testnet)", chainId: 11155111, native: "ETH", mainnet: false, explorer: "https://sepolia.etherscan.io", defaultRpc: "https://ethereum-sepolia-rpc.publicnode.com", infura: "sepolia.infura.io" },
  { key: "base-sepolia", label: "Base Sepolia (testnet)", chainId: 84532, native: "ETH", mainnet: false, explorer: "https://sepolia.basescan.org", infura: "base-sepolia.infura.io" },
  { key: "bsc-testnet", label: "BNB Chain testnet", chainId: 97, native: "BNB", mainnet: false, explorer: "https://testnet.bscscan.com", infura: "bsc-testnet.infura.io" },
  { key: "polygon-amoy", label: "Polygon Amoy (testnet)", chainId: 80002, native: "POL", mainnet: false, explorer: "https://amoy.polygonscan.com", infura: "polygon-amoy.infura.io" },
  { key: "ethereum", label: "Ethereum mainnet", chainId: 1, native: "ETH", mainnet: true, explorer: "https://etherscan.io", infura: "mainnet.infura.io" },
  { key: "base", label: "Base mainnet", chainId: 8453, native: "ETH", mainnet: true, explorer: "https://basescan.org", infura: "base-mainnet.infura.io" },
  { key: "bsc", label: "BNB Chain mainnet", chainId: 56, native: "BNB", mainnet: true, explorer: "https://bscscan.com", infura: "bsc-mainnet.infura.io" },
  { key: "polygon", label: "Polygon mainnet", chainId: 137, native: "POL", mainnet: true, explorer: "https://polygonscan.com", infura: "polygon-mainnet.infura.io" },
];
export const netByKey = (k: string) => CHAIN_NETS.find(n => n.key === k);

const INFURA_KEY = /^[0-9a-fA-F]{32}$/;
const infuraKey = (env: Record<string, any>) => { const k = typeof env.INFURA_API_KEY === "string" ? env.INFURA_API_KEY.trim() : ""; return INFURA_KEY.test(k) ? k : ""; };
const isInfuraUrl = (url: string) => { try { return new URL(url).hostname.endsWith(".infura.io"); } catch { return false; } };

/**
 * Resolve the RPC URL for a network. Precedence: an explicit CHAIN_RPC_<KEY> URL, then Infura (INFURA_API_KEY secret, https://<network>.infura.io/v3/<key>),
 * then the built-in public default. Only http(s) URLs without credentials are accepted. The URL may contain a key: never log or return it.
 */
export function rpcUrlFor(net: ChainNet, env: Record<string, any>): string | undefined {
  const raw = env["CHAIN_RPC_" + net.key.toUpperCase().replace(/-/g, "_")], key = infuraKey(env);
  const v = typeof raw === "string" && raw.trim() ? raw.trim() : key && net.infura ? "https://" + net.infura + "/v3/" + key : net.defaultRpc;
  if (!v) return undefined;
  try { const u = new URL(v); return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password ? u.toString() : undefined; } catch { return undefined; }
}

/** Where the connection comes from, for display only (never the key): "custom" | "infura" | "public" | null. */
export function rpcSourceFor(net: ChainNet, env: Record<string, any>): "custom" | "infura" | "public" | null {
  const url = rpcUrlFor(net, env); if (!url) return null;
  const raw = env["CHAIN_RPC_" + net.key.toUpperCase().replace(/-/g, "_")];
  return typeof raw === "string" && raw.trim() ? "custom" : isInfuraUrl(url) ? "infura" : "public";
}

/** Extra request headers for the endpoint. The Infura API key secret (INFURA_API_SECRET) is sent only to *.infura.io, as HTTP Basic with an empty user name. */
export function rpcHeadersFor(url: string, env: Record<string, any>): Record<string, string> {
  const secret = typeof env.INFURA_API_SECRET === "string" ? env.INFURA_API_SECRET.trim() : "";
  if (!secret || !isInfuraUrl(url)) return {};
  return { authorization: "Basic " + btoa(":" + secret) };
}
