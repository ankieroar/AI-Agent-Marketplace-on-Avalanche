import './globals.css';import Providers from './providers';
export const metadata={title:'AI Marketplace & Dispute Protocol',description:'Avalanche Fuji marketplace, escrow and on-chain policy proof verification'};
export default function Layout({children}:{children:React.ReactNode}){return <html lang="vi"><body><Providers>{children}</Providers></body></html>;}

