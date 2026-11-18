use std::hash::blake2s;

fn id_bytes(hi: Field, lo: Field) -> [u8; 32] {
    let h: [u8; 32] = hi.to_be_bytes();
    let l: [u8; 32] = lo.to_be_bytes();
    let mut bytes: [u8; 32] = [0; 32];
    for i in 0..16 {
        assert((h[i] == 0) & (l[i] == 0));
        bytes[i] = h[16 + i];
        bytes[16 + i] = l[16 + i];
    }
    bytes
}

fn commitment(order: [u8; 32], version: [u8; 32], window: u64, max_refund: u64,
              nonce: [u8; 16]) -> [u8; 32] {
    let domain = "avalanche.service.policy.v1".as_bytes();
    let w: [u8; 32] = (window as Field).to_be_bytes();
    let m: [u8; 32] = (max_refund as Field).to_be_bytes();
    let mut preimage: [u8; 128] = [0; 128];
    for i in 0..27 { preimage[i] = domain[i]; }
    for i in 0..32 {
        preimage[32 + i] = order[i];
        preimage[64 + i] = version[i];
    }
    for i in 0..8 {
        preimage[96 + i] = w[24 + i];
        preimage[104 + i] = m[24 + i];
    }
    for i in 0..16 { preimage[112 + i] = nonce[i]; }
    blake2s(preimage)
}

fn case_nullifier(order: [u8; 32], case_id: [u8; 32], source: [u8; 32],
                  policy: [u8; 32], nonce: [u8; 16]) -> Field {
    let domain = "avalanche.service.nullifier.v1".as_bytes();
    let mut preimage: [u8; 176] = [0; 176];
    for i in 0..30 { preimage[i] = domain[i]; }
    for i in 0..32 {
        preimage[32 + i] = order[i];
        preimage[64 + i] = case_id[i];
        preimage[96 + i] = source[i];
        preimage[128 + i] = policy[i];
    }
    for i in 0..16 { preimage[160 + i] = nonce[i]; }
    let digest = blake2s(preimage);
    let mut result = 0;
    for i in 1..32 { result = result * 256 + digest[i] as Field; }
    result
}

fn main(
    case_hi: pub Field, case_lo: pub Field,
    order_hi: pub Field, order_lo: pub Field,
    commitment_hi: pub Field, commitment_lo: pub Field,
    version_hi: pub Field, version_lo: pub Field,
    source_hi: pub Field, source_lo: pub Field,
    claim_timestamp: pub u64, payout_amount: pub u64, nullifier: pub Field,
    purchase_timestamp: pub u64, claim_deadline: pub u64,
    dispute_window: u64, max_refund: u64, policy_nonce: [u8; 16],
) {
    let order = id_bytes(order_hi, order_lo);
    let policy = id_bytes(commitment_hi, commitment_lo);
    assert(commitment(order, id_bytes(version_hi, version_lo), dispute_window, max_refund, policy_nonce) == policy);
    assert((purchase_timestamp > 0) & (dispute_window > 0));
    assert(claim_deadline == purchase_timestamp + dispute_window);
    assert((claim_timestamp >= purchase_timestamp) & (claim_timestamp <= claim_deadline));
    assert((payout_amount > 0) & (payout_amount <= max_refund));
    assert(nullifier != 0);
    assert(case_nullifier(order, id_bytes(case_hi, case_lo), id_bytes(source_hi, source_lo), policy, policy_nonce) == nullifier);
}
