import './globals.css';import Providers from './providers';
export const metadata={title:'Dispute L1 · Warranty',description:'Private warranty protocol — Day 1 foundation'};
export default function Layout({children}:{children:React.ReactNode}){return <html lang="vi"><body><Providers>{children}</Providers></body></html>;}

