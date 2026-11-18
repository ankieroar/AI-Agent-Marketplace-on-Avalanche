'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useAccount, useConnect, useSignMessage } from 'wagmi';
import { sha256, toBytes } from 'viem';
import styles from './day2.module.css';

type Status = 'PAID' | 'RUNNING' | 'DELIVERED' | 'ACCEPTED' | 'DISPUTED';
type Result = {summary:string;keyPoints:string[];caveats:string[]};
type Review = 'OPENED' | 'ANALYZING' | 'APPROVED' | 'REJECTED';
const example = 'Đơn #001 mua dịch vụ tóm tắt tài liệu với giá 0,01 AVAX. Tài liệu mô tả quy trình xử lý trong một ngày. Tài liệu không ghi rõ thời điểm bắt đầu.';
const reviewNotes = {
  evidence:'Tài liệu mô tả thời gian xử lý trong một ngày, thiếu thời điểm bắt đầu.',
  policy:'Order mẫu dùng cửa sổ khiếu nại một giờ kể từ lúc mua.',
  resolution:'Đề xuất hoàn một nửa phí thử nghiệm. Reviewer cần xác nhận.',
};

function Summary({result}:{result:Result}) {
  return <>
    <p>{result.summary}</p>
    <ul>{result.keyPoints.map((point,i)=><li key={i}>{point}</li>)}</ul>
    {result.caveats.length>0 && <p className={styles.note}>{result.caveats.join(' ')}</p>}
  </>;
}

function ConnectedExecution() {
  const {address}=useAccount();
  const {connect,connectors,error:connectError}=useConnect();
  const {signMessageAsync}=useSignMessage();
  const [id,setId]=useState('');
  const [text,setText]=useState(example);
  const [order,setOrder]=useState<{scope:string;buyer:string;status:number}|null>(null);
  const [result,setResult]=useState<(Result & {mode:string;hash:string})|null>(null);
  const [busy,setBusy]=useState(false);
  const [feedback,setFeedback]=useState('');
  const orderId=id.trim().toLowerCase();

  async function loadOrder() {
    const response=await fetch('/api/day2/orders/'+orderId);
    const data=await response.json();
    if(!response.ok) throw new Error(data.error);
    setOrder(data);
    return data as NonNullable<typeof order>;
  }
  async function act(run:boolean) {
    if(!/^0x[0-9a-f]{64}$/.test(orderId)) {setFeedback('Nhập orderId dạng 0x kèm 64 ký tự hex.');return;}
    setBusy(true);setFeedback('');setResult(null);
    try {
      const known=await loadOrder();
      if (!run) return;
      if (address?.toLowerCase()!==known.buyer.toLowerCase()) throw new Error('Kết nối ví buyer của order.');
      const body=JSON.stringify({text:text.trim()});
      const expires=Math.floor(Date.now()/1000)+240;
      const digest=sha256(toBytes(body)).slice(2);
      const message=['Warranty Day 2 request',known.scope,'execute',orderId,String(expires),digest].join('\n');
      const signature=await signMessageAsync({message});
      const response=await fetch('/api/day2/orders/'+orderId+'/execute',{
        method:'POST',headers:{'Content-Type':'application/json','X-Wallet-Expires':String(expires),
          'X-Wallet-Signature':signature},body,
      });
      const data=await response.json();
      if (!response.ok) throw new Error(data.error);
      if (response.status===202) {setFeedback('Order đang chạy. Thử lại với cùng văn bản.');return;}
      setResult({...data.result,mode:data.mode,hash:data.resultHash});
    } catch(error) {
      setFeedback(error instanceof Error?error.message:'Không thể thực hiện giao dịch.');
    } finally {setBusy(false);}
  }
  return <section className={styles.panel}>
    <h2>Chạy qua API với order Hardhat</h2>
    <p>Mở Hardhat node, tạo một order chưa chạy và nhập ID bên dưới. Ví buyer ký yêu cầu API.</p>
    {address?<p className={styles.mono}>{address}</p>:<button disabled={!connectors.length}
      onClick={()=>connect({connector:connectors[0]})}>Kết nối ví buyer</button>}
    <label htmlFor="order">Order ID</label>
    <input id="order" value={id} onChange={event=>{setId(event.target.value);setOrder(null);setResult(null);}} />
    <label htmlFor="real-text">Văn bản mẫu</label>
    <textarea id="real-text" rows={4} value={text} maxLength={12000} onChange={event=>setText(event.target.value)} />
    <div className={styles.actions}>
      <button disabled={busy} onClick={()=>void act(false)}>Kiểm tra order</button>
      <button disabled={busy || !address || !text.trim()} onClick={()=>void act(true)}>Ký và chạy agent</button>
    </div>
    {order&&<p>Trạng thái on-chain: {['MISSING','PAID','DELIVERED','ACCEPTED','DISPUTED','RESOLVED','EXPIRED'][order.status] || order.status}</p>}
    {result&&<div><p>Chế độ: <strong>{result.mode}</strong></p><Summary result={result}/><p className={styles.mono}>{result.hash}</p></div>}
    {(feedback || connectError)&&<p role="alert">{feedback || connectError?.message}</p>}
  </section>;
}

export default function Day2() {
  const [details,setDetails]=useState(false);
  const [mode,setMode]=useState<'demo'|'api'>('demo');
  const [status,setStatus]=useState<Status>();
  const [review,setReview]=useState<Review>();
  const [document,setDocument]=useState(example);
  const [evidence,setEvidence]=useState('Thiếu thời điểm bắt đầu trong tài liệu.');
  const [result,setResult]=useState<Result>();
  const [timeline,setTimeline]=useState<string[]>([]);
  const step=(next:string)=>setTimeline(items=>[...items,next]);

  async function execute() {
    setStatus('RUNNING');step('Agent bắt đầu xử lý.');
    await new Promise(resolve=>setTimeout(resolve,500));
    const excerpt=document.trim().slice(0,240);
    setResult({summary:excerpt,keyPoints:[excerpt],caveats:['Kết quả giả lập dùng để kiểm tra giao diện.']});
    setStatus('DELIVERED');step('Agent đã giao kết quả.');
  }
  function reset() {setStatus(undefined);setReview(undefined);setResult(undefined);setTimeline([]);}
  return <main className={styles.workspace}>
    <Link href="/">← Day 1</Link>
    <header><p className="eyebrow">AI AGENT MARKETPLACE</p><h1>Document Summary Agent</h1>
      <p>Tóm tắt tài liệu ngắn và kiểm tra luồng khiếu nại của một đơn dịch vụ.</p></header>
    <div className={styles.actions}>
      <button aria-pressed={mode==='demo'} onClick={()=>setMode('demo')}>Demo giả lập</button>
      <button aria-pressed={mode==='api'} onClick={()=>setMode('api')}>API local</button>
    </div>
    {mode==='api'?<ConnectedExecution/>:<div className={styles.grid}>
      <div>
        <section className={styles.panel}><h2>Danh sách agent</h2>
          <h3>Document Summary</h3><p>Tóm tắt, ý chính và điểm còn thiếu trong tài liệu.</p>
          <p><strong>0,01 AVAX mô phỏng</strong></p>
          <button onClick={()=>setDetails(value=>!value)}>{details?'Ẩn chi tiết':'Xem chi tiết'}</button>
          {details&&<div><p>Cửa sổ khiếu nại: một giờ kể từ lúc mua.</p>
            <button disabled={!!status} onClick={()=>{setStatus('PAID');step('Đã mua. Phí được khóa trong escrow giả lập.');}}>Mua dịch vụ</button>
          </div>}
        </section>
        {status&&<section className={styles.panel}><h2>Order dịch vụ</h2><p className={styles.status}>{status}</p>
          <label htmlFor="document">Tài liệu mẫu</label><textarea rows={4} id="document" value={document}
            disabled={status!=='PAID'} onChange={event=>setDocument(event.target.value)} maxLength={12000}/>
          <button disabled={status!=='PAID'||!document.trim()} onClick={()=>void execute()}>Chạy agent</button>
          {result&&<div><h3>Kết quả</h3><Summary result={result}/></div>}
          {status==='DELIVERED'&&<div className={styles.actions}>
            <button onClick={()=>{setStatus('ACCEPTED');step('Buyer chấp nhận. Escrow trả seller.');}}>Chấp nhận</button>
            <button onClick={()=>{setStatus('DISPUTED');setReview('OPENED');step('Đã mở khiếu nại.');}}>Mở tranh chấp</button>
          </div>}
          {(status==='ACCEPTED'||review==='APPROVED'||review==='REJECTED')&&<button onClick={reset}>Tạo order mới</button>}
        </section>}
      </div>
      <div>
        <section className={styles.panel}><h2>Timeline</h2>
          {timeline.length?<ol>{timeline.map((event,i)=><li key={i}>{event}</li>)}</ol>:<p>Chưa có giao dịch.</p>}
        </section>
        {review&&<section className={styles.panel}><h2>Reviewer</h2><p className={styles.status}>{review}</p>
          <label htmlFor="evidence">Bằng chứng mẫu</label><textarea rows={3} id="evidence" value={evidence}
            disabled={review!=='OPENED'} onChange={event=>setEvidence(event.target.value)}/>
          {review==='OPENED'&&<button disabled={!evidence.trim()} onClick={()=>{setReview('ANALYZING');step('Đã lưu bằng chứng mẫu và chạy pipeline giả lập.');}}>Phân tích</button>}
          {review!=='OPENED'&&<dl>{Object.entries(reviewNotes).map(([key,value])=><div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>}
          {review==='ANALYZING'&&<div className={styles.actions}>
            <button onClick={()=>{setReview('APPROVED');step('Reviewer duyệt hoàn 0,005 AVAX mô phỏng.');}}>Duyệt hoàn tiền</button>
            <button onClick={()=>{setReview('REJECTED');step('Reviewer từ chối hoàn tiền.');}}>Từ chối</button>
          </div>}
        </section>}
      </div>
    </div>}
  </main>;
}
