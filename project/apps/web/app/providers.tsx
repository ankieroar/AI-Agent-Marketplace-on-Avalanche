'use client';
import {WagmiProvider,createConfig,http} from 'wagmi';
import {injected} from 'wagmi';
import {avalancheFuji} from 'wagmi/chains';
import {defineChain} from 'viem';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {useState} from 'react';
export const dispute=defineChain({id:662831,name:'Dispute L1',nativeCurrency:{name:'DISP',symbol:'DISP',decimals:18},rpcUrls:{default:{http:['https://managed-nodes.avax.network/ext/bc/CnnZk7teddWLgqy2BD74T6TDUD6oJJVR3DtZTAspXSDd2xCvz/rpc']}},testnet:true});
const config=createConfig({chains:[avalancheFuji,dispute],connectors:[injected()],transports:{[avalancheFuji.id]:http(),[dispute.id]:http()}});
export default function Providers({children}:{children:React.ReactNode}){const [client]=useState(()=>new QueryClient());return <WagmiProvider config={config}><QueryClientProvider client={client}>{children}</QueryClientProvider></WagmiProvider>;}

