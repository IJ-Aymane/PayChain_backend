import crypto from "node:crypto";

import {
  claimDemoPay,
  createEscrowDeposit,
  disputeEscrowOnchain,
  getBalances,
  isBlockchainEnabled,
  refundEscrowOnchain,
  releaseEscrowOnchain,
  transferPayTokens
} from "../utils/blockchain.mjs";
import { creditDemoFaucet, debitDemoEthForEscrow, getDemoBalances, refundDemoEthEscrow, releaseDemoEthEscrow, transferDemoPay } from "../models/demoLedgerModel.mjs";

export { isBlockchainEnabled } from "../utils/blockchain.mjs";

export async function getWalletBalances(walletAddress) {
  if (!isBlockchainEnabled()) {
    return getDemoBalances(walletAddress);
  }

  return getBalances(walletAddress);
}

export async function claimPay(walletAddress) {
  if (!isBlockchainEnabled()) {
    const amount = process.env.FAUCET_PAY_AMOUNT ?? "100";
    const ethAmount = process.env.FAUCET_ETH_AMOUNT ?? "1";
    await creditDemoFaucet({ walletAddress, payAmount: amount, ethAmount });

    return {
      asset: "PAY",
      amount,
      status: "SUCCESS",
      txHash: createDemoTxHash(),
      ethTopUpTxHash: Number(ethAmount) > 0 ? createDemoTxHash() : null,
      demo: true
    };
  }

  return claimDemoPay(walletAddress);
}

export async function transferPay({ fromEncryptedPrivateKey, fromAddress, toAddress, amount }) {
  if (!isBlockchainEnabled()) {
    await transferDemoPay({ fromAddress, toAddress, amount });

    return {
      asset: "PAY",
      amount,
      txHash: createDemoTxHash(),
      status: "SUCCESS",
      demo: true
    };
  }

  return transferPayTokens({ fromEncryptedPrivateKey, toAddress, amount });
}

export async function createEscrowDepositResult({ buyerEncryptedPrivateKey, buyerAddress, sellerAddress, amount }) {
  if (!isBlockchainEnabled()) {
    await debitDemoEthForEscrow({ buyerAddress, amount });

    return {
      txHash: createDemoTxHash(),
      onchainEscrowId: `demo-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
      status: "AWAITING_DELIVERY",
      demo: true
    };
  }

  return createEscrowDeposit({ buyerEncryptedPrivateKey, sellerAddress, amount });
}

export async function releaseEscrowResult({ buyerEncryptedPrivateKey, onchainEscrowId, sellerAddress, amount }) {
  if (!isBlockchainEnabled()) {
    await releaseDemoEthEscrow({ sellerAddress, amount });
    return { txHash: createDemoTxHash(), status: "COMPLETED", demo: true };
  }

  return releaseEscrowOnchain({ buyerEncryptedPrivateKey, onchainEscrowId });
}

export async function disputeEscrowResult({ participantEncryptedPrivateKey, onchainEscrowId }) {
  if (!isBlockchainEnabled()) {
    return { txHash: createDemoTxHash(), status: "DISPUTED", demo: true };
  }

  return disputeEscrowOnchain({ participantEncryptedPrivateKey, onchainEscrowId });
}

export async function refundEscrowResult({ onchainEscrowId, buyerAddress, amount }) {
  if (!isBlockchainEnabled()) {
    await refundDemoEthEscrow({ buyerAddress, amount });
    return { txHash: createDemoTxHash(), status: "REFUNDED", demo: true };
  }

  return refundEscrowOnchain({ onchainEscrowId });
}

export function createDemoTxHash() {
  return `0x${crypto.randomBytes(32).toString("hex")}`;
}
