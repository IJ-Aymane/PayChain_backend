import { randomUUID } from "node:crypto";

import { execute, query } from "../config/database.mjs";

export async function createEscrow({
  buyerUserId,
  sellerUserId,
  buyerAddress,
  sellerAddress,
  asset,
  amount,
  onchainEscrowId = null,
  status,
  depositTxHash = null,
  error = null
}) {
  const id = randomUUID();

  await execute(
    `INSERT INTO escrows (
      id, buyer_user_id, seller_user_id, buyer_address, seller_address, asset,
      amount, onchain_escrow_id, status, deposit_tx_hash, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, buyerUserId, sellerUserId, buyerAddress, sellerAddress, asset, String(amount), onchainEscrowId, status, depositTxHash, error]
  );

  return findEscrowById(id);
}

export async function findEscrowById(id) {
  const rows = await query("SELECT * FROM escrows WHERE id = ? LIMIT 1", [id]);
  return rows[0] ?? null;
}

export async function updateEscrow(id, updates) {
  const allowed = new Map([
    ["status", "status"],
    ["onchainEscrowId", "onchain_escrow_id"],
    ["depositTxHash", "deposit_tx_hash"],
    ["releaseTxHash", "release_tx_hash"],
    ["disputeTxHash", "dispute_tx_hash"],
    ["refundTxHash", "refund_tx_hash"],
    ["error", "error"]
  ]);

  const entries = Object.entries(updates).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    return findEscrowById(id);
  }

  const assignments = [];
  const values = [];
  for (const [key, value] of entries) {
    const column = allowed.get(key);
    if (!column) {
      continue;
    }

    assignments.push(`${column} = ?`);
    values.push(value);
  }

  assignments.push("updated_at = CURRENT_TIMESTAMP");
  values.push(id);

  await execute(`UPDATE escrows SET ${assignments.join(", ")} WHERE id = ?`, values);
  return findEscrowById(id);
}

export async function listEscrowsForUser(userId) {
  return query(
    `SELECT * FROM escrows
     WHERE buyer_user_id = ? OR seller_user_id = ?
     ORDER BY created_at DESC`,
    [userId, userId]
  );
}
