import { privateKeyToAccount } from 'viem/accounts';

const serverUrl = process.env.SOURCEPAY_URL || 'http://127.0.0.1:8787';
const agentKey = process.env.AGENT_PRIVATE_KEY || process.env.AGENT_KEY;

if (!agentKey) {
  console.error('ERROR: AGENT_PRIVATE_KEY environment variable is required.');
  console.error('Run: $env:AGENT_PRIVATE_KEY="0x..." ; node scripts/agent-runner.mjs');
  process.exit(1);
}

const cleanKey = agentKey.startsWith('0x') ? agentKey : `0x${agentKey}`;
if (!/^0x[0-9a-fA-F]{64}$/.test(cleanKey)) {
  console.error('ERROR: Invalid AGENT_PRIVATE_KEY format. Must be a 32-byte hex key.');
  process.exit(1);
}

const agentAccount = privateKeyToAccount(cleanKey);
console.log(`[Autonomous Agent] Initialized agent wallet: ${agentAccount.address}`);

const question = process.argv[2] || 'Arc citation licensing note';
const budget = Number(process.argv[3] || 10);

console.log(`[Autonomous Agent] Researching objective: "${question}" with budget ${budget} USDC...`);

async function run() {
  try {
    // 1. Route the request to find sources
    const routeRes = await fetch(`${serverUrl}/api/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        budget,
        buyerWallet: agentAccount.address,
      }),
    });

    const routeData = await routeRes.json();
    if (!routeRes.ok) {
      throw new Error(routeData.error || 'Failed to route request.');
    }

    const receipt = routeData.receipt;
    console.log(`\n[Autonomous Agent] Found matching sources!`);
    console.log(`Receipt ID: ${receipt.id}`);
    console.log(`Total cost: ${receipt.totalSpend} USDC`);
    console.log(`Sources cited:`);
    receipt.sources.forEach((s) => {
      console.log(` - [${s.kind}] ${s.title} (${s.price} USDC) | Wallet: ${s.wallet}`);
    });

    // 2. Fetch payment requirements
    console.log(`\n[Autonomous Agent] Fetching payment requirements...`);
    const reqRes = await fetch(`${serverUrl}/api/receipts/${receipt.id}/payment-requirements?access=${receipt.accessToken}&payer=${agentAccount.address}`);
    const reqData = await reqRes.json();
    if (!reqRes.ok) {
      throw new Error(reqData.error || 'Failed to fetch payment requirements.');
    }

    // 3. Programmatically sign payment payloads
    console.log(`[Autonomous Agent] Programmatically signing EIP-3009 TransferWithAuthorization payloads...`);
    const payments = [];
    for (const item of reqData.requirements) {
      if (!item.typedData) {
        throw new Error(`Payment preparation failed for source: ${item.title}`);
      }

      const { paymentPayloadTemplate, ...signableTypedData } = item.typedData;
      
      // Sign using Viem account
      const signature = await agentAccount.signTypedData({
        domain: signableTypedData.domain,
        types: signableTypedData.types,
        primaryType: signableTypedData.primaryType,
        message: signableTypedData.message,
      });

      const templatePayload = paymentPayloadTemplate;
      const templateInnerPayload = templatePayload?.payload || {};

      payments.push({
        sourceId: item.sourceId,
        paymentPayload: {
          ...templatePayload,
          payload: {
            ...templateInnerPayload,
            authorization: signableTypedData.message,
            signature,
          },
        },
      });
    }

    // 4. Submit payments to the backend for Gateway verification & settlement
    console.log(`[Autonomous Agent] Submitting signed payloads to Gateway for settlement...`);
    const payRes = await fetch(`${serverUrl}/api/receipts/${receipt.id}/pay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accessToken: receipt.accessToken,
        payments,
      }),
    });

    const payData = await payRes.json();
    if (!payRes.ok) {
      throw new Error(payData.payment?.reason || payData.error || 'Payment execution failed.');
    }

    console.log(`\n[Autonomous Agent] Payout completed successfully!`);
    console.log(`Receipt Status: ${payData.receipt.paymentStatus}`);
    console.log(`Settlements details:`);
    payData.payment.settlements.forEach((s) => {
      console.log(` - Paid ${s.amount / 1000000} USDC to creator: ${s.payTo}`);
      console.log(`   Transaction: ${s.transactionId}`);
    });
    
    console.log(`\n[Autonomous Agent] Research completed! Citation records settled on Arc Testnet.`);
  } catch (err) {
    console.error(`\n[Autonomous Agent] Flow failed:`, err.message);
    process.exit(1);
  }
}

run();
