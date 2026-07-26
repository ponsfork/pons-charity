import { type Address, erc20Abi, maxUint256, type PublicClient, type WalletClient } from "viem";

export async function balanceOf(
  pc: PublicClient,
  token: Address,
  owner: Address,
): Promise<bigint> {
  return pc.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  });
}

export async function totalSupply(pc: PublicClient, token: Address): Promise<bigint> {
  return pc.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" });
}

export async function allowance(
  pc: PublicClient,
  token: Address,
  owner: Address,
  spender: Address,
): Promise<bigint> {
  return pc.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender],
  });
}

/** Ensure `spender` can pull at least `amount` of `token` from our account. */
export async function ensureAllowance(
  pc: PublicClient,
  wc: WalletClient,
  token: Address,
  spender: Address,
  amount: bigint,
): Promise<`0x${string}` | null> {
  const owner = wc.account!.address;
  const current = await allowance(pc, token, owner, spender);
  if (current >= amount) return null;

  const { request } = await pc.simulateContract({
    account: wc.account,
    address: token,
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, maxUint256],
  });
  const hash = await wc.writeContract(request);
  await pc.waitForTransactionReceipt({ hash });
  return hash;
}

export async function transfer(
  pc: PublicClient,
  wc: WalletClient,
  token: Address,
  to: Address,
  amount: bigint,
): Promise<`0x${string}`> {
  const { request } = await pc.simulateContract({
    account: wc.account,
    address: token,
    abi: erc20Abi,
    functionName: "transfer",
    args: [to, amount],
  });
  return wc.writeContract(request);
}
