import type { Address } from "viem";

/**
 * Robinhood Chain + pons.family address book.
 *
 * Robinhood Chain — Arbitrum L2, EVM, native gas = ETH.
 *   RPC:      https://rpc.mainnet.chain.robinhood.com
 *   chainId:  4663
 *   explorer: https://robinhoodchain.blockscout.com
 *
 * pons.family runs on Bags-style infra: tokens launch straight into Uniswap V3
 * quoted against WETH, the LP position is locked, and the creator's share of
 * trading fees is claimed from the Locker via `collectFees(token)`.
 *
 * Addresses verified from Blockscout (getabi) + pons docs.
 */

export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const ROBINHOOD_EXPLORER = "https://robinhoodchain.blockscout.com";

export const ADDRESSES = {
  // Canonical WETH on Robinhood Chain. The bots also read router.WETH9() and
  // each token's pairedToken at runtime, so this is a fallback, not a trust anchor.
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address,
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11" as Address,

  // pons — active + legacy launch factories
  ponsFactory: "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB" as Address,
  ponsFactoryLegacy: "0x0c37a24F5D23A486FA692d1500881d698B1F77a4" as Address,

  // pons — fee/liquidity locker (this is where creator fees are claimed)
  ponsLocker: "0x736D76699C26D0d966744cAe304C000d471f7F35" as Address,

  // Uniswap V3 stack used by pons
  v3Factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA" as Address,
  positionManager: "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3" as Address,
  swapRouter: "0xCaf681a66D020601342297493863E78C959E5cb2" as Address,
  quoterV2: "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7" as Address,
} as const;

/** First block each factory produced tokens at — used to bound log scans. */
export const FACTORY_DEPLOY_BLOCK = {
  active: 8991118n,
  legacy: 8600612n,
} as const;

/** Standard EVM burn sink. */
export const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD" as Address;
