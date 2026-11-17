const { expect } = require('chai');
const { predicateKeys } = require('../../services/relayer-monitor/warp-delivery');
const { query } = require('../../services/relayer-monitor/fuji-rpc-proxy');
describe('Authenticated relay transport helpers', function () {
  it('preserves a Warp message, adds FF delimiter and rejects a substituted message', function () {
    const signed = '0x' + '11'.repeat(32) + '22'.repeat(32);
    const keys = predicateKeys(signed, '0x' + '11'.repeat(32));
    expect(keys).to.have.length(3);
    expect(keys[2]).to.equal('0xff' + '00'.repeat(31));
    expect(() => predicateKeys(signed, '0x' + '33'.repeat(32))).to.throw('different unsigned');
  });
  it('splits inclusive log ranges into at most 100 blocks, preserving filters and order', async function () {
    const calls = [];
    const request = { jsonrpc: '2.0', id: 9, method: 'eth_getLogs', params: [{ fromBlock: '0x64', toBlock: '0x12b', address: '0xabc', topics: ['0xdef'] }] };
    const result = await query(request, async r => { calls.push(r.params[0]); return { result: [r.params[0].fromBlock] }; });
    expect(calls.map(c => [c.fromBlock, c.toBlock])).to.deep.equal([['0x64', '0xc7'], ['0xc8', '0x12b']]);
    expect(calls.every(c => c.address === '0xabc' && c.topics[0] === '0xdef')).to.equal(true);
    expect(result).to.deep.equal({ jsonrpc: '2.0', id: 9, result: ['0x64', '0xc8'] });
    const error = { jsonrpc: '2.0', id: 9, error: { code: -32000, message: 'upstream unavailable' } };
    expect(await query(request, async () => error)).to.equal(error);
  });
});
