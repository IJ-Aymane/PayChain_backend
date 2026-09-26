import { isConfiguredAdmin } from "../middlewares/adminMiddleware.mjs";
import { createEscrow, findEscrowById, listEscrowsForUser, updateEscrow } from "../models/escrowModel.mjs";
import { getLocalChainBlocks, verifyLocalChainIntegrity } from "../models/localBlockchainModel.mjs";
import { createTransaction, findTransactionReceiptForUser, listTransactionsForUserFiltered } from "../models/transactionModel.mjs";
import { findUserByIdentifier, toSafeUser } from "../models/userModel.mjs";
import { normalizeAsset } from "../utils/blockchain.mjs";
import {
  claimPay,
  createEscrowDepositResult,
  disputeEscrowResult,
  getWalletBalances,
  refundEscrowResult,
  releaseEscrowResult,
  transferPay
} from "../services/walletService.mjs";
import { httpError } from "../utils/auth.mjs";

export async function profile(request, response, next) {
  try {
    response.json({ user: toSafeUser(request.user) });
  } catch (error) {
    next(error);
  }
}

export async function balance(request, response, next) {
  try {
    response.json(await getWalletBalances(request.user.wallet_address));
  } catch (error) {
    next(error);
  }
}

export async function history(request, response, next) {
  try {
    const transactions = await listTransactionsForUserFiltered({
      userId: request.user.id,
      type: request.query.type,
      status: request.query.status,
      from: request.query.from,
      to: request.query.to,
      search: request.query.search,
      limit: request.query.limit
    });
    const escrows = await listEscrowsForUser(request.user.id);

    response.json({ transactions, escrows });
  } catch (error) {
    next(error);
  }
}

export async function receipt(request, response, next) {
  try {
    const transaction = await findTransactionReceiptForUser(request.params.id, request.user.id);
    if (transaction === null) {
      throw httpError(404, "Transaction not found");
    }

    response.json({ receipt: buildReceipt(transaction, request.user) });
  } catch (error) {
    next(error);
  }
}

export async function statement(request, response, next) {
  try {
    const transactions = await listTransactionsForUserFiltered({
      userId: request.user.id,
      type: request.query.type,
      status: request.query.status,
      from: request.query.from,
      to: request.query.to,
      search: request.query.search,
      limit: request.query.limit ?? 500
    });
    const currentBalance = await getWalletBalances(request.user.wallet_address);

    response.json({
      account: {
        user: toSafeUser(request.user),
        walletAddress: request.user.wallet_address,
        mode: currentBalance.mode ?? "demo"
      },
      filters: {
        from: request.query.from ?? null,
        to: request.query.to ?? null,
        type: request.query.type ?? null,
        status: request.query.status ?? null,
        search: request.query.search ?? null
      },
      currentBalance,
      summary: summarizeStatement(transactions, request.user.id),
      transactions
    });
  } catch (error) {
    next(error);
  }
}

export async function localChainStatus(request, response, next) {
  try {
    const [status, blocks] = await Promise.all([
      verifyLocalChainIntegrity(),
      getLocalChainBlocks({ limit: request.query.limit ?? 20 })
    ]);

    response.json({ status, blocks });
  } catch (error) {
    next(error);
  }
}

export async function claimFaucet(request, response, next) {
  const user = request.user;

  try {
    const result = await claimPay(user.wallet_address);
    const transaction = await createTransaction({
      type: "FAUCET_CLAIM",
      asset: result.asset,
      amount: result.amount,
      toUserId: user.id,
      toAddress: user.wallet_address,
      txHash: result.txHash,
      status: result.status,
      metadata: { ethTopUpTxHash: result.ethTopUpTxHash, mode: result.demo ? "demo" : "blockchain" }
    });
    const updatedBalance = await getWalletBalances(user.wallet_address);

    if (result.status !== "SUCCESS") {
      response.status(502).json({
        error: "Faucet transaction was mined but failed",
        transaction,
        balance: updatedBalance
      });
      return;
    }

    response.status(201).json({ transaction, balance: updatedBalance });
  } catch (error) {
    await logFailedFaucet(user, error);
    next(error);
  }
}

export async function transfer(request, response, next) {
  let receiver;
  const sender = request.user;
  const { recipient } = request.body;
  let amount = "0";

  try {
    amount = normalizeAmount(request.body.amount);

    receiver = await findUserByIdentifier(recipient);
    if (!receiver) {
      throw httpError(404, "Recipient user not found");
    }

    if (receiver.id === sender.id) {
      throw httpError(400, "You cannot send PAY to yourself");
    }

    const result = await transferPay({
      fromEncryptedPrivateKey: sender.encrypted_private_key,
      fromAddress: sender.wallet_address,
      toAddress: receiver.wallet_address,
      amount
    });

    const transaction = await createTransaction({
      type: "TRANSFER",
      asset: result.asset,
      amount,
      fromUserId: sender.id,
      toUserId: receiver.id,
      fromAddress: sender.wallet_address,
      toAddress: receiver.wallet_address,
      txHash: result.txHash,
      status: result.status,
      metadata: { mode: result.demo ? "demo" : "blockchain" }
    });
    const updatedBalance = await getWalletBalances(sender.wallet_address);

    if (result.status !== "SUCCESS") {
      response.status(502).json({
        error: "Token transfer was mined but failed",
        transaction,
        balance: updatedBalance,
        recipient: toSafeUser(receiver)
      });
      return;
    }

    response.status(201).json({
      transaction,
      balance: updatedBalance,
      recipient: toSafeUser(receiver)
    });
  } catch (error) {
    if (receiver) {
      await logFailedTransfer({ sender, receiver, amount, error });
    }

    next(error);
  }
}

export async function createEscrowAction(request, response, next) {
  try {
    const buyer = request.user;
    const { seller } = request.body;
    const amount = normalizeAmount(request.body.amount);
    const asset = normalizeAsset(request.body.asset ?? "ETH");

    if (asset !== "ETH") {
      throw httpError(400, "The current Escrow contract supports ETH deposits only");
    }

    const sellerUser = await findUserByIdentifier(seller);
    if (!sellerUser) {
      throw httpError(404, "Seller user not found");
    }

    if (sellerUser.id === buyer.id) {
      throw httpError(400, "You cannot open an escrow with yourself");
    }

    const result = await createEscrowDepositResult({
      buyerEncryptedPrivateKey: buyer.encrypted_private_key,
      buyerAddress: buyer.wallet_address,
      sellerAddress: sellerUser.wallet_address,
      amount
    });

    const escrow = await createEscrow({
      buyerUserId: buyer.id,
      sellerUserId: sellerUser.id,
      buyerAddress: buyer.wallet_address,
      sellerAddress: sellerUser.wallet_address,
      asset,
      amount,
      onchainEscrowId: result.onchainEscrowId,
      status: result.status,
      depositTxHash: result.txHash
    });

    await createTransaction({
      type: "ESCROW_DEPOSIT",
      asset,
      amount,
      fromUserId: buyer.id,
      toUserId: sellerUser.id,
      fromAddress: buyer.wallet_address,
      toAddress: sellerUser.wallet_address,
      txHash: result.txHash,
      status: result.status,
      metadata: { escrowId: escrow.id, onchainEscrowId: result.onchainEscrowId, mode: result.demo ? "demo" : "blockchain" }
    });

    response.status(201).json({ escrow, seller: toSafeUser(sellerUser) });
  } catch (error) {
    next(error);
  }
}

export async function releaseEscrow(request, response, next) {
  try {
    const buyer = request.user;
    const escrow = await loadEscrowForUser(request.params.id, buyer.id);

    if (escrow.buyer_user_id !== buyer.id) {
      throw httpError(403, "Only the buyer can release this escrow");
    }

    if (escrow.status !== "AWAITING_DELIVERY") {
      throw httpError(400, "Escrow is not awaiting delivery");
    }

    const result = await releaseEscrowResult({
      buyerEncryptedPrivateKey: buyer.encrypted_private_key,
      onchainEscrowId: escrow.onchain_escrow_id,
      sellerAddress: escrow.seller_address,
      amount: escrow.amount
    });

    const updated = await updateEscrow(escrow.id, {
      status: result.status,
      releaseTxHash: result.txHash
    });

    await createTransaction({
      type: "ESCROW_RELEASE",
      asset: escrow.asset,
      amount: escrow.amount,
      fromUserId: escrow.buyer_user_id,
      toUserId: escrow.seller_user_id,
      fromAddress: escrow.buyer_address,
      toAddress: escrow.seller_address,
      txHash: result.txHash,
      status: result.status,
      metadata: { escrowId: escrow.id, onchainEscrowId: escrow.onchain_escrow_id, mode: result.demo ? "demo" : "blockchain" }
    });

    response.json({ escrow: updated });
  } catch (error) {
    next(error);
  }
}

export async function disputeEscrow(request, response, next) {
  try {
    const user = request.user;
    const escrow = await loadEscrowForUser(request.params.id, user.id);

    if (escrow.status !== "AWAITING_DELIVERY") {
      throw httpError(400, "Escrow cannot be disputed from its current state");
    }

    const result = await disputeEscrowResult({
      participantEncryptedPrivateKey: user.encrypted_private_key,
      onchainEscrowId: escrow.onchain_escrow_id
    });

    const updated = await updateEscrow(escrow.id, {
      status: result.status,
      disputeTxHash: result.txHash
    });

    await createTransaction({
      type: "ESCROW_DISPUTE",
      asset: escrow.asset,
      amount: escrow.amount,
      fromUserId: user.id,
      toUserId: escrow.buyer_user_id === user.id ? escrow.seller_user_id : escrow.buyer_user_id,
      fromAddress: user.wallet_address,
      toAddress: escrow.buyer_user_id === user.id ? escrow.seller_address : escrow.buyer_address,
      txHash: result.txHash,
      status: result.status,
      metadata: { escrowId: escrow.id, onchainEscrowId: escrow.onchain_escrow_id, mode: result.demo ? "demo" : "blockchain" }
    });

    response.json({ escrow: updated });
  } catch (error) {
    next(error);
  }
}

export async function refundEscrow(request, response, next) {
  try {
    const user = request.user;
    if (!isConfiguredAdmin(user)) {
      throw httpError(403, "Only an admin arbitrator can refund disputed escrows");
    }

    const escrow = await loadEscrow(request.params.id);

    if (escrow.status !== "DISPUTED") {
      throw httpError(400, "Only disputed escrows can be refunded");
    }

    const result = await refundEscrowResult({
      onchainEscrowId: escrow.onchain_escrow_id,
      buyerAddress: escrow.buyer_address,
      amount: escrow.amount
    });
    const updated = await updateEscrow(escrow.id, {
      status: result.status,
      refundTxHash: result.txHash
    });

    await createTransaction({
      type: "ESCROW_REFUND",
      asset: escrow.asset,
      amount: escrow.amount,
      fromUserId: escrow.seller_user_id,
      toUserId: escrow.buyer_user_id,
      fromAddress: escrow.seller_address,
      toAddress: escrow.buyer_address,
      txHash: result.txHash,
      status: result.status,
      metadata: {
        escrowId: escrow.id,
        onchainEscrowId: escrow.onchain_escrow_id,
        mode: result.demo ? "demo" : "blockchain",
        adminUserId: user.id
      }
    });

    response.json({ escrow: updated });
  } catch (error) {
    next(error);
  }
}

async function loadEscrow(escrowId) {
  const escrow = await findEscrowById(escrowId);
  if (!escrow) {
    throw httpError(404, "Escrow not found");
  }

  if (!escrow.onchain_escrow_id) {
    throw httpError(400, "Escrow is missing its on-chain ID");
  }

  return escrow;
}

async function loadEscrowForUser(escrowId, userId) {
  const escrow = await loadEscrow(escrowId);

  if (escrow.buyer_user_id !== userId && escrow.seller_user_id !== userId) {
    throw httpError(403, "You are not a participant in this escrow");
  }

  return escrow;
}

async function logFailedFaucet(user, error) {
  try {
    await createTransaction({
      type: "FAUCET_CLAIM",
      asset: "PAY",
      amount: process.env.FAUCET_PAY_AMOUNT ?? "100",
      toUserId: user.id,
      toAddress: user.wallet_address,
      status: "FAILED",
      error: getErrorMessage(error)
    });
  } catch {
  }
}

async function logFailedTransfer({ sender, receiver, amount, error }) {
  try {
    await createTransaction({
      type: "TRANSFER",
      asset: "PAY",
      amount: String(amount ?? "0"),
      fromUserId: sender.id,
      toUserId: receiver.id,
      fromAddress: sender.wallet_address,
      toAddress: receiver.wallet_address,
      status: "FAILED",
      error: getErrorMessage(error)
    });
  } catch {
  }
}


function buildReceipt(transaction, user) {
  const direction = transaction.from_user_id === user.id ? "debit" : "credit";
  return {
    id: transaction.id,
    reference: transaction.tx_hash,
    type: transaction.type,
    direction,
    asset: transaction.asset,
    amount: transaction.amount,
    status: transaction.status,
    date: transaction.created_at,
    mode: parseMetadata(transaction.metadata_json).mode ?? "demo",
    from: {
      userId: transaction.from_user_id,
      username: transaction.from_username,
      email: transaction.from_email,
      address: transaction.from_address
    },
    to: {
      userId: transaction.to_user_id,
      username: transaction.to_username,
      email: transaction.to_email,
      address: transaction.to_address
    },
    metadata: parseMetadata(transaction.metadata_json),
    localBlock: transaction.local_block_hash ? {
      number: Number(transaction.local_block_number),
      hash: transaction.local_block_hash,
      previousHash: transaction.local_block_previous_hash
    } : null,
    issuedTo: toSafeUser(user)
  };
}

function summarizeStatement(transactions, userId) {
  const summary = {
    count: transactions.length,
    payCredits: 0,
    payDebits: 0,
    failed: 0,
    success: 0
  };

  for (const transaction of transactions) {
    if (transaction.status === "FAILED") {
      summary.failed += 1;
    }

    if (transaction.status === "SUCCESS") {
      summary.success += 1;
    }

    if (transaction.asset !== "PAY") {
      continue;
    }

    const amount = Number(transaction.amount);
    if (Number.isFinite(amount) === false) {
      continue;
    }

    if (transaction.to_user_id === userId) {
      summary.payCredits += amount;
    }

    if (transaction.from_user_id === userId) {
      summary.payDebits += amount;
    }
  }

  summary.netPay = summary.payCredits - summary.payDebits;
  return summary;
}

function parseMetadata(value) {
  if (value === null || value === undefined || value === "") {
    return {};
  }

  if (typeof value === "object") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function normalizeAmount(amount) {
  const value = String(amount ?? "").trim();

  if (!/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(value) || Number(value) <= 0) {
    throw httpError(400, "Amount must be a positive decimal with up to 18 decimal places");
  }

  return value;
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : "Unexpected error";
}
