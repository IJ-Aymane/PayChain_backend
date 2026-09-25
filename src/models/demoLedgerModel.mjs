import { getAddress } from "ethers";

import { query, withTransaction } from "../config/database.mjs";
import { httpError } from "../utils/auth.mjs";
import { appendDemoBalanceBlockTx, assertLocalChainHealthy } from "./localBlockchainModel.mjs";

const TOKEN_DECIMALS = 18n;
const SCALE = 10n ** TOKEN_DECIMALS;

export async function getDemoBalances(walletAddress) {
  const address = getAddress(walletAddress);
  await ensureDemoBalance(address);

  const rows = await query(
    "SELECT pay_balance_units, eth_balance_units FROM demo_balances WHERE wallet_address = ? LIMIT 1",
    [address]
  );
  const row = rows[0] ?? { pay_balance_units: "0", eth_balance_units: "0" };

  return formatBalancePayload(address, row);
}

export async function creditDemoFaucet({ walletAddress, payAmount, ethAmount }) {
  await assertLocalChainHealthy();
  const address = getAddress(walletAddress);
  const payUnits = parsePositiveUnits(payAmount);
  const ethUnits = parseNonNegativeUnits(ethAmount ?? "0");

  await withTransaction(async (tx) => {
    await ensureDemoBalanceTx(tx, address);
    const row = await getDemoBalanceForUpdate(tx, address);

    await tx.execute(
      `UPDATE demo_balances
       SET pay_balance_units = ?, eth_balance_units = ?
       WHERE wallet_address = ?`,
      [
        (BigInt(row.pay_balance_units) + payUnits).toString(),
        (BigInt(row.eth_balance_units) + ethUnits).toString(),
        address
      ]
    );
    await appendDemoBalanceBlockTx(tx, {
      walletAddress: address,
      eventType: "DEMO_FAUCET_BALANCE_CREDIT",
      context: { payAmount: String(payAmount), ethAmount: String(ethAmount ?? "0") }
    });
  });

  return getDemoBalances(address);
}

export async function transferDemoPay({ fromAddress, toAddress, amount }) {
  await assertLocalChainHealthy();
  const sender = getAddress(fromAddress);
  const recipient = getAddress(toAddress);
  const units = parsePositiveUnits(amount);

  await withTransaction(async (tx) => {
    const [first, second] = [sender, recipient].sort();
    await ensureDemoBalanceTx(tx, first);
    await ensureDemoBalanceTx(tx, second);
    await getDemoBalanceForUpdate(tx, first);
    await getDemoBalanceForUpdate(tx, second);

    const senderRow = await getDemoBalanceForUpdate(tx, sender);
    const senderBalance = BigInt(senderRow.pay_balance_units);
    if (senderBalance < units) {
      throw httpError(400, "Insufficient PAY balance");
    }

    const recipientRow = await getDemoBalanceForUpdate(tx, recipient);

    await tx.execute(
      "UPDATE demo_balances SET pay_balance_units = ? WHERE wallet_address = ?",
      [(senderBalance - units).toString(), sender]
    );
    await tx.execute(
      "UPDATE demo_balances SET pay_balance_units = ? WHERE wallet_address = ?",
      [(BigInt(recipientRow.pay_balance_units) + units).toString(), recipient]
    );
    await appendDemoBalanceBlockTx(tx, {
      walletAddress: sender,
      eventType: "DEMO_TRANSFER_BALANCE_DEBIT",
      context: { amount: String(amount), counterparty: recipient }
    });
    await appendDemoBalanceBlockTx(tx, {
      walletAddress: recipient,
      eventType: "DEMO_TRANSFER_BALANCE_CREDIT",
      context: { amount: String(amount), counterparty: sender }
    });
  });

  return getDemoBalances(sender);
}

export async function debitDemoEthForEscrow({ buyerAddress, amount }) {
  await assertLocalChainHealthy();
  const buyer = getAddress(buyerAddress);
  const units = parsePositiveUnits(amount);

  await withTransaction(async (tx) => {
    await ensureDemoBalanceTx(tx, buyer);
    const buyerRow = await getDemoBalanceForUpdate(tx, buyer);
    const buyerBalance = BigInt(buyerRow.eth_balance_units);

    if (buyerBalance < units) {
      throw httpError(400, "Insufficient demo ETH balance for escrow");
    }

    await tx.execute(
      "UPDATE demo_balances SET eth_balance_units = ? WHERE wallet_address = ?",
      [(buyerBalance - units).toString(), buyer]
    );
    await appendDemoBalanceBlockTx(tx, {
      walletAddress: buyer,
      eventType: "DEMO_ESCROW_ETH_HOLD",
      context: { amount: String(amount) }
    });
  });

  return getDemoBalances(buyer);
}

export async function releaseDemoEthEscrow({ sellerAddress, amount }) {
  await assertLocalChainHealthy();
  const seller = getAddress(sellerAddress);
  const units = parsePositiveUnits(amount);

  await withTransaction(async (tx) => {
    await ensureDemoBalanceTx(tx, seller);
    const sellerRow = await getDemoBalanceForUpdate(tx, seller);

    await tx.execute(
      "UPDATE demo_balances SET eth_balance_units = ? WHERE wallet_address = ?",
      [(BigInt(sellerRow.eth_balance_units) + units).toString(), seller]
    );
    await appendDemoBalanceBlockTx(tx, {
      walletAddress: seller,
      eventType: "DEMO_ESCROW_ETH_RELEASE",
      context: { amount: String(amount) }
    });
  });

  return getDemoBalances(seller);
}

export async function refundDemoEthEscrow({ buyerAddress, amount }) {
  await assertLocalChainHealthy();
  const buyer = getAddress(buyerAddress);
  const units = parsePositiveUnits(amount);

  await withTransaction(async (tx) => {
    await ensureDemoBalanceTx(tx, buyer);
    const buyerRow = await getDemoBalanceForUpdate(tx, buyer);

    await tx.execute(
      "UPDATE demo_balances SET eth_balance_units = ? WHERE wallet_address = ?",
      [(BigInt(buyerRow.eth_balance_units) + units).toString(), buyer]
    );
    await appendDemoBalanceBlockTx(tx, {
      walletAddress: buyer,
      eventType: "DEMO_ESCROW_ETH_REFUND",
      context: { amount: String(amount) }
    });
  });

  return getDemoBalances(buyer);
}

export async function setDemoPayBalance(walletAddress, amount) {
  await assertLocalChainHealthy();
  const address = getAddress(walletAddress);
  const units = parseNonNegativeUnits(String(amount ?? "0"));

  await withTransaction(async (tx) => {
    await ensureDemoBalanceTx(tx, address);
    await tx.execute(
      "UPDATE demo_balances SET pay_balance_units = ? WHERE wallet_address = ?",
      [units.toString(), address]
    );
    await appendDemoBalanceBlockTx(tx, {
      walletAddress: address,
      eventType: "DEMO_ADMIN_PAY_SET",
      context: { amount: String(amount ?? "0") }
    });
  });

  return getDemoBalances(address);
}

export async function resetDemoBalance(walletAddress) {
  await assertLocalChainHealthy();
  const address = getAddress(walletAddress);
  await withTransaction(async (tx) => {
    await ensureDemoBalanceTx(tx, address);
    await tx.execute(
      "UPDATE demo_balances SET pay_balance_units = '0', eth_balance_units = '0' WHERE wallet_address = ?",
      [address]
    );
    await appendDemoBalanceBlockTx(tx, {
      walletAddress: address,
      eventType: "DEMO_ADMIN_BALANCE_RESET",
      context: { payAmount: "0", ethAmount: "0" }
    });
  });

  return getDemoBalances(address);
}

export async function getDemoLedgerTotals() {
  const rows = await query(
    "SELECT COALESCE(SUM(CAST(pay_balance_units AS DECIMAL(65,0))), 0) AS pay_units, COALESCE(SUM(CAST(eth_balance_units AS DECIMAL(65,0))), 0) AS eth_units FROM demo_balances"
  );

  return {
    pay: formatUnits(rows[0]?.pay_units ?? "0"),
    eth: formatUnits(rows[0]?.eth_units ?? "0")
  };
}

export function formatDemoBalanceRow(row) {
  return {
    pay: formatUnits(row.pay_balance_units ?? "0"),
    eth: formatUnits(row.eth_balance_units ?? "0")
  };
}

export function parseUnits(value) {
  return parsePositiveUnits(value);
}

export function formatUnits(units) {
  const value = BigInt(units);
  const whole = value / SCALE;
  const fraction = (value % SCALE).toString().padStart(Number(TOKEN_DECIMALS), "0").replace(/0+$/, "");

  return fraction ? `${whole}.${fraction}` : whole.toString();
}

async function ensureDemoBalance(walletAddress) {
  await assertLocalChainHealthy();
  await withTransaction(async (tx) => {
    const result = await tx.execute(
      "INSERT IGNORE INTO demo_balances (wallet_address, pay_balance_units, eth_balance_units) VALUES (?, '0', '0')",
      [walletAddress]
    );

    if (Number(result.affectedRows ?? 0) > 0) {
      await appendDemoBalanceBlockTx(tx, {
        walletAddress,
        eventType: "DEMO_BALANCE_ACCOUNT_OPENED",
        context: { payAmount: "0", ethAmount: "0" }
      });
    }
  });
}

async function ensureDemoBalanceTx(tx, walletAddress) {
  await tx.execute(
    "INSERT IGNORE INTO demo_balances (wallet_address, pay_balance_units, eth_balance_units) VALUES (?, '0', '0')",
    [walletAddress]
  );
}

async function getDemoBalanceForUpdate(tx, walletAddress) {
  const rows = await tx.query(
    "SELECT pay_balance_units, eth_balance_units FROM demo_balances WHERE wallet_address = ? FOR UPDATE",
    [walletAddress]
  );

  return rows[0] ?? { pay_balance_units: "0", eth_balance_units: "0" };
}

function parsePositiveUnits(value) {
  const units = parseNonNegativeUnits(value);
  if (units <= 0n) {
    throw httpError(400, "Amount must be a positive decimal");
  }

  return units;
}

function parseNonNegativeUnits(value) {
  const raw = String(value ?? "").trim();
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(raw)) {
    throw httpError(400, "Amount must be a positive decimal");
  }

  const [whole, fraction = ""] = raw.split(".");
  if (fraction.length > Number(TOKEN_DECIMALS)) {
    throw httpError(400, "Amount has too many decimal places");
  }

  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(Number(TOKEN_DECIMALS), "0"));
}

function formatBalancePayload(address, row) {
  return {
    address,
    eth: {
      symbol: "ETH",
      balance: formatUnits(row.eth_balance_units)
    },
    token: {
      symbol: "PAY",
      balance: formatUnits(row.pay_balance_units),
      contractAddress: null,
      demo: true
    },
    mode: "demo"
  };
}
