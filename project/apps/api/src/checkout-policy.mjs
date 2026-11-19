// Called only after reading the order from the configured settlement contract.
export async function persistCheckoutPolicy(pool, order) {
  await pool.query(`INSERT INTO service_policies
    (order_id,agent_id,policy_version_hash,commitment,ciphertext,source)
    SELECT order_id,agent_id,policy_version_hash,commitment,ciphertext,'checkout'
    FROM pending_service_policies WHERE order_id=$1 AND commitment=$2
    AND agent_id=$3 AND policy_version_hash=$4
    ON CONFLICT(order_id) DO NOTHING`,
    [order.orderId,order.policyCommitment,order.agentId,order.policyVersionHash]);
}
