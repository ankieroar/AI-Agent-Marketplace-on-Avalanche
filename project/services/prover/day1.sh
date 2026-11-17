#!/usr/bin/env bash
set -euo pipefail
# Run inside Linux; pin compatible releases instead of mixing nightly versions.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TOOLS="$ROOT/.tools"
mkdir -p "$TOOLS/noir" "$TOOLS/bb"
export PATH="$TOOLS/noir:$TOOLS/bb:$PATH"
if ! command -v nargo >/dev/null; then
 curl --fail -L https://github.com/noir-lang/noir/releases/download/v1.0.0-beta.3/nargo-x86_64-unknown-linux-gnu.tar.gz -o "$TOOLS/noir.tar.gz"
 tar -xzf "$TOOLS/noir.tar.gz" -C "$TOOLS/noir"
fi
if ! command -v bb >/dev/null; then
 curl --fail -L https://github.com/AztecProtocol/aztec-packages/releases/download/v0.82.2/barretenberg-amd64-linux.tar.gz -o "$TOOLS/bb.tar.gz"
 tar -xzf "$TOOLS/bb.tar.gz" -C "$TOOLS/bb"
fi
nargo --version
bb --version
cd "$ROOT/circuits/hello_world"
if [ ! -f Prover.toml ]; then cp Prover.example.toml Prover.toml; fi
nargo test
nargo execute
bb write_vk -b target/hello_world.json -o target/vk --oracle_hash keccak
bb prove -b target/hello_world.json -w target/hello_world.gz -o target/proof --oracle_hash keccak
bb verify -k target/vk -p target/proof --oracle_hash keccak
bb contract -k target/vk -o target/UltraVerifier.sol
mkdir -p "$ROOT/contracts/contracts/generated"
cp target/UltraVerifier.sol "$ROOT/contracts/contracts/generated/UltraVerifier.sol"
