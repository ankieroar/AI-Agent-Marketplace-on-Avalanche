'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { OrderWorkspace } from './order-workspace';
import styles from './day2.module.css';

function WorkspacePage() {
  const order = useSearchParams().get('order');
  const orderId = order?.trim().toLowerCase();
  if (orderId && /^0x[0-9a-f]{64}$/.test(orderId)) {
    return <OrderWorkspace key={orderId} orderId={orderId} />;
  }
  return (
    <main className={styles.workspace}>
      <header>
        <h1>Workspace Document Summary</h1>
        <p role={order === null ? undefined : 'alert'}>
          {order === null
            ? 'Mua dịch vụ và chọn một đơn đã thanh toán để tóm tắt tài liệu hoặc hỏi AI.'
            : 'Order ID trong liên kết không hợp lệ. Chọn lại đơn từ marketplace.'}
        </p>
      </header>
      <nav className={styles.workspaceNav} aria-label="Marketplace">
        <Link href="/day3#service-listing">Mua dịch vụ</Link>
        <Link href="/day3#my-services">Dịch vụ đã mua</Link>
      </nav>
    </main>
  );
}

export default function Day2() {
  return (
    <Suspense fallback={<main className={styles.workspace}>Đang mở workspace AI…</main>}>
      <WorkspacePage />
    </Suspense>
  );
}
