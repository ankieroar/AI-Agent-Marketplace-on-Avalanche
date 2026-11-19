'use client';

import { useEffect, useState } from 'react';
import {
  useAccount,
  useConnect,
  useDisconnect,
  useSwitchChain,
  useSignMessage,
  useSignTypedData,
  usePublicClient,
  useReadContract,
  useWalletClient,
} from 'wagmi';
import {
  sha256,
  toBytes,
  formatEther,
  keccak256,
  stringToHex,
  parseSignature,
  isAddress,
  decodeEventLog,
  numberToHex,
  type EIP1193Provider,
} from 'viem';
import { hardhat } from 'viem/chains';
import styles from './day3.module.css';
import {
  FUJI_CHAIN_ID,
  LOCAL_CHAIN_ID,
  EXPLORERS,
  DEFAULT_ADDRESSES,
  serviceOrderManagerAbi,
  marketplaceGatewayAbi,
  agentRegistryAbi,
  disputeManagerAbi,
  disputeResultSenderAbi,
  settlementEscrowAbi,
  ORDER_STATUS_LABELS,
  CASE_STATUS_LABELS,
  DEFAULT_AGENT_ID,
  serviceQuoteTypes,
  serviceQuoteDomain,
  zeroAddress,
  type LocalAddresses,
} from '../contracts';

type Role = 'buyer' | 'seller' | 'reviewer';
type Result = { summary: string; keyPoints: string[]; caveats: string[] };

type SignedQuote = {
  buyer: `0x${string}`;
  agentId: `0x${string}`;
  salt: `0x${string}`;
  commitment: `0x${string}`;
  policyVersionHash: `0x${string}`;
  priceWei: string;
  validUntil: string;
  orderId: `0x${string}`;
  v: number;
  r: `0x${string}`;
  s: `0x${string}`;
  chainId: number;
  orderManager: `0x${string}`;
};

type ListingView = {
  seller: `0x${string}`;
  priceWei: bigint;
  policyVersionHash: `0x${string}`;
  disputeWindow: bigint;
  active: boolean;
  approved: boolean;
};

type OrderView = {
  orderId: string;
  agentId: string;
  buyer: string;
  seller: string;
  priceWei: bigint;
  status: number;
  resultHash: string;
  caseId: string;
};

type CaseView = {
  claim: {
    caseId: string;
    orderId: string;
    policyCommitment: string;
    claimTimestamp: bigint;
    lockedAmount: bigint;
    purchaseTimestamp: bigint;
    claimDeadline: bigint;
  };
  status: number;
  payoutAmount: bigint;
  proofRef: string;
  reviewerApprovalRef: string;
  resolutionSent: boolean | null;
};

type Feedback = {
  type: 'error' | 'success' | 'info';
  message: string;
  details?: string;
};

type AuditEntry = { id: number; time: string; text: string; txHash?: string; chainId?: number };

const QUOTE_KEY = 'day3-service-quote';
const EXPIRY_SKEW_SECONDS = 30;
const ZERO_BYTES32 = `0x${'0'.repeat(64)}`;
const REVIEWER_CONFIRMATIONS = {
  analyze: 'Đã bắt đầu phân tích. Bạn có thể tạo ZK proof.',
  beginReview: 'Case đã chuyển sang xét duyệt.',
  approve: 'Đã duyệt hoàn tiền. Gửi phán quyết tới escrow để ghi có cho Buyer.',
  reject: 'Đã từ chối hoàn tiền. Gửi phán quyết tới escrow để chốt đơn.',
  sendResolution: 'Escrow đã ghi nhận phán quyết. Ví nhận tiền có thể rút trong mục Số dư escrow.',
};

function errorText(err: unknown) {
  if (err && typeof err === 'object') {
    const value = err as { shortMessage?: string; message?: string };
    return value.shortMessage || value.message || 'Lỗi không xác định';
  }
  return 'Lỗi không xác định';
}

function operationError(error: unknown, fallback: string): Feedback {
  const shortMessage = errorText(error);
  const fullMessage = error instanceof Error ? error.message : shortMessage;
  const isTechnical = /\n|0x[0-9a-f]{64}|revert|execution failed|request arguments|\bRPC\b/i.test(fullMessage)
    || fullMessage.length > 180;
  const messageWithReason = `${fallback} ${shortMessage}`;
  let message = isTechnical ? fallback : messageWithReason;
  if (/user rejected|user denied|rejected by (the )?user/i.test(fullMessage)) {
    message = 'Bạn đã từ chối yêu cầu trong ví. Thử lại khi sẵn sàng.';
  } else if (/insufficient funds|insufficient balance/i.test(fullMessage)) {
    message = 'Ví không đủ số dư để thực hiện giao dịch. Kiểm tra số dư và phí gas.';
  }
  return {
    type: 'error',
    message,
    details: message === messageWithReason ? undefined : fullMessage,
  };
}

function FeedbackNotice({
  feedback, pending = false, onDismiss,
}: {
  feedback: Feedback;
  pending?: boolean;
  onDismiss?: () => void;
}) {
  return (
    <div
      className={styles.notice}
      data-tone={feedback.type}
      role={feedback.type === 'error' ? 'alert' : 'status'}
    >
      <span className={pending ? styles.spinner : styles.noticeIcon} aria-hidden="true">
        {!pending && (feedback.type === 'success' ? '✓' : feedback.type === 'error' ? '!' : 'i')}
      </span>
      <div className={styles.noticeBody}>
        <div>{feedback.message}</div>
        {feedback.details && (
          <details key={feedback.details} className={styles.errorDetails}>
            <summary>Xem toàn bộ lỗi</summary>
            <pre tabIndex={0} aria-label="Chi tiết lỗi">{feedback.details}</pre>
          </details>
        )}
      </div>
      {onDismiss && !pending && (
        <button className={styles.dismissNotice} aria-label="Đóng thông báo" onClick={onDismiss}>×</button>
      )}
    </div>
  );
}

function sameAddress(left?: string, right?: string) {
  return !!left && !!right && left.toLowerCase() === right.toLowerCase();
}

function isHex32(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function readOrder(orderId: string, data: any): OrderView {
  return {
    orderId,
    agentId: (data.agentId ?? data[0]) as string,
    buyer: (data.buyer ?? data[1]) as string,
    seller: (data.seller ?? data[2]) as string,
    priceWei: BigInt(data.priceWei ?? data[3]),
    status: Number(data.status ?? data[4]),
    resultHash: (data.resultHash ?? data[5]) as string,
    caseId: (data.caseId ?? data[6]) as string,
  };
}

function formatPayout(value: string) {
  try {
    return `${formatEther(BigInt(value))} AVAX`;
  } catch {
    return value;
  }
}

function parseQuote(raw: string): SignedQuote {
  const value = JSON.parse(raw) as Partial<SignedQuote>;
  if (!value || typeof value !== 'object') throw new Error('Quote JSON không hợp lệ');
  const hexFields: Array<keyof SignedQuote> = ['orderId', 'agentId', 'salt', 'commitment', 'policyVersionHash'];
  for (const field of hexFields) {
    if (!isHex32(value[field])) throw new Error(`Quote thiếu ${field} hợp lệ`);
  }
  if (typeof value.buyer !== 'string' || !isAddress(value.buyer) ||
      typeof value.orderManager !== 'string' || !isAddress(value.orderManager)) {
    throw new Error('Quote có địa chỉ Buyer hoặc ServiceOrderManager không hợp lệ');
  }
  if (typeof value.priceWei !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value.priceWei)) {
    throw new Error('Quote priceWei không hợp lệ');
  }
  if (typeof value.validUntil !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value.validUntil)) {
    throw new Error('Quote validUntil không hợp lệ');
  }
  if (typeof value.v !== 'number' || !isHex32(value.r) || !isHex32(value.s)) {
    throw new Error('Quote thiếu chữ ký v/r/s');
  }
  if (typeof value.chainId !== 'number') throw new Error('Quote thiếu chainId');
  return value as SignedQuote;
}

const EXAMPLE_DOC = `Hợp đồng dịch vụ thử nghiệm Hackathon:
Bên B cam kết cung cấp dịch vụ tóm tắt hồ sơ trong vòng 24 giờ kể từ thời điểm nhận thanh toán.
Giá dịch vụ: 0.01 AVAX.
Cửa sổ mở khiếu nại: 3600 giây (1 giờ).
Mức bồi hoàn tối đa khi có tranh chấp: 0.005 AVAX.
Trường hợp bất khả kháng hoặc thiếu dữ liệu đầu vào cần thông báo cho bên A trong 2 giờ.`;

export default function Day3Page() {
  // --- Wallet & Chain State ---
  const { address, connector, isConnected, chain, chainId } = useAccount();
  const { connect, connectors, error: connectError, isPending: connecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const { signMessageAsync } = useSignMessage();
  const { signTypedDataAsync } = useSignTypedData();

  // Local deployment addresses change on every Hardhat restart; testnet ones
  // come from NEXT_PUBLIC_* env vars. Never derive one chain's address from the
  // other chain's wallet state.
  const isFujiDeployment = process.env.NEXT_PUBLIC_DAY3_TRANSPORT === 'fuji-only';
  const isLocal = !isFujiDeployment;
  const settlementChainId = isLocal ? LOCAL_CHAIN_ID : FUJI_CHAIN_ID;
  const disputeChainId = settlementChainId;
  const settlementClient = usePublicClient({ chainId: settlementChainId });
  const disputeClient = usePublicClient({ chainId: disputeChainId });
  const { data: walletClient } = useWalletClient();

  const [runtimeAddresses, setRuntimeAddresses] = useState<Partial<LocalAddresses> | null>(null);
  const [runtimeError, setRuntimeError] = useState<Feedback | null>(null);

  // --- UI & Role Mode ---
  const [activeRole, setActiveRole] = useState<Role>('buyer');
  const [activeTab, setActiveTab] = useState<'marketplace' | 'seller' | 'reviewer'>('marketplace');

  // --- Contract Addresses (Configurable / Default) ---
  const [customOrderManager, setCustomOrderManager] = useState('');
  const [customGateway, setCustomGateway] = useState('');
  const [customDisputeManager, setCustomDisputeManager] = useState('');
  const [customResultSender, setCustomResultSender] = useState('');
  const [customEscrow, setCustomEscrow] = useState('');

  const settlementBook: LocalAddresses = isLocal
    ? { ...DEFAULT_ADDRESSES.local, ...(runtimeAddresses ?? {}) }
    : {
        serviceOrderManager: DEFAULT_ADDRESSES.fuji.serviceOrderManager,
        marketplaceGateway: DEFAULT_ADDRESSES.fuji.marketplaceGateway,
        agentRegistry: DEFAULT_ADDRESSES.fuji.agentRegistry,
        escrow: DEFAULT_ADDRESSES.fuji.escrow,
        disputeManager: DEFAULT_ADDRESSES.disputeL1.disputeManager,
        resultSender: DEFAULT_ADDRESSES.disputeL1.resultSender,
      };
  const disputeBook: LocalAddresses = isLocal
    ? { ...DEFAULT_ADDRESSES.local, ...(runtimeAddresses ?? {}) }
    : {
        serviceOrderManager: DEFAULT_ADDRESSES.fuji.serviceOrderManager,
        marketplaceGateway: DEFAULT_ADDRESSES.fuji.marketplaceGateway,
        agentRegistry: DEFAULT_ADDRESSES.fuji.agentRegistry,
        escrow: DEFAULT_ADDRESSES.fuji.escrow,
        disputeManager: DEFAULT_ADDRESSES.disputeL1.disputeManager,
        resultSender: DEFAULT_ADDRESSES.disputeL1.resultSender,
      };

  const orderManagerAddress = (customOrderManager.trim() || settlementBook.serviceOrderManager) as `0x${string}`;
  const gatewayAddress = (customGateway.trim() || settlementBook.marketplaceGateway) as `0x${string}`;
  const agentRegistryAddress = settlementBook.agentRegistry as `0x${string}`;
  const escrowAddress = (customEscrow.trim() || settlementBook.escrow) as `0x${string}`;
  const disputeManagerAddress = (customDisputeManager.trim() || disputeBook.disputeManager) as `0x${string}`;
  const resultSenderAddress = (customResultSender.trim() || disputeBook.resultSender) as `0x${string}`;

  // --- Buyer / Marketplace States ---
  const [orderId, setOrderIdState] = useState<string>('');
  const [documentText, setDocumentText] = useState(EXAMPLE_DOC);
  const [loadedOrder, setOrderOnChain] = useState<OrderView | null>(null);
  const orderOnChain = sameAddress(loadedOrder?.orderId, orderId.trim()) ? loadedOrder : null;

  const [aiResult, setAiResult] = useState<(Result & { mode: string; hash: string }) | null>(null);
  const [caseId, setCaseId] = useState<string>('');
  const [evidenceText, setEvidenceText] = useState('Dịch vụ thiếu các điều khoản bắt buộc và không hoàn thành đúng tiến độ.');

  // --- Listing & Quote States ---
  const [listing, setListing] = useState<ListingView | null>(null);
  const [listingBusy, setListingBusy] = useState(false);
  const [listingError, setListingError] = useState('');
  const [buyerForQuote, setBuyerForQuote] = useState('');
  const [quoteMinutes, setQuoteMinutes] = useState('30');
  const [signedQuote, setSignedQuote] = useState<SignedQuote | null>(null);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [showQuotePaste, setShowQuotePaste] = useState(false);
  const [quotePaste, setQuotePaste] = useState('');
  const [sellerResultHash, setSellerResultHash] = useState('');
  const [witnessFile, setWitnessFile] = useState('');

  // --- Reviewer States ---
  const [reviewerAddress, setReviewerAddress] = useState('');
  const [pipelineBusy, setPipelineBusy] = useState(false);
  const [pipelineResult, setPipelineResult] = useState<{
    mode: string;
    model?: string;
    note?: string;
    evidence: {
      purchaseDate: string | null;
      faultDescription: string;
      missingEvidence: string[];
    };
    analysis: {
      eligible: boolean;
      reasons: string[];
    };
    resolution: {
      proposedPayout: string;
      reason: string;
      requiresHumanReview: boolean;
    };
  } | null>(null);

  const [loadedReviewerCase, setReviewerCase] = useState<CaseView | null>(null);
  const reviewerCase = sameAddress(loadedReviewerCase?.claim.caseId, caseId.trim()) ? loadedReviewerCase : null;
  const [proofJson, setProofJson] = useState('');
  const [refundWei, setRefundWei] = useState('');
  const [generatingProof, setGeneratingProof] = useState(false);
  const [sendingEvidence, setSendingEvidence] = useState(false);
  async function prepareCaseProof() {
    const id = caseId.trim().toLowerCase();
    if (!isHex32(id) || reviewerCase?.claim.caseId.toLowerCase() !== id) {
      setFeedback({ type: 'error', message: 'Tra cứu đúng Case ID trước khi tạo proof.' });
      return;
    }
    const requestedRefund = refundWei.trim();
    if (requestedRefund && !/^[1-9][0-9]*$/.test(requestedRefund)) {
      setFeedback({ type: 'error', message: 'Số tiền hoàn phải là số nguyên lớn hơn 0, tính bằng wei.' });
      return;
    }
    setBusy(true);
    setGeneratingProof(true);
    setProofJson('');
    setFeedback({ type: 'info', message: 'Đang tạo ZK proof bằng WASM…' });
    try {
      const response = await fetch('/api/day3/cases/' + id + '/prepare-proof', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify(requestedRefund ? { refundWei: requestedRefund } : {}),
      });
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 409 && result.error === 'refundWei is required until an analysis is available for this case') {
          throw new Error('Worker chưa lưu mức hoàn cho case này. Nhập số tiền hoàn bằng wei rồi tạo proof lại.');
        }
        throw new Error(result.error || 'Không tạo được proof');
      }
      setProofJson(JSON.stringify({proof:result.proof,publicInputs:result.publicInputs}));
      setRefundWei(result.payoutWei);
      setFeedback({type:'success',message:`Đã tạo proof cho ${formatPayout(result.payoutWei)}. Kiểm tra số tiền rồi ký nộp proof.`});
    } catch (error) {
      setFeedback(operationError(error, 'Tạo ZK proof thất bại.'));
    } finally {
      setGeneratingProof(false);
      setBusy(false);
    }
  }

  // --- Timeline & Operation Feeds ---
  const [logs, setLogs] = useState<AuditEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [addingLocalNetwork, setAddingLocalNetwork] = useState(false);

  const addLog = (text: string, txHash?: string, chainId?: number) => {
    const time = new Date().toLocaleTimeString('vi-VN');
    setLogs((prev) => [{ id: prev.length + 1, time, text, txHash, chainId }, ...prev]);
  };

  const isReviewerWallet = sameAddress(address, reviewerAddress);
  const isSellerWallet = !!address && sameAddress(address, listing?.seller);
  const isOrderBuyer = !!address && sameAddress(address, orderOnChain?.buyer);
  const onSettlementChain = chain?.id === settlementChainId;
  const quoteForConnectedBuyer = !!signedQuote && sameAddress(signedQuote.buyer, address);
  const quoteDomainMatches =
    !!signedQuote && signedQuote.chainId === settlementChainId && sameAddress(signedQuote.orderManager, orderManagerAddress);
  const quotePriceMatches =
    !!signedQuote && !!listing && BigInt(signedQuote.priceWei) === listing.priceWei;
  const quoteExpired = !!signedQuote && Number(signedQuote.validUntil) <= Math.floor(Date.now() / 1000);

  // --- Load local deployment manifest (Hardhat restarts change addresses) ---
  useEffect(() => {
    if (!isLocal) {
      setRuntimeAddresses(null);
      setRuntimeError(null);
      return;
    }
    let alive = true;
    fetch('/api/day3/config', { cache: 'no-store' })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Không đọc được manifest local');
        if (data.chainId !== LOCAL_CHAIN_ID || data.transport !== 'same-chain') {
          throw new Error('Manifest local không khớp Hardhat 31337. Chạy lại script chuẩn bị contract local.');
        }
        return data as { addresses: Partial<LocalAddresses> };
      })
      .then((data) => {
        if (!alive) return;
        setRuntimeAddresses(data.addresses);
        setRuntimeError(null);
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setRuntimeAddresses(null);
        setRuntimeError(operationError(error, 'Không đọc được cấu hình contract local.'));
      });
    return () => {
      alive = false;
    };
  }, [isLocal]);

  async function registerSummaryAgent() {
    if (!walletClient || !settlementClient || !(await ensureChain(settlementChainId))) return;
    setBusy(true);
    try {
      const hash = await walletClient.writeContract({address:agentRegistryAddress,abi:agentRegistryAbi,
        functionName:'registerAgent',args:[DEFAULT_AGENT_ID,10000000000000000n,'document-summary',
          keccak256(stringToHex('document-summary-policy-v1')),3600n]});
      const receipt = await settlementClient.waitForTransactionReceipt({hash});
      if (receipt.status !== 'success') throw new Error('Đăng ký listing thất bại');
      await loadListing();
    } catch (error) { setFeedback(operationError(error, 'Không đăng ký được listing.')); }
    finally { setBusy(false); }
  }

  // --- Load listing from AgentRegistry ---
  async function loadListing() {
    if (!settlementClient || zeroAddress(agentRegistryAddress)) {
      setListing(null);
      if (zeroAddress(agentRegistryAddress)) setListingError('Chưa có địa chỉ AgentRegistry cho mạng này.');
      return;
    }
    setListingBusy(true);
    setListingError('');
    try {
      const data = (await settlementClient.readContract({
        address: agentRegistryAddress,
        abi: agentRegistryAbi,
        functionName: 'getAgent',
        args: [DEFAULT_AGENT_ID],
      })) as any;
      const seller = (data.seller ?? data[0]) as `0x${string}`;
      const priceWei = BigInt(data.priceWei ?? data[1]);
      const version = (data.policyVersionHash ?? data[3]) as `0x${string}`;
      const window = BigInt(data.disputeWindow ?? data[4]);
      const active = Boolean(data.active ?? data[5]);
      let approved = false;
      if (seller && !zeroAddress(seller)) {
        approved = (await settlementClient.readContract({
          address: agentRegistryAddress,
          abi: agentRegistryAbi,
          functionName: 'approvedSeller',
          args: [seller],
        })) as boolean;
      }
      const view: ListingView = { seller, priceWei, policyVersionHash: version, disputeWindow: window, active, approved };
      setListing(view);
      if (seller && zeroAddress(seller)) setListingError('Agent chưa được đăng ký trên mạng này.');
      if (seller && !sameAddress(seller, address)) setBuyerForQuote((prev) => prev || (address ?? ''));
    } catch (error) {
      setListing(null);
      const failure = operationError(error, 'Không đọc được listing.');
      setListingError(failure.message);
      setFeedback(failure);
    } finally {
      setListingBusy(false);
    }
  }

  useEffect(() => {
    void loadListing();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentRegistryAddress, settlementClient]);

  // --- Load reviewer role from DisputeManager ---
  useEffect(() => {
    const client = disputeClient;
    if (!client || zeroAddress(disputeManagerAddress)) {
      setReviewerAddress('');
      return;
    }
    let alive = true;
    client
      .readContract({ address: disputeManagerAddress, abi: disputeManagerAbi, functionName: 'reviewer' })
      .then((value) => {
        if (alive) setReviewerAddress(value as string);
      })
      .catch(() => {
        if (alive) setReviewerAddress('');
      });
    return () => {
      alive = false;
    };
  }, [disputeClient, disputeManagerAddress]);

  // --- Restore the last signed quote (same browser, role switching) ---
  useEffect(() => {
    const raw = typeof window === 'undefined' ? null : window.localStorage.getItem(QUOTE_KEY);
    if (!raw) return;
    try {
      const quote = parseQuote(raw);
      setSignedQuote(quote);
      setBuyerForQuote(quote.buyer);
      if (address) setOrderIdState(quote.orderId);
    } catch {
      window.localStorage.removeItem(QUOTE_KEY);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const {
    data: claimable,
    isFetching: loadingClaimable,
    isError: claimableUnavailable,
    refetch: refreshClaimable,
  } = useReadContract({
    address: escrowAddress,
    abi: settlementEscrowAbi,
    functionName: 'claimable',
    args: address ? [address] : undefined,
    chainId: settlementChainId,
    query: { enabled: !!address && !zeroAddress(escrowAddress) },
  });

  // --- Helper: Check Order On-Chain (always on the settlement chain) ---
  async function fetchOrder(idToQuery?: string) {
    const targetId = (idToQuery || orderId).trim().toLowerCase() as `0x${string}`;
    if (!isHex32(targetId)) {
      setFeedback({ type: 'error', message: 'Vui lòng nhập Order ID dạng hex 64 ký tự (0x...)' });
      return;
    }
    if (!settlementClient || zeroAddress(orderManagerAddress)) {
      setFeedback({ type: 'error', message: 'Chưa có địa chỉ ServiceOrderManager cho mạng này.' });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const data = await settlementClient.readContract({
        address: orderManagerAddress,
        abi: serviceOrderManagerAbi,
        functionName: 'orders',
        args: [targetId],
      });
      const order = readOrder(targetId, data);
      setOrderOnChain(order);
      setOrderIdState(targetId);
      if (isHex32(order.caseId) && order.caseId !== ZERO_BYTES32) setCaseId(order.caseId);
      if (address && !zeroAddress(escrowAddress)) void refreshClaimable();
      addLog(`Tra cứu Order on-chain thành công (${ORDER_STATUS_LABELS[order.status] || order.status})`, undefined, settlementChainId);
    } catch (error) {
      setFeedback(operationError(error, 'Không tra cứu được đơn hàng.'));
    } finally {
      setBusy(false);
    }
  }

  // --- Chain switch helper: switching is asynchronous, so never send a tx in
  // the same tick on the wrong chain. Ask the user to press the action again.
  async function ensureChain(target: number, retryAction = true) {
    if (!isConnected) {
      setFeedback({ type: 'error', message: 'Kết nối ví trước khi chuyển mạng.' });
      return false;
    }
    if (chainId === target) return true;
    try {
      await switchChainAsync({ chainId: target });
      setFeedback({ type: 'info', message: retryAction
        ? 'Đã chuyển mạng. Bấm lại thao tác để gửi giao dịch.'
        : 'Đã chuyển mạng.' });
    } catch (error) {
      setFeedback(operationError(error, target === LOCAL_CHAIN_ID
        ? 'Chưa chuyển được sang Hardhat Local. Nếu Core chưa có mạng này, bấm “Thêm Hardhat vào ví”.'
        : 'Không chuyển được mạng.'));
    }
    return false;
  }

  async function addLocalNetwork() {
    if (!connector) return;
    setAddingLocalNetwork(true);
    setFeedback(null);
    try {
      const provider = await connector.getProvider() as EIP1193Provider;
      const localChainId = numberToHex(hardhat.id);
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: localChainId,
          chainName: 'Hardhat Local',
          nativeCurrency: hardhat.nativeCurrency,
          rpcUrls: [...hardhat.rpcUrls.default.http],
        }],
      });
      if (Number(await provider.request({ method: 'eth_chainId' })) !== hardhat.id) {
        await switchChainAsync({ chainId: hardhat.id });
      }
      setFeedback({ type: 'info', message: 'Đã chuyển sang Hardhat Local.' });
    } catch (error) {
      setFeedback(operationError(error, 'Không thêm được Hardhat Local. Kiểm tra mạng trong Core → Settings → Networks.'));
    } finally {
      setAddingLocalNetwork(false);
    }
  }

  // --- 1a. Seller: Create and sign an EIP-712 service quote ---
  async function handleSignQuote() {
    if (!address || !walletClient) {
      setFeedback({ type: 'error', message: 'Kết nối ví Seller trước.' });
      return;
    }
    if (!listing) {
      setFeedback({ type: 'error', message: 'Chưa đọc được listing để tạo quote.' });
      return;
    }
    if (!isSellerWallet) {
      setFeedback({ type: 'error', message: 'Ví hiện tại không phải Seller của listing này.' });
      return;
    }
    if (zeroAddress(orderManagerAddress)) {
      setFeedback({ type: 'error', message: 'Chưa có địa chỉ ServiceOrderManager.' });
      return;
    }
    const buyer = buyerForQuote.trim();
    if (!isAddress(buyer)) {
      setFeedback({ type: 'error', message: 'Địa chỉ Buyer không hợp lệ.' });
      return;
    }
    if (sameAddress(buyer, address)) {
      setFeedback({ type: 'error', message: 'Buyer phải là ví khác với Seller.' });
      return;
    }
    const minutes = Number(quoteMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440) {
      setFeedback({ type: 'error', message: 'Hiệu lực quote phải từ 1 đến 1440 phút.' });
      return;
    }
    if (!(await ensureChain(settlementChainId))) return;

    setQuoteBusy(true);
    setFeedback({ type: 'info', message: 'Đang tạo policy commitment và ký quote EIP-712...' });
    try {
      const salt = keccak256(stringToHex(`quote-${Date.now()}-${crypto.randomUUID()}`)) as `0x${string}`;
      const orderId = (await settlementClient!.readContract({
        address: orderManagerAddress,
        abi: serviceOrderManagerAbi,
        functionName: 'orderIdFor',
        args: [buyer as `0x${string}`, salt],
      })) as `0x${string}`;

      const quoteResponse = await fetch('/api/day3/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId,
          agentId: DEFAULT_AGENT_ID,
          policyVersionHash: listing.policyVersionHash,
          priceWei: listing.priceWei.toString(),
          disputeWindow: listing.disputeWindow.toString(),
        }),
      });
      const quoteData = await quoteResponse.json();
      if (!quoteResponse.ok) throw new Error(quoteData.error || 'Không tạo được policy commitment');
      if (!isHex32(quoteData.policyCommitment)) throw new Error('Commitment trả về không hợp lệ');

      const validUntil = BigInt(Math.floor(Date.now() / 1000) + minutes * 60);
      const message = {
        orderId,
        agentId: DEFAULT_AGENT_ID,
        policyCommitment: quoteData.policyCommitment as `0x${string}`,
        policyVersionHash: listing.policyVersionHash,
        priceWei: listing.priceWei,
        validUntil,
      };
      const signature = await signTypedDataAsync({
        domain: serviceQuoteDomain(settlementChainId, orderManagerAddress),
        types: serviceQuoteTypes,
        primaryType: 'ServiceQuote',
        message,
      });
      const parts = parseSignature(signature);
      const v = Number(parts.v ?? BigInt(parts.yParity ?? 0) + 27n);
      const quote: SignedQuote = {
        buyer: buyer as `0x${string}`,
        agentId: DEFAULT_AGENT_ID,
        salt,
        commitment: message.policyCommitment,
        policyVersionHash: listing.policyVersionHash,
        priceWei: listing.priceWei.toString(),
        validUntil: validUntil.toString(),
        orderId,
        v,
        r: parts.r,
        s: parts.s,
        chainId: settlementChainId,
        orderManager: orderManagerAddress,
      };
      setSignedQuote(quote);
      setWitnessFile(typeof quoteData.witnessFile === 'string' ? quoteData.witnessFile : '');
      setOrderIdState(quote.orderId);
      window.localStorage.setItem(QUOTE_KEY, JSON.stringify(quote));
      addLog(
        `Seller đã ký quote cho ${buyer.slice(0, 8)}... — policyCommitment ${quote.commitment.slice(0, 10)}...`,
        undefined,
        settlementChainId,
      );
      setFeedback({
        type: 'success',
        message: `Quote đã ký. Hạn khiếu nại ${listing.disputeWindow.toString()}s, hoàn tối đa ${formatEther(
          (listing.priceWei * 3n) / 4n,
        )} AVAX. Chuyển vai trò sang Buyer để mua.`,
      });
    } catch (error) {
      setFeedback(operationError(error, 'Không ký được quote.'));
    } finally {
      setQuoteBusy(false);
    }
  }

  function handleImportQuote() {
    try {
      const quote = parseQuote(quotePaste.trim());
      setSignedQuote(quote);
      setBuyerForQuote(quote.buyer);
      setOrderIdState(quote.orderId);
      window.localStorage.setItem(QUOTE_KEY, JSON.stringify(quote));
      setShowQuotePaste(false);
      setQuotePaste('');
      const domainOk =
        quote.chainId === settlementChainId && sameAddress(quote.orderManager, orderManagerAddress);
      setFeedback({
        type: 'success',
        message: domainOk
          ? 'Đã nạp quote.'
          : 'Đã nạp quote — kiểm tra lại mạng và địa chỉ ServiceOrderManager trước khi mua.',
      });
    } catch (error) {
      setFeedback(operationError(error, 'Quote không hợp lệ.'));
    }
  }

  async function handleCopyQuote() {
    if (!signedQuote) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(signedQuote));
      setFeedback({ type: 'success', message: 'Đã copy quote JSON vào clipboard.' });
    } catch {
      setFeedback({ type: 'error', message: 'Trình duyệt không cho phép copy. Chọn toàn bộ JSON bên dưới.' });
    }
  }

  // --- 1b. Buyer: Purchase with the Seller-signed quote ---
  async function handleBuyService() {
    if (!address || !walletClient) {
      setFeedback({ type: 'error', message: 'Vui lòng kết nối ví Buyer trước.' });
      return;
    }
    if (!signedQuote) {
      setFeedback({ type: 'error', message: 'Cần quote do Seller ký. Chuyển sang vai trò Seller để tạo quote.' });
      return;
    }
    if (!quoteForConnectedBuyer) {
      setFeedback({ type: 'error', message: 'Quote này được ký cho địa chỉ Buyer khác.' });
      return;
    }
    if (!quoteDomainMatches) {
      setFeedback({ type: 'error', message: 'Quote thuộc mạng hoặc ServiceOrderManager khác.' });
      return;
    }
    if (quoteExpired) {
      setFeedback({ type: 'error', message: 'Quote đã hết hạn. Yêu cầu Seller ký quote mới.' });
      return;
    }
    if (!quotePriceMatches) {
      setFeedback({ type: 'error', message: 'Giá trong quote khác giá listing hiện tại. Yêu cầu quote mới.' });
      return;
    }
    if (zeroAddress(orderManagerAddress)) {
      setFeedback({ type: 'error', message: 'Chưa có địa chỉ ServiceOrderManager.' });
      return;
    }
    if (!(await ensureChain(settlementChainId))) return;

    setBusy(true);
    setFeedback({ type: 'info', message: 'Đang gửi giao dịch purchaseService...' });
    try {
      const txHash = await walletClient.writeContract({
        address: orderManagerAddress,
        abi: serviceOrderManagerAbi,
        functionName: 'purchaseService',
        args: [
          signedQuote.agentId,
          signedQuote.salt,
          signedQuote.commitment,
          BigInt(signedQuote.validUntil),
          signedQuote.v,
          signedQuote.r,
          signedQuote.s,
        ],
        value: BigInt(signedQuote.priceWei),
      });
      addLog('Đã gửi giao dịch mua dịch vụ', txHash, settlementChainId);
      setFeedback({ type: 'info', message: 'Đang chờ block xác nhận...' });
      const receipt = await settlementClient!.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') throw new Error('Giao dịch mua đã bị revert.');
      setOrderIdState(signedQuote.orderId);
      addLog(`Order đã tạo thành công: ${signedQuote.orderId}`, receipt.transactionHash, settlementChainId);
      await fetchOrder(signedQuote.orderId);
      setFeedback({ type: 'success', message: 'Đã mua dịch vụ. Bạn có thể gửi tài liệu cho Service Agent.' });
    } catch (error) {
      setFeedback(operationError(error, 'Không mua được dịch vụ. Kiểm tra giá, địa chỉ Buyer và hạn của quote.'));
    } finally {
      setBusy(false);
    }
  }

  // --- 2. Execute AI Service via real backend API ---
  async function handleExecuteService() {
    const id = orderId.trim().toLowerCase();
    if (!isHex32(id)) {
      setFeedback({ type: 'error', message: 'Nhập Order ID hợp lệ của đơn đã mua để chạy AI Service.' });
      return;
    }
    if (!address) {
      setFeedback({ type: 'error', message: 'Vui lòng kết nối ví Buyer của order này.' });
      return;
    }
    setBusy(true);
    setFeedback({ type: 'info', message: 'Đang kiểm tra đơn đã mua...' });
    setAiResult(null);

    try {
      // The backend scope uses the settlement chain id even when the wallet is
      // currently focused on a different network.
      const scope = `${settlementChainId}:${orderManagerAddress.toLowerCase()}`;
      const lookup = await fetch(`/api/day3/orders/${id}`, { cache: 'no-store' });
      const order = await lookup.json();
      if (lookup.status === 404) throw new Error('Chưa tìm thấy đơn đã mua. Hãy hoàn tất Mua dịch vụ hoặc nhập đúng Order ID của đơn đã xác nhận.');
      if (!lookup.ok) throw new Error(order.error || 'Không kiểm tra được đơn qua backend.');
      if (order.scope !== scope) throw new Error('Web và backend đang dùng khác mạng hoặc địa chỉ ServiceOrderManager.');
      if (!sameAddress(order.buyer, address)) throw new Error('Hãy kết nối đúng ví Buyer của đơn này.');
      setFeedback({ type: 'info', message: 'Đang ký yêu cầu xác thực bằng ví Buyer...' });
      const body = JSON.stringify({ text: documentText.trim() });
      const expires = Math.floor(Date.now() / 1000) + 240;
      const digest = sha256(toBytes(body)).slice(2);
      const message = ['Warranty Day 2 request', scope, 'execute', id, String(expires), digest].join('\n');

      const signature = await signMessageAsync({ message });
      addLog('Đã ký xác thực ví Buyer. Đang gọi Backend Service Agent runtime...');

      const res = await fetch(`/api/day3/orders/${id}/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Wallet-Expires': String(expires),
          'X-Wallet-Signature': signature,
        },
        body,
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Lỗi khi gọi Service Agent runtime');

      if (res.status === 202) {
        setFeedback({ type: 'info', message: 'Order đang được xử lý ngầm trong hàng đợi. Vui lòng thử lại sau giây lát.' });
        return;
      }

      setAiResult({
        ...data.result,
        mode: data.mode,
        hash: data.resultHash,
      });
      setSellerResultHash(data.resultHash);

      addLog(`Service Agent hoàn tất phân tích (Mode: ${data.mode})`);
      await fetchOrder();
      setFeedback({ type: 'success', message: 'Service Agent đã trả kết quả. Gửi Order ID và Result hash cho Seller để bàn giao.' });
    } catch (error) {
      setFeedback(operationError(error, 'Service Agent không trả được kết quả.'));
    } finally {
      setBusy(false);
    }
  }

  // --- 2b. Seller: attest delivery and withdraw claimable funds ---
  async function handleMarkDelivered() {
    if (!walletClient) return;
    if (!isHex32(orderId)) {
      setFeedback({ type: 'error', message: 'Order ID không hợp lệ.' });
      return;
    }
    if (!isHex32(sellerResultHash)) {
      setFeedback({ type: 'error', message: 'Result hash phải là bytes32 (0x + 64 hex). Chạy AI trước để lấy hash.' });
      return;
    }
    if (!(await ensureChain(settlementChainId))) return;
    setBusy(true);
    setFeedback({ type: 'info', message: 'Seller đang ghi nhận bàn giao kết quả on-chain...' });
    try {
      const txHash = await walletClient.writeContract({
        address: orderManagerAddress,
        abi: serviceOrderManagerAbi,
        functionName: 'markDelivered',
        args: [orderId as `0x${string}`, sellerResultHash as `0x${string}`],
      });
      addLog('Seller gửi xác nhận bàn giao', txHash, settlementChainId);
      const receipt = await settlementClient!.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') throw new Error('Giao dịch bàn giao bị revert.');
      await fetchOrder();
      setFeedback({ type: 'success', message: 'Đã đánh dấu Delivered. Buyer có thể Accept hoặc Dispute.' });
    } catch (error) {
      setFeedback(operationError(error, 'Không xác nhận được bàn giao.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleWithdraw() {
    if (!walletClient || zeroAddress(escrowAddress)) return;
    if (!(await ensureChain(settlementChainId))) return;
    setBusy(true);
    setFeedback({ type: 'info', message: 'Đang rút số dư escrow khả dụng...' });
    try {
      const txHash = await walletClient.writeContract({
        address: escrowAddress,
        abi: settlementEscrowAbi,
        functionName: 'withdraw',
      });
      addLog('Đã gửi giao dịch rút tiền từ escrow', txHash, settlementChainId);
      const receipt = await settlementClient!.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') throw new Error('Giao dịch rút tiền bị revert.');
      await refreshClaimable();
      setFeedback({ type: 'success', message: 'Đã rút tiền về ví.' });
    } catch (error) {
      setFeedback(operationError(error, 'Không rút được tiền từ escrow.'));
    } finally {
      setBusy(false);
    }
  }

  // --- 3. Buyer: Accept (release to Seller) ---
  async function handleAcceptOrder() {
    if (!walletClient || !orderId) return;
    if (orderOnChain && !sameAddress(orderOnChain.buyer, address)) {
      setFeedback({ type: 'error', message: 'Chỉ Buyer của order mới được Accept.' });
      return;
    }
    if (orderOnChain && orderOnChain.status !== 2) {
      setFeedback({ type: 'error', message: 'Order phải ở trạng thái Delivered (Seller đã bàn giao) mới Accept được.' });
      return;
    }
    if (!(await ensureChain(settlementChainId))) return;
    setBusy(true);
    setFeedback({ type: 'info', message: 'Đang gửi giao dịch Accept lên escrow...' });
    try {
      const txHash = await walletClient.writeContract({
        address: orderManagerAddress,
        abi: serviceOrderManagerAbi,
        functionName: 'accept',
        args: [orderId as `0x${string}`],
      });
      addLog('Buyer gửi xác nhận nghiệm thu', txHash, settlementChainId);
      const receipt = await settlementClient!.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') throw new Error('Giao dịch Accept bị revert.');
      addLog('Escrow đã ghi số dư cho Seller. Seller cần gọi withdraw().', undefined, settlementChainId);
      await fetchOrder();
      setFeedback({
        type: 'success',
        message: 'Buyer đã chấp nhận kết quả. Escrow ghi có cho Seller; Seller rút bằng nút trong tab Seller.',
      });
    } catch (error) {
      setFeedback(operationError(error, 'Không nghiệm thu được đơn hàng.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleSettleExpired() {
    const id = orderId.trim();
    if (!walletClient || !settlementClient || !address || !isHex32(id)) return;
    if (!(await ensureChain(settlementChainId))) return;
    setBusy(true);
    try {
      const request = {
        account: address,
        address: orderManagerAddress,
        abi: serviceOrderManagerAbi,
        functionName: 'settleExpired',
        args: [id],
      } as const;
      await settlementClient.simulateContract(request);
      const hash = await walletClient.writeContract(request);
      const receipt = await settlementClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('Giao dịch quyết toán bị revert.');
      addLog('Quyết toán đơn quá hạn', hash, settlementChainId);
      await fetchOrder(id);
      setFeedback({ type: 'success', message: 'Đã quyết toán. Kiểm tra số dư escrow bằng ví nhận tiền.' });
    } catch (error) {
      setFeedback(operationError(error, 'Chỉ quyết toán được đơn Paid hoặc Delivered sau hạn khiếu nại.'));
    } finally {
      setBusy(false);
    }
  }

  // --- 4. Buyer: Open a dispute ---
  async function handleOpenDispute() {
    if (!walletClient || !orderId) return;
    if (zeroAddress(gatewayAddress)) {
      setFeedback({ type: 'error', message: 'Chưa có địa chỉ MarketplaceGateway.' });
      return;
    }
    if (orderOnChain && !sameAddress(orderOnChain.buyer, address)) {
      setFeedback({ type: 'error', message: 'Chỉ Buyer của order mới được mở tranh chấp.' });
      return;
    }
    if (!(await ensureChain(settlementChainId))) return;
    setBusy(true);
    setFeedback({ type: 'info', message: 'Đang mở khiếu nại qua MarketplaceGateway...' });
    try {
      addLog(`Gọi openCase(${orderId}) trên MarketplaceGateway...`, undefined, settlementChainId);
      const txHash = await walletClient.writeContract({
        address: gatewayAddress,
        abi: marketplaceGatewayAbi,
        functionName: 'openCase',
        args: [orderId as `0x${string}`],
      });
      addLog('Đã gửi giao dịch mở tranh chấp', txHash, settlementChainId);
      const receipt = await settlementClient!.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') throw new Error('Giao dịch mở tranh chấp bị revert.');

      let opened: string | null = null;
      for (const log of receipt.logs) {
        if (!sameAddress(log.address, gatewayAddress)) continue;
        try {
          const decoded = decodeEventLog({
            abi: marketplaceGatewayAbi,
            eventName: 'CaseOpened',
            data: log.data,
            topics: log.topics,
          });
          opened = (decoded.args as any).caseId as string;
        } catch {
          // ignore logs from other events
        }
      }
      if (opened) {
        setCaseId(opened);
        addLog(`CaseOpened: ${opened}`, receipt.transactionHash, settlementChainId);
      } else {
        addLog('Đã mở case nhưng không giải mã được CaseOpened. Tra cứu thủ công theo Order ID.', receipt.transactionHash, settlementChainId);
      }
      await fetchOrder();
      setFeedback({
        type: 'success',
        message: 'Đã mở khiếu nại. Reviewer có thể tra cứu case trên cùng mạng.',
      });
    } catch (error) {
      setFeedback(operationError(error, 'Không mở được tranh chấp.'));
    } finally {
      setBusy(false);
    }
  }

  async function uploadBuyerEvidence() {
    const caseForOrder = orderOnChain?.caseId;
    if (!isOrderBuyer || orderOnChain?.status !== 4 || !isHex32(caseForOrder) || !evidenceText.trim()) return;
    setBusy(true);
    setSendingEvidence(true);
    setFeedback({ type: 'info', message: 'Xác nhận chữ ký trong ví Buyer để gửi bằng chứng.' });
    try {
      const id = caseForOrder.toLowerCase();
      const body = JSON.stringify({caseId:id,text:evidenceText.trim()});
      const expires = String(Math.floor(Date.now()/1000)+240);
      const scope = settlementChainId + ':' + orderManagerAddress.toLowerCase();
      const message = ['Warranty Day 2 request',scope,'upload',id,expires,sha256(toBytes(body)).slice(2)].join('\n');
      const signature = await signMessageAsync({message});
      setFeedback({ type: 'info', message: 'Đang lưu bằng chứng cho case…' });
      const response = await fetch('/api/day3/cases/upload',{method:'POST',body,
        headers:{'Content-Type':'application/json','X-Wallet-Expires':expires,'X-Wallet-Signature':signature}});
      const record = await response.json();
      if (!response.ok) throw new Error(record.error || 'Không lưu được bằng chứng');
      addLog(`Đã lưu bằng chứng cho case ${id}`);
      setFeedback({ type: 'success', message: 'Đã lưu bằng chứng. Reviewer có thể tra cứu Case ID để xử lý.' });
    } catch (error) {
      setFeedback(operationError(error, 'Không gửi được bằng chứng.'));
    } finally {
      setSendingEvidence(false);
      setBusy(false);
    }
  }

  // --- 5. Reviewer: Fetch the on-chain case ---
  async function handleFetchCase(targetCaseId?: string) {
    const idToLook = (targetCaseId || caseId).trim().toLowerCase() as `0x${string}`;
    if (!isHex32(idToLook)) {
      setFeedback({ type: 'error', message: 'Vui lòng nhập Case ID hợp lệ (0x...)' });
      return;
    }
    if (!disputeClient || zeroAddress(disputeManagerAddress)) {
      setFeedback({ type: 'error', message: 'Chưa có địa chỉ DisputeManager cho mạng này.' });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const data = (await disputeClient.readContract({
        address: disputeManagerAddress,
        abi: disputeManagerAbi,
        functionName: 'getCase',
        args: [idToLook],
      })) as any;
      const claimVal = data.claim || data[0];
      const status = Number(data.status ?? data[1]);
      if (status === 0) {
        setReviewerCase(null);
        setFeedback({ type: 'error', message: 'Không tìm thấy case trên mạng hiện tại. Kiểm tra lại Case ID.' });
        return;
      }
      const payoutAmountVal = data.payoutAmount ?? data[2];
      const proofRefVal = data.proofRef ?? data[3];
      const reviewerApprovalRefVal = data.reviewerApprovalRef ?? data[4];
      let resolutionSent: boolean | null = null;
      if ((status === 5 || status === 6) && !zeroAddress(resultSenderAddress)) {
        resolutionSent = await disputeClient.readContract({
          address: resultSenderAddress,
          abi: disputeResultSenderAbi,
          functionName: 'sent',
          args: [idToLook],
        }).catch(() => null);
      }
      const view: CaseView = {
        claim: {
          caseId: claimVal.caseId ?? claimVal[0],
          orderId: claimVal.orderId ?? claimVal[1],
          policyCommitment: claimVal.policyCommitment ?? claimVal[2],
          claimTimestamp: BigInt(claimVal.claimTimestamp ?? claimVal[3]),
          lockedAmount: BigInt(claimVal.lockedAmount ?? claimVal[7]),
          purchaseTimestamp: BigInt(claimVal.purchaseTimestamp ?? claimVal[8]),
          claimDeadline: BigInt(claimVal.claimDeadline ?? claimVal[9]),
        },
        status,
        payoutAmount: BigInt(payoutAmountVal),
        proofRef: proofRefVal,
        reviewerApprovalRef: reviewerApprovalRefVal,
        resolutionSent,
      };
      if (!sameAddress(loadedReviewerCase?.claim.caseId, idToLook)) {
        setProofJson('');
        setRefundWei('');
        setPipelineResult(null);
      }
      setReviewerCase(view);
      setCaseId(idToLook);
      addLog(`Đã tra cứu case · ${CASE_STATUS_LABELS[view.status] || view.status}`, undefined, disputeChainId);
    } catch (error) {
      setFeedback(operationError(error, 'Không tra cứu được case.'));
    } finally {
      setBusy(false);
    }
  }

  // --- 6. Trigger 3 Dispute Agents pipeline (server-side model key) ---
  async function handleRunDisputePipeline() {
    const claim = reviewerCase?.claim;
    if (!isReviewerWallet || !claim || !sameAddress(claim.caseId, caseId.trim())) {
      setFeedback({ type: 'error', message: 'Kết nối ví Reviewer và tra cứu case trước khi phân tích.' });
      return;
    }
    setPipelineBusy(true);
    setPipelineResult(null);
    setFeedback({ type: 'info', message: 'Đang chạy chuỗi 3 Dispute Agents: Evidence -> Policy -> Resolution...' });
    try {
      // Policy P0 caps refund at 75% of the escrowed price (matches quote witness).
      const maxPayout = (claim.lockedAmount * 3n) / 4n;

      const res = await fetch('/api/day3/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: evidenceText.trim(),
          claimTimestamp: String(claim.claimTimestamp),
          policy: {
            purchaseTimestamp: String(claim.purchaseTimestamp),
            warrantyEndTimestamp: String(claim.claimDeadline),
            maxPayout: maxPayout.toString(),
            nonce: '0x' + '11'.repeat(32),
          },
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Lỗi khi gọi pipeline 3 Dispute Agents');

      setPipelineResult(data);
      addLog(`Pipeline 3 Dispute Agents hoàn tất (${data.mode})`, undefined, disputeChainId);
      setFeedback({
        type: 'success',
        message: `3 Dispute Agents đã phân tích xong. Đề xuất hoàn: ${formatEther(BigInt(data.resolution.proposedPayout))} AVAX (chỉ là khuyến nghị, không phải phán quyết).`,
      });
    } catch (error) {
      setFeedback(operationError(error, 'Không chạy được Dispute Agents.'));
    } finally {
      setPipelineBusy(false);
    }
  }

  // --- 7. Reviewer actions (wallet must have the on-chain role) ---
  async function handleSubmitProof() {
    const id = caseId.trim().toLowerCase();
    if (!walletClient || !disputeClient || zeroAddress(disputeManagerAddress)) {
      setFeedback({ type: 'error', message: 'Kết nối ví reviewer và kiểm tra cấu hình DisputeManager trước khi nộp proof.' });
      return;
    }
    if (!isReviewerWallet) {
      setFeedback({ type: 'error', message: 'Ví hiện tại không phải reviewer của DisputeManager.' });
      return;
    }
    if (!isHex32(id) || reviewerCase?.claim.caseId.toLowerCase() !== id || reviewerCase.status === 0) {
      setFeedback({ type: 'error', message: 'Hãy tra cứu đúng Case ID trước khi nộp proof.' });
      return;
    }
    if (reviewerCase.status !== 2) {
      setFeedback({ type: 'error', message: 'Case phải ở trạng thái Analyzing. Nếu đang Opened, bấm Bắt đầu phân tích trước.' });
      return;
    }
    let parsed: { proof?: unknown; publicInputs?: unknown };
    try {
      const value: unknown = JSON.parse(proofJson);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
      parsed = value;
    } catch {
      setFeedback({ type: 'error', message: 'Proof JSON không parse được.' });
      return;
    }
    if (typeof parsed.proof !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(parsed.proof)) {
      setFeedback({ type: 'error', message: 'proof phải là hex string 0x...' });
      return;
    }
    if (!Array.isArray(parsed.publicInputs) || parsed.publicInputs.length !== 15 || !parsed.publicInputs.every(isHex32)) {
      setFeedback({ type: 'error', message: 'publicInputs phải có đúng 15 phần tử như ProofGate.' });
      return;
    }
    const inputs = parsed.publicInputs as string[];
    const amount = BigInt(inputs[11]);
    const nullifier = inputs[12] as `0x${string}`;
    if (amount === 0n || !isHex32(nullifier)) {
      setFeedback({ type: 'error', message: 'payoutAmount/nullifier trong public inputs không hợp lệ.' });
      return;
    }
    if (!(await ensureChain(disputeChainId))) return;

    setBusy(true);
    setFeedback({ type: 'info', message: 'Reviewer đang nộp ZK proof lên ProofGate...' });
    try {
      const txHash = await walletClient.writeContract({
        address: disputeManagerAddress,
        abi: disputeManagerAbi,
        functionName: 'submitProof',
        args: [id, amount, nullifier, parsed.proof as `0x${string}`],
      });
      addLog(`Reviewer nộp ZK proof (${formatEther(amount)} AVAX)`, txHash, disputeChainId);
      const receipt = await disputeClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') throw new Error('Giao dịch bị revert. Kiểm tra proof có thuộc đúng case và chưa được dùng.');
      await handleFetchCase(id);
      setFeedback({ type: 'success', message: 'Proof đã được xác minh on-chain. Chuyển sang Merchant Review.' });
    } catch (error) {
      setFeedback(operationError(error, 'Không nộp được ZK proof.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleReviewerAction(action: keyof typeof REVIEWER_CONFIRMATIONS) {
    if (!walletClient || !disputeClient) return;
    if (!isReviewerWallet) {
      setFeedback({ type: 'error', message: 'Ví hiện tại không phải reviewer của DisputeManager.' });
      return;
    }
    const cId = caseId.trim().toLowerCase();
    if (!isHex32(cId) || !reviewerCase) {
      setFeedback({ type: 'error', message: 'Tra cứu đúng Case ID trước khi thực hiện thao tác.' });
      return;
    }
    if (action === 'sendResolution' && reviewerCase.resolutionSent) {
      setFeedback({ type: 'info', message: 'Phán quyết của case này đã được gửi tới escrow.' });
      return;
    }
    if (!(await ensureChain(disputeChainId))) return;

    setBusy(true);
    setFeedback({ type: 'info', message: 'Xác nhận giao dịch trong ví Reviewer.' });
    try {
      let txHash: `0x${string}`;

      if (action === 'analyze') {
        txHash = await walletClient.writeContract({
          address: disputeManagerAddress,
          abi: disputeManagerAbi,
          functionName: 'startAnalysis',
          args: [cId],
        });
        addLog('Reviewer bắt đầu phân tích chứng cứ', txHash, disputeChainId);
      } else if (action === 'beginReview') {
        txHash = await walletClient.writeContract({
          address: disputeManagerAddress,
          abi: disputeManagerAbi,
          functionName: 'beginReview',
          args: [cId],
        });
        addLog('Chuyển case sang xét duyệt', txHash, disputeChainId);
      } else if (action === 'approve') {
        if (!reviewerCase.proofRef || reviewerCase.proofRef === ZERO_BYTES32) {
          setFeedback({ type: 'error', message: 'Chưa có ZK proof verified; hợp đồng sẽ từ chối approve.' });
          return;
        }
        const approvalRef = keccak256(stringToHex(`reviewer-approve-${Date.now()}`));
        txHash = await walletClient.writeContract({
          address: disputeManagerAddress,
          abi: disputeManagerAbi,
          functionName: 'decide',
          args: [cId, true, approvalRef],
        });
        addLog(`Reviewer duyệt hoàn ${formatEther(reviewerCase.payoutAmount)} AVAX`, txHash, disputeChainId);
      } else if (action === 'reject') {
        const approvalRef = keccak256(stringToHex(`reviewer-reject-${Date.now()}`));
        txHash = await walletClient.writeContract({
          address: disputeManagerAddress,
          abi: disputeManagerAbi,
          functionName: 'decide',
          args: [cId, false, approvalRef],
        });
        addLog('Reviewer từ chối hoàn tiền', txHash, disputeChainId);
      } else {
        txHash = await walletClient.writeContract({
          address: resultSenderAddress,
          abi: disputeResultSenderAbi,
          functionName: 'sendResolution',
          args: [cId],
        });
        addLog('Gửi phán quyết tới escrow', txHash, disputeChainId);
      }

      setFeedback({ type: 'info', message: 'Đã gửi giao dịch. Đang chờ xác nhận trên mạng…' });
      const receipt = await disputeClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') throw new Error('Giao dịch reviewer bị revert.');
      await handleFetchCase(cId);
      setFeedback({ type: 'success', message: REVIEWER_CONFIRMATIONS[action] });
    } catch (error) {
      if (action === 'sendResolution' && /already sent/i.test(errorText(error))) {
        await handleFetchCase(cId);
        setFeedback({
          type: 'info',
          message: 'Phán quyết của case này đã được gửi tới escrow. Kiểm tra số dư bằng ví nhận tiền.',
          details: error instanceof Error ? error.message : errorText(error),
        });
      } else {
        setFeedback(operationError(error, 'Giao dịch Reviewer không thành công.'));
      }
    } finally {
      setBusy(false);
    }
  }

  const contractExplorer = EXPLORERS[settlementChainId];
  const disputeExplorer = EXPLORERS[disputeChainId];
  const listingPrice = listing?.priceWei ?? 10000000000000000n;
  const maxRefund = (listingPrice * 3n) / 4n;
  const canReview = !busy && isReviewerWallet && !!reviewerCase;

  return (
    <main className={styles.container}>
      <header className={styles.header}>
        <h1>Marketplace & Dispute Protocol</h1>
        <p className="intro">
          Mua dịch vụ AI qua escrow, nghiệm thu hoặc mở khiếu nại. Reviewer nộp ZK proof để contract xác minh trước khi duyệt hoàn tiền.
        </p>
        <p className={styles.hint}>
          Môi trường hiện tại: {isLocal ? 'Hardhat Local' : 'Avalanche Fuji C-Chain'}. Kết nối Dispute L1 qua Teleporter tạm thời chưa khả dụng.
        </p>
      </header>

      {/* --- Top Bar: Network Info & Multi-Role Selector --- */}
      <nav className={styles.navBar} aria-label="Ví và vai trò">
        <div className={styles.networkStatus}>
          <span
            className={`${styles.badge} ${
              chain?.id === FUJI_CHAIN_ID
                ? styles.badgeFuji
                : styles.badgeOther
            }`}
          >
            <span className={styles.indicator} />
            {chain?.name || (isConnected ? 'Mạng ví chưa được hỗ trợ' : 'Chưa kết nối ví')} ({chainId ?? 'N/A'})
          </span>

          {isConnected ? (
            <button className={styles.btnSecondary} onClick={() => disconnect()}>
              Ngắt ví ({address?.slice(0, 6)}…{address?.slice(-4)})
            </button>
          ) : connectors.map((wallet) => (
            <button
              key={wallet.uid}
              className={styles.btnPrimary}
              disabled={connecting}
              onClick={() => {
                setFeedback(null);
                connect({ connector: wallet });
              }}
            >
              {connecting ? 'Đang kết nối…' : `Kết nối ${wallet.id === 'injected' ? 'ví trình duyệt' : wallet.name}`}
            </button>
          ))}
        </div>
        <div className={styles.networkActions}>
          <button
            className={styles.btnSecondary}
            disabled={!isConnected || chainId === settlementChainId || addingLocalNetwork}
            onClick={() => void ensureChain(settlementChainId, false)}
          >
            {isLocal ? 'Local (31337)' : 'Fuji (43113)'}
          </button>
          {isLocal && isConnected && chainId !== LOCAL_CHAIN_ID && (
            <button
              className={styles.btnSecondary}
              disabled={addingLocalNetwork}
              onClick={() => void addLocalNetwork()}
            >
              {addingLocalNetwork ? 'Đang chờ xác nhận trong ví…' : 'Thêm Hardhat vào ví'}
            </button>
          )}
        </div>

        <div className={styles.roleSelector} role="group" aria-label="Vai trò hiển thị">
          <button
            className={`${styles.roleBtn} ${activeRole === 'buyer' ? styles.roleBtnActive : ''}`}
            aria-pressed={activeRole === 'buyer'}
            onClick={() => {
              setActiveRole('buyer');
              setActiveTab('marketplace');
            }}
          >
            👤 Buyer
          </button>
          <button
            className={`${styles.roleBtn} ${activeRole === 'seller' ? styles.roleBtnActive : ''}`}
            aria-pressed={activeRole === 'seller'}
            onClick={() => {
              setActiveRole('seller');
              setActiveTab('seller');
            }}
          >
            🏪 Seller
          </button>
          <button
            className={`${styles.roleBtn} ${activeRole === 'reviewer' ? styles.roleBtnActive : ''}`}
            aria-pressed={activeRole === 'reviewer'}
            onClick={() => {
              setActiveRole('reviewer');
              setActiveTab('reviewer');
            }}
          >
            ⚖️ Reviewer / Arbitrator
          </button>
        </div>
      </nav>

      {feedback ? (
        <div className={styles.notificationArea}>
          <FeedbackNotice
            feedback={feedback}
            pending={feedback.type === 'info' && (busy || quoteBusy || pipelineBusy || addingLocalNetwork)}
            onDismiss={() => setFeedback(null)}
          />
        </div>
      ) : !isConnected && connectError && (
        <FeedbackNotice feedback={operationError(connectError, 'Không kết nối được ví.')} />
      )}
      {runtimeError && isLocal && (
        <FeedbackNotice feedback={runtimeError} />
      )}

      {/* --- Main Dashboard Grid --- */}
      <div className={styles.grid}>
        {/* Left Column: Role-Specific Action Workspace */}
        <div>
          {/* TAB 1: BUYER & MARKETPLACE FLOW */}
          {activeTab === 'marketplace' && (
            <>
              {/* Step 1: Browse Listing */}
              <section className={styles.panel}>
                <h2>Document Summary Agent</h2>
                <p>
                  Nhận văn bản/hợp đồng đầu vào, phân tích và trích xuất tóm tắt ngắn, ý chính và các điều khoản cảnh báo rủi
                  ro.
                </p>
                <div className={styles.statusCard}>
                  <div className={styles.statusRow}>
                    <span className={styles.statusKey}>Giá dịch vụ (listing on-chain):</span>
                    <span className={styles.statusVal}>{formatEther(listingPrice)} AVAX</span>
                  </div>
                  <div className={styles.statusRow}>
                    <span className={styles.statusKey}>Cửa sổ khiếu nại:</span>
                    <span className={styles.statusVal}>
                      {listing ? `${listing.disputeWindow.toString()}s` : 'Chưa đọc được listing'}
                    </span>
                  </div>
                  <div className={styles.statusRow}>
                    <span className={styles.statusKey}>Mức hoàn tối đa (P0):</span>
                    <span className={styles.statusVal}>{formatEther(maxRefund)} AVAX (qua ZK Proof)</span>
                  </div>
                  <div className={styles.statusRow}>
                    <span className={styles.statusKey}>Seller:</span>
                    <span className={`${styles.statusVal} ${styles.mono}`}>
                      {listing?.seller && !zeroAddress(listing.seller) ? listing.seller : 'Chưa đăng ký'}
                    </span>
                  </div>
                  <div className={styles.statusRow}>
                    <span className={styles.statusKey}>Trạng thái listing:</span>
                    <span className={styles.statusVal}>
                      {listingError
                        ? '⚠️ ' + listingError
                        : listingBusy
                        ? 'Đang đọc...'
                        : listing
                        ? `${listing.active ? 'Active' : 'Inactive'} · ${listing.approved ? 'Seller approved' : 'Seller chưa duyệt'}`
                        : 'Chưa có dữ liệu'}
                    </span>
                  </div>
                </div>

                <div className={styles.actions}>
                  <button className={styles.btnSecondary} disabled={listingBusy} onClick={() => void loadListing()}>
                    Làm mới listing
                  </button>
                </div>

                <div style={{ marginTop: '1rem' }}>
                  {!signedQuote ? (
                    <p className={styles.hint}>
                      Cần quote do Seller ký trước khi mua. Chuyển sang tab <strong>Seller</strong> (ví Seller) để tạo quote,
                      hoặc dán quote JSON do Seller gửi.
                    </p>
                  ) : (
                    <div className={styles.statusCard}>
                      <div className={styles.statusRow}>
                        <span className={styles.statusKey}>Quote Buyer:</span>
                        <span className={`${styles.statusVal} ${styles.mono}`}>{signedQuote.buyer}</span>
                      </div>
                      <div className={styles.statusRow}>
                        <span className={styles.statusKey}>Hết hạn quote:</span>
                        <span className={styles.statusVal}>
                          {new Date(Number(signedQuote.validUntil) * 1000).toLocaleString('vi-VN')}{' '}
                          {quoteExpired ? '· ⚠️ đã hết hạn' : ''}
                        </span>
                      </div>
                      <div className={styles.statusRow}>
                        <span className={styles.statusKey}>Policy commitment:</span>
                        <span className={`${styles.statusVal} ${styles.mono}`}>{signedQuote.commitment.slice(0, 18)}...</span>
                      </div>
                      {!quoteForConnectedBuyer && (
                        <div className={styles.statusRow}>
                          <span className={styles.statusKey}>Ví hiện tại:</span>
                          <span className={styles.statusVal}>⚠️ không khớp Buyer trong quote</span>
                        </div>
                      )}
                      {!quoteDomainMatches && (
                        <div className={styles.statusRow}>
                          <span className={styles.statusKey}>Mạng/contract:</span>
                          <span className={styles.statusVal}>⚠️ quote thuộc mạng hoặc contract khác</span>
                        </div>
                      )}
                      {!quotePriceMatches && (
                        <div className={styles.statusRow}>
                          <span className={styles.statusKey}>Giá:</span>
                          <span className={styles.statusVal}>⚠️ quote khác giá listing hiện tại</span>
                        </div>
                      )}
                    </div>
                  )}

                  <div className={styles.actions}>
                    <button
                      className={styles.btnPrimary}
                      disabled={
                        busy ||
                        !isConnected ||
                        !signedQuote ||
                        !quoteForConnectedBuyer ||
                        !quoteDomainMatches ||
                        !quotePriceMatches ||
                        quoteExpired ||
                        !onSettlementChain
                      }
                      onClick={handleBuyService}
                    >
                      Mua dịch vụ ({formatEther(listingPrice)} AVAX on-chain)
                    </button>
                    <button className={styles.btnSecondary} onClick={() => setShowQuotePaste((prev) => !prev)}>
                      {showQuotePaste ? 'Đóng' : 'Dán quote JSON'}
                    </button>
                  </div>
                  {!onSettlementChain && (
                    <p className={styles.hint}>
                      Giao dịch mua diễn ra trên {isLocal ? 'Local Hardhat' : 'Fuji C-Chain'}. Chuyển mạng trước khi bấm mua.
                    </p>
                  )}
                  {showQuotePaste && (
                    <div style={{ marginTop: '0.6rem' }}>
                      <textarea
                        className={`${styles.textarea} ${styles.mono}`}
                        rows={5}
                        placeholder='{"buyer":"0x...","orderId":"0x...","v":27,...}'
                        value={quotePaste}
                        onChange={(e) => setQuotePaste(e.target.value)}
                      />
                      <div className={styles.actions}>
                        <button className={styles.btnSecondary} disabled={!quotePaste.trim()} onClick={handleImportQuote}>
                          Nạp quote
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </section>

              {/* Step 2: Order Management & AI Execution */}
              <section className={styles.panel}>
                <h2>2. Thực thi dịch vụ AI qua Backend API</h2>

                <label className={styles.label} htmlFor="buyer-order-id">Order ID</label>
                <div className={styles.fieldAction}>
                  <input
                    id="buyer-order-id"
                    className={`${styles.input} ${styles.mono}`}
                    placeholder="0x..."
                    value={orderId}
                    onChange={(e) => setOrderIdState(e.target.value)}
                    disabled={busy}
                  />
                  <button className={styles.btnSecondary} disabled={busy || !orderId} onClick={() => fetchOrder()}>
                    Kiểm tra
                  </button>
                </div>

                {orderOnChain && (
                  <div className={styles.statusCard}>
                    <div className={styles.statusRow}>
                      <span className={styles.statusKey}>Trạng thái On-chain:</span>
                      <span className={styles.statusVal} style={{ color: '#83e8cc' }}>
                        {ORDER_STATUS_LABELS[orderOnChain.status] || orderOnChain.status}
                      </span>
                    </div>
                    <div className={styles.statusRow}>
                      <span className={styles.statusKey}>Buyer:</span>
                      <span className={`${styles.statusVal} ${styles.mono}`}>{orderOnChain.buyer}</span>
                    </div>
                    <div className={styles.statusRow}>
                      <span className={styles.statusKey}>Seller:</span>
                      <span className={`${styles.statusVal} ${styles.mono}`}>{orderOnChain.seller}</span>
                    </div>
                    <div className={styles.statusRow}>
                      <span className={styles.statusKey}>Tiền ký quỹ Escrow:</span>
                      <span className={styles.statusVal}>{formatEther(orderOnChain.priceWei)} AVAX</span>
                    </div>
                    {orderOnChain.status >= 3 && (
                      <div className={styles.statusRow}>
                        <span className={styles.statusKey}>Order đã quyết toán/khóa:</span>
                        <span className={styles.statusVal}>Không thể Accept hoặc Dispute thêm.</span>
                      </div>
                    )}
                    {orderOnChain.caseId && orderOnChain.caseId !== ZERO_BYTES32 && (
                      <div className={styles.statusRow}>
                        <span className={styles.statusKey}>Case ID tranh chấp:</span>
                        <span className={`${styles.statusVal} ${styles.mono}`}>{orderOnChain.caseId}</span>
                      </div>
                    )}
                  </div>
                )}

                <label className={styles.label}>Văn bản mẫu cần tóm tắt:</label>
                <textarea
                  className={styles.textarea}
                  rows={4}
                  value={documentText}
                  onChange={(e) => setDocumentText(e.target.value)}
                />

                <div className={styles.actions}>
                  <button
                    className={styles.btnAccent}
                    disabled={busy || !orderId || !isConnected}
                    onClick={handleExecuteService}
                  >
                    Ký ví & Gọi Service Agent
                  </button>
                </div>

                {aiResult && (
                  <div className={styles.resultBox}>
                    <p style={{ margin: '0 0 0.5rem', fontWeight: 600, color: '#83e8cc' }}>
                      Kết quả từ AI Agent ({aiResult.mode}):
                    </p>
                    <p>{aiResult.summary}</p>
                    <ul className={styles.keyPoints}>
                      {aiResult.keyPoints?.map((pt, i) => (
                        <li key={i}>{pt}</li>
                      ))}
                    </ul>
                    {aiResult.caveats?.length > 0 && <div className={styles.caveat}>{aiResult.caveats.join(' ')}</div>}
                    <p className={`${styles.mono}`} style={{ marginTop: '0.8rem', fontSize: '0.8rem', color: '#7a8e99' }}>
                      Result Hash: {aiResult.hash}
                    </p>
                    <p className={styles.hint}>
                      Kết quả này do backend trả về. Trạng thái on-chain chỉ chuyển sang Delivered khi Seller ký
                      <strong> markDelivered</strong> với result hash.
                    </p>
                  </div>
                )}
              </section>

              {/* Step 3: Accept or Open Dispute */}
              <section className={styles.panel}>
                <h2>3. Nghiệm thu hoặc Khiếu nại dịch vụ</h2>
                <p>
                  Nếu hài lòng với kết quả của AI, Buyer chọn <strong>Chấp nhận</strong> để escrow ghi có tiền cho Seller.
                  Nếu dịch vụ vi phạm cam kết, Buyer chọn <strong>Mở tranh chấp</strong> để tạo case trên cùng mạng.
                </p>
                {orderOnChain?.status === 4 && (
                  <div className={styles.actionNote}>
                    <p>Đơn đang tranh chấp. Reviewer dùng Case ID để thẩm định và gửi phán quyết.</p>
                    <button className={styles.btnSecondary} disabled={busy} onClick={() => void fetchOrder()}>
                      Làm mới trạng thái đơn
                    </button>
                  </div>
                )}
                {orderOnChain?.status === 5 && (
                  <p className={styles.actionNote} data-complete="true">
                    Đơn đã được quyết toán. Xem mục <a href="#escrow-balance">Số dư escrow</a> để kiểm tra tiền có thể rút.
                  </p>
                )}

                <div className={styles.actions}>
                  <button
                    className={styles.btnPrimary}
                    disabled={busy || !isOrderBuyer || orderOnChain?.status !== 2}
                    onClick={handleAcceptOrder}
                  >
                    ✅ Chấp nhận (Ghi có cho Seller)
                  </button>

                  <button
                    className={styles.btnDanger}
                    disabled={
                      busy ||
                      !isOrderBuyer ||
                      !orderOnChain ||
                      (orderOnChain.status !== 1 && orderOnChain.status !== 2)
                    }
                    onClick={handleOpenDispute}
                  >
                    Mở tranh chấp
                  </button>
                  {(orderOnChain?.status === 1 || orderOnChain?.status === 2) && (
                    <button
                      className={styles.btnSecondary}
                      disabled={busy || !isConnected}
                      onClick={() => void handleSettleExpired()}
                    >
                      Quyết toán đơn quá hạn
                    </button>
                  )}
                </div>
                {orderOnChain?.status === 4 && isHex32(orderOnChain.caseId) && (
                  <div className={styles.insetPanel} aria-busy={sendingEvidence}>
                    <label htmlFor="buyer-evidence" className={styles.fieldTitle}>Bằng chứng của Buyer</label>
                    <textarea
                      id="buyer-evidence"
                      className={styles.textarea}
                      rows={4}
                      value={evidenceText}
                      maxLength={30000}
                      onChange={(e) => setEvidenceText(e.target.value)}
                      disabled={sendingEvidence}
                      placeholder="Mô tả vấn đề hoặc điều khoản dịch vụ bị vi phạm"
                    />
                    {!isOrderBuyer && <p className={styles.hint}>Kết nối đúng ví Buyer của đơn để ký và gửi bằng chứng.</p>}
                    <div className={styles.actions}>
                      <button
                        className={styles.btnAccent}
                        disabled={busy || !isOrderBuyer || !evidenceText.trim()}
                        onClick={uploadBuyerEvidence}
                      >
                        {sendingEvidence ? 'Đang gửi bằng chứng…' : 'Ký và gửi bằng chứng'}
                      </button>
                    </div>
                  </div>
                )}
              </section>
            </>
          )}

          {/* TAB 1.5: SELLER WORKSPACE */}
          {activeTab === 'seller' && (
            <section className={styles.panel}>
              {listing && zeroAddress(listing.seller) && <button className={styles.btnPrimary}
                disabled={busy || !walletClient} onClick={registerSummaryAgent}>
                Đăng ký Document Summary · 0,01 AVAX · khiếu nại trong 1 giờ
              </button>}
              <h2>
                <span>Seller Workspace</span>
                <span
                  className={styles.badge}
                  style={{ background: isSellerWallet ? '#132f30' : '#2a1e1e', color: isSellerWallet ? '#83e8cc' : '#ff867d' }}
                >
                  {listingBusy ? 'Đang đọc listing' :
                    !listing ? 'Chưa xác định Seller' :
                    zeroAddress(listing.seller) ? 'Chưa có Seller' :
                    !address ? 'Chưa kết nối ví' :
                    isSellerWallet ? 'Ví Seller hợp lệ' : 'Ví không phải Seller'}
                </span>
              </h2>
              <p>
                Seller ký <strong>EIP-712 ServiceQuote</strong> cho đúng Buyer. Chữ ký gắn với orderId, agent, giá,
                policyCommitment và hạn quote. Sau khi AI trả kết quả, Seller ghi nhận bàn giao on-chain để Buyer có thể
                Accept hoặc Dispute.
              </p>

              <div className={styles.statusCard}>
                <div className={styles.statusRow}>
                  <span className={styles.statusKey}>Seller on-chain:</span>
                  <span className={`${styles.statusVal} ${styles.mono}`}>
                    {listing?.seller && !zeroAddress(listing.seller) ? listing.seller : 'Chưa đọc được'}
                  </span>
                </div>
                <div className={styles.statusRow}>
                  <span className={styles.statusKey}>Listing:</span>
                  <span className={styles.statusVal}>
                    {listing ? `${formatEther(listing.priceWei)} AVAX · ${listing.disputeWindow.toString()}s · ${listing.active ? 'Active' : 'Inactive'}` : '—'}
                  </span>
                </div>
                <div className={styles.statusRow}>
                  <span className={styles.statusKey}>Policy version:</span>
                  <span className={`${styles.statusVal} ${styles.mono}`}>{listing?.policyVersionHash?.slice(0, 18) ?? '—'}...</span>
                </div>
              </div>

              {listingError && <p role="status">{listingError}</p>}
              <h3>1. Ký quote cho Buyer</h3>
              <label className={styles.label}>Địa chỉ ví Buyer:</label>
              <input
                className={`${styles.input} ${styles.mono}`}
                placeholder="0x..."
                value={buyerForQuote}
                onChange={(e) => setBuyerForQuote(e.target.value)}
              />
              <label className={styles.label}>Hiệu lực quote (phút):</label>
              <input
                className={styles.input}
                inputMode="numeric"
                value={quoteMinutes}
                onChange={(e) => setQuoteMinutes(e.target.value)}
              />
              <div className={styles.actions}>
                <button
                  className={styles.btnAccent}
                  disabled={quoteBusy || !isConnected || !listing || !onSettlementChain}
                  onClick={handleSignQuote}
                >
                  {quoteBusy ? 'Đang ký...' : 'Ký EIP-712 Quote'}
                </button>
                <button className={styles.btnSecondary} onClick={() => void loadListing()} disabled={listingBusy}>
                  Đọc lại listing
                </button>
              </div>
              {!onSettlementChain && (
                <p className={styles.hint}>
                  Ký quote trên {isLocal ? 'Local Hardhat (31337)' : 'Fuji C-Chain (43113)'} để domain khớp contract.
                </p>
              )}

              {signedQuote && (
                <div style={{ marginTop: '1rem' }}>
                  <div className={styles.actions}>
                    <button className={styles.btnSecondary} onClick={handleCopyQuote}>
                      Copy quote JSON
                    </button>
                  </div>
                  <textarea
                    className={`${styles.textarea} ${styles.mono}`}
                    rows={7}
                    readOnly
                    value={JSON.stringify(signedQuote, null, 2)}
                  />
                  {witnessFile && (
                    <p className={styles.hint}>
                      Policy witness (chỉ server đọc) đã lưu tại <code>{witnessFile}</code>. Prover của Người 2 dùng đúng
                      file này để tạo proof khớp <code>policyCommitment</code>.
                    </p>
                  )}
                </div>
              )}

              <h3 style={{ marginTop: '1.5rem' }}>2. Ghi nhận bàn giao (markDelivered)</h3>
              <p className={styles.hint}>
                Chỉ Seller của order gọi được. Dùng đúng result hash mà backend đã trả cho Buyer.
              </p>
              <label className={styles.label}>Order ID:</label>
              <input
                className={`${styles.input} ${styles.mono}`}
                placeholder="0x..."
                value={orderId}
                onChange={(e) => setOrderIdState(e.target.value)}
              />
              <label className={styles.label}>Result hash (bytes32):</label>
              <input
                className={`${styles.input} ${styles.mono}`}
                placeholder="0x..."
                value={sellerResultHash}
                onChange={(e) => setSellerResultHash(e.target.value)}
              />
              <div className={styles.actions}>
                <button className={styles.btnPrimary} disabled={busy || !isConnected} onClick={handleMarkDelivered}>
                  Mark Delivered
                </button>
              </div>

            </section>
          )}

          {/* TAB 2: REVIEWER & DISPUTE L1 WORKSPACE */}
          {activeTab === 'reviewer' && (
            <section className={styles.panel}>
              <h2>
                <span>Thẩm định tranh chấp</span>
                <span className={styles.badge} style={{ background: '#1c3638', color: '#83e8cc' }}>
                  Chain ID: {disputeChainId}
                </span>
              </h2>
              <p>
                ProofGate xác minh ZK proof trên cùng mạng với escrow. AI đưa ra khuyến nghị và reviewer ký phán quyết bằng ví.
              </p>

              <div className={styles.statusCard}>
                <div className={styles.statusRow}>
                  <span className={styles.statusKey}>Reviewer on-chain:</span>
                  <span className={`${styles.statusVal} ${styles.mono}`}>{reviewerAddress || 'Chưa đọc được'}</span>
                </div>
                <div className={styles.statusRow}>
                  <span className={styles.statusKey}>Ví hiện tại:</span>
                  <span className={styles.statusVal}>
                    {isReviewerWallet ? '✅ đúng role reviewer' : '⚠️ không có quyền approve/reject'}
                  </span>
                </div>
              </div>

              <label className={styles.label} htmlFor="reviewer-case-id">Case ID</label>
              <div className={styles.fieldAction}>
                <input
                  id="reviewer-case-id"
                  className={`${styles.input} ${styles.mono}`}
                  placeholder="0x..."
                  value={caseId}
                  onChange={(e) => setCaseId(e.target.value)}
                  disabled={busy}
                />
                <button className={styles.btnSecondary} disabled={busy || !caseId} onClick={() => handleFetchCase()}>
                  Tra cứu
                </button>
              </div>

              {reviewerCase && (
                <div className={styles.statusCard}>
                  <div className={styles.statusRow}>
                    <span className={styles.statusKey}>Trạng thái case</span>
                    <span className={styles.statusVal} style={{ color: '#83e8cc' }}>
                      {CASE_STATUS_LABELS[reviewerCase.status] || reviewerCase.status}
                    </span>
                  </div>
                  <div className={styles.statusRow}>
                    <span className={styles.statusKey}>Order ID gốc:</span>
                    <span className={`${styles.statusVal} ${styles.mono}`}>{reviewerCase.claim.orderId}</span>
                  </div>
                  <div className={styles.statusRow}>
                    <span className={styles.statusKey}>Số tiền tạm khóa:</span>
                    <span className={styles.statusVal}>{formatEther(reviewerCase.claim.lockedAmount)} AVAX</span>
                  </div>
                  <div className={styles.statusRow}>
                    <span className={styles.statusKey}>Claim timestamp / deadline:</span>
                    <span className={styles.statusVal}>
                      {new Date(Number(reviewerCase.claim.claimTimestamp) * 1000).toLocaleString('vi-VN')} /{' '}
                      {new Date(Number(reviewerCase.claim.claimDeadline) * 1000).toLocaleString('vi-VN')}
                    </span>
                  </div>
                  <div className={styles.statusRow}>
                    <span className={styles.statusKey}>ZK Proof Reference:</span>
                    <span className={`${styles.statusVal} ${styles.mono}`}>
                      {reviewerCase.proofRef && reviewerCase.proofRef !== ZERO_BYTES32
                        ? '✅ ' + reviewerCase.proofRef.slice(0, 16) + '...'
                        : '⏳ Chưa xác minh'}
                    </span>
                  </div>
                  {reviewerCase.payoutAmount > 0n && (
                    <div className={styles.statusRow}>
                      <span className={styles.statusKey}>Mức hoàn đã xác minh:</span>
                      <span className={styles.statusVal} style={{ color: '#ff867d' }}>
                        {formatPayout(reviewerCase.payoutAmount.toString())}
                      </span>
                    </div>
                  )}
                  {(reviewerCase.status === 5 || reviewerCase.status === 6) && (
                    <div className={styles.statusRow}>
                      <span className={styles.statusKey}>Phán quyết tới escrow</span>
                      <span className={styles.statusVal}>
                        {reviewerCase.resolutionSent === true ? 'Đã gửi' : reviewerCase.resolutionSent === false ? 'Chờ gửi' : 'Chưa đọc được'}
                      </span>
                    </div>
                  )}
                  <div className={styles.statusRow}>
                    <span className={styles.statusKey}>Explorer:</span>
                    <span className={styles.statusVal}>
                      <a className={styles.linkExplorer} href={disputeExplorer.addressUrl(disputeManagerAddress)} target="_blank" rel="noreferrer">
                        DisputeManager on {disputeExplorer.name} ↗
                      </a>
                    </span>
                  </div>
                </div>
              )}
              {reviewerCase?.status === 1 && (
                <div className={styles.actions}>
                  <button
                    className={styles.btnPrimary}
                    disabled={!canReview}
                    onClick={() => handleReviewerAction('analyze')}
                  >
                    Bắt đầu phân tích
                  </button>
                </div>
              )}

              {/* 3 Dispute Agents Pipeline trigger */}
              <div className={styles.insetPanel} aria-busy={pipelineBusy}>
                <h3>Phân tích bằng AI</h3>
                <p style={{ fontSize: '0.88rem', color: '#9db2be', margin: '0 0 0.8rem' }}>
                  Chạy chuỗi phân tích tự động: <strong>Evidence Agent</strong> (bóc tách chứng cứ) → <strong>Policy Agent</strong> (đối chiếu điều khoản) → <strong>Resolution Assistant</strong> (đề xuất mức bồi hoàn cho người duyệt).
                </p>

                <label className={styles.label} htmlFor="reviewer-evidence">Nội dung bằng chứng</label>
                <textarea
                  id="reviewer-evidence"
                  className={styles.textarea}
                  rows={3}
                  value={evidenceText}
                  onChange={(e) => setEvidenceText(e.target.value)}
                />
                <p className={styles.hint}>
                  `OPENROUTER_API_KEY` chỉ đọc từ server (`project/.env`). Không nhập API key vào trình duyệt.
                </p>

                <div className={styles.actions}>
                  <button
                    className={styles.btnAccent}
                    disabled={busy || pipelineBusy || !isReviewerWallet || !reviewerCase || !evidenceText.trim()}
                    onClick={handleRunDisputePipeline}
                  >
                    {pipelineBusy ? 'Đang phân tích bằng chứng…' : 'Chạy 3 Dispute Agents'}
                  </button>
                </div>

                {pipelineResult && (
                  <div className={styles.resultBox} style={{ border: '1px solid #2d7a71', marginTop: '1rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.8rem' }}>
                      <strong style={{ color: '#83e8cc' }}>Kết quả từ 3 Dispute Agents:</strong>
                      <span className={styles.badge} style={{ background: '#132f30', color: '#83e8cc' }}>
                        OpenRouter
                      </span>
                    </div>

                    <div style={{ marginBottom: '0.75rem' }}>
                      <p style={{ margin: '0.2rem 0', fontWeight: 600, color: '#e2ebf0' }}>🔍 1. Evidence Agent:</p>
                      <p style={{ margin: '0.2rem 0', color: '#b4c0c7', fontSize: '0.9rem' }}>
                        Mô tả lỗi: {pipelineResult.evidence.faultDescription}
                      </p>
                      {pipelineResult.evidence.missingEvidence.length > 0 && (
                        <p style={{ margin: '0.2rem 0', color: '#e5b158', fontSize: '0.85rem' }}>
                          Dữ liệu thiếu: {pipelineResult.evidence.missingEvidence.join(', ')}
                        </p>
                      )}
                    </div>

                    <div style={{ marginBottom: '0.75rem' }}>
                      <p style={{ margin: '0.2rem 0', fontWeight: 600, color: '#e2ebf0' }}>📜 2. Policy Agent:</p>
                      <p style={{ margin: '0.2rem 0', fontSize: '0.9rem', color: pipelineResult.analysis.eligible ? '#83e8cc' : '#ff867d' }}>
                        Đủ điều kiện bảo hành: <strong>{pipelineResult.analysis.eligible ? 'ĐỦ ĐIỀU KIỆN (ELIGIBLE)' : 'KHÔNG ĐỦ ĐIỀU KIỆN'}</strong>
                      </p>
                      <ul style={{ paddingLeft: '1.2rem', margin: '0.3rem 0', color: '#b4c0c7', fontSize: '0.88rem' }}>
                        {pipelineResult.analysis.reasons.map((r, i) => (
                          <li key={i}>{r}</li>
                        ))}
                      </ul>
                    </div>

                    <div>
                      <p style={{ margin: '0.2rem 0', fontWeight: 600, color: '#e2ebf0' }}>⚖️ 3. Resolution Assistant:</p>
                      <p style={{ margin: '0.2rem 0', fontSize: '0.92rem', color: '#ff867d' }}>
                        Đề xuất hoàn: <strong>{formatEther(BigInt(pipelineResult.resolution.proposedPayout))} AVAX</strong> ({pipelineResult.resolution.proposedPayout} wei)
                      </p>
                      <p style={{ margin: '0.2rem 0', color: '#b4c0c7', fontSize: '0.88rem' }}>
                        Lý do: {pipelineResult.resolution.reason}
                      </p>
                      <p className={styles.hint}>
                        AI recommendation không phải phán quyết. Chỉ reviewer có role mới approve/reject; payout on-chain phải
                        khớp ZK proof đã xác minh.
                      </p>
                    </div>
                  </div>
                )}
              </div>

              <div className={styles.insetPanel} aria-busy={generatingProof}>
                <h3>ZK proof</h3>
                {!reviewerCase && <p className={styles.hint}>Tra cứu Case ID để bắt đầu.</p>}
                {reviewerCase?.status === 1 && <p className={styles.hint}>Bấm Bắt đầu phân tích để mở bước tạo proof.</p>}
                {reviewerCase && reviewerCase.proofRef !== ZERO_BYTES32 && (
                  <p className={styles.actionNote} data-complete="true">Proof đã được xác minh trên hợp đồng.</p>
                )}
                <label className={styles.label} htmlFor="proof-refund-wei">Số tiền hoàn (wei)</label>
                <div className={styles.amountField}>
                  <input
                    id="proof-refund-wei"
                    className={`${styles.input} ${styles.amountInput}`}
                    aria-describedby="proof-refund-hint"
                    value={refundWei}
                    inputMode="numeric"
                    placeholder="Nhập số tiền bằng wei"
                    disabled={generatingProof}
                    onChange={(e) => setRefundWei(e.target.value)}
                  />
                  <span aria-hidden="true">wei</span>
                </div>
                <p id="proof-refund-hint" className={styles.hint}>
                  Chỉ để trống khi worker đã lưu mức hoàn cho case.
                  {/^[1-9][0-9]*$/.test(refundWei.trim()) && <> Số tiền bạn nhập tương đương {formatPayout(refundWei.trim())}.</>}
                </p>
                <div className={styles.actions}>
                  <button
                    className={styles.btnAccent}
                    disabled={!canReview || reviewerCase?.status !== 2}
                    onClick={prepareCaseProof}
                  >
                    {generatingProof ? 'Đang tạo proof…' : 'Tạo proof bằng WASM'}
                  </button>
                </div>
                <label className={styles.label} htmlFor="proof-json">Proof JSON</label>
                <textarea
                  id="proof-json"
                  className={`${styles.textarea} ${styles.mono}`}
                  rows={4}
                  placeholder="Proof sẽ tự điền sau khi tạo hoặc bạn có thể dán JSON vào đây"
                  value={proofJson}
                  disabled={generatingProof}
                  onChange={(e) => setProofJson(e.target.value)}
                  spellCheck={false}
                />
                <div className={styles.actions}>
                  <button
                    className={styles.btnPrimary}
                    disabled={!canReview || reviewerCase?.status !== 2 || !proofJson.trim()}
                    onClick={handleSubmitProof}
                  >
                    Nộp Proof
                  </button>
                </div>
              </div>

              {reviewerCase && reviewerCase.status >= 2 && (
                <div className={styles.insetPanel}>
                  <h3>Phán quyết và quyết toán</h3>
                  <div className={styles.actions}>
                    {(reviewerCase.status === 2 || reviewerCase.status === 3) && (
                      <button
                        className={styles.btnSecondary}
                        disabled={!canReview}
                        onClick={() => handleReviewerAction('beginReview')}
                      >
                        Chuyển vào Merchant Review
                      </button>
                    )}
                    {reviewerCase.status === 4 && (
                      <>
                        <button
                          className={styles.btnAccent}
                          disabled={!canReview || reviewerCase.proofRef === ZERO_BYTES32}
                          onClick={() => handleReviewerAction('approve')}
                        >
                          Duyệt hoàn tiền
                        </button>
                        <button className={styles.btnDanger} disabled={!canReview} onClick={() => handleReviewerAction('reject')}>
                          Từ chối hoàn tiền
                        </button>
                      </>
                    )}
                    {(reviewerCase.status === 5 || reviewerCase.status === 6) && (
                      <button
                        className={styles.btnPrimary}
                        disabled={!canReview || reviewerCase.resolutionSent === true || zeroAddress(resultSenderAddress)}
                        onClick={() => handleReviewerAction('sendResolution')}
                      >
                        {reviewerCase.resolutionSent ? 'Đã gửi phán quyết' : 'Gửi phán quyết tới escrow'}
                      </button>
                    )}
                  </div>
                  {reviewerCase.status === 2 && (
                    <p className={styles.hint}>Để duyệt hoàn tiền, nộp ZK proof trước khi chuyển sang xét duyệt.</p>
                  )}
                  {reviewerCase.status === 4 && reviewerCase.proofRef === ZERO_BYTES32 && (
                    <p className={styles.hint}>Case chưa có proof hợp lệ nên chỉ có thể từ chối hoàn tiền.</p>
                  )}
                  {reviewerCase.resolutionSent && (
                    <p className={styles.actionNote} data-complete="true">
                      Phán quyết đã được gửi. Ví nhận tiền có thể rút tại mục Số dư escrow trong tab Buyer hoặc Seller.
                    </p>
                  )}
                </div>
              )}
            </section>
          )}

          {activeTab !== 'reviewer' && (
            <section id="escrow-balance" className={styles.panel}>
              <h2>Số dư escrow</h2>
              <div className={styles.balanceCard} aria-busy={loadingClaimable}>
                <span>{address ? `Có thể rút về ví ${address.slice(0, 6)}…${address.slice(-4)}` : 'Kết nối ví nhận tiền'}</span>
                <strong>{claimable === undefined ? '—' : `${formatEther(claimable)} AVAX`}</strong>
              </div>
              {claimableUnavailable && <p className={styles.hint}>Không đọc được số dư. Bấm Làm mới số dư để thử lại.</p>}
              <div className={styles.actions}>
                <button
                  className={styles.btnPrimary}
                  disabled={busy || loadingClaimable || !claimable || claimableUnavailable}
                  onClick={handleWithdraw}
                >
                  Rút tiền (Withdraw)
                </button>
                <button
                  className={styles.btnSecondary}
                  disabled={busy || loadingClaimable || !address || zeroAddress(escrowAddress)}
                  onClick={() => void refreshClaimable()}
                >
                  {loadingClaimable ? 'Đang đọc số dư…' : 'Làm mới số dư'}
                </button>
              </div>
            </section>
          )}

          {/* Contract Address Override Setting */}
          <details className={styles.panel} style={{ cursor: 'pointer' }}>
            <summary style={{ fontWeight: 600, color: '#9db2be' }}>⚙️ Cấu hình địa chỉ Contract</summary>
            <div style={{ marginTop: '1rem' }}>
              <p className={styles.hint}>
                Local đọc <code>.runtime/day2/day2-local.json</code>. Fuji dùng biến{' '}
                <code>NEXT_PUBLIC_FUJI_*</code> / <code>NEXT_PUBLIC_L1_*</code>, hoặc dán tay bên dưới. Không commit key.
              </p>
              <label className={styles.label}>ServiceOrderManager ({isLocal ? 'Local' : 'Fuji'}):</label>
              <input
                className={`${styles.input} ${styles.mono}`}
                value={customOrderManager}
                placeholder={settlementBook.serviceOrderManager}
                onChange={(e) => setCustomOrderManager(e.target.value)}
              />
              <label className={styles.label}>MarketplaceGateway ({isLocal ? 'Local' : 'Fuji'}):</label>
              <input
                className={`${styles.input} ${styles.mono}`}
                value={customGateway}
                placeholder={settlementBook.marketplaceGateway}
                onChange={(e) => setCustomGateway(e.target.value)}
              />
              <label className={styles.label}>SettlementEscrow ({isLocal ? 'Local' : 'Fuji'}):</label>
              <input
                className={`${styles.input} ${styles.mono}`}
                value={customEscrow}
                placeholder={settlementBook.escrow}
                onChange={(e) => setCustomEscrow(e.target.value)}
              />
              <label className={styles.label}>DisputeManager ({isLocal ? 'Local' : 'Fuji'}):</label>
              <input
                className={`${styles.input} ${styles.mono}`}
                value={customDisputeManager}
                placeholder={disputeBook.disputeManager}
                onChange={(e) => setCustomDisputeManager(e.target.value)}
              />
              <label className={styles.label}>DisputeResultSender ({isLocal ? 'Local' : 'Fuji'}):</label>
              <input
                className={`${styles.input} ${styles.mono}`}
                value={customResultSender}
                placeholder={disputeBook.resultSender}
                onChange={(e) => setCustomResultSender(e.target.value)}
              />
              <div style={{ marginTop: '0.6rem', display: 'flex', flexWrap: 'wrap', gap: '0.6rem' }}>
                {[
                  ['AgentRegistry', agentRegistryAddress],
                  ['ServiceOrderManager', orderManagerAddress],
                  ['MarketplaceGateway', gatewayAddress],
                  ['SettlementEscrow', escrowAddress],
                ].map(([label, value]) => (
                  <a
                    key={label}
                    className={styles.linkExplorer}
                    href={zeroAddress(value) ? '#' : contractExplorer.addressUrl(value)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {label}: {zeroAddress(value) ? 'chưa cấu hình' : value.slice(0, 10) + '...'} ({contractExplorer.name}) ↗
                  </a>
                ))}
                {[
                  ['DisputeManager', disputeManagerAddress],
                  ['DisputeResultSender', resultSenderAddress],
                ].map(([label, value]) => (
                  <a
                    key={label}
                    className={styles.linkExplorer}
                    href={zeroAddress(value) ? '#' : disputeExplorer.addressUrl(value)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {label}: {zeroAddress(value) ? 'chưa cấu hình' : value.slice(0, 10) + '...'} ({disputeExplorer.name}) ↗
                  </a>
                ))}
              </div>
            </div>
          </details>
        </div>

        <aside aria-label="Nhật ký và hướng dẫn">
          <section className={`${styles.panel} ${styles.auditPanel}`} aria-labelledby="audit-heading">
            <div className={styles.auditHeader}>
              <h2 id="audit-heading">Nhật ký giao dịch</h2>
              <button
                className={`${styles.btnSecondary} ${styles.smallButton}`}
                disabled={!logs.length}
                onClick={() => setLogs([])}
              >
                Xóa nhật ký
              </button>
            </div>

            {logs.length === 0 ? (
              <p className={styles.emptyAudit}>Giao dịch và kết quả tra cứu sẽ hiện ở đây.</p>
            ) : (
              <ol className={styles.timelineList} reversed tabIndex={0} aria-label="Lịch sử thao tác, mới nhất trước">
                {logs.map((log) => {
                  const explorer = log.chainId && log.chainId !== LOCAL_CHAIN_ID ? EXPLORERS[log.chainId] : null;
                  return (
                    <li key={log.id}>
                      <span className={styles.stepNumber} aria-hidden="true">{log.id}</span>
                      <div className={styles.auditEntry}>
                        <time className={styles.auditTime}>{log.time}</time>
                        <p>{log.text}</p>
                        {log.txHash && <code className={styles.auditHash}>{log.txHash}</code>}
                        {log.txHash && explorer && (
                          <a href={explorer.txUrl(log.txHash)} target="_blank" rel="noreferrer" className={styles.linkExplorer}>
                            Xem trên {explorer.name} ↗
                          </a>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          <details className={`${styles.panel} ${styles.quickGuide}`}>
            <summary>Hướng dẫn thử nghiệm nhanh</summary>
            <ol>
              <li>
                <strong>Seller:</strong> kết nối ví Seller, mở tab Seller, nhập địa chỉ ví Buyer và ký quote.
              </li>
              <li>
                <strong>Mua dịch vụ:</strong> chuyển sang ví Buyer, kiểm tra quote khớp rồi bấm Mua để khóa AVAX vào escrow.
              </li>
              <li>
                <strong>Chạy AI:</strong> ký yêu cầu bằng ví Buyer để gọi backend Document Summary Agent.
              </li>
              <li>
                <strong>Seller bàn giao:</strong> nhập result hash và gọi markDelivered; sau đó Seller withdraw khi escrow ghi có.
              </li>
              <li>
                <strong>Nghiệm thu / Khiếu nại:</strong> Buyer Accept để trả tiền, hoặc mở case trên cùng mạng.
              </li>
              <li>
                <strong>Thẩm định:</strong> Reviewer tra cứu Case ID, nộp ZK proof, ký quyết định và áp dụng kết quả vào escrow.
              </li>
            </ol>
          </details>
        </aside>
      </div>
    </main>
  );
}
