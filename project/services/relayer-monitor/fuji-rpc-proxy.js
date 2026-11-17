const http = require('node:http');

// Public Fuji RPC permits 100 blocks per eth_getLogs call. The official
// relayer requests 200; split inclusive ranges without skipping/duplicating blocks.
async function query(request, upstream) {
  if (request.method !== 'eth_getLogs' || request.params?.[0]?.blockHash) return upstream(request);
  const filter = request.params[0];
  const height = async tag => {
    if (tag === 'earliest') return 0n;
    if (tag === undefined || tag === 'latest') {
      const response = await upstream({ jsonrpc: '2.0', id: request.id, method: 'eth_blockNumber', params: [] });
      if (response.error) throw new Error(response.error.message);
      return BigInt(response.result);
    }
    if (typeof tag === 'string' && /^0x[0-9a-f]+$/i.test(tag)) return BigInt(tag);
    return null;
  };
  const from = await height(filter.fromBlock), to = await height(filter.toBlock);
  if (from === null || to === null || to < from || to - from < 100n) return upstream(request);
  const logs = [];
  for (let start = from; start <= to; start += 100n) {
    const end = start + 99n < to ? start + 99n : to;
    const response = await upstream({ ...request, params: [{ ...filter, fromBlock: '0x' + start.toString(16), toBlock: '0x' + end.toString(16) }] });
    if (response.error) return response;
    logs.push(...response.result);
  }
  return { jsonrpc: '2.0', id: request.id, result: logs };
}

async function startProxy(url, port) {
  let queue = Promise.resolve(), lastStarted = 0;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const upstream = request => {
    const operation = queue.then(async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        await pause(Math.max(0, 2000 - (Date.now() - lastStarted)));
        lastStarted = Date.now();
        const response = await fetch(url, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request), signal: AbortSignal.timeout(20000),
        });
        if (response.status === 429 && attempt < 3) {
          const retrySeconds = Number(response.headers.get('retry-after'));
          await response.body?.cancel();
          await pause(Math.max(5000 * 2 ** attempt, Number.isFinite(retrySeconds) ? retrySeconds * 1000 : 0));
          continue;
        }
        if (!response.ok) throw new Error('Fuji RPC HTTP ' + response.status);
        return response.json();
      }
    });
    queue = operation.catch(() => {});
    return operation;
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method !== 'POST') { res.writeHead(405); res.end('{}'); return; }
    let request;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 1048576) throw new Error('Request too large'); chunks.push(chunk); }
      request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const reply = Array.isArray(request) ? await Promise.all(request.map(r => query(r, upstream))) : await query(request, upstream);
      res.end(JSON.stringify(reply));
    } catch (error) {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32000, message: error.message } }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}
module.exports = { query, startProxy };
