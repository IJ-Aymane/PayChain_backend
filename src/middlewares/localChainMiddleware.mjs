import { assertLocalChainHealthy, isLocalBlockchainEnabled } from "../models/localBlockchainModel.mjs";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function verifyLocalChainBeforeMutation(request, _response, next) {
  try {
    if (isLocalBlockchainEnabled() === false || MUTATING_METHODS.has(request.method) === false) {
      next();
      return;
    }

    await assertLocalChainHealthy();
    next();
  } catch (error) {
    next(error);
  }
}
