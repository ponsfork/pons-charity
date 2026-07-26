import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  webSocket,
  fallback,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, nonceManager } from "viem/accounts";
import {
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_EXPLORER,
  ROBINHOOD_RPC,
} from "./addresses.js";

export const robinhoodChain = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ROBINHOOD_RPC] } },
  blockExplorers: {
    default: { name: "Blockscout", url: ROBINHOOD_EXPLORER },
  },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

// Extra RPCs viem transparently fails over to if the primary errors/times out.
// ArrowRPC (chainId 4663 verified) needs no key/signup. Override or extend with
// RPC_FALLBACKS=url1,url2 in .env (e.g. add a dedicated Alchemy/QuickNode URL).
const DEFAULT_FALLBACKS = ["https://rpc.arrowrpc.com"];

export interface Clients {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: ReturnType<typeof privateKeyToAccount>;
}

export function makeClients(opts: {
  rpcUrl: string;
  wsUrl?: string;
  rpcFallbacks?: string[];
  privateKey: `0x${string}`;
}): Clients {
  // nonceManager serializes nonce allocation locally so rapid sequential sends in one
  // cycle (fee skim → $FORK buyback → payouts) never collide on a stale nonce.
  const account = privateKeyToAccount(opts.privateKey, { nonceManager });

  const envFallbacks = (process.env.RPC_FALLBACKS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const extra = (opts.rpcFallbacks ?? (envFallbacks.length ? envFallbacks : DEFAULT_FALLBACKS))
    .filter((u) => u && u !== opts.rpcUrl);

  // Ordered HTTP transports: primary first, then every fallback.
  const httpTransports = [opts.rpcUrl, ...extra].map((u) =>
    http(u, { timeout: 15_000, retryCount: 2 }),
  );

  const publicClient = createPublicClient({
    chain: robinhoodChain,
    transport: fallback([
      ...(opts.wsUrl ? [webSocket(opts.wsUrl)] : []),
      ...httpTransports,
    ]),
  });

  const walletClient = createWalletClient({
    chain: robinhoodChain,
    transport: fallback(httpTransports),
    account,
  });

  return { publicClient, walletClient, account };
}
