import crypto from "node:crypto";

import {
  Contract,
  FetchRequest,
  Interface,
  JsonRpcProvider,
  Wallet,
  formatEther,
  formatUnits,
  getAddress,
  parseEther,
  parseUnits
} from "ethers";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address to, uint256 amount) returns (bool)"
];

const ESCROW_ABI = [
  "function deposit(address payable seller) payable returns (uint256 escrowId)",
  "function release(uint256 escrowId)",
  "function dispute(uint256 escrowId)",
  "function refund(uint256 escrowId)",
  "event EscrowDeposited(uint256 indexed escrowId, address indexed buyer, address indexed seller, uint256 amount)",
  "event EscrowReleased(uint256 indexed escrowId, address indexed seller, uint256 amount)",
  "event EscrowDisputed(uint256 indexed escrowId, address indexed openedBy)",
  "event EscrowRefunded(uint256 indexed escrowId, address indexed buyer, uint256 amount)"
];

const escrowInterface = new Interface(ESCROW_ABI);

let provider;
let tokenMetadataCache;

export function isBlockchainEnabled() {
  const value = String(process.env.BLOCKCHAIN_ENABLED ?? "false").trim().toLowerCase();
  return ["true", "1", "yes", "on"].includes(value);
}

export function generateCustodialWallet() {
  const wallet = Wallet.createRandom();

  return {
    address: wallet.address,
    encryptedPrivateKey: encryptPrivateKey(wallet.privateKey)
  };
}

export function encryptPrivateKey(privateKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(privateKey, "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();

  return JSON.stringify({
    version: 1,
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    ciphertext: ciphertext.toString("hex")
  });
}

export function decryptPrivateKey(encryptedPrivateKey) {
  const payload = JSON.parse(encryptedPrivateKey);
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    Buffer.from(payload.iv, "hex")
  );

  decipher.setAuthTag(Buffer.from(payload.tag, "hex"));

  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "hex")),
    decipher.final()
  ]).toString("utf8");
}

export async function claimDemoPay(toAddress) {
  const recipient = getAddress(toAddress);
  const masterWallet = getMasterWallet();
  const token = getPayTokenContract(masterWallet);
  const metadata = await getPayTokenMetadata();
  const amount = process.env.FAUCET_PAY_AMOUNT ?? "100";
  const ethTopUp = await ensureGasSponsorship(recipient);

  const tokenTx = await token.transfer(recipient, parseUnits(amount, metadata.decimals));
  const tokenReceipt = await tokenTx.wait();

  return {
    asset: metadata.symbol,
    amount,
    status: tokenReceipt?.status === 1 ? "SUCCESS" : "FAILED",
    txHash: tokenTx.hash,
    ethTopUpTxHash: ethTopUp?.txHash ?? null
  };
}

export async function transferPayTokens({ fromEncryptedPrivateKey, toAddress, amount }) {
  const senderWallet = getWalletFromEncryptedKey(fromEncryptedPrivateKey);
  const recipient = getAddress(toAddress);
  const metadata = await getPayTokenMetadata();

  await assertSufficientToken(senderWallet.address, amount, metadata.decimals);
  await ensureGasSponsorship(senderWallet.address);

  const token = getPayTokenContract(senderWallet);
  const tx = await token.transfer(recipient, parseUnits(amount, metadata.decimals));
  const receipt = await tx.wait();

  return {
    asset: metadata.symbol,
    amount,
    txHash: tx.hash,
    status: receipt?.status === 1 ? "SUCCESS" : "FAILED"
  };
}

export async function getBalances(address) {
  const normalizedAddress = getAddress(address);
  const ethBalance = await withRpcReadRetry(() => getProvider().getBalance(normalizedAddress));
  const balances = {
    address: normalizedAddress,
    eth: {
      symbol: "ETH",
      balance: formatEther(ethBalance)
    },
    token: null
  };

  if (isPayTokenConfigured()) {
    const token = getPayTokenContract(getProvider());
    const metadata = await getPayTokenMetadata();
    const rawTokenBalance = await withRpcReadRetry(() => token.balanceOf(normalizedAddress));

    balances.token = {
      symbol: metadata.symbol,
      balance: formatUnits(rawTokenBalance, metadata.decimals),
      contractAddress: getPayContractAddress()
    };
  }

  return balances;
}

export async function createEscrowDeposit({ buyerEncryptedPrivateKey, sellerAddress, amount }) {
  if (!isConfiguredAddress(process.env.ESCROW_CONTRACT_ADDRESS)) {
    throw httpError(503, "ESCROW_CONTRACT_ADDRESS is not configured");
  }

  const buyerWallet = getWalletFromEncryptedKey(buyerEncryptedPrivateKey);
  await assertSufficientEth(buyerWallet.address, amount, true);

  const escrow = getEscrowContract(buyerWallet);
  const tx = await escrow.deposit(getAddress(sellerAddress), { value: parseEther(amount) });
  const receipt = await tx.wait();
  const onchainEscrowId = extractEscrowId(receipt);

  return {
    txHash: tx.hash,
    onchainEscrowId,
    status: receipt?.status === 1 ? "AWAITING_DELIVERY" : "FAILED"
  };
}

export async function releaseEscrowOnchain({ buyerEncryptedPrivateKey, onchainEscrowId }) {
  const buyerWallet = getWalletFromEncryptedKey(buyerEncryptedPrivateKey);
  await ensureGasSponsorship(buyerWallet.address);

  const escrow = getEscrowContract(buyerWallet);
  const tx = await escrow.release(BigInt(onchainEscrowId));
  const receipt = await tx.wait();

  return {
    txHash: tx.hash,
    status: receipt?.status === 1 ? "COMPLETED" : "FAILED"
  };
}

export async function disputeEscrowOnchain({ participantEncryptedPrivateKey, onchainEscrowId }) {
  const participantWallet = getWalletFromEncryptedKey(participantEncryptedPrivateKey);
  await ensureGasSponsorship(participantWallet.address);

  const escrow = getEscrowContract(participantWallet);
  const tx = await escrow.dispute(BigInt(onchainEscrowId));
  const receipt = await tx.wait();

  return {
    txHash: tx.hash,
    status: receipt?.status === 1 ? "DISPUTED" : "FAILED"
  };
}

export async function refundEscrowOnchain({ onchainEscrowId }) {
  const arbitratorWallet = getMasterWallet();
  const escrow = getEscrowContract(arbitratorWallet);
  const tx = await escrow.refund(BigInt(onchainEscrowId));
  const receipt = await tx.wait();

  return {
    txHash: tx.hash,
    status: receipt?.status === 1 ? "REFUNDED" : "FAILED"
  };
}

export function normalizeAsset(asset) {
  const normalized = String(asset ?? process.env.DEFAULT_ASSET ?? "PAY").trim().toUpperCase();
  if (normalized === "ETH") {
    return "ETH";
  }

  return "PAY";
}

function getWalletFromEncryptedKey(encryptedPrivateKey) {
  return new Wallet(validatePrivateKey(decryptPrivateKey(encryptedPrivateKey), "encrypted_private_key"), getProvider());
}

function getProvider() {
  if (!provider) {
    const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL;
    if (!rpcUrl) {
      throw httpError(503, "BASE_SEPOLIA_RPC_URL is not configured");
    }

    const request = new FetchRequest(rpcUrl);
    request.timeout = Number(process.env.RPC_TIMEOUT_MS ?? 60_000);

    provider = new JsonRpcProvider(
      request,
      Number(process.env.BASE_SEPOLIA_CHAIN_ID ?? 84532),
      { staticNetwork: true }
    );
  }

  return provider;
}

function getMasterWallet() {
  return new Wallet(
    validatePrivateKey(process.env.MASTER_WALLET_PRIVATE_KEY, "MASTER_WALLET_PRIVATE_KEY"),
    getProvider()
  );
}

function getPayTokenContract(signerOrProvider) {
  if (!isPayTokenConfigured()) {
    throw httpError(503, "PAY_CONTRACT_ADDRESS is not configured");
  }

  return new Contract(getPayContractAddress(), ERC20_ABI, signerOrProvider);
}

function getPayContractAddress() {
  const address = process.env.PAY_CONTRACT_ADDRESS ?? process.env.ERC20_CONTRACT_ADDRESS;
  if (!isConfiguredAddress(address)) {
    throw httpError(503, "PAY_CONTRACT_ADDRESS is not configured");
  }

  return getAddress(address);
}

function isPayTokenConfigured() {
  const address = process.env.PAY_CONTRACT_ADDRESS ?? process.env.ERC20_CONTRACT_ADDRESS;
  return isConfiguredAddress(address);
}

function getEscrowContract(signerOrProvider) {
  if (!isConfiguredAddress(process.env.ESCROW_CONTRACT_ADDRESS)) {
    throw httpError(503, "ESCROW_CONTRACT_ADDRESS is not configured");
  }

  return new Contract(getAddress(process.env.ESCROW_CONTRACT_ADDRESS), ESCROW_ABI, signerOrProvider);
}

async function getPayTokenMetadata() {
  if (tokenMetadataCache) {
    return tokenMetadataCache;
  }

  const token = getPayTokenContract(getProvider());
  let symbol = "PAY";
  let decimals = 18;

  try {
    symbol = await withRpcReadRetry(() => token.symbol());
  } catch {
    symbol = "PAY";
  }

  try {
    decimals = Number(await withRpcReadRetry(() => token.decimals()));
  } catch {
    decimals = 18;
  }

  tokenMetadataCache = { symbol, decimals };
  return tokenMetadataCache;
}

async function ensureGasSponsorship(address) {
  const sponsorAmount = process.env.GAS_SPONSOR_ETH_AMOUNT ?? process.env.FAUCET_ETH_AMOUNT ?? "0.0005";
  if (Number(sponsorAmount) <= 0) {
    return null;
  }

  const normalizedAddress = getAddress(address);
  const minimum = parseEther(process.env.GAS_SPONSOR_MIN_ETH ?? "0.00003");
  const currentBalance = await withRpcReadRetry(() => getProvider().getBalance(normalizedAddress));

  if (currentBalance >= minimum) {
    return null;
  }

  const tx = await getMasterWallet().sendTransaction({
    to: normalizedAddress,
    value: parseEther(sponsorAmount)
  });
  const receipt = await tx.wait();

  return {
    txHash: tx.hash,
    amount: sponsorAmount,
    status: receipt?.status === 1 ? "SUCCESS" : "FAILED"
  };
}

async function assertSufficientEth(address, amount, includeGasBuffer = false) {
  const balance = await withRpcReadRetry(() => getProvider().getBalance(getAddress(address)));
  const required = parseEther(amount);
  const gasBuffer = includeGasBuffer ? parseEther("0.00005") : 0n;

  if (balance < required + gasBuffer) {
    throw httpError(400, "Insufficient ETH balance");
  }
}

async function assertSufficientToken(address, amount, decimals) {
  const token = getPayTokenContract(getProvider());
  const balance = await withRpcReadRetry(() => token.balanceOf(getAddress(address)));
  const required = parseUnits(amount, decimals);

  if (balance < required) {
    throw httpError(400, "Insufficient PAY balance");
  }
}

function extractEscrowId(receipt) {
  for (const log of receipt?.logs ?? []) {
    try {
      const parsed = escrowInterface.parseLog(log);
      if (parsed?.name === "EscrowDeposited") {
        return parsed.args.escrowId.toString();
      }
    } catch {
      // Ignore unrelated logs emitted by other contracts.
    }
  }

  return null;
}

function isConfiguredAddress(address) {
  if (!address || address === ZERO_ADDRESS) {
    return false;
  }

  try {
    getAddress(address);
    return true;
  } catch {
    return false;
  }
}

async function withRpcReadRetry(action) {
  const attempts = Math.max(1, Number(process.env.RPC_RETRY_ATTEMPTS ?? 3));
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (!isRetryableRpcError(error) || attempt === attempts) {
        throw error;
      }

      await sleep(350 * attempt);
    }
  }

  throw lastError;
}

function isRetryableRpcError(error) {
  return ["TIMEOUT", "NETWORK_ERROR", "SERVER_ERROR", "UNKNOWN_ERROR", "ECONNRESET", "ETIMEDOUT"].includes(error?.code);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validatePrivateKey(privateKey, name) {
  const value = String(privateKey ?? "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw httpError(503, `${name} must be a 32-byte 0x-prefixed hex private key`);
  }

  return value;
}

function getEncryptionKey() {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret || secret.length < 24) {
    throw httpError(500, "ENCRYPTION_KEY must be set to a long random value");
  }

  if (/^[a-fA-F0-9]{64}$/.test(secret)) {
    return Buffer.from(secret, "hex");
  }

  return crypto.createHash("sha256").update(secret).digest();
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
