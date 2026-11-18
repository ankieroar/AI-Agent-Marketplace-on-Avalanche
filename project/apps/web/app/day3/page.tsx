'use client';

import Link from 'next/link';
import { useState, useEffect } from 'react';
import {
  useAccount,
  useConnect,
  useDisconnect,
  useSwitchChain,
  useSignMessage,
  usePublicClient,
  useWalletClient,
} from 'wagmi';
import {
  sha256,
  toBytes,
  parseEther,
  formatEther,
  keccak256,
  stringToHex,
  encodePacked,
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
  disputeManagerAbi,
  disputeResultSenderAbi,
  ORDER_STATUS_LABELS,
  CASE_STATUS_LABELS,
  DEFAULT_AGENT_ID,
  DEFAULT_POLICY_VERSION,
} from '../contracts';

type Role = 'buyer' | 'seller' | 'reviewer';
type Result = { summary: string; keyPoints: string[]; caveats: string[] };

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
  const { switchChain } = useSwitchChain();
  const { signMessageAsync } = useSignMessage();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();

  // --- UI & Role Mode ---
  const [activeRole, setActiveRole] = useState<Role>('buyer');
  const [activeTab, setActiveTab] = useState<'marketplace' | 'reviewer'>('marketplace');

  // --- Contract Addresses (Configurable / Default) ---
  const [customOrderManager, setCustomOrderManager] = useState('');
  const [customGateway, setCustomGateway] = useState('');
  const [customDisputeManager, setCustomDisputeManager] = useState('');
  const [customResultSender, setCustomResultSender] = useState('');

  // Auto-detect addresses based on chain
  const orderManagerAddress = (customOrderManager.trim() ||
    (chain?.id === FUJI_CHAIN_ID
      ? DEFAULT_ADDRESSES.fuji.serviceOrderManager
      : DEFAULT_ADDRESSES.local.serviceOrderManager)) as `0x${string}`;

  const gatewayAddress = (customGateway.trim() ||
    (chain?.id === FUJI_CHAIN_ID
      ? DEFAULT_ADDRESSES.fuji.marketplaceGateway
      : DEFAULT_ADDRESSES.local.marketplaceGateway)) as `0x${string}`;

  const disputeManagerAddress = (customDisputeManager.trim() ||
    (chain?.id === DISPUTE_CHAIN_ID
      ? DEFAULT_ADDRESSES.disputeL1.disputeManager
      : DEFAULT_ADDRESSES.local.disputeManager)) as `0x${string}`;

  const resultSenderAddress = (customResultSender.trim() ||
    (chain?.id === DISPUTE_CHAIN_ID
      ? DEFAULT_ADDRESSES.disputeL1.resultSender
      : DEFAULT_ADDRESSES.local.resultSender)) as `0x${string}`;

  // --- Buyer / Marketplace States ---
  const [orderId, setOrderId] = useState<string>('');
  const [documentText, setDocumentText] = useState(EXAMPLE_DOC);
  const [orderOnChain, setOrderOnChain] = useState<{
    agentId: string;
    buyer: string;
    seller: string;
    priceWei: bigint;
    status: number;
    resultHash: string;
    caseId: string;
  } | null>(null);

  const [aiResult, setAiResult] = useState<(Result & { mode: string; hash: string }) | null>(null);
  const [caseId, setCaseId] = useState<string>('');
  const [evidenceText, setEvidenceText] = useState('Dịch vụ thiếu các điều khoản bắt buộc và không hoàn thành đúng tiến độ.');

  // --- Reviewer States ---
  const [customApiKey, setCustomApiKey] = useState('');
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

  const [reviewerCase, setReviewerCase] = useState<{
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
  } | null>(null);

  // --- Timeline & Operation Feeds ---
  const [logs, setLogs] = useState<Array<{ time: string; text: string; txHash?: string; chainId?: number }>>([]);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'error' | 'success' | 'info'; message: string } | null>(null);

  const addLog = (text: string, txHash?: string, chainId?: number) => {
    const time = new Date().toLocaleTimeString('vi-VN');
    setLogs((prev) => [{ time, text, txHash, chainId: chainId ?? chain?.id }, ...prev]);
  };

  // --- Helper: Check Order On-Chain ---
  async function fetchOrder(idToQuery?: string) {
    const targetId = (idToQuery || orderId).trim() as `0x${string}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(targetId)) {
      setFeedback({ type: 'error', message: 'Vui lòng nhập Order ID dạng hex 64 ký tự (0x...)' });
      return;
    }
    if (!publicClient) return;
    setBusy(true);
    setFeedback(null);
    try {
      const data = (await publicClient.readContract({
        address: orderManagerAddress,
        abi: serviceOrderManagerAbi,
        functionName: 'orders',
        args: [targetId],
      })) as any;
      const [agentIdVal, buyerVal, sellerVal, priceWeiVal, statusVal, resultHashVal, caseIdVal] = data;
      setOrderOnChain({
        agentId: agentIdVal,
        buyer: buyerVal,
        seller: sellerVal,
        priceWei: priceWeiVal,
        status: Number(statusVal),
        resultHash: resultHashVal,
        caseId: caseIdVal,
      });
      if (caseIdVal && caseIdVal !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
        setCaseId(caseIdVal);
      }
      addLog(`Tra cứu Order on-chain thành công (${ORDER_STATUS_LABELS[Number(statusVal)] || statusVal})`);
    } catch (err: any) {
      setFeedback({ type: 'error', message: 'Lỗi tra cứu contract: ' + (err.shortMessage || err.message) });
    } finally {
      setBusy(false);
    }
  }

  // --- 1. Buy Service On-Chain ---
  async function handleBuyService() {
    if (!address || !walletClient || !publicClient) {
      setFeedback({ type: 'error', message: 'Vui lòng kết nối ví trước.' });
      return;
    }
    if (chain?.id === DISPUTE_CHAIN_ID) {
      setFeedback({ type: 'error', message: 'Mua dịch vụ diễn ra trên Fuji C-Chain hoặc Local, vui lòng chuyển mạng.' });
      return;
    }
    setBusy(true);
    setFeedback({ type: 'info', message: 'Đang chuẩn bị quote và gửi giao dịch mua dịch vụ...' });
    try {
      // Create random salt for unique orderId
      const salt = keccak256(stringToHex(`order-${Date.now()}-${Math.random()}`));
      const commitment = keccak256(stringToHex(`policy-commitment-${salt}`));
      const validUntil = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const price = parseEther('0.01');

      // Note: In local Hardhat / deployed setup, seller signs EIP-712 quote.
      // If direct signature isn't available from UI, we submit with dummy or self-signed if seller=buyer
      const dummyV = 27;
      const dummyR = ('0x' + '1'.repeat(64)) as `0x${string}`;
      const dummyS = ('0x' + '2'.repeat(64)) as `0x${string}`;

      addLog('Gửi giao dịch purchaseService lên Smart Contract...');
      const txHash = await walletClient.writeContract({
        address: orderManagerAddress,
        abi: serviceOrderManagerAbi,
        functionName: 'purchaseService',
        args: [DEFAULT_AGENT_ID, salt, commitment, validUntil, dummyV, dummyR, dummyS],
        value: price,
      });

      addLog(`Giao dịch mua đã gửi: ${txHash}`, txHash);
      setFeedback({ type: 'info', message: 'Đang chờ block xác nhận trên chuỗi...' });

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      const computedId = await publicClient.readContract({
        address: orderManagerAddress,
        abi: serviceOrderManagerAbi,
        functionName: 'orderIdFor',
        args: [address, salt],
      });

      setOrderId(computedId);
      addLog(`Order đã tạo thành công: ${computedId}`, receipt.transactionHash);
      setFeedback({ type: 'success', message: `Đã mua dịch vụ thành công! Order ID: ${computedId}` });
      await fetchOrder(computedId);
    } catch (err: any) {
      // If purchaseService reverts due to signature verification in non-mock contracts, explain clearly:
      setFeedback({
        type: 'error',
        message: 'Lỗi giao dịch mua on-chain: ' + (err.shortMessage || err.message) +
          '. (Gợi ý: Nếu đang chạy fixture API local, bạn có thể dán sẵn Order ID đã thanh toán để tiếp tục luồng Run -> Result -> Dispute).',
      });
    } finally {
      setBusy(false);
    }
  }

  // --- 2. Execute AI Service via Real Backend API ---
  async function handleExecuteService() {
    if (!orderId) {
      setFeedback({ type: 'error', message: 'Cần có Order ID để chạy AI Service.' });
      return;
    }
    if (!address) {
      setFeedback({ type: 'error', message: 'Vui lòng kết nối ví buyer của order này.' });
      return;
    }
    setBusy(true);
    setFeedback({ type: 'info', message: 'Đang ký yêu cầu xác thực bằng ví Buyer...' });
    setAiResult(null);

    try {
      const scope = `${chain?.id || 31337}:${orderManagerAddress.toLowerCase()}`;
      const body = JSON.stringify({ text: documentText.trim() });
      const expires = Math.floor(Date.now() / 1000) + 240;
      const digest = sha256(toBytes(body)).slice(2);
      const message = ['Warranty Day 2 request', scope, 'execute', orderId.toLowerCase(), String(expires), digest].join('\n');

      const signature = await signMessageAsync({ message });
      addLog('Đã ký xác thực ví buyer. Đang gọi Backend Service Agent runtime...');

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

      addLog(`Service Agent hoàn tất phân tích (Mode: ${data.mode})`);
      setFeedback({ type: 'success', message: 'Service Agent đã trả kết quả phân tích có cấu trúc!' });
      await fetchOrder();
    } catch (err: any) {
      setFeedback({ type: 'error', message: 'Lỗi thực thi AI: ' + err.message });
    } finally {
      setBusy(false);
    }
  }

  // --- 3. Buyer Action: Accept Service (Release to Seller) ---
  async function handleAcceptOrder() {
    if (!walletClient || !publicClient || !orderId) return;
    setBusy(true);
    setFeedback({ type: 'info', message: 'Đang gửi giao dịch Accept lên Escrow on-chain...' });
    try {
      const txHash = await walletClient.writeContract({
        address: orderManagerAddress,
        abi: serviceOrderManagerAbi,
        functionName: 'accept',
        args: [orderId as `0x${string}`],
      });
      addLog(`Buyer gửi lệnh Accept: ${txHash}`, txHash);
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      addLog(`Giao dịch Accept hoàn tất! Escrow đã chuyển 0.01 AVAX cho Seller.`);
      setFeedback({ type: 'success', message: 'Buyer đã chấp nhận kết quả! Tiền ký quỹ đã được giải ngân cho Seller.' });
      await fetchOrder();
    } catch (err: any) {
      setFeedback({ type: 'error', message: 'Lỗi khi Accept order: ' + (err.shortMessage || err.message) });
    } finally {
      setBusy(false);
    }
  }

  // --- 4. Buyer Action: Open Dispute (Trigger Teleporter) ---
  async function handleOpenDispute() {
    if (!walletClient || !publicClient || !orderId) return;
    setBusy(true);
    setFeedback({ type: 'info', message: 'Đang mở khiếu nại qua MarketplaceGateway...' });
    try {
      addLog(`Gọi openCase(${orderId}) trên MarketplaceGateway...`);
      const txHash = await walletClient.writeContract({
        address: gatewayAddress,
        abi: marketplaceGatewayAbi,
        functionName: 'openCase',
        args: [orderId as `0x${string}`],
      });
      addLog(`Giao dịch mở dispute đã gửi: ${txHash}`, txHash);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      addLog('Event CaseOpened đã phát. Thông điệp được chuyển qua Teleporter sang Dispute L1.', receipt.transactionHash);
      setFeedback({
        type: 'success',
        message: 'Đã mở khiếu nại thành công! Teleporter đang điều hướng vụ việc sang Dispute L1.',
      });
      await fetchOrder();
    } catch (err: any) {
      setFeedback({ type: 'error', message: 'Lỗi khi mở dispute: ' + (err.shortMessage || err.message) });
    } finally {
      setBusy(false);
    }
  }

  // --- 5. Reviewer: Fetch Case on Dispute L1 ---
  async function handleFetchCase(targetCaseId?: string) {
    const idToLook = (targetCaseId || caseId).trim() as `0x${string}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(idToLook)) {
      setFeedback({ type: 'error', message: 'Vui lòng nhập Case ID hợp lệ (0x...)' });
      return;
    }
    if (!publicClient) return;
    setBusy(true);
    setFeedback(null);
    try {
      const data = (await publicClient.readContract({
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
      setReviewerCase({
        claim: {
          caseId: claimVal.caseId,
          orderId: claimVal.orderId,
          policyCommitment: claimVal.policyCommitment,
          claimTimestamp: claimVal.claimTimestamp,
          lockedAmount: claimVal.lockedAmount,
          purchaseTimestamp: claimVal.purchaseTimestamp,
          claimDeadline: claimVal.claimDeadline,
        },
        status: Number(statusVal),
        payoutAmount: payoutAmountVal,
        proofRef: proofRefVal,
        reviewerApprovalRef: reviewerApprovalRefVal,
      });
      addLog(`Reviewer tra cứu Case L1 thành công (${CASE_STATUS_LABELS[Number(statusVal)] || statusVal})`);
    } catch (err: any) {
      setFeedback({ type: 'error', message: 'Lỗi tra cứu Case L1: ' + (err.shortMessage || err.message) });
    } finally {
      setBusy(false);
    }
  }

  // --- 6. Trigger 3 Dispute Agents Pipeline ---
  async function handleRunDisputePipeline() {
    setPipelineBusy(true);
    setFeedback({ type: 'info', message: 'Đang chạy chuỗi 3 Dispute Agents: Evidence -> Policy -> Resolution...' });
    try {
      const now = Math.floor(Date.now() / 1000);
      const purchaseTime = reviewerCase?.claim.purchaseTimestamp
        ? Number(reviewerCase.claim.purchaseTimestamp)
        : now - 1800;
      const deadline = reviewerCase?.claim.claimDeadline
        ? Number(reviewerCase.claim.claimDeadline)
        : now + 1800;
      const locked = reviewerCase?.claim.lockedAmount
        ? reviewerCase.claim.lockedAmount.toString()
        : '10000000000000000'; // 0.01 AVAX

      const res = await fetch('/api/day3/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: evidenceText.trim(),
          claimTimestamp: String(now),
          policy: {
            purchaseTimestamp: String(purchaseTime),
            warrantyEndTimestamp: String(deadline),
            maxPayout: locked,
            nonce: '0x' + '11'.repeat(32),
          },
          apiKey: customApiKey.trim() || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Lỗi khi gọi pipeline 3 Dispute Agents');

      setPipelineResult(data);
      addLog(`Pipeline 3 Dispute Agents hoàn tất! (Chế độ: ${data.mode})`);
      setFeedback({
        type: 'success',
        message: `3 Dispute Agents đã hoàn thành phân tích! Khuyến nghị hoàn: ${formatEther(BigInt(data.resolution.proposedPayout))} AVAX`,
      });
    } catch (err: any) {
      setFeedback({ type: 'error', message: 'Lỗi chạy Dispute Agents: ' + err.message });
    } finally {
      setPipelineBusy(false);
    }
  }

  // --- 7. Reviewer Actions on Dispute L1 ---
  async function handleReviewerAction(action: 'analyze' | 'beginReview' | 'approve' | 'reject' | 'sendResolution') {
    if (!walletClient || !publicClient || !caseId) return;
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
        addLog(`Reviewer bắt đầu phân tích chứng cứ: ${txHash}`, txHash);
      } else if (action === 'beginReview') {
        txHash = await walletClient.writeContract({
          address: disputeManagerAddress,
          abi: disputeManagerAbi,
          functionName: 'beginReview',
          args: [cId],
        });
        addLog(`Chuyển case sang trạng thái Merchant/Reviewer xét duyệt: ${txHash}`, txHash);
      } else if (action === 'approve') {
        const approvalRef = keccak256(stringToHex(`reviewer-approve-${Date.now()}`));
        txHash = await walletClient.writeContract({
          address: disputeManagerAddress,
          abi: disputeManagerAbi,
          functionName: 'decide',
          args: [cId, true, approvalRef],
        });
        addLog(`Reviewer ĐỒNG Ý hoàn tiền: ${txHash}`, txHash);
      } else if (action === 'reject') {
        const approvalRef = keccak256(stringToHex(`reviewer-reject-${Date.now()}`));
        txHash = await walletClient.writeContract({
          address: disputeManagerAddress,
          abi: disputeManagerAbi,
          functionName: 'decide',
          args: [cId, false, approvalRef],
        });
        addLog(`Reviewer TỪ CHỐI hoàn tiền: ${txHash}`, txHash);
      } else {
        // Send Resolution via Teleporter to C-Chain
        txHash = await walletClient.writeContract({
          address: resultSenderAddress,
          abi: disputeResultSenderAbi,
          functionName: 'sendResolution',
          args: [cId],
        });
        addLog(`Gửi phán quyết qua Teleporter về Fuji C-Chain: ${txHash}`, txHash);
      }

      await publicClient.waitForTransactionReceipt({ hash: txHash });
      setFeedback({ type: 'success', message: `Thao tác [${action}] trên Dispute L1 thành công!` });
      await handleFetchCase();
    } catch (err: any) {
      setFeedback({ type: 'error', message: `Lỗi thao tác reviewer: ` + (err.shortMessage || err.message) });
    } finally {
      setBusy(false);
    }
  }

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
            {chain?.name || 'Mạng chưa xác định'} ({chain?.id || 'N/A'})
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
            Chuyển sang Fuji (43113)
          </button>
          <button
            className={styles.btnSecondary}
            disabled={chain?.id === DISPUTE_CHAIN_ID}
            onClick={() => switchChain({ chainId: DISPUTE_CHAIN_ID })}
          >
            Chuyển sang Dispute L1 (662831)
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
              setActiveTab('marketplace');
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
                    <span className={styles.statusKey}>Giá dịch vụ:</span>
                    <span className={styles.statusVal}>0.01 AVAX testnet</span>
                  </div>
                  <div className={styles.statusRow}>
                    <span className={styles.statusKey}>Chính sách khiếu nại:</span>
                    <span className={styles.statusVal}>Cửa sổ 3600s (1 giờ) từ lúc thanh toán</span>
                  </div>
                  <div className={styles.statusRow}>
                    <span className={styles.statusKey}>Mức hoàn tối đa:</span>
                    <span className={styles.statusVal}>0.005 AVAX (qua ZK Proof)</span>
                  </div>
                </div>

                <div className={styles.actions}>
                  <button className={styles.btnPrimary} disabled={busy || !isConnected} onClick={handleBuyService}>
                    Mua dịch vụ (0.01 AVAX on-chain)
                  </button>
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
                    onChange={(e) => setOrderId(e.target.value)}
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
                      <span className={styles.statusKey}>Tiền ký quỹ Escrow:</span>
                      <span className={styles.statusVal}>{formatEther(orderOnChain.priceWei)} AVAX</span>
                    </div>
                    {orderOnChain.caseId && orderOnChain.caseId !== '0x0000000000000000000000000000000000000000000000000000000000000000' && (
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
                    {aiResult.caveats?.length > 0 && (
                      <div className={styles.caveat}>{aiResult.caveats.join(' ')}</div>
                    )}
                    <p className={`${styles.mono}`} style={{ marginTop: '0.8rem', fontSize: '0.8rem', color: '#7a8e99' }}>
                      Result Hash: {aiResult.hash}
                    </p>
                  </div>
                )}
              </section>

              {/* Step 3: Accept or Open Dispute */}
              <section className={styles.panel}>
                <h2>3. Nghiệm thu hoặc Khiếu nại dịch vụ</h2>
                <p>
                  Nếu hài lòng với kết quả của AI, Buyer chọn <strong>Chấp nhận</strong> để giải ngân tiền cho Seller.
                  Nếu dịch vụ vi phạm cam kết, Buyer chọn <strong>Mở tranh chấp</strong> để kích hoạt Teleporter sang
                  Dispute L1.
                </p>

                <div className={styles.actions}>
                  <button
                    className={styles.btnPrimary}
                    disabled={busy || !orderId || !isConnected}
                    onClick={handleAcceptOrder}
                  >
                    ✅ Chấp nhận (Giải ngân cho Seller)
                  </button>

                  <button
                    className={styles.btnSecondary}
                    style={{ borderColor: '#ff867d', color: '#ff867d' }}
                    disabled={busy || !orderId || !isConnected}
                    onClick={handleOpenDispute}
                  >
                    ⚠️ Mở tranh chấp (Cross-Chain Dispute)
                  </button>
                </div>
              </section>
            </>
          )}

          {/* TAB 2: REVIEWER & DISPUTE L1 WORKSPACE */}
          {activeTab === 'reviewer' && (
            <section className={styles.panel}>
              <h2>
                <span>Thẩm định Tranh chấp (Dispute L1)</span>
                <span className={styles.badge} style={{ background: '#1c3638', color: '#83e8cc' }}>
                  Chain ID: 662831
                </span>
              </h2>
              <p>
                Trang dành cho Merchant / Arbitrator xem xét các vụ việc được Teleporter chuyển từ Fuji sang. Kiểm tra ZK
                Proof do ProofGate xác minh trước khi quyết định hoàn tiền.
              </p>

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
                    <span className={styles.statusKey}>ZK Proof Reference:</span>
                    <span className={`${styles.statusVal} ${styles.mono}`}>
                      {reviewerCase.proofRef && reviewerCase.proofRef !== '0x0000000000000000000000000000000000000000000000000000000000000000'
                        ? '✅ ' + reviewerCase.proofRef.slice(0, 16) + '...'
                        : '⏳ Chưa xác minh'}
                    </span>
                  </div>
                  {reviewerCase.payoutAmount > 0n && (
                    <div className={styles.statusRow}>
                      <span className={styles.statusKey}>Mức hoàn đề xuất:</span>
                      <span className={styles.statusVal} style={{ color: '#ff867d' }}>
                        {formatEther(reviewerCase.payoutAmount)} AVAX
                      </span>
                    </div>
                  )}
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

                <div style={{ marginTop: '0.6rem' }}>
                  <label className={styles.label}>OpenRouter API Key (Tùy chọn - để gọi Live LLM):</label>
                  <input
                    type="password"
                    className={styles.input}
                    placeholder="sk-or-v1-... (Để trống để dùng Local Deterministic Mode)"
                    value={customApiKey}
                    onChange={(e) => setCustomApiKey(e.target.value)}
                  />
                </div>

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
                        {pipelineResult.mode === 'openrouter_live' ? '🟢 Live OpenRouter API' : '🟡 Local Zod Mode'}
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
                    </div>
                  </div>
                )}
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
                  disabled={busy || !reviewerCase || reviewerCase.status !== 4}
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
            </section>
          )}

          {/* Contract Address Override Setting */}
          <details className={styles.panel} style={{ cursor: 'pointer' }}>
            <summary style={{ fontWeight: 600, color: '#9db2be' }}>⚙️ Cấu hình địa chỉ Contract tùy chỉnh</summary>
            <div style={{ marginTop: '1rem' }}>
              <label className={styles.label}>ServiceOrderManager (Fuji/Local):</label>
              <input
                className={`${styles.input} ${styles.mono}`}
                value={customOrderManager}
                placeholder={DEFAULT_ADDRESSES.local.serviceOrderManager}
                onChange={(e) => setCustomOrderManager(e.target.value)}
              />
              <label className={styles.label}>MarketplaceGateway (Fuji/Local):</label>
              <input
                className={`${styles.input} ${styles.mono}`}
                value={customGateway}
                placeholder={DEFAULT_ADDRESSES.local.marketplaceGateway}
                onChange={(e) => setCustomGateway(e.target.value)}
              />
              <label className={styles.label}>DisputeManager (Dispute L1):</label>
              <input
                className={`${styles.input} ${styles.mono}`}
                value={customDisputeManager}
                placeholder={DEFAULT_ADDRESSES.disputeL1.disputeManager}
                onChange={(e) => setCustomDisputeManager(e.target.value)}
              />
              <label className={styles.label}>DisputeResultSender (Dispute L1):</label>
              <input
                className={`${styles.input} ${styles.mono}`}
                value={customResultSender}
                placeholder={DEFAULT_ADDRESSES.disputeL1.resultSender}
                onChange={(e) => setCustomResultSender(e.target.value)}
              />
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
                <strong>Mua dịch vụ:</strong> Kết nối ví Buyer, chọn Mua dịch vụ để ký quỹ escrow 0.01 AVAX.
              </li>
              <li>
                <strong>Chạy AI:</strong> Ký yêu cầu bằng ví Buyer để gọi backend Document Summary Agent.
              </li>
              <li>
                <strong>Nghiệm thu:</strong> Chọn Chấp nhận để trả tiền cho Seller, hoặc Mở tranh chấp để gửi hồ sơ sang Dispute L1.
              </li>
              <li>
                <strong>Thẩm định (L1):</strong> Chuyển sang mạng Dispute L1, tra cứu Case ID, xác minh ZK Proof và duyệt hoàn tiền.
              </li>
            </ol>
          </section>
        </div>
      </div>
    </main>
  );
}
