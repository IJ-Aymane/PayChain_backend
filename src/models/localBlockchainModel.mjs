import crypto from "node:crypto";

import { execute, query, withTransaction } from "../config/database.mjs";
import { httpError } from "../utils/auth.mjs";

const GENESIS_PREVIOUS_HASH = "0".repeat(64);
const LOCAL_CHAIN_ENABLED_VALUES = ["true", "1", "yes", "on"];

export function isLocalBlockchainEnabled() {
  const value = String(process.env.LOCAL_BLOCKCHAIN_ENABLED ?? "true").trim().toLowerCase();
  return LOCAL_CHAIN_ENABLED_VALUES.includes(value);
}

export async function initializeLocalBlockchain() {
  if (isLocalBlockchainEnabled() === false) {
    return;
  }

  await withTransaction(async (tx) => {
    await ensureGenesisBlockTx(tx);
    await backfillTransactionsTx(tx);
    await backfillDemoBalancesTx(tx);
  });
}

export async function appendTransactionBlockTx(tx, transaction) {
  if (isLocalBlockchainEnabled() === false) {
    return null;
  }

  return appendLocalBlockTx(tx, {
    eventType: `TRANSACTION_${transaction.type}`,
    sourceTable: "transactions",
    sourceId: transaction.id,
    payload: buildTransactionPayload(transaction)
  });
}

export async function appendDemoBalanceBlockTx(tx, { walletAddress, eventType = "DEMO_BALANCE_CHANGE", context = null } = {}) {
  if (isLocalBlockchainEnabled() === false) {
    return null;
  }

  const rows = await tx.query(
    "SELECT wallet_address, pay_balance_units, eth_balance_units, updated_at FROM demo_balances WHERE wallet_address = ? LIMIT 1",
    [walletAddress]
  );
  const row = rows[0];

  if (!row) {
    throw httpError(500, "Demo balance row is missing for local blockchain block");
  }

  return appendLocalBlockTx(tx, {
    eventType,
    sourceTable: "demo_balances",
    sourceId: row.wallet_address,
    payload: buildDemoBalancePayload(row, context)
  });
}

export async function verifyLocalChainIntegrity() {
  if (isLocalBlockchainEnabled() === false) {
    return {
      valid: true,
      enabled: false,
      blockCount: 0,
      latestHash: null,
      message: "Local blockchain verification is disabled"
    };
  }

  const blocks = await query(
    `SELECT block_number, block_timestamp, event_type, source_table, source_id,
            previous_hash, data_hash, hash, nonce, payload_json, created_at
     FROM local_blocks
     ORDER BY block_number ASC`
  );

  if (blocks.length === 0) {
    return {
      valid: false,
      enabled: true,
      blockCount: 0,
      latestHash: null,
      message: "Local blockchain has no genesis block"
    };
  }

  const latestBalanceBlocks = new Map();
  let previousHash = GENESIS_PREVIOUS_HASH;
  let expectedNumber = 0n;

  for (const block of blocks) {
    const issue = verifyBlockShape(block, previousHash, expectedNumber);
    if (issue) {
      return buildInvalidResult(blocks, block, issue);
    }

    if (block.source_table === "transactions") {
      const transactionIssue = await verifyTransactionPayload(block);
      if (transactionIssue) {
        return buildInvalidResult(blocks, block, transactionIssue);
      }
    }

    if (block.source_table === "demo_balances") {
      latestBalanceBlocks.set(String(block.source_id).toLowerCase(), block);
    }

    previousHash = block.hash;
    expectedNumber += 1n;
  }

  for (const block of latestBalanceBlocks.values()) {
    const balanceIssue = await verifyDemoBalancePayload(block);
    if (balanceIssue) {
      return buildInvalidResult(blocks, block, balanceIssue);
    }
  }

  const latest = blocks[blocks.length - 1];
  return {
    valid: true,
    enabled: true,
    blockCount: blocks.length,
    latestBlockNumber: Number(latest.block_number),
    latestHash: latest.hash,
    checkedAt: new Date().toISOString(),
    message: "Local blockchain integrity verified"
  };
}

export async function assertLocalChainHealthy() {
  const result = await verifyLocalChainIntegrity();
  if (result.valid === false) {
    throw httpError(409, `Local blockchain integrity check failed: ${result.message}`);
  }

  return result;
}

export async function getLocalChainBlocks({ limit = 20 } = {}) {
  const sanitizedLimit = sanitizeLimit(limit, 20, 100);
  return query(
    `SELECT block_number, block_timestamp, event_type, source_table, source_id,
            previous_hash, data_hash, hash, nonce, created_at
     FROM local_blocks
     ORDER BY block_number DESC
     LIMIT ${sanitizedLimit}`
  );
}

async function appendLocalBlockTx(tx, { eventType, sourceTable, sourceId, payload }) {
  await ensureGenesisBlockTx(tx);

  const latestRows = await tx.query(
    "SELECT block_number, hash FROM local_blocks ORDER BY block_number DESC LIMIT 1 FOR UPDATE"
  );
  const latest = latestRows[0];
  const blockNumber = BigInt(latest.block_number) + 1n;
  const previousHash = latest.hash;
  const blockTimestamp = new Date().toISOString();
  const payloadJson = canonicalStringify(payload);
  const dataHash = sha256(payloadJson);
  const nonce = 0;
  const blockHash = calculateBlockHash({
    blockNumber,
    blockTimestamp,
    eventType,
    sourceTable,
    sourceId,
    previousHash,
    dataHash,
    nonce
  });

  await tx.execute(
    `INSERT INTO local_blocks (
       block_number, block_timestamp, event_type, source_table, source_id,
       previous_hash, data_hash, hash, nonce, payload_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      blockNumber.toString(),
      blockTimestamp,
      eventType,
      sourceTable,
      sourceId,
      previousHash,
      dataHash,
      blockHash,
      nonce,
      payloadJson
    ]
  );

  return {
    blockNumber: Number(blockNumber),
    hash: blockHash,
    previousHash,
    dataHash,
    eventType,
    sourceTable,
    sourceId
  };
}

async function ensureGenesisBlockTx(tx) {
  const rows = await tx.query("SELECT block_number FROM local_blocks ORDER BY block_number ASC LIMIT 1 FOR UPDATE");
  if (rows.length > 0) {
    return;
  }

  const payload = {
    schema: "paychain.local.genesis.v1",
    project: "PayChain",
    message: "Genesis block for the PayChain local SHA-256 blockchain",
    createdFor: "PFA demo",
    version: 1
  };
  const payloadJson = canonicalStringify(payload);
  const blockTimestamp = new Date().toISOString();
  const dataHash = sha256(payloadJson);
  const hash = calculateBlockHash({
    blockNumber: 0n,
    blockTimestamp,
    eventType: "GENESIS",
    sourceTable: "local_blocks",
    sourceId: "genesis",
    previousHash: GENESIS_PREVIOUS_HASH,
    dataHash,
    nonce: 0
  });

  await tx.execute(
    `INSERT INTO local_blocks (
       block_number, block_timestamp, event_type, source_table, source_id,
       previous_hash, data_hash, hash, nonce, payload_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["0", blockTimestamp, "GENESIS", "local_blocks", "genesis", GENESIS_PREVIOUS_HASH, dataHash, hash, 0, payloadJson]
  );
}

async function backfillTransactionsTx(tx) {
  const rows = await tx.query(
    `SELECT t.*
     FROM transactions t
     LEFT JOIN local_blocks b ON b.source_table = 'transactions' AND b.source_id = t.id
     WHERE b.id IS NULL
     ORDER BY t.created_at ASC`
  );

  for (const transaction of rows) {
    await appendLocalBlockTx(tx, {
      eventType: `BACKFILL_TRANSACTION_${transaction.type}`,
      sourceTable: "transactions",
      sourceId: transaction.id,
      payload: buildTransactionPayload(transaction)
    });
  }
}

async function backfillDemoBalancesTx(tx) {
  const rows = await tx.query(
    `SELECT db.wallet_address, db.pay_balance_units, db.eth_balance_units, db.updated_at
     FROM demo_balances db
     LEFT JOIN local_blocks b ON b.source_table = 'demo_balances' AND LOWER(b.source_id) = LOWER(db.wallet_address)
     WHERE b.id IS NULL
     ORDER BY db.updated_at ASC`
  );

  for (const balance of rows) {
    await appendLocalBlockTx(tx, {
      eventType: "BACKFILL_DEMO_BALANCE",
      sourceTable: "demo_balances",
      sourceId: balance.wallet_address,
      payload: buildDemoBalancePayload(balance, { reason: "startup-backfill" })
    });
  }
}

function verifyBlockShape(block, expectedPreviousHash, expectedNumber) {
  if (BigInt(block.block_number) !== expectedNumber) {
    return `Expected block number ${expectedNumber.toString()} but found ${block.block_number}`;
  }

  if (block.previous_hash !== expectedPreviousHash) {
    return `Invalid previous hash on block ${block.block_number}`;
  }

  const expectedDataHash = sha256(block.payload_json);
  if (block.data_hash !== expectedDataHash) {
    return `Payload hash mismatch on block ${block.block_number}`;
  }

  const expectedHash = calculateBlockHash({
    blockNumber: BigInt(block.block_number),
    blockTimestamp: block.block_timestamp,
    eventType: block.event_type,
    sourceTable: block.source_table,
    sourceId: block.source_id,
    previousHash: block.previous_hash,
    dataHash: block.data_hash,
    nonce: Number(block.nonce ?? 0)
  });

  if (block.hash !== expectedHash) {
    return `Block hash mismatch on block ${block.block_number}`;
  }

  return null;
}

async function verifyTransactionPayload(block) {
  const rows = await query("SELECT * FROM transactions WHERE id = ? LIMIT 1", [block.source_id]);
  const transaction = rows[0];

  if (!transaction) {
    return `Transaction row ${block.source_id} is missing`;
  }

  const expectedPayload = canonicalStringify(buildTransactionPayload(transaction));
  if (block.payload_json !== expectedPayload) {
    return `Transaction row ${block.source_id} does not match its SHA-256 block payload`;
  }

  return null;
}

async function verifyDemoBalancePayload(block) {
  const rows = await query(
    "SELECT wallet_address, pay_balance_units, eth_balance_units, updated_at FROM demo_balances WHERE wallet_address = ? LIMIT 1",
    [block.source_id]
  );
  const balance = rows[0];

  if (!balance) {
    return `Demo balance row ${block.source_id} is missing`;
  }

  const storedPayload = safeJsonParse(block.payload_json);
  const currentPayload = buildDemoBalancePayload(balance, storedPayload.context ?? null);
  const expectedPayload = canonicalStringify(currentPayload);

  if (block.payload_json !== expectedPayload) {
    return `Demo balance row ${block.source_id} does not match the latest SHA-256 block payload`;
  }

  return null;
}

function buildInvalidResult(blocks, block, message) {
  const latest = blocks[blocks.length - 1] ?? null;
  return {
    valid: false,
    enabled: true,
    blockCount: blocks.length,
    latestBlockNumber: latest ? Number(latest.block_number) : null,
    latestHash: latest?.hash ?? null,
    failedBlockNumber: block ? Number(block.block_number) : null,
    failedBlockHash: block?.hash ?? null,
    checkedAt: new Date().toISOString(),
    message
  };
}

function buildTransactionPayload(transaction) {
  return {
    schema: "paychain.local.transaction.v1",
    id: normalizeValue(transaction.id),
    type: normalizeValue(transaction.type),
    asset: normalizeValue(transaction.asset),
    amount: normalizeValue(transaction.amount),
    fromUserId: normalizeValue(transaction.from_user_id),
    toUserId: normalizeValue(transaction.to_user_id),
    fromAddress: normalizeValue(transaction.from_address),
    toAddress: normalizeValue(transaction.to_address),
    txHash: normalizeValue(transaction.tx_hash),
    status: normalizeValue(transaction.status),
    error: normalizeValue(transaction.error),
    metadata: normalizeJson(transaction.metadata_json),
    createdAt: normalizeValue(transaction.created_at)
  };
}

function buildDemoBalancePayload(row, context) {
  return {
    schema: "paychain.local.demo_balance.v1",
    walletAddress: normalizeValue(row.wallet_address),
    payBalanceUnits: normalizeValue(row.pay_balance_units ?? "0"),
    ethBalanceUnits: normalizeValue(row.eth_balance_units ?? "0"),
    updatedAt: normalizeValue(row.updated_at),
    context: context ?? null
  };
}

function calculateBlockHash({ blockNumber, blockTimestamp, eventType, sourceTable, sourceId, previousHash, dataHash, nonce }) {
  return sha256(canonicalStringify({
    blockNumber: blockNumber.toString(),
    blockTimestamp,
    eventType,
    sourceTable,
    sourceId,
    previousHash,
    dataHash,
    nonce
  }));
}

function canonicalStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(",")}}`;
  }

  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function normalizeValue(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return String(value);
}

function normalizeJson(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value === "object") {
    return value;
  }

  return safeJsonParse(value);
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function sanitizeLimit(value, fallback, maximum) {
  const number = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(Math.max(number, 1), maximum);
}
