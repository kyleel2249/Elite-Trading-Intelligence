/**
 * EVM networks shown on the wallet dashboard. Mirrors app/chain/networks.py so both sides agree on chain ids and native coins.
 * RPC endpoints are never hard-coded except the one the backend already ships (Sepolia public node): set CHAIN_RPC_<KEY> to enable another.
 */
export interface ChainNet { key: string; label: string; chainId: number; native: string; mainnet: boolean; explorer: string; defaultRpc?: string }
export const CHAIN_NETS: ChainNet[] = [
  { key: "sepolia", label: "Ethereum Sepolia (testnet)", chainId: 11155111, native: "ETH", mainnet: false, explorer: "https://sepolia.etherscan.io", defaultRpc: "https://ethereum-sepolia-rpc.publicnode.com" },
  { key: "base-sepolia", label: "Base Sepolia (testnet)", chainId: 84532, native: "ETH", mainnet: false, explorer: "https://sepolia.basescan.org" },
  { key: "bsc-testnet", label: "BNB Chain testnet", chainId: 97, native: "BNB", mainnet: false, explorer: "https://testnet.bscscan.com" },
  { key: "polygon-amoy", label: "Polygon Amoy (testnet)", chainId: 80002, native: "POL", mainnet: false, explorer: "https://amoy.polygonscan.com" },
  { key: "ethereum", label: "Ethereum mainnet", chainId: 1, native: "ETH", mainnet: true, explorer: "https://etherscan.io" },
  { key: "base", label: "Base mainnet", chainId: 8453, native: "ETH", mainnet: true, explorer: "https://basescan.org" },
  { key: "bsc", label: "BNB Chain mainnet", chainId: 56, native: "BNB", mainnet: true, explorer: "https://bscscan.com" },
  { key: "polygon", label: "Polygon mainnet", chainId: 137, native: "POL", mainnet: true, explorer: "https://polygonscan.com" },
];
export const netByKey = (k: string) => CHAIN_NETS.find(n => n.key === k);

/** Resolve the RPC URL for a network from the Worker environment, or the built-in default. Only http(s) URLs without credentials are accepted. */
export function rpcUrlFor(net: ChainNet, env: Record<string, any>): string | undefined {
  const raw = env["CHAIN_RPC_" + net.key.toUpperCase().replace(/-/g, "_")];
  const v = typeof raw === "string" && raw.trim() ? raw.trim() : net.defaultRpc;
  if (!v) return undefined;
  try { const u = new URL(v); return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password ? u.toString() : undefined; } catch { return undefined; }
}
