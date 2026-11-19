$projectDir = Split-Path -Parent $PSScriptRoot
$runtimeFile = Join-Path $projectDir 'deployments/fuji-only/runtime.json'
$deployment = Get-Content -LiteralPath $runtimeFile -Raw -ErrorAction Stop | ConvertFrom-Json
if ($deployment.chainId -ne 43113 -or $deployment.transport -ne 'same-chain') {
    throw 'Expected the Fuji same-chain deployment.'
}
$env:DAY2_CONTRACTS_FILE = $runtimeFile
$env:DAY3_SERVICE_MANIFEST = $runtimeFile
$env:DAY3_L1_MANIFEST = $runtimeFile
$env:DAY2_RPC_URL = 'https://api.avax-test.network/ext/bc/C/rpc'
$env:DAY3_SERVICE_RPC_URL = $env:DAY2_RPC_URL
$env:DAY3_L1_RPC_URL = $env:DAY2_RPC_URL
$env:NEXT_PUBLIC_DAY3_TRANSPORT = 'fuji-only'
$env:NEXT_PUBLIC_FUJI_SERVICE_ORDER_MANAGER = $deployment.contracts.ServiceOrderManager.address
$env:NEXT_PUBLIC_FUJI_MARKETPLACE_GATEWAY = $deployment.contracts.MarketplaceGateway.address
$env:NEXT_PUBLIC_FUJI_AGENT_REGISTRY = $deployment.contracts.AgentRegistry.address
$env:NEXT_PUBLIC_FUJI_ESCROW = $deployment.contracts.SettlementEscrow.address
$env:NEXT_PUBLIC_L1_DISPUTE_MANAGER = $deployment.contracts.DisputeManager.address
$env:NEXT_PUBLIC_L1_PROOF_GATE = $deployment.contracts.ProofGate.address
$env:NEXT_PUBLIC_L1_RESULT_SENDER = $deployment.contracts.DisputeResultSender.address
