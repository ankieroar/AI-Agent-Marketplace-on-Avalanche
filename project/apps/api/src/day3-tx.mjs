/**
 * Transaction confirmation and retry helpers for the Day 3 worker.
 *
 * The worker never reports success from a transaction hash alone. A write is
 * only accepted after the receipt is successful AND the caller's `applied`
 * read-back observes the expected final on-chain state. Reads use the same RPC
 * that submitted the transaction, so a mined receipt is not enough by itself.
 */
import { ethers } from 'ethers';

export class TxError extends Error {
  constructor(message, { txHash, retryable = false, cause } = {}) {
    super(message, { cause });
    this.name = 'TxError';
    this.txHash = txHash;
    this.retryable = retryable;
  }
}

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isRetryableError(error) {
  if (!error) return false;
  if (error.retryable === true) return true;
  if (error.code === 'CALL_EXCEPTION' || error.code === 'ACTION_REJECTED' ||
      error.code === 'INSUFFICIENT_FUNDS' || error.code === 'NONCE_EXPIRED') return false;
  const code = String(error.code ?? error.error?.code ?? '');
  if (['ECONNRESET', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'SERVER_ERROR', 'TIMEOUT',
    'NETWORK_ERROR', 'EAI_AGAIN'].includes(code)) return true;
  if (error.error && error.error !== error) return isRetryableError(error.error);
  return /timeout|timed out|network|socket|connection reset|ECONN|EAI_AGAIN|nonce too low|replacement transaction/i
    .test(String(error.message ?? ''));
}

/**
 * Poll an on-chain read until the predicate is true. Returns the observed value
 * or null on timeout. The injectable clock/sleep keep unit tests instant.
 */
export async function waitForState(read, predicate, {
  timeoutMs = 15_000,
  intervalMs = 1_000,
  sleep = delay,
  now = Date.now,
} = {}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

/**
 * Send one contract write, wait for confirmations, then require the read-back
 * state. `applied` is both the idempotency guard and the final-state assertion:
 * if it is already true, no transaction is sent.
 *
 * `before` is used for pre-write validation (for example, checking that the
 * signer is still the reviewer). `sleep`/`now` are injectable for tests.
 */
export async function sendConfirmed({
  contract,
  method,
  args = [],
  signer,
  confirmations = 1,
  timeoutMs = 120_000,
  retries = 2,
  stateTimeoutMs = 15_000,
  stateIntervalMs = 1_000,
  before,
  applied,
  sleep = delay,
  now = Date.now,
  logger = () => {},
} = {}) {
  const connected = signer ? contract.connect(signer) : contract;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (applied && await applied()) {
      return { status: 'already-applied', method, attempts: attempt };
    }
    if (before) await before();

    let transaction;
    try {
      transaction = await connected[method](...args);
      logger({ event: 'tx-sent', method, txHash: transaction.hash, attempt });
    } catch (error) {
      if (applied && await applied()) {
        return { status: 'already-applied', method, attempts: attempt + 1 };
      }
      if (attempt < retries && isRetryableError(error)) {
        const wait = Math.min(2 ** attempt * 1_000, 8_000);
        logger({ event: 'tx-retry', method, attempt: attempt + 1, wait, error: error.message });
        await sleep(wait);
        continue;
      }
      throw new TxError(`${method} failed: ${error.message}`, { cause: error });
    }

    let receipt;
    try {
      receipt = await contract.runner.provider.waitForTransaction(
        transaction.hash, confirmations, timeoutMs,
      );
    } catch (error) {
      // The transaction may still have been broadcast. Never send a duplicate
      // because a local timeout is not proof that the write failed.
      throw new TxError(`${method} confirmation failed: ${error.message}`, {
        txHash: transaction.hash,
        retryable: false,
        cause: error,
      });
    }
    if (!receipt) {
      throw new TxError(`${method} not confirmed within ${timeoutMs}ms`, {
        txHash: transaction.hash,
        retryable: false,
      });
    }
    if (Number(receipt.status) !== 1) {
      if (applied && await applied()) {
        return { status: 'already-applied', method, txHash: transaction.hash, attempts: attempt + 1 };
      }
      throw new TxError(`${method} reverted`, { txHash: transaction.hash });
    }

    if (applied) {
      const final = await waitForState(applied, Boolean, {
        timeoutMs: stateTimeoutMs, intervalMs: stateIntervalMs, sleep, now,
      });
      if (!final) {
        throw new TxError(`${method} confirmed but final on-chain state was not updated`, {
          txHash: transaction.hash,
          retryable: false,
        });
      }
      logger({ event: 'tx-final', method, txHash: transaction.hash });
      return { status: 'confirmed', method, txHash: transaction.hash, receipt, final };
    }

    logger({ event: 'tx-confirmed', method, txHash: transaction.hash });
    return { status: 'confirmed', method, txHash: transaction.hash, receipt };
  }
  throw new TxError(`${method} failed after retries`);
}

export function requireAddress(value, label) {
  if (!ethers.isAddress(value)) throw new TxError(label + ' is not a valid address');
  return ethers.getAddress(value);
}
