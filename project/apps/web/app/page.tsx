'use client';

import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi';
import Link from 'next/link';

export default function Page() {
  const { address, isConnected, chain } = useAccount();
  const { connect, connectors, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, error: switchError } = useSwitchChain();

  return (
    <main>
      <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
        <Link href="/day3" style={{ color: '#83e8cc', fontWeight: 'bold' }}>
          🚀 Day 3 · Integration Portal (Marketplace + Dispute) →
        </Link>
        <span style={{ color: '#556' }}>|</span>
        <Link href="/day2" style={{ color: '#b4c0c7' }}>
          Day 2 · Marketplace Demo
        </Link>
      </div>

      <p className="eyebrow">AVALANCHE / PRIVATE DISPUTE & MARKETPLACE PROTOCOL</p>
      <h1>
        Bảo hành minh bạch.
        <br />
        Bằng chứng riêng tư.
      </h1>
      <p className="intro">
        Nền tảng xử lý khiếu nại dịch vụ AI trên Fuji C-Chain và Custom Dispute L1. Tích hợp ZK Proof, Teleporter cross-chain
        và AI Agent Service Marketplace.
      </p>

      <section>
        <h2>Kết nối mạng thử nghiệm</h2>
        {isConnected ? (
          <>
            <p className="address">{address}</p>
            <p>Mạng hiện tại: {chain?.name || 'Không hỗ trợ'} (ID: {chain?.id})</p>
            <button onClick={() => disconnect()}>Ngắt kết nối</button>
          </>
        ) : (
          <button disabled={!connectors.length} onClick={() => connect({ connector: connectors[0] })}>
            Kết nối ví
          </button>
        )}
        <div className="networks">
          <button disabled={!isConnected} onClick={() => switchChain({ chainId: 43113 })}>
            Fuji C-Chain · 43113
          </button>
          <button disabled={!isConnected} onClick={() => switchChain({ chainId: 662831 })}>
            Dispute L1 · 662831
          </button>
        </div>
        <p role="alert">{error?.message || switchError?.message}</p>
      </section>

      <section>
        <h2>Tiến trình tích hợp Ngày 3</h2>
        <p>
          <strong>Luồng hoàn chỉnh:</strong> Kết nối ví (Buyer/Seller/Reviewer) → Browse Service → Buy on-chain (Escrow) →
          Execute AI qua Backend → Nghiệm thu (Release) hoặc Mở khiếu nại (Teleporter) → Reviewer thẩm định ZK Proof trên L1 →
          Giải ngân hoàn tiền.
        </p>
        <div style={{ marginTop: '1rem' }}>
          <Link href="/day3">
            <button style={{ background: '#83e8cc', color: '#101519', fontWeight: 600 }}>
              Mở Giao diện Tích hợp Ngày 3 →
            </button>
          </Link>
        </div>
      </section>
    </main>
  );
}
