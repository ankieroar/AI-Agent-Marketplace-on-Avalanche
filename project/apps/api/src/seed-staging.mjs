import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { ethers } from 'ethers';
import { pool } from './db.mjs';
import { encrypt } from './crypto.mjs';
import { day2Chain } from './day2-chain.mjs';
import { SeedError, policyAad, verifyCheckout, verifyCheckoutEvent } from './seed-policy.mjs';

const root = new URL('../../../', import.meta.url);
const localPath = url => fileURLToPath(url);
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const checkOnly = argv.includes('--check');

function option(name) {
  const index = argv.indexOf('--' + name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new SeedError('--' + name + ' requires a value');
  return value;
}

async function readJson(file, label) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new SeedError(label + ' not found: ' + file);
    throw new SeedError('Cannot read ' + label + ': ' + error.message);
  }
}

async function resolveOrderId(fixtureFile) {
  const explicit = option('order-id') ?? process.env.SEED_ORDER_ID;
  if (explicit) {
    if (!ethers.isHexString(explicit, 32)) throw new SeedError('order id must be bytes32');
    return explicit.toLowerCase();
  }
  const fixture = await readJson(fixtureFile, 'Day 2 order fixture');
  if (!ethers.isHexString(fixture.paid, 32)) {
    throw new SeedError('Fixture has no paid order; pass --order-id');
  }
  return fixture.paid.toLowerCase();
}

function databaseTarget() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new SeedError('DATABASE_URL is required; set the staging connection string in project/.env');
  try {
    const url = new URL(raw);
    return { host: url.hostname, port: url.port || '5432', name: url.pathname.replace(/^\//, '') };
  } catch {
    return { host: 'configured', port: '', name: '' };
  }
}

async function checkDatabase() {
  const target = databaseTarget();
  let row;
  try {
    ({ rows: [row] } = await pool.query(`SELECT current_database() AS db,
      to_regclass('public.service_orders') IS NOT NULL AS orders,
      to_regclass('public.service_policies') IS NOT NULL AS policies`));
  } catch (error) {
    throw new SeedError('Cannot connect to staging database at ' + target.host + ': ' + error.message);
  }
  if (!row.orders || !row.policies) {
    throw new SeedError('Database schema is missing; run: npm run migrate -w @warranty/api');
  }
  return { host: target.host, port: target.port, name: row.db, status: 'ready' };
}

async function checkBackend() {
  const configured = option('backend-url') ?? process.env.SEED_BACKEND_URL;
  if (!configured) return null;
  let response;
  try {
    response = await fetch(new URL('/health', configured), { signal: AbortSignal.timeout(5000) });
  } catch (error) {
    throw new SeedError('Backend health check failed at ' + configured + ': ' + error.message);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.database !== 'ready') {
    throw new SeedError('Backend is not ready (HTTP ' + response.status + ')');
  }
  return configured;
}

async function verifyCheckoutTx(chain, manifest, orderId, verified, txHash) {
  if (!txHash) return null;
  if (!ethers.isHexString(txHash, 32)) throw new SeedError('checkout tx hash must be bytes32');
  const contract = manifest.contracts?.ServiceOrderManager;
  if (!contract?.abi || !contract?.address) {
    throw new SeedError('Manifest lacks the ServiceOrderManager ABI/address needed to verify the tx');
  }
  const receipt = await chain.provider.getTransactionReceipt(txHash).catch(() => null);
  if (!receipt) throw new SeedError('Checkout transaction not found on the configured RPC');
  if (Number(receipt.status) !== 1) throw new SeedError('Checkout transaction reverted');
  verifyCheckoutEvent({
    logs: receipt.logs, iface: new ethers.Interface(contract.abi),
    address: contract.address, orderId, verified,
  });
  return { hash: txHash.toLowerCase(), blockNumber: receipt.blockNumber };
}

async function main() {
  if (process.env.DAY2_CHAIN_MODE === 'mock') {
    throw new SeedError('Mock chain is not a real checkout; unset DAY2_CHAIN_MODE before seeding');
  }
  const manifestFile = option('manifest') ?? process.env.DAY2_CONTRACTS_FILE
    ?? localPath(new URL('.runtime/day2/day2-local.json', root));
  process.env.DAY2_CONTRACTS_FILE = manifestFile;
  const policyFile = option('policy') ?? process.env.SEED_POLICY_FILE
    ?? localPath(new URL('.runtime/day2/day2-mock-policy.json', root));
  const fixtureFile = option('fixture') ?? process.env.SEED_FIXTURE_FILE
    ?? localPath(new URL('.runtime/day2/day2-api-fixture.json', root));

  const manifest = await readJson(manifestFile, 'Contract manifest');
  const policy = await readJson(policyFile, 'Service policy witness');
  const orderId = await resolveOrderId(fixtureFile);

  const chain = await day2Chain();
  const order = await chain.order(orderId);
  if (!order) throw new SeedError('Order is not confirmed on chain: ' + orderId);
  const wantedAgent = (option('agent-id') ?? process.env.SEED_AGENT_ID ?? order.agentId).toLowerCase();
  const listing = await chain.listing(wantedAgent);
  if (!listing) {
    throw new SeedError('Agent ' + wantedAgent + ' is not active/approved in AgentRegistry');
  }

  const verified = verifyCheckout({ listing, order, policy });
  const checkout = await verifyCheckoutTx(chain, manifest, verified.orderId, verified,
    option('tx-hash') ?? process.env.SEED_CHECKOUT_TX_HASH);

  const summary = {
    orderId: verified.orderId,
    agentId: verified.agentId,
    buyer: verified.buyer,
    seller: verified.seller,
    priceWei: verified.priceWei,
    orderStatus: verified.status,
    policyCommitment: verified.commitment,
    policyVersionHash: verified.policyVersionHash,
    purchaseTimestamp: verified.purchaseTimestamp,
    claimDeadline: verified.claimDeadline,
    checkoutTxHash: checkout?.hash ?? null,
    checkoutBlockNumber: checkout?.blockNumber ?? null,
    manifestChainId: manifest.chainId ?? null,
  };

  if (dryRun) {
    console.log(JSON.stringify({ status: 'validated', ...summary, database: 'unchanged (dry run)' }, null, 2));
    return summary;
  }
  if (checkOnly) {
    const database = await checkDatabase();
    const backend = await checkBackend();
    console.log(JSON.stringify({ status: 'checked', ...summary, database, backend: backend ?? 'not configured' }, null, 2));
    return summary;
  }

  const database = await checkDatabase();
  const backend = await checkBackend();
  if (!process.env.AES_KEY_HEX) throw new SeedError('AES_KEY_HEX is required to store the policy');

  const ciphertext = encrypt(verified.witness, process.env.AES_KEY_HEX, policyAad(verified.orderId));
  const snapshot = {
    ...order,
    policyCommitment: verified.commitment,
    policyVersionHash: verified.policyVersionHash,
    purchaseTimestamp: verified.purchaseTimestamp,
    claimDeadline: verified.claimDeadline,
    seedSource: 'checkout',
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO agent_listings_cache(agent_id,listing) VALUES($1,$2)
       ON CONFLICT(agent_id) DO UPDATE SET listing=excluded.listing,updated_at=now()`,
      [listing.agentId, listing],
    );
    await client.query(
      `INSERT INTO service_orders(order_id,buyer,snapshot) VALUES($1,$2,$3)
       ON CONFLICT(order_id) DO UPDATE SET buyer=excluded.buyer,snapshot=excluded.snapshot,updated_at=now()`,
      [verified.orderId, verified.buyer, snapshot],
    );
    const { rowCount } = await client.query(
      `INSERT INTO service_policies(order_id,agent_id,policy_version_hash,commitment,ciphertext,source,checkout_tx_hash)
       VALUES($1,$2,$3,$4,$5,'checkout',$6)
       ON CONFLICT(order_id) DO UPDATE SET ciphertext=excluded.ciphertext,source=excluded.source,
         checkout_tx_hash=COALESCE(excluded.checkout_tx_hash,service_policies.checkout_tx_hash),seeded_at=now()
       WHERE service_policies.commitment=excluded.commitment
         AND service_policies.policy_version_hash=excluded.policy_version_hash
       RETURNING order_id`,
      [verified.orderId, verified.agentId, verified.policyVersionHash, verified.commitment, ciphertext,
        checkout?.hash ?? null],
    );
    if (!rowCount) {
      throw new SeedError('An existing policy for this order has a different commitment; refusing to overwrite');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const receipt = {
    ...summary,
    database,
    backend: backend ?? 'not configured',
    seededAt: new Date().toISOString(),
  };
  const receiptFile = option('receipt') ?? localPath(new URL('.runtime/day2/seed-staging.json', root));
  try {
    await mkdir(dirname(receiptFile), { recursive: true });
    await writeFile(receiptFile, JSON.stringify(receipt, null, 2) + '\n');
    receipt.receipt = receiptFile;
  } catch (error) {
    receipt.receipt = 'not written: ' + error.message;
  }
  console.log(JSON.stringify(receipt, null, 2));
  return receipt;
}

try {
  await main();
} catch (error) {
  console.error('Seed failed: ' + error.message);
  if (process.env.SEED_DEBUG === '1') {
    if (error.cause?.message) console.error('Cause: ' + error.cause.message);
    if (error.stack) console.error(error.stack);
  }
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
