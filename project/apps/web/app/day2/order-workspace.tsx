'use client';

import Link from 'next/link';
import { useState, type ChangeEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatEther, sha256, toBytes } from 'viem';
import { useAccount, useConnect, useSignMessage, useSwitchChain } from 'wagmi';
import { DEFAULT_AGENT_ID, FUJI_CHAIN_ID, LOCAL_CHAIN_ID, ORDER_STATUS_LABELS } from '../contracts';
import { MAX_DOCUMENT_CHARACTERS, readDocumentFile } from './document-file';
import styles from './day2.module.css';

type Result = { summary: string; keyPoints: string[]; caveats: string[] };
type Execution = { result: Result; resultHash: string; mode: string; document?: string };
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
  request: { source: string } | null;
};

function Summary({ result }: { result: Result }) {
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
        <h1>Tóm tắt và hỏi đáp tài liệu</h1>
        <p>Dịch vụ Document Summary · Order ID</p>
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
        <OrderActions key={`${order.scope}:${orderId}:${address}`} order={order} refreshOrder={orderQuery.refetch} />
      )}
    </main>
  );
}

type Action = 'execute' | 'retry' | 'result' | 'chat';
const ORDER_ACTIONS = {
  execute: 'execute',
  retry: 'retry-execute',
  result: 'read-result',
  chat: 'order-chat',
} as const;

function OrderActions({ order, refreshOrder }: { order: ServiceOrder; refreshOrder: () => Promise<unknown> }) {
  const { signMessageAsync } = useSignMessage();
  const [document, setDocument] = useState('');
  const [readingFile, setReadingFile] = useState(false);
  const [fileName, setFileName] = useState('');
  const [fileError, setFileError] = useState('');
  const [execution, setExecution] = useState<Execution>();
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState('');
  const [model, setModel] = useState('');
  const [pending, setPending] = useState<Action>();
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const hasSummary = order.execution?.status === 'delivered';
  const canRun = order.status === 1 && !hasSummary;
  const hasSavedDocument = !!order.request;

  async function importDocument(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || readingFile || pending) return;
    setReadingFile(true);
    setFileError('');
    try {
      setDocument(await readDocumentFile(file));
      setFileName(file.name);
      setError('');
    } catch (cause) {
      setFileError(formatError(cause, 'Không đọc được tệp. Hãy thử lại hoặc dán văn bản.'));
    } finally {
      setReadingFile(false);
    }
  }

  async function signedRequest(endpoint: Action, input: object) {
    const body = JSON.stringify(input);
    const expires = Math.floor(Date.now() / 1000) + 240;
    const digest = sha256(toBytes(body)).slice(2);
    const message = ['Warranty Day 2 request', order.scope, ORDER_ACTIONS[endpoint], order.orderId, String(expires), digest].join('\n');
    setStatus('Xác nhận chữ ký trong ví Buyer.');
    const signature = await signMessageAsync({ message });
    setStatus(endpoint === 'chat' ? 'AI đang trả lời câu hỏi…' : endpoint === 'result'
      ? 'Đang mở kết quả của đơn…' : 'AI đang tóm tắt tài liệu…');
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

  async function loadSummary(action: Exclude<Action, 'chat'>) {
    const text = document.trim();
    if (pending || (action === 'execute' && (readingFile || !canRun || !text || hasSavedDocument))) return;
    setPending(action);
    setError('');
    try {
      const { data, inProgress } = await signedRequest(action, action === 'execute' ? { text } : {});
      if (inProgress) {
        setStatus('AI đang xử lý tài liệu của đơn. Hãy chờ rồi kiểm tra lại.');
        await refreshOrder();
        return;
      }
      setExecution(action === 'execute' ? { ...data, document: text } : data);
      setStatus('');
    } catch (cause) {
      setError(formatError(cause, 'Không mở được kết quả của đơn.'));
      setStatus('');
      if (action !== 'result') await refreshOrder();
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
      const { data } = await signedRequest('chat', { messages });
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
        <h2>Tài liệu và bản tóm tắt</h2>
        {execution ? (
          <>
            <p className={styles.status}>{execution.mode === 'mock' ? 'Tóm tắt mô phỏng' : 'Đã tóm tắt qua OpenRouter'}</p>
            <Summary result={execution.result} />
            {execution.document && (
              <details className={styles.sourceDocument}>
                <summary>Xem tài liệu đã gửi cho đơn</summary>
                <p>{execution.document}</p>
              </details>
            )}
            <p className={styles.note}>Gửi Order ID và Result hash này cho Seller để xác nhận bàn giao.</p>
            <code className={styles.mono}>{execution.resultHash}</code>
          </>
        ) : hasSummary ? (
          <button disabled={!!pending} onClick={() => void loadSummary('result')}>Ký để mở bản tóm tắt đã lưu</button>
        ) : canRun && hasSavedDocument ? (
          <>
            <p>Đơn đã gắn với một tài liệu. Bạn có thể tiếp tục tóm tắt chính tài liệu đó mà không cần nhập lại.</p>
            <button disabled={!!pending} onClick={() => void loadSummary('retry')}>
              {order.execution?.status === 'running' ? 'Ký để kiểm tra bản tóm tắt' : 'Ký và thử lại tài liệu đã lưu'}
            </button>
          </>
        ) : canRun ? (
          <>
            <div className={styles.filePicker}>
              <input id="order-document-file" type="file"
                accept=".docx,.txt,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
                aria-describedby="order-document-file-hint" disabled={!!pending || readingFile} onChange={importDocument} />
              <label htmlFor="order-document-file">Tải tệp để tóm tắt</label>
            </div>
            <p className={styles.note} id="order-document-file-hint">.docx hoặc .txt (UTF-8), tối đa 10 MB và 12.000 ký tự.</p>
            {fileError && <p className={styles.workspaceFeedback} role="alert">{fileError}</p>}
            {readingFile && <p className={styles.note} role="status">Đang đọc tệp…</p>}
            {!readingFile && fileName && (
              <p className={styles.fileStatus} role="status">Đã trích văn bản từ {fileName}. Kiểm tra nội dung bên dưới trước khi ký.</p>
            )}
            <label htmlFor="order-document">Văn bản cần tóm tắt</label>
            <textarea id="order-document" rows={5} value={document} maxLength={MAX_DOCUMENT_CHARACTERS}
              disabled={!!pending || readingFile} placeholder="Dán, nhập hoặc chỉnh sửa văn bản đã trích từ tệp"
              onChange={event => setDocument(event.target.value)} />
            <p className={styles.note}>Mỗi đơn dùng một tài liệu. Nếu bạn muốn gửi tài liệu khác, hãy tạo đơn mới.</p>
            <div className={styles.actions}>
              <button disabled={!!pending || readingFile || !document.trim()} onClick={() => void loadSummary('execute')}>Ký và tóm tắt</button>
            </div>
          </>
        ) : (
          <p>Đơn này chưa có kết quả tóm tắt.</p>
        )}
      </section>
      <section className={styles.panel} aria-label="Hỏi đáp theo đơn">
        <h2>Hỏi tiếp về tài liệu của đơn</h2>
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
            <label htmlFor="order-question">Câu hỏi về tài liệu</label>
            <textarea id="order-question" rows={3} maxLength={2000} value={question} disabled={!!pending}
              placeholder="Ví dụ: Tài liệu quy định thời hạn bàn giao bao lâu?"
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
