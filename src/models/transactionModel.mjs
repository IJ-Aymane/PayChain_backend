import { randomUUID } from "node:crypto";

import { query, withTransaction } from "../config/database.mjs";
import { appendTransactionBlockTx, assertLocalChainHealthy } from "./localBlockchainModel.mjs";

export async function createTransaction({
  type,
  asset,
  amount,
  fromUserId = null,
  toUserId = null,
  fromAddress = null,
  toAddress = null,
  txHash = null,
  status,
  error = null,
  metadata = null
}) {
  const id = randomUUID();
  await assertLocalChainHealthy();

  return withTransaction(async (tx) => {
    await tx.execute(
      `INSERT INTO transactions (
        id, type, asset, from_user_id, to_user_id, from_address, to_address,
        amount, tx_hash, status, error, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        type,
        asset,
        fromUserId,
        toUserId,
        fromAddress,
        toAddress,
        String(amount),
        txHash,
        status,
        error,
        metadata ? JSON.stringify(metadata) : null
      ]
    );

    const rows = await tx.query("SELECT * FROM transactions WHERE id = ? LIMIT 1", [id]);
    const transaction = rows[0];
    await appendTransactionBlockTx(tx, transaction);
    return transaction;
  });
}

export async function findTransactionById(id) {
  const rows = await query("SELECT * FROM transactions WHERE id = ? LIMIT 1", [id]);
  return rows[0] ?? null;
}

export async function listTransactionsForUser(userId) {
  return query(
    `SELECT * FROM transactions
     WHERE from_user_id = ? OR to_user_id = ?
     ORDER BY created_at DESC`,
    [userId, userId]
  );
}

export async function listTransactionsForUserFiltered({ userId, type = "", status = "", from = "", to = "", search = "", limit = 200 } = {}) {
  const { whereSql, params } = buildTransactionFilters({ userId, type, status, from, to, search });
  const sanitizedLimit = sanitizeLimit(limit, 200, 500);

  return query(
    `SELECT * FROM transactions
     ${whereSql}
     ORDER BY created_at DESC
     LIMIT ${sanitizedLimit}`,
    params
  );
}

export async function findTransactionReceiptForUser(transactionId, userId) {
  const rows = await query(
    `SELECT
       t.*,
       fu.username AS from_username,
       fu.email AS from_email,
       tu.username AS to_username,
       tu.email AS to_email,
       lb.block_number AS local_block_number,
       lb.hash AS local_block_hash,
       lb.previous_hash AS local_block_previous_hash
     FROM transactions t
     LEFT JOIN users fu ON fu.id = t.from_user_id
     LEFT JOIN users tu ON tu.id = t.to_user_id
     LEFT JOIN local_blocks lb ON lb.source_table = 'transactions' AND lb.source_id = t.id
     WHERE t.id = ? AND (t.from_user_id = ? OR t.to_user_id = ?)
     LIMIT 1`,
    [transactionId, userId, userId]
  );

  return rows[0] ?? null;
}

export async function listTransactionsForAdmin({ type = "", status = "", search = "", limit = 200 } = {}) {
  const params = [];
  const filters = [];

  if (type) {
    filters.push("t.type = ?");
    params.push(type);
  }

  if (status) {
    filters.push("t.status = ?");
    params.push(status);
  }

  const rawSearch = String(search ?? "").trim();
  if (rawSearch) {
    filters.push("(LOWER(t.type) LIKE ? OR LOWER(t.asset) LIKE ? OR LOWER(t.tx_hash) LIKE ? OR LOWER(fu.username) LIKE ? OR LOWER(tu.username) LIKE ? OR LOWER(fu.email) LIKE ? OR LOWER(tu.email) LIKE ?)");
    const like = `%${rawSearch.toLowerCase()}%`;
    params.push(like, like, like, like, like, like, like);
  }

  const sanitizedLimit = sanitizeLimit(limit, 200, 500);

  return query(
    `SELECT
       t.*,
       fu.username AS from_username,
       fu.email AS from_email,
       tu.username AS to_username,
       tu.email AS to_email
     FROM transactions t
     LEFT JOIN users fu ON fu.id = t.from_user_id
     LEFT JOIN users tu ON tu.id = t.to_user_id
     ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
     ORDER BY t.created_at DESC
     LIMIT ${sanitizedLimit}`,
    params
  );
}

export async function countTransactionsByStatus() {
  const rows = await query(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'SUCCESS' THEN 1 ELSE 0 END) AS success,
       SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN type = 'FAUCET_CLAIM' THEN 1 ELSE 0 END) AS faucet_claims,
       SUM(CASE WHEN type = 'TRANSFER' THEN 1 ELSE 0 END) AS transfers,
       SUM(CASE WHEN type LIKE 'ESCROW_%' THEN 1 ELSE 0 END) AS escrows
     FROM transactions`
  );

  return {
    total: Number(rows[0]?.total ?? 0),
    success: Number(rows[0]?.success ?? 0),
    failed: Number(rows[0]?.failed ?? 0),
    faucetClaims: Number(rows[0]?.faucet_claims ?? 0),
    transfers: Number(rows[0]?.transfers ?? 0),
    escrows: Number(rows[0]?.escrows ?? 0)
  };
}

function buildTransactionFilters({ userId, type, status, from, to, search }) {
  const filters = ["(from_user_id = ? OR to_user_id = ?)"];
  const params = [userId, userId];

  if (type) {
    filters.push("type = ?");
    params.push(type);
  }

  if (status) {
    filters.push("status = ?");
    params.push(status);
  }

  if (from) {
    filters.push("created_at >= ?");
    params.push(`${from} 00:00:00`);
  }

  if (to) {
    filters.push("created_at <= ?");
    params.push(`${to} 23:59:59`);
  }

  const rawSearch = String(search ?? "").trim();
  if (rawSearch) {
    filters.push("(LOWER(type) LIKE ? OR LOWER(asset) LIKE ? OR LOWER(tx_hash) LIKE ? OR LOWER(error) LIKE ?)");
    const like = `%${rawSearch.toLowerCase()}%`;
    params.push(like, like, like, like);
  }

  return { whereSql: `WHERE ${filters.join(" AND ")}`, params };
}

function sanitizeLimit(value, fallback, maximum) {
  const number = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(Math.max(number, 1), maximum);
}
