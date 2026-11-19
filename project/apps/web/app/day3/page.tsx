'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  useAccount,
  useConnect,
  useDisconnect,
  useSwitchChain,
  useSignMessage,
  useSignTypedData,
  usePublicClient,
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
} from 'viem';
import styles from './day3.module.css';
import {
  FUJI_CHAIN_ID,
  DISPUTE_CHAIN_ID,
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
};

const QUOTE_KEY = 'day3-service-quote';
const EXPIRY_SKEW_SECONDS = 30;

function errorText(err: unknown) {
  if (err && typeof err === 'object') {
    const value = err as { shortMessage?: string; message?: string };
    return value.shortMessage || value.message || 'Lỗi không xác định';
  }
  return 'Lỗi không xác định';
}

function sameAddress(left?: string, right?: string) {
  return !!left && !!right && left.toLowerCase() === right.toLowerCase();
}

function isHex32(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function readOrder(data: any): OrderView {
  return {
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
  const hexFields: Array<keyof SignedQuote> = ['buyer', 'agentId', 'salt', 'commitment', 'policyVersionHash'];
  for (const field of hexFields) {
    if (!isHex32(value[field])) throw new Error(`Quote thiếu ${field} hợp lệ`);
  }
  if (!isAddress(value.buyer as string) || !isHex32(value.orderId) || !isHex32(value.orderManager)) {
    throw new Error('Quote có địa chỉ hoặc bytes32 không hợp lệ');
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
  const { address, isConnected, chain } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, switchChainAsync } = useSwitchChain();
  const { signMessageAsync } = useSignMessage();
  const { signTypedDataAsync } = useSignTypedData();

  // Local deployment addresses change on every Hardhat restart; testnet ones
  // come from NEXT_PUBLIC_* env vars. Never derive one chain's address from the
  // other chain's wallet state.
  const isLocal = !chain || chain.id === LOCAL_CHAIN_ID;
  const settlementChainId = isLocal ? LOCAL_CHAIN_ID : FUJI_CHAIN_ID;
  const disputeChainId = isLocal ? LOCAL_CHAIN_ID : DISPUTE_CHAIN_ID;
  const settlementClient = usePublicClient({ chainId: settlementChainId });
  const disputeClient = usePublicClient({ chainId: disputeChainId });
  const { data: walletClient } = useWalletClient();

  const [runtimeAddresses, setRuntimeAddresses] = useState<Partial<LocalAddresses> | null>(null);
  const [runtimeError, setRuntimeError] = useState('');

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
  const [orderOnChain, setOrderOnChain] = useState<OrderView | null>(null);

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

  const [reviewerCase, setReviewerCase] = useState<CaseView | null>(null);
  const [proofJson, setProofJson] = useState('');
  const [claimable, setClaimable] = useState<bigint | null>(null);

  // --- Timeline & Operation Feeds ---
  const [logs, setLogs] = useState<Array<{ time: string; text: string; txHash?: string; chainId?: number }>>([]);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'error' | 'success' | 'info'; message: string } | null>(null);

  const addLog = (text: string, txHash?: string, chainId?: number) => {
    const time = new Date().toLocaleTimeString('vi-VN');
    setLogs((prev) => [{ time, text, txHash, chainId }, ...prev]);
  };

  const isReviewerWallet = sameAddress(address, reviewerAddress);
  const isSellerWallet = !!address && sameAddress(address, listing?.seller);
  const onSettlementChain = chain?.id === settlementChainId;
  const onDisputeChain = chain?.id === disputeChainId;
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
      setRuntimeError('');
      return;
    }
    let alive = true;
    fetch('/api/day3/config', { cache: 'no-store' })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Không đọc được manifest local');
        return data as { addresses: Partial<LocalAddresses> };
      })
      .then((data) => {
        if (!alive) return;
        setRuntimeAddresses(data.addresses);
        setRuntimeError('');
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setRuntimeAddresses(null);
        setRuntimeError(errorText(error));
      });
    return () => {
      alive = false;
    };
  }, [isLocal]);

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
      setListingError('Không đọc được listing: ' + errorText(error));
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

  // --- Escrow claimable balance for the connected wallet ---
  async function loadClaimable() {
    if (!settlementClient || !address || zeroAddress(escrowAddress)) {
      setClaimable(null);
      return;
    }
    try {
      const value = (await settlementClient.readContract({
        address: escrowAddress,
        abi: settlementEscrowAbi,
        functionName: 'claimable',
        args: [address],
      })) as bigint;
      setClaimable(value);
    } catch {
      setClaimable(null);
    }
  }

  useEffect(() => {
    void loadClaimable();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, escrowAddress, settlementClient, orderOnChain?.status]);

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
      const order = readOrder(data);
      setOrderOnChain(order);
      setOrderIdState(targetId);
      if (isHex32(order.caseId) && order.caseId !== `0x${'0'.repeat(64)}`) setCaseId(order.caseId);
      addLog(`Tra cứu Order on-chain thành công (${ORDER_STATUS_LABELS[order.status] || order.status})`, undefined, settlementChainId);
    } catch (error) {
      setFeedback({ type: 'error', message: 'Lỗi tra cứu contract: ' + errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  // --- Chain switch helper: switching is asynchronous, so never send a tx in
  // the same tick on the wrong chain. Ask the user to press the action again.
  async function ensureChain(target: number) {
    if (chain?.id === target) return true;
    try {
      await switchChainAsync({ chainId: target });
      setFeedback({ type: 'info', message: 'Đã chuyển mạng. Bấm lại thao tác để gửi giao dịch.' });
    } catch (error) {
      setFeedback({ type: 'error', message: 'Không chuyển được mạng: ' + errorText(error) });
    }
    return false;
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
      setFeedback({ type: 'error', message: 'Lỗi ký quote: ' + errorText(error) });
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
      setFeedback({ type: 'error', message: 'Quote không hợp lệ: ' + errorText(error) });
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
      addLog(`Đã gửi purchaseService: ${txHash}`, txHash, settlementChainId);
      setFeedback({ type: 'info', message: 'Đang chờ block xác nhận...' });
      const receipt = await settlementClient!.waitForTransactionReceipt({ hash: txHash });
      setOrderIdState(signedQuote.orderId);
      addLog(`Order đã tạo thành công: ${signedQuote.orderId}`, receipt.transactionHash, settlementChainId);
      setFeedback({ type: 'success', message: `Đã mua dịch vụ. Order ID: ${signedQuote.orderId}` });
      await fetchOrder(signedQuote.orderId);
    } catch (error) {
      setFeedback({
        type: 'error',
        message:
          'Lỗi giao dịch mua on-chain: ' +
          errorText(error) +
          '. Kiểm tra: listing còn active, quote chưa hết hạn, đúng giá và Seller đã ký cho đúng Buyer.',
      });
    } finally {
      setBusy(false);
    }
  }

  // --- 2. Execute AI Service via real backend API ---
  async function handleExecuteService() {
    if (!orderId) {
      setFeedback({ type: 'error', message: 'Cần có Order ID để chạy AI Service.' });
      return;
    }
    if (!address) {
      setFeedback({ type: 'error', message: 'Vui lòng kết nối ví Buyer của order này.' });
      return;
    }
    setBusy(true);
    setFeedback({ type: 'info', message: 'Đang ký yêu cầu xác thực bằng ví Buyer...' });
    setAiResult(null);

    try {
      // The backend scope uses the settlement chain id even when the wallet is
      // currently focused on the Dispute L1.
      const scope = `${settlementChainId}:${orderManagerAddress.toLowerCase()}`;
      const body = JSON.stringify({ text: documentText.trim() });
      const expires = Math.floor(Date.now() / 1000) + 240;
      const digest = sha256(toBytes(body)).slice(2);
      const message = ['Warranty Day 2 request', scope, 'execute', orderId.toLowerCase(), String(expires), digest].join('\n');

      const signature = await signMessageAsync({ message });
      addLog('Đã ký xác thực ví Buyer. Đang gọi Backend Service Agent runtime...');

      const res = await fetch(`/api/day3/orders/${orderId.toLowerCase()}/execute`, {
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
      setSellerResultHash((prev) => prev || data.resultHash);

      addLog(`Service Agent hoàn tất phân tích (Mode: ${data.mode})`);
      setFeedback({ type: 'success', message: 'Service Agent đã trả kết quả phân tích có cấu trúc!' });
      await fetchOrder();
    } catch (error) {
      setFeedback({ type: 'error', message: 'Lỗi thực thi AI: ' + errorText(error) });
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
      addLog(`Seller gửi markDelivered: ${txHash}`, txHash, settlementChainId);
      await settlementClient!.waitForTransactionReceipt({ hash: txHash });
      setFeedback({ type: 'success', message: 'Đã đánh dấu Delivered. Buyer có thể Accept hoặc Dispute.' });
      await fetchOrder();
    } catch (error) {
      setFeedback({ type: 'error', message: 'Lỗi markDelivered: ' + errorText(error) });
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
      addLog(`Rút tiền từ escrow: ${txHash}`, txHash, settlementChainId);
      await settlementClient!.waitForTransactionReceipt({ hash: txHash });
      await loadClaimable();
      setFeedback({ type: 'success', message: 'Đã rút tiền về ví.' });
    } catch (error) {
      setFeedback({ type: 'error', message: 'Lỗi rút escrow: ' + errorText(error) });
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
      addLog(`Buyer gửi lệnh Accept: ${txHash}`, txHash, settlementChainId);
      await settlementClient!.waitForTransactionReceipt({ hash: txHash });
      addLog('Escrow đã ghi số dư cho Seller. Seller cần gọi withdraw().', undefined, settlementChainId);
      setFeedback({
        type: 'success',
        message: 'Buyer đã chấp nhận kết quả. Escrow ghi có cho Seller; Seller rút bằng nút trong tab Seller.',
      });
      await fetchOrder();
    } catch (error) {
      setFeedback({ type: 'error', message: 'Lỗi khi Accept order: ' + errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  // --- 4. Buyer: Open dispute (Teleporter) ---
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
      addLog(`Giao dịch mở dispute đã gửi: ${txHash}`, txHash, settlementChainId);
      const receipt = await settlementClient!.waitForTransactionReceipt({ hash: txHash });

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
        addLog(`CaseOpened: ${opened}. Thông điệp đang chờ Teleporter relay sang Dispute L1.`, receipt.transactionHash, settlementChainId);
      } else {
        addLog('Đã mở case nhưng không giải mã được CaseOpened. Tra cứu thủ công theo Order ID.', receipt.transactionHash, settlementChainId);
      }
      setFeedback({
        type: 'success',
        message: 'Đã mở khiếu nại. Thông điệp đang chờ relay sang Dispute L1; trạng thái trên L1 chỉ xuất hiện sau khi relay xác nhận.',
      });
      await fetchOrder();
    } catch (error) {
      setFeedback({ type: 'error', message: 'Lỗi khi mở dispute: ' + errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  // --- 5. Reviewer: Fetch case on Dispute L1 ---
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
      const statusVal = data.status ?? data[1];
      const payoutAmountVal = data.payoutAmount ?? data[2];
      const proofRefVal = data.proofRef ?? data[3];
      const reviewerApprovalRefVal = data.reviewerApprovalRef ?? data[4];
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
        status: Number(statusVal),
        payoutAmount: BigInt(payoutAmountVal),
        proofRef: proofRefVal,
        reviewerApprovalRef: reviewerApprovalRefVal,
      };
      setReviewerCase(view);
      setCaseId(idToLook);
      addLog(`Reviewer tra cứu Case L1 thành công (${CASE_STATUS_LABELS[view.status] || view.status})`, undefined, disputeChainId);
    } catch (error) {
      setFeedback({ type: 'error', message: 'Lỗi tra cứu Case L1: ' + errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  // --- 6. Trigger 3 Dispute Agents pipeline (server-side model key) ---
  async function handleRunDisputePipeline() {
    setPipelineBusy(true);
    setFeedback({ type: 'info', message: 'Đang chạy chuỗi 3 Dispute Agents: Evidence -> Policy -> Resolution...' });
    try {
      const now = Math.floor(Date.now() / 1000);
      const claim = reviewerCase?.claim;
      const purchaseTime = claim?.purchaseTimestamp ? Number(claim.purchaseTimestamp) : now - 1800;
      const deadline = claim?.claimDeadline ? Number(claim.claimDeadline) : now + 1800;
      const claimTime = claim?.claimTimestamp ? Number(claim.claimTimestamp) : now;
      const locked = claim?.lockedAmount ?? BigInt('10000000000000000'); // 0.01 AVAX fallback
      // Policy P0 caps refund at 75% of the escrowed price (matches quote witness).
      const maxPayout = (locked * 3n) / 4n;

      const res = await fetch('/api/day3/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: evidenceText.trim(),
          claimTimestamp: String(claimTime),
          policy: {
            purchaseTimestamp: String(purchaseTime),
            warrantyEndTimestamp: String(deadline),
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
      setFeedback({ type: 'error', message: 'Lỗi chạy Dispute Agents: ' + errorText(error) });
    } finally {
      setPipelineBusy(false);
    }
  }

  // --- 7. Reviewer actions on Dispute L1 (wallet must be the reviewer role) ---
  async function handleSubmitProof() {
    if (!walletClient || !caseId) return;
    if (!isReviewerWallet) {
      setFeedback({ type: 'error', message: 'Ví hiện tại không phải reviewer của DisputeManager.' });
      return;
    }
    let parsed: { proof?: unknown; publicInputs?: unknown };
    try {
      parsed = JSON.parse(proofJson) as { proof?: unknown; publicInputs?: unknown };
    } catch {
      setFeedback({ type: 'error', message: 'Proof JSON không parse được.' });
      return;
    }
    if (typeof parsed.proof !== 'string' || !/^0x[0-9a-fA-F]+$/.test(parsed.proof)) {
      setFeedback({ type: 'error', message: 'proof phải là hex string 0x...' });
      return;
    }
    if (!Array.isArray(parsed.publicInputs) || parsed.publicInputs.length !== 15) {
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
        args: [caseId as `0x${string}`, amount, nullifier, parsed.proof as `0x${string}`],
      });
      addLog(`Reviewer nộp ZK proof (${formatEther(amount)} AVAX): ${txHash}`, txHash, disputeChainId);
      await disputeClient!.waitForTransactionReceipt({ hash: txHash });
      setFeedback({ type: 'success', message: 'Proof đã được xác minh on-chain. Chuyển sang Merchant Review.' });
      await handleFetchCase(caseId);
    } catch (error) {
      setFeedback({ type: 'error', message: 'Lỗi nộp proof: ' + errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  async function handleReviewerAction(action: 'analyze' | 'beginReview' | 'approve' | 'reject' | 'sendResolution') {
    if (!walletClient || !caseId) return;
    if (!isReviewerWallet) {
      setFeedback({ type: 'error', message: 'Ví hiện tại không phải reviewer của DisputeManager.' });
      return;
    }
    if (!(await ensureChain(disputeChainId))) return;

    setBusy(true);
    setFeedback(null);
    try {
      const cId = caseId as `0x${string}`;
      let txHash: `0x${string}`;

      if (action === 'analyze') {
        txHash = await walletClient.writeContract({
          address: disputeManagerAddress,
          abi: disputeManagerAbi,
          functionName: 'startAnalysis',
          args: [cId],
        });
        addLog(`Reviewer bắt đầu phân tích chứng cứ: ${txHash}`, txHash, disputeChainId);
      } else if (action === 'beginReview') {
        txHash = await walletClient.writeContract({
          address: disputeManagerAddress,
          abi: disputeManagerAbi,
          functionName: 'beginReview',
          args: [cId],
        });
        addLog(`Chuyển case sang Merchant/Reviewer xét duyệt: ${txHash}`, txHash, disputeChainId);
      } else if (action === 'approve') {
        if (!reviewerCase?.proofRef || reviewerCase.proofRef === `0x${'0'.repeat(64)}`) {
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
        addLog(`Reviewer ĐỒNG Ý hoàn ${formatEther(reviewerCase.payoutAmount)} AVAX: ${txHash}`, txHash, disputeChainId);
      } else if (action === 'reject') {
        const approvalRef = keccak256(stringToHex(`reviewer-reject-${Date.now()}`));
        txHash = await walletClient.writeContract({
          address: disputeManagerAddress,
          abi: disputeManagerAbi,
          functionName: 'decide',
          args: [cId, false, approvalRef],
        });
        addLog(`Reviewer TỪ CHỐI hoàn tiền: ${txHash}`, txHash, disputeChainId);
      } else {
        txHash = await walletClient.writeContract({
          address: resultSenderAddress,
          abi: disputeResultSenderAbi,
          functionName: 'sendResolution',
          args: [cId],
        });
        addLog(`Gửi phán quyết qua Teleporter về C-Chain: ${txHash}`, txHash, disputeChainId);
      }

      await disputeClient!.waitForTransactionReceipt({ hash: txHash });
      setFeedback({ type: 'success', message: `Thao tác [${action}] trên Dispute L1 thành công!` });
      await handleFetchCase(caseId);
    } catch (error) {
      setFeedback({ type: 'error', message: `Lỗi thao tác reviewer: ` + errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  const zeroBytes32 = `0x${'0'.repeat(64)}`;
  const contractExplorer = EXPLORERS[settlementChainId];
  const disputeExplorer = EXPLORERS[disputeChainId];
  const listingPrice = listing?.priceWei ?? 10000000000000000n;
  const maxRefund = (listingPrice * 3n) / 4n;

  return (
    <main className={styles.container}>
      <Link href="/" className={styles.backLink}>
        ← Quay về Trang chủ
      </Link>

      <header className={styles.header}>
        <p className="eyebrow">HACKATHON DAY 3 · INTEGRATION PORTAL</p>
        <h1>Marketplace & Dispute Protocol</h1>
        <p className="intro">
          Kết nối hai chuỗi Avalanche Fuji C-Chain và Custom Dispute L1. Tích hợp trọn vẹn luồng Buyer (Mua → Chạy AI →
          Chấp nhận / Khiếu nại) và luồng Reviewer (Thẩm định ZK Proof → Phán quyết → Hoàn tiền).
        </p>
      </header>

      {/* --- Top Bar: Network Info & Multi-Role Selector --- */}
      <nav className={styles.navBar}>
        <div className={styles.networkStatus}>
          <span
            className={`${styles.badge} ${
              chain?.id === FUJI_CHAIN_ID
                ? styles.badgeFuji
                : chain?.id === DISPUTE_CHAIN_ID
                ? styles.badgeDispute
                : styles.badgeOther
            }`}
          >
            <span className={styles.indicator} />
            {chain?.name || 'Chưa kết nối ví'} ({chain?.id || 'N/A'})
          </span>

          {isConnected ? (
            <button className={styles.btnSecondary} onClick={() => disconnect()}>
              Ngắt ví ({address?.slice(0, 6)}...{address?.slice(-4)})
            </button>
          ) : (
            <button
              className={styles.btnPrimary}
              disabled={!connectors.length}
              onClick={() => connect({ connector: connectors[0] })}
            >
              Kết nối ví Web3
            </button>
          )}
        </div>

        <div className={styles.actions} style={{ margin: 0 }}>
          <button
            className={styles.btnSecondary}
            disabled={chain?.id === FUJI_CHAIN_ID}
            onClick={() => switchChain({ chainId: FUJI_CHAIN_ID })}
          >
            Fuji (43113)
          </button>
          <button
            className={styles.btnSecondary}
            disabled={chain?.id === DISPUTE_CHAIN_ID}
            onClick={() => switchChain({ chainId: DISPUTE_CHAIN_ID })}
          >
            Dispute L1 (662831)
          </button>
          <button
            className={styles.btnSecondary}
            disabled={chain?.id === LOCAL_CHAIN_ID}
            onClick={() => switchChain({ chainId: LOCAL_CHAIN_ID })}
          >
            Local (31337)
          </button>
        </div>

        <div className={styles.roleSelector}>
          <button
            className={`${styles.roleBtn} ${activeRole === 'buyer' ? styles.roleBtnActive : ''}`}
            onClick={() => {
              setActiveRole('buyer');
              setActiveTab('marketplace');
            }}
          >
            👤 Buyer
          </button>
          <button
            className={`${styles.roleBtn} ${activeRole === 'seller' ? styles.roleBtnActive : ''}`}
            onClick={() => {
              setActiveRole('seller');
              setActiveTab('seller');
            }}
          >
            🏪 Seller
          </button>
          <button
            className={`${styles.roleBtn} ${activeRole === 'reviewer' ? styles.roleBtnActive : ''}`}
            onClick={() => {
              setActiveRole('reviewer');
              setActiveTab('reviewer');
            }}
          >
            ⚖️ Reviewer / Arbitrator
          </button>
        </div>
      </nav>

      {/* --- Feedback Notification --- */}
      {feedback && (
        <div className={feedback.type === 'error' ? styles.alertBox : styles.successBox}>
          {feedback.message}
        </div>
      )}
      {runtimeError && isLocal && (
        <div className={styles.alertBox}>
          {runtimeError} — dán địa chỉ thủ công trong mục “Cấu hình địa chỉ Contract”.
        </div>
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
                <h2>
                  <span>1. Curated AI Service</span>
                  <span className={styles.badge} style={{ background: '#23343e' }}>
                    P0 MVP
                  </span>
                </h2>
                <h3>Document Summary Agent</h3>
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

                <label className={styles.label}>Mã Order ID (64 ký tự hex):</label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <input
                    className={`${styles.input} ${styles.mono}`}
                    placeholder="0x..."
                    value={orderId}
                    onChange={(e) => setOrderIdState(e.target.value)}
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
                    {orderOnChain.caseId && orderOnChain.caseId !== zeroBytes32 && (
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
                  Nếu dịch vụ vi phạm cam kết, Buyer chọn <strong>Mở tranh chấp</strong> để kích hoạt Teleporter sang
                  Dispute L1.
                </p>
                {orderOnChain && orderOnChain.status !== 2 && orderOnChain.status !== 1 && (
                  <p className={styles.hint}>
                    Order hiện ở trạng thái {ORDER_STATUS_LABELS[orderOnChain.status] || orderOnChain.status}. Accept cần
                    trạng thái <strong>Delivered</strong>; Dispute cần order còn trong cửa sổ khiếu nại.
                  </p>
                )}

                <div className={styles.actions}>
                  <button
                    className={styles.btnPrimary}
                    disabled={busy || !orderId || !isConnected || !orderOnChain || orderOnChain.status !== 2}
                    onClick={handleAcceptOrder}
                  >
                    ✅ Chấp nhận (Ghi có cho Seller)
                  </button>

                  <button
                    className={styles.btnSecondary}
                    style={{ borderColor: '#ff867d', color: '#ff867d' }}
                    disabled={
                      busy ||
                      !orderId ||
                      !isConnected ||
                      !orderOnChain ||
                      (orderOnChain.status !== 1 && orderOnChain.status !== 2)
                    }
                    onClick={handleOpenDispute}
                  >
                    ⚠️ Mở tranh chấp (Cross-Chain Dispute)
                  </button>
                </div>
              </section>
            </>
          )}

          {/* TAB 1.5: SELLER WORKSPACE */}
          {activeTab === 'seller' && (
            <section className={styles.panel}>
              <h2>
                <span>Seller Workspace</span>
                <span
                  className={styles.badge}
                  style={{ background: isSellerWallet ? '#132f30' : '#2a1e1e', color: isSellerWallet ? '#83e8cc' : '#ff867d' }}
                >
                  {isSellerWallet ? 'Ví Seller hợp lệ' : 'Ví không phải Seller'}
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

              <h3 style={{ marginTop: '1.5rem' }}>3. Rút tiền từ Escrow</h3>
              <div className={styles.statusCard}>
                <div className={styles.statusRow}>
                  <span className={styles.statusKey}>Claimable của ví hiện tại:</span>
                  <span className={styles.statusVal}>
                    {claimable === null ? '—' : `${formatEther(claimable)} AVAX`}
                  </span>
                </div>
              </div>
              <div className={styles.actions}>
                <button className={styles.btnPrimary} disabled={busy || !claimable || claimable === 0n} onClick={handleWithdraw}>
                  Withdraw
                </button>
                <button className={styles.btnSecondary} disabled={busy} onClick={() => void loadClaimable()}>
                  Làm mới số dư
                </button>
              </div>
            </section>
          )}

          {/* TAB 2: REVIEWER & DISPUTE L1 WORKSPACE */}
          {activeTab === 'reviewer' && (
            <section className={styles.panel}>
              <h2>
                <span>Thẩm định Tranh chấp (Dispute L1)</span>
                <span className={styles.badge} style={{ background: '#1c3638', color: '#83e8cc' }}>
                  Chain ID: {disputeChainId}
                </span>
              </h2>
              <p>
                Trang dành cho Merchant / Arbitrator xem xét các vụ việc được Teleporter chuyển từ Fuji sang. Kiểm tra ZK
                Proof do ProofGate xác minh trước khi quyết định hoàn tiền. AI chỉ đề xuất; người có role mới quyết định.
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

              <label className={styles.label}>Nhập Case ID (bytes32):</label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input
                  className={`${styles.input} ${styles.mono}`}
                  placeholder="0x..."
                  value={caseId}
                  onChange={(e) => setCaseId(e.target.value)}
                />
                <button className={styles.btnSecondary} disabled={busy || !caseId} onClick={() => handleFetchCase()}>
                  Tra cứu
                </button>
              </div>

              {reviewerCase && (
                <div className={styles.statusCard}>
                  <div className={styles.statusRow}>
                    <span className={styles.statusKey}>Trạng thái Case L1:</span>
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
                      {reviewerCase.proofRef && reviewerCase.proofRef !== zeroBytes32
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

              {/* 3 Dispute Agents Pipeline trigger */}
              <div style={{ marginTop: '1.2rem', padding: '1rem', background: '#11191f', borderRadius: '10px', border: '1px solid #23343e' }}>
                <h3 style={{ margin: '0 0 0.6rem', color: '#83e8cc' }}>🤖 Trợ lý AI: 3 Dispute Agents</h3>
                <p style={{ fontSize: '0.88rem', color: '#9db2be', margin: '0 0 0.8rem' }}>
                  Chạy chuỗi phân tích tự động: <strong>Evidence Agent</strong> (bóc tách chứng cứ) → <strong>Policy Agent</strong> (đối chiếu điều khoản) → <strong>Resolution Assistant</strong> (đề xuất mức bồi hoàn cho người duyệt).
                </p>

                <label className={styles.label}>Nội dung bằng chứng khiếu nại (Evidence):</label>
                <textarea
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
                    disabled={pipelineBusy || !evidenceText.trim()}
                    onClick={handleRunDisputePipeline}
                  >
                    🚀 Chạy 3 Dispute Agents
                  </button>
                </div>

                {pipelineResult && (
                  <div className={styles.resultBox} style={{ border: '1px solid #2d7a71', marginTop: '1rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.8rem' }}>
                      <strong style={{ color: '#83e8cc' }}>Kết quả từ 3 Dispute Agents:</strong>
                      <span className={styles.badge} style={{ background: '#132f30', color: '#83e8cc' }}>
                        {pipelineResult.mode === 'openrouter_live' ? '🟢 Live OpenRouter API' : '🟡 Deterministic Mode'}
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

              {/* Proof submission (reviewer wallet, proof produced by prover) */}
              <div style={{ marginTop: '1.2rem', padding: '1rem', background: '#11191f', borderRadius: '10px', border: '1px solid #23343e' }}>
                <h3 style={{ margin: '0 0 0.6rem', color: '#83e8cc' }}>🔐 Nộp ZK Proof (reviewer wallet)</h3>
                <p className={styles.hint}>
                  Proof do prover của Người 2 tạo, ví dụ{' '}
                  <code>node apps/api/src/prove-case.mjs &lt;caseId&gt; &lt;refundWei&gt; &lt;policy.json&gt;</code>. Dán JSON{' '}
                  <code>{'{ proof, publicInputs }'}</code> ở đây; ví reviewer gửi <code>submitProof</code> để ProofGate xác minh.
                </p>
                <textarea
                  className={`${styles.textarea} ${styles.mono}`}
                  rows={5}
                  placeholder='{"proof":"0x...","publicInputs":["0x...",...15 items]}'
                  value={proofJson}
                  onChange={(e) => setProofJson(e.target.value)}
                />
                <div className={styles.actions}>
                  <button
                    className={styles.btnPrimary}
                    disabled={busy || !caseId || !proofJson.trim() || !onDisputeChain}
                    onClick={handleSubmitProof}
                  >
                    Nộp Proof
                  </button>
                </div>
                {!onDisputeChain && <p className={styles.hint}>Chuyển ví sang Dispute L1 trước khi nộp proof.</p>}
              </div>

              <div className={styles.actions}>
                <button
                  className={styles.btnSecondary}
                  disabled={busy || !reviewerCase || reviewerCase.status !== 1}
                  onClick={() => handleReviewerAction('analyze')}
                >
                  1. Bắt đầu phân tích
                </button>

                <button
                  className={styles.btnSecondary}
                  disabled={busy || !reviewerCase || (reviewerCase.status !== 2 && reviewerCase.status !== 3)}
                  onClick={() => handleReviewerAction('beginReview')}
                >
                  2. Chuyển vào Merchant Review
                </button>

                <button
                  className={styles.btnAccent}
                  disabled={busy || !reviewerCase || reviewerCase.status !== 4 || !reviewerCase.proofRef || reviewerCase.proofRef === zeroBytes32}
                  onClick={() => handleReviewerAction('approve')}
                >
                  3. Duyệt hoàn tiền (Approve)
                </button>

                <button
                  className={styles.btnSecondary}
                  style={{ borderColor: '#e95048' }}
                  disabled={busy || !reviewerCase || reviewerCase.status !== 4}
                  onClick={() => handleReviewerAction('reject')}
                >
                  3. Từ chối (Reject)
                </button>

                <button
                  className={styles.btnPrimary}
                  disabled={busy || !reviewerCase || (reviewerCase.status !== 5 && reviewerCase.status !== 6)}
                  onClick={() => handleReviewerAction('sendResolution')}
                >
                  4. Gửi kết quả về Fuji (Teleporter)
                </button>
              </div>
              {!isReviewerWallet && (
                <p className={styles.hint}>
                  Các nút thao tác chỉ chạy khi ví hiện tại trùng địa chỉ reviewer on-chain. Đây là kiểm soát quyền ở
                  contract, không phải nút ẩn trên UI.
                </p>
              )}
            </section>
          )}

          {/* Contract Address Override Setting */}
          <details className={styles.panel} style={{ cursor: 'pointer' }}>
            <summary style={{ fontWeight: 600, color: '#9db2be' }}>⚙️ Cấu hình địa chỉ Contract</summary>
            <div style={{ marginTop: '1rem' }}>
              <p className={styles.hint}>
                Local: tự đọc từ <code>.runtime/day2/day2-local.json</code>. Fuji/L1: đặt biến{' '}
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
              <label className={styles.label}>DisputeManager ({isLocal ? 'Local' : 'Dispute L1'}):</label>
              <input
                className={`${styles.input} ${styles.mono}`}
                value={customDisputeManager}
                placeholder={disputeBook.disputeManager}
                onChange={(e) => setCustomDisputeManager(e.target.value)}
              />
              <label className={styles.label}>DisputeResultSender ({isLocal ? 'Local' : 'Dispute L1'}):</label>
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

        {/* Right Column: Live Audit Timeline & Explorer Links */}
        <div>
          <section className={styles.panel}>
            <h2>
              <span>Nhật ký giao dịch (Live Audit)</span>
              <button
                className={styles.btnSecondary}
                style={{ padding: '0.2rem 0.6rem', fontSize: '0.8rem' }}
                onClick={() => setLogs([])}
              >
                Xóa
              </button>
            </h2>

            {logs.length === 0 ? (
              <p style={{ color: '#8fa5b0' }}>Chưa có sự kiện nào được ghi nhận.</p>
            ) : (
              <ul className={styles.timelineList}>
                {logs.map((log, idx) => {
                  const explorer = log.chainId ? EXPLORERS[log.chainId] : null;
                  return (
                    <li key={idx}>
                      <span className={styles.stepNumber}>{logs.length - idx}</span>
                      <strong style={{ color: '#83e8cc' }}>[{log.time}]</strong> {log.text}
                      {log.txHash && explorer && (
                        <div>
                          <a
                            href={explorer.txUrl(log.txHash)}
                            target="_blank"
                            rel="noreferrer"
                            className={styles.linkExplorer}
                          >
                            🔗 Xem trên {explorer.name} ↗
                          </a>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Quick Guide & Roles */}
          <section className={styles.panel}>
            <h2>Hướng dẫn thử nghiệm nhanh</h2>
            <ol style={{ paddingLeft: '1.2rem', color: '#b4c0c7', lineHeight: 1.7 }}>
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
                <strong>Nghiệm thu / Khiếu nại:</strong> Buyer Accept để trả tiền, hoặc Open Dispute để gửi hồ sơ sang
                Dispute L1.
              </li>
              <li>
                <strong>Thẩm định (L1):</strong> chuyển sang Dispute L1, tra cứu Case ID, nộp ZK proof, duyệt/từ chối hoàn tiền,
                rồi gửi kết quả về Fuji. Mỗi bước có explorer link trong nhật ký.
              </li>
            </ol>
          </section>
        </div>
      </div>
    </main>
  );
}
