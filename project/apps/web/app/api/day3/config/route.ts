import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

// Hardhat deploys at fresh addresses every restart. The Day 2 fixture writes the
// manifest below; the browser cannot read it directly, so expose only the
// public addresses here. No ABI and no secrets are returned.
const contractNames = {
  serviceOrderManager: 'ServiceOrderManager',
  marketplaceGateway: 'MarketplaceGateway',
  agentRegistry: 'AgentRegistry',
  escrow: 'SettlementEscrow',
  disputeManager: 'DisputeManager',
  resultSender: 'DisputeResultSender',
} as const;

function projectRoot() {
  const cwd = process.cwd();
  return cwd.endsWith(path.join('apps', 'web')) ? path.resolve(cwd, '..', '..') : cwd;
}

export async function GET() {
  const directory = process.env.DAY3_RUNTIME_DIR || path.join(projectRoot(), '.runtime', 'day3');
  const file = process.env.DAY2_MANIFEST_FILE || path.join(path.dirname(directory), 'day2', 'day2-local.json');
  try {
    const manifest = JSON.parse(await readFile(file, 'utf8')) as {
      chainId?: number;
      transport?: string;
      contracts?: Record<string, { address?: string }>;
    };
    if (!manifest.contracts) throw new Error('missing contracts');
    const addresses: Record<string, string> = {};
    for (const [key, name] of Object.entries(contractNames)) {
      const address = manifest.contracts[name]?.address;
      if (typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address)) addresses[key] = address;
    }
    return NextResponse.json({ chainId: manifest.chainId ?? 31337, addresses,
      transport: manifest.transport === 'same-chain' ? 'same-chain' : 'relay', source: file }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return NextResponse.json(
      { error: 'Chưa có deployment local. Chạy npx.cmd hardhat run scripts/day3-prepare-local.js --network localhost trong thư mục contracts.' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
