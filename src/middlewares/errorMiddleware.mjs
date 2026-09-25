export function notFoundHandler(_request, response) {
  response.status(404).json({ error: "Route not found" });
}

export function errorHandler(error, _request, response, _next) {
  const statusCode = getHttpStatusCode(error);

  if (statusCode >= 500) {
    console.error(error);
  }

  response.status(statusCode).json({
    error: getHttpErrorMessage(error, statusCode)
  });
}

function getHttpStatusCode(error) {
  if (Number.isInteger(error?.statusCode)) {
    return error.statusCode;
  }

  if (error?.code === "ER_DUP_ENTRY") {
    return 409;
  }

  switch (error?.code) {
    case "CALL_EXCEPTION":
    case "INSUFFICIENT_FUNDS":
    case "INVALID_ARGUMENT":
    case "NUMERIC_FAULT":
      return 400;
    case "ETIMEDOUT":
    case "ECONNREFUSED":
    case "PROTOCOL_CONNECTION_LOST":
    case "NETWORK_ERROR":
    case "SERVER_ERROR":
    case "TIMEOUT":
    case "UNKNOWN_ERROR":
      return 503;
    default:
      return 500;
  }
}

function getHttpErrorMessage(error, statusCode) {
  if (error?.code === "ER_DUP_ENTRY") {
    return "Email, username or wallet already exists";
  }

  if (error?.code === "INSUFFICIENT_FUNDS") {
    return "Insufficient ETH balance for amount and network fee";
  }

  if (error?.code === "CALL_EXCEPTION") {
    return error.shortMessage ?? "Blockchain transaction reverted";
  }

  if (error?.code === "INVALID_ARGUMENT") {
    return error.shortMessage ?? "Invalid blockchain argument";
  }

  if (error?.code === "TIMEOUT") {
    return "Base Sepolia RPC request timed out. Try again or set a faster BASE_SEPOLIA_RPC_URL.";
  }

  if (statusCode >= 500 && process.env.NODE_ENV === "production") {
    return "Internal server error";
  }

  return error instanceof Error ? error.message : "Unexpected error";
}
