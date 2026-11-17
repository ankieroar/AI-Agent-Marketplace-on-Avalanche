#!/usr/bin/env bash
set -euo pipefail
# Run inside Linux; pin compatible releases instead of mixing nightly versions.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TOOLS="$ROOT/.tools"
mkdir -p "$TOOLS/noir"
export PATH="$TOOLS/noir:$PATH"
if ! command -v nargo >/dev/null; then
 curl --fail -L https://github.com/noir-lang/noir/releases/download/v1.0.0-beta.3/nargo-x86_64-unknown-linux-gnu.tar.gz -o "$TOOLS/noir.tar.gz"
 tar -xzf "$TOOLS/noir.tar.gz" -C "$TOOLS/noir"
fi
nargo --version
cd "$ROOT/circuits/hello_world"
if [ ! -f Prover.toml ]; then cp Prover.example.toml Prover.toml; fi
nargo test
nargo execute
# Use the same Barretenberg version through WASM on CPUs where native bb traps.
# The API exports the actual VK and Solidity verifier, with blinded UltraPlonk proofs.
cd "$ROOT/services/prover"
npm ci --workspaces=false
node prove-wasm.mjs
