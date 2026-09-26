import { listEscrowsForAdmin } from "../models/escrowModel.mjs";
import { countTransactionsByStatus, createTransaction, listTransactionsForAdmin } from "../models/transactionModel.mjs";
import { countUsers, findUserById, listUsersForAdmin, suspendUser, toSafeUser, unsuspendUser } from "../models/userModel.mjs";
import { formatDemoBalanceRow, getDemoLedgerTotals, resetDemoBalance, setDemoPayBalance } from "../models/demoLedgerModel.mjs";
import { httpError } from "../utils/auth.mjs";

export async function adminSummary(_request, response, next) {
  try {
    const [users, transactionStats, ledgerTotals] = await Promise.all([
      countUsers(),
      countTransactionsByStatus(),
      getDemoLedgerTotals()
    ]);

    response.json({ users, transactions: transactionStats, ledgerTotals, mode: "demo" });
  } catch (error) {
    next(error);
  }
}

export async function adminUsers(request, response, next) {
  try {
    const users = await listUsersForAdmin({ search: request.query.search, limit: request.query.limit });

    response.json({
      users: users.map((user) => ({
        ...toSafeUser(user),
        walletAddress: user.wallet_address,
        failedLoginAttempts: user.failed_login_attempts,
        lockedUntil: user.locked_until,
        activeSessions: Number(user.active_sessions ?? 0),
        balances: formatDemoBalanceRow(user)
      }))
    });
  } catch (error) {
    next(error);
  }
}

export async function adminTransactions(request, response, next) {
  try {
    const transactions = await listTransactionsForAdmin({
      type: request.query.type,
      status: request.query.status,
      search: request.query.search,
      limit: request.query.limit
    });

    response.json({ transactions });
  } catch (error) {
    next(error);
  }
}

export async function adminEscrows(request, response, next) {
  try {
    const escrows = await listEscrowsForAdmin({
      status: request.query.status,
      search: request.query.search,
      limit: request.query.limit
    });

    response.json({ escrows });
  } catch (error) {
    next(error);
  }
}

export async function resetUserDemoBalance(request, response, next) {
  try {
    const user = await loadAdminUser(request.params.id);
    const balance = await resetDemoBalance(user.wallet_address);

    await createTransaction({
      type: "ADMIN_BALANCE_RESET",
      asset: "PAY",
      amount: "0",
      toUserId: user.id,
      toAddress: user.wallet_address,
      txHash: createAdminReference(),
      status: "SUCCESS",
      metadata: { mode: "demo", adminUserId: request.user.id }
    });

    response.json({ user: toSafeUser(user), balance });
  } catch (error) {
    next(error);
  }
}

export async function setUserDemoBalance(request, response, next) {
  try {
    const user = await loadAdminUser(request.params.id);
    const amount = request.body.amount ?? "0";
    const balance = await setDemoPayBalance(user.wallet_address, amount);

    await createTransaction({
      type: "ADMIN_BALANCE_SET",
      asset: "PAY",
      amount,
      toUserId: user.id,
      toAddress: user.wallet_address,
      txHash: createAdminReference(),
      status: "SUCCESS",
      metadata: { mode: "demo", adminUserId: request.user.id }
    });

    response.json({ user: toSafeUser(user), balance });
  } catch (error) {
    next(error);
  }
}

export async function suspendUserAccount(request, response, next) {
  try {
    const user = await loadAdminUser(request.params.id);
    const updated = await suspendUser(user.id);
    response.json({ user: toSafeUser(updated), lockedUntil: updated.locked_until });
  } catch (error) {
    next(error);
  }
}

export async function unsuspendUserAccount(request, response, next) {
  try {
    const user = await loadAdminUser(request.params.id);
    const updated = await unsuspendUser(user.id);
    response.json({ user: toSafeUser(updated), lockedUntil: updated.locked_until });
  } catch (error) {
    next(error);
  }
}

async function loadAdminUser(id) {
  const user = await findUserById(id);
  if (user === null) {
    throw httpError(404, "User not found");
  }

  return user;
}

function createAdminReference() {
  return `demo-admin-${Date.now()}`;
}
