import { CHAIN_CONFIGS } from '@circle-fin/x402-batching/client';
import { createPublicClient, createWalletClient, http, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const agentKey = process.env.AGENT_PRIVATE_KEY || process.env.AGENT_KEY;
if (!agentKey) {
  console.error('ERROR: AGENT_PRIVATE_KEY environment variable is required.');
  process.exit(1);
}

const cleanKey = agentKey.startsWith('0x') ? agentKey : `0x${agentKey}`;
if (!/^0x[0-9a-fA-F]{64}$/.test(cleanKey)) {
  console.error('ERROR: Invalid AGENT_PRIVATE_KEY format. Must be a 32-byte hex key.');
  process.exit(1);
}

const amountUsdc = Number(process.argv[2] || 1);
if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) {
  console.error('ERROR: Amount must be a positive number of USDC.');
  process.exit(1);
}
const amountAtomic = BigInt(Math.round(amountUsdc * 1_000_000));

const account = privateKeyToAccount(cleanKey);
const chain = CHAIN_CONFIGS.arcTestnet;
const usdcAddress = getAddress(chain.usdc);
const gatewayWalletAddress = getAddress(chain.gatewayWallet);
const rpcUrl = process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network';

const ERC20_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
];

const GATEWAY_WALLET_ABI = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'availableBalance',
    stateMutability: 'view',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'depositor', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
];

async function run() {
  const publicClient = createPublicClient({ chain: chain.chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: chain.chain, transport: http(rpcUrl) });

  console.log(`[Fund Gateway] Wallet: ${account.address}`);
  console.log(`[Fund Gateway] Gateway Wallet contract: ${gatewayWalletAddress}`);
  console.log(`[Fund Gateway] Depositing ${amountUsdc} USDC (${amountAtomic} atomic units)...`);

  const walletUsdcBalance = await publicClient.readContract({
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  });
  if (walletUsdcBalance < amountAtomic) {
    const have = Number(walletUsdcBalance) / 1_000_000;
    throw new Error(
      `Wallet only has ${have} USDC, need ${amountUsdc} USDC. Fund ${account.address} from https://faucet.circle.com (Arc Testnet) first.`,
    );
  }

  console.log('[Fund Gateway] Approving Gateway Wallet contract to spend USDC...');
  const approveHash = await walletClient.writeContract({
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [gatewayWalletAddress, amountAtomic],
  });
  const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
  if (approveReceipt.status !== 'success') throw new Error(`approve() failed (tx ${approveHash}).`);
  console.log(`[Fund Gateway] Approved. tx ${approveHash}`);

  console.log('[Fund Gateway] Depositing into Gateway Wallet contract...');
  const depositHash = await walletClient.writeContract({
    address: gatewayWalletAddress,
    abi: GATEWAY_WALLET_ABI,
    functionName: 'deposit',
    args: [usdcAddress, amountAtomic],
  });
  const depositReceipt = await publicClient.waitForTransactionReceipt({ hash: depositHash });
  if (depositReceipt.status !== 'success') throw new Error(`deposit() failed (tx ${depositHash}).`);
  console.log(`[Fund Gateway] Deposited. tx ${depositHash}`);

  const available = await publicClient.readContract({
    address: gatewayWalletAddress,
    abi: GATEWAY_WALLET_ABI,
    functionName: 'availableBalance',
    args: [usdcAddress, account.address],
  });
  console.log(
    `[Fund Gateway] Gateway-available balance for ${account.address}: ${Number(available) / 1_000_000} USDC`,
  );
  console.log('[Fund Gateway] Done. scripts/agent-runner.mjs should now be able to settle real x402 Gateway payments.');
}

run().catch((err) => {
  console.error('[Fund Gateway] Failed:', err.message);
  process.exitCode = 1;
});
