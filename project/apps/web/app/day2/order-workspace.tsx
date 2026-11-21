'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatEther, sha256, toBytes } from 'viem';
import { useAccount, useConnect, useSignMessage, useSwitchChain } from 'wagmi';
import { DEFAULT_AGENT_ID, FUJI_CHAIN_ID, LOCAL_CHAIN_ID, ORDER_STATUS_LABELS } from '../contracts';
import styles from './day2.module.css';

export type Result = { summary: string; keyPoints: string[]; caveats: string[] };
type Execution = { result: Result; resultHash: string; mode: string };
type ChatMessage = { role: 'user' | 'assistant'; content: string };
type ServiceOrder = {
  orderId: string;
  scope: string;
  buyer: string;
  agentId: string;
  priceWei: string;
  status: number;
  warranty: boolean;
  execution: { status: string } | null;
};

export function Summary({ result }: { result: Result }) {
  return (
    <>
      <p>{result.summary}</p>
      <ul>{result.keyPoints.map((point, index) => <li key={index}>{point}</li>)}</ul>
      {result.caveats.length > 0 && <p className={styles.note}>{result.caveats.join(' ')}</p>}
    </>
  );
}

function formatError(error: unknown, fallback: string) {
  if (!(error instanceof Error)) return fallback;
  const firstLine = error.message.split('\n', 1)[0];
  if (/user (rejected|denied)/i.test(firstLine)) return 'Bạn đã từ chối ký trong ví.';
  return firstLine.length <= 200 ? firstLine : fallback;
}

export function OrderWorkspace({ orderId }: { orderId: string }) {
  const { address, chainId } = useAccount();
  const { connect, connectors, isPending: connecting, error: connectError } = useConnect();
  const { switchChain, isPending: switching, error: switchError } = useSwitchChain();
  const orderQuery = useQuery({
    queryKey: ['service-workspace-order', orderId],
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/day2/orders/${orderId}`, { cache: 'no-store', signal });
      const data = await response.json();
      if (response.status === 404) throw new Error('Chưa thấy đơn đã xác nhận. Kiểm tra Order ID, hoặc làm mới sau khi giao dịch đủ xác nhận.');
      if (!response.ok) throw new Error(data.error || 'Không tải được đơn.');
      return data as ServiceOrder;
    },
  });
  const order = orderQuery.data;
  const expectedChain = Number(order?.scope.split(':')[0]);
  const supportedChain = expectedChain === FUJI_CHAIN_ID || expectedChain === LOCAL_CHAIN_ID;
  const isBuyer = !!address && address.toLowerCase() === order?.buyer.toLowerCase();
  const canUseOrder = order && isBuyer && supportedChain && chainId === expectedChain
    && order.agentId === DEFAULT_AGENT_ID && !order.warranty;

  return (
    <main className={styles.workspace}>
      <nav className={styles.workspaceNav} aria-label="Marketplace">
        <Link href={`/day3?order=${orderId}#service-order`}>← Về đơn hàng</Link>
        <Link href="/day3#my-services">Dịch vụ đã mua</Link>
        <Link href="/day3#service-listing">Mua dịch vụ</Link>
      </nav>
      <header>
        <h1>Document Summary</h1>
        <p>Tóm tắt và hỏi đáp trong đơn đã mua.</p>
        <p className={styles.mono}>{orderId}</p>
      </header>
      <section className={styles.panel} aria-label="Thông tin đơn và ví Buyer">
        {order && (
          <>
            <p className={styles.status}>{ORDER_STATUS_LABELS[order.status]} · {formatEther(BigInt(order.priceWei))} AVAX</p>
            <p className={styles.mono}>Ví Buyer {order.buyer}</p>
          </>
        )}
        {orderQuery.isFetching && <p role="status">Đang kiểm tra đơn…</p>}
        {orderQuery.isError && (
          <>
            <p role="alert">{formatError(orderQuery.error, 'Không tải được đơn.')}</p>
            <button disabled={orderQuery.isFetching} onClick={() => void orderQuery.refetch()}>Thử tải lại đơn</button>
          </>
        )}
        {!address && (
          <div className={styles.actions}>
            {connectors.map(connector => (
              <button key={connector.uid} disabled={connecting} onClick={() => connect({ connector })}>
                {connecting ? 'Đang kết nối…' : `Kết nối ${connector.id === 'injected' ? 'ví Buyer' : connector.name}`}
              </button>
            ))}
          </div>
        )}
        {address && order && !isBuyer && <p role="status">Chuyển sang ví Buyer của đơn này trong Core để sử dụng AI.</p>}
        {order && (!supportedChain || order.agentId !== DEFAULT_AGENT_ID || order.warranty) && (
          <p role="status">Đơn này chưa hỗ trợ workspace Document Summary.</p>
        )}
        {isBuyer && supportedChain && chainId !== expectedChain && (
          <button disabled={switching} onClick={() => switchChain({ chainId: expectedChain })}>
            {switching ? 'Đang chuyển mạng…' : `Chuyển sang ${expectedChain === FUJI_CHAIN_ID ? 'Fuji (43113)' : 'Hardhat Local (31337)'}`}
          </button>
        )}
        {(connectError || switchError) && <p role="alert">{formatError(connectError || switchError, 'Kiểm tra lại kết nối ví.')}</p>}
      </section>
      {canUseOrder && (
        <OrderActions key={`${order.scope}:${orderId}:${address}`} order={order} />
      )}
    </main>
  );
}

function OrderActions({ order }: { order: ServiceOrder }) {
  const { signMessageAsync } = useSignMessage();
  const [document, setDocument] = useState('');
  const [execution, setExecution] = useState<Execution>();
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState('');
  const [model, setModel] = useState('');
  const [pending, setPending] = useState<'execute' | 'result' | 'chat'>();
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const canRun = order.status === 1 && order.execution?.status !== 'delivered';

  async function signedRequest(endpoint: string, action: string, input: object) {
    const body = JSON.stringify(input);
    const expires = Math.floor(Date.now() / 1000) + 240;
    const digest = sha256(toBytes(body)).slice(2);
    const message = ['Warranty Day 2 request', order.scope, action, order.orderId, String(expires), digest].join('\n');
    setStatus('Xác nhận chữ ký trong ví Buyer.');
    const signature = await signMessageAsync({ message });
    setStatus(endpoint === 'chat' ? 'AI đang trả lời…' : 'Đang tải kết quả của đơn…');
    const response = await fetch(`/api/day2/orders/${order.orderId}/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Wallet-Expires': String(expires),
        'X-Wallet-Signature': signature,
      },
      body,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Yêu cầu AI không thành công.');
    return { data, inProgress: response.status === 202 };
  }

  async function loadSummary(run: boolean) {
    if (pending || (run && (!canRun || !document.trim()))) return;
    setPending(run ? 'execute' : 'result');
    setError('');
    try {
      const { data, inProgress } = run
        ? await signedRequest('execute', 'execute', { text: document.trim() })
        : await signedRequest('result', 'read-result', {});
      if (inProgress) {
        setStatus('Agent đang thực thi. Hãy thử lại sau với cùng nội dung tài liệu.');
        return;
      }
      setExecution(data);
      setStatus('');
    } catch (cause) {
      setError(formatError(cause, 'Không mở được kết quả của đơn.'));
      setStatus('');
    } finally {
      setPending(undefined);
    }
  }

  async function sendQuestion() {
    const content = question.trim();
    if (pending || !execution || !content) return;
    const next: ChatMessage[] = [...history, { role: 'user', content }];
    const messages = next.slice(-7).map(entry => ({
      role: entry.role, content: entry.content.slice(0, 2000).trim(),
    }));
    setPending('chat');
    setError('');
    try {
      const { data } = await signedRequest('chat', 'order-chat', { messages });
      setHistory([...next, { role: 'assistant', content: data.reply }]);
      setQuestion('');
      setModel(data.model);
    } catch (cause) {
      setError(formatError(cause, 'Không gửi được câu hỏi.'));
    } finally {
      setStatus('');
      setPending(undefined);
    }
  }

  return (
    <div className={styles.grid}>
      <section className={styles.panel} aria-label="Tóm tắt và Result hash">
        <h2>Kết quả dịch vụ</h2>
        {execution ? (
          <>
            <Summary result={execution.result} />
            <p className={styles.note}>Gửi Order ID và Result hash này cho Seller để xác nhận bàn giao.</p>
            <code className={styles.mono}>{execution.resultHash}</code>
          </>
        ) : canRun ? (
          <>
            <label htmlFor="order-document">Tài liệu cần tóm tắt</label>
            <textarea id="order-document" rows={5} value={document} maxLength={12000} disabled={!!pending}
              onChange={event => setDocument(event.target.value)} />
            <div className={styles.actions}>
              <button disabled={!!pending || !document.trim()} onClick={() => void loadSummary(true)}>Ký và tóm tắt</button>
            </div>
          </>
        ) : order.execution?.status === 'delivered' ? (
          <button disabled={!!pending} onClick={() => void loadSummary(false)}>Ký để mở kết quả đã lưu</button>
        ) : (
          <p>Đơn này chưa có kết quả tóm tắt.</p>
        )}
      </section>
      <section className={styles.panel} aria-label="Hỏi đáp theo đơn">
        <h2>Hỏi AI về tài liệu</h2>
        {!execution ? (
          <p>Tóm tắt tài liệu hoặc mở kết quả đã lưu để bắt đầu hỏi đáp.</p>
        ) : (
          <>
            <p className={styles.note}>AI dùng dữ liệu của đơn này để trả lời. Mỗi câu hỏi cần chữ ký ví Buyer.</p>
            {history.length > 0 && (
              <div className={styles.chatLog} aria-live="polite" tabIndex={0}>
                {history.map((entry, index) => (
                  <p key={index}><strong>{entry.role === 'user' ? 'Bạn' : 'AI'}:</strong> {entry.content}</p>
                ))}
              </div>
            )}
            <label htmlFor="order-question">Câu hỏi tiếp theo</label>
            <textarea id="order-question" rows={3} maxLength={2000} value={question} disabled={!!pending}
              onChange={event => setQuestion(event.target.value)} />
            <button disabled={!!pending || !question.trim()} onClick={() => void sendQuestion()}>Ký và gửi câu hỏi</button>
            {model && <p className={styles.note}>Model trả lời: {model}</p>}
          </>
        )}
      </section>
      {(status || error) && (
        <p className={styles.workspaceFeedback} role={error ? 'alert' : 'status'}>
          {error || status}
        </p>
      )}
    </div>
  );
}
