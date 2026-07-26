import { type Address, type PublicClient, type WalletClient } from "viem";
import { ponsFactoryAbi, ponsLockerAbi } from "./abis.js";
import { ADDRESSES } from "./addresses.js";
import { balanceOf } from "./erc20.js";

/** Decoded PonsLaunchFactory.getLaunchedToken(token) tuple. */
export interface LaunchedToken {
  token: Address;
  deployer: Address;
  pairedToken: Address;
  positionManager: Address;
  positionId: bigint;
  dexId: bigint;
  launchConfigId: bigint;
  restrictionsEndBlock: bigint;
  supply: bigint;
  isToken0: boolean;
  poolFee: bigint;
  exists: boolean;
  initialBuyAmount: bigint;
}

export async function getLaunchedToken(
  pc: PublicClient,
  token: Address,
): Promise<LaunchedToken> {
  const info = (await pc.readContract({
    address: ADDRESSES.ponsFactory,
    abi: ponsFactoryAbi,
    functionName: "getLaunchedToken",
    args: [token],
  })) as LaunchedToken;
  return info;
}

export async function graduationStatus(
  pc: PublicClient,
  token: Address,
): Promise<{ pairedPrincipal: bigint; threshold: bigint; graduated: boolean }> {
  const [pairedPrincipal, threshold, graduated] = (await pc.readContract({
    address: ADDRESSES.ponsFactory,
    abi: ponsFactoryAbi,
    functionName: "graduationStatus",
    args: [token],
  })) as [bigint, bigint, boolean];
  return { pairedPrincipal, threshold, graduated };
}

/** Split raw (amount0, amount1) into {weth, token} using pool token ordering. */
export function splitAmounts(
  info: LaunchedToken,
  amount0: bigint,
  amount1: bigint,
): { weth: bigint; token: bigint } {
  return info.isToken0
    ? { token: amount0, weth: amount1 }
    : { token: amount1, weth: amount0 };
}

/**
 * Preview claimable creator fees without sending a tx. `collectFees` is not a
 * view function, so we eth_call-simulate it and read its (amount0, amount1) return.
 */
export async function previewFees(
  pc: PublicClient,
  info: LaunchedToken,
  account: Address,
): Promise<{ weth: bigint; token: bigint }> {
  try {
    const { result } = await pc.simulateContract({
      account,
      address: ADDRESSES.ponsLocker,
      abi: ponsLockerAbi,
      functionName: "collectFees",
      args: [info.token],
    });
    const [a0, a1] = result as [bigint, bigint];
    return splitAmounts(info, a0, a1);
  } catch {
    return { weth: 0n, token: 0n };
  }
}

/**
 * Claim accrued creator fees from the locker to the fee recipient (our wallet).
 * Returns the tx hash and the actual amounts received, measured by balance delta.
 */
export async function claimFees(
  pc: PublicClient,
  wc: WalletClient,
  info: LaunchedToken,
  wethAddress: Address,
): Promise<{ hash: `0x${string}`; weth: bigint; token: bigint }> {
  const me = wc.account!.address;
  const [wethBefore, tokenBefore] = await Promise.all([
    balanceOf(pc, wethAddress, me),
    balanceOf(pc, info.token, me),
  ]);

  const { request } = await pc.simulateContract({
    account: wc.account,
    address: ADDRESSES.ponsLocker,
    abi: ponsLockerAbi,
    functionName: "collectFees",
    args: [info.token],
  });
  const hash = await wc.writeContract(request);
  await pc.waitForTransactionReceipt({ hash });

  const [wethAfter, tokenAfter] = await Promise.all([
    balanceOf(pc, wethAddress, me),
    balanceOf(pc, info.token, me),
  ]);

  return {
    hash,
    weth: wethAfter - wethBefore,
    token: tokenAfter - tokenBefore,
  };
}
