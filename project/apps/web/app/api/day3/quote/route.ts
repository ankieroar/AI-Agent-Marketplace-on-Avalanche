import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

// The commitment scheme is owned by the prover service (Người 2). Reuse it so
// the quote signed by the Seller commits to exactly the witness the prover
// later feeds into the Noir circuit.
import { serviceCommitment } from '../../../../../../services/prover/service-policy-input.mjs';

const hex32 = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);

function projectRoot() {
  const cwd = process.cwd();
  return cwd.endsWith(path.join('apps', 'web')) ? path.resolve(cwd, '..', '..') : cwd;
}

function runtimeDirectory() {
  return process.env.DAY3_RUNTIME_DIR || path.join(projectRoot(), '.runtime', 'day3');
}

async function remember(orderId: string, record: Record<string, unknown>, policy: Record<string, string>) {
  const directory = runtimeDirectory();
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'policies.json');
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    existing = {};
  }
  existing[orderId.toLowerCase()] = record;
  await writeFile(file, JSON.stringify(existing, null, 2), { encoding: 'utf8', mode: 0o600 });

  // `apps/api/src/prove-case.mjs` expects a plain witness object, so also keep
  // one file per order. It is the exact input the commitment was built from.
  const witnessFile = path.join(directory, `policy-${orderId.toLowerCase()}.json`);
  await writeFile(witnessFile, JSON.stringify(policy, null, 2), { encoding: 'utf8', mode: 0o600 });
  return { file, witnessFile };
}

type QuoteBody = {
  orderId: string;
  agentId: string;
  policyVersionHash: string;
  priceWei: string;
  disputeWindow?: string;
};

function parseBody(body: unknown): QuoteBody {
  if (!body || typeof body !== 'object') throw new Error('Body không hợp lệ');
  const raw = body as Record<string, unknown>;
  if (!hex32(raw.orderId) || !hex32(raw.agentId) || !hex32(raw.policyVersionHash)) {
    throw new Error('orderId, agentId và policyVersionHash phải là bytes32');
  }
  if (typeof raw.priceWei !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw.priceWei) || raw.priceWei === '0') {
    throw new Error('priceWei phải là số wei dạng chuỗi');
  }
  const window = raw.disputeWindow ?? '3600';
  if (typeof window !== 'string' || !/^(0|[1-9][0-9]*)$/.test(window) || window === '0') {
    throw new Error('disputeWindow phải là số giây dạng chuỗi');
  }
  return {
    orderId: raw.orderId,
    agentId: raw.agentId,
    policyVersionHash: raw.policyVersionHash,
    priceWei: raw.priceWei,
    disputeWindow: window,
  };
}

export async function POST(request: Request) {
  try {
    const input = parseBody(await request.json());
    const priceWei = BigInt(input.priceWei);
    // P0 policy: refund never exceeds the amount the Buyer already escrowed.
    // 75% matches the Day 2 fixture (0.0075 / 0.01 AVAX).
    const maxRefund = ((priceWei * 3n) / 4n).toString();
    const policy = {
      disputeWindow: input.disputeWindow as string,
      maxRefund,
      nonce: '0x' + randomBytes(16).toString('hex'),
    };
    const policyCommitment = serviceCommitment(input.orderId, input.policyVersionHash, policy);
    const stored = await remember(
      input.orderId,
      {
        agentId: input.agentId,
        policyVersionHash: input.policyVersionHash,
        priceWei: priceWei.toString(),
        policy,
        createdAt: new Date().toISOString(),
      },
      policy,
    );
    return NextResponse.json(
      {
        orderId: input.orderId,
        policyCommitment,
        policy,
        stored: true,
        // Path is relative to the repository root for the demo commands below.
        witnessFile: path.relative(projectRoot(), stored.witnessFile).replaceAll(path.sep, '/'),
        note: 'Policy witness chỉ lưu local cho demo. Production phải mã hóa và chỉ prover được đọc.',
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Không tạo được quote' },
      { status: 400 },
    );
  }
}
