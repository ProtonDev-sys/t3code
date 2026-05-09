import { getPairingTokenFromUrl } from "../../pairingUrl";
import { readHostedPairingRequest } from "../../hostedPairing";

export interface ResolvedRemotePairingTarget {
  readonly credential: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

function normalizeRemoteBaseUrl(rawValue: string): URL {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    throw new Error("Enter a backend URL.");
  }

  const normalizedInput =
    /^[a-zA-Z][a-zA-Z\d+-]*:\/\//.test(trimmed) || trimmed.startsWith("//")
      ? trimmed
      : `${defaultProtocolForBareHost(trimmed)}://${trimmed}`;
  const url = new URL(normalizedInput, window.location.origin);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

export function defaultProtocolForBareHost(rawValue: string): "http" | "https" {
  const host = rawValue
    .trim()
    .replace(/^\/\//u, "")
    .split(/[/?#]/u)[0]!
    .replace(/^\[|\]$/gu, "")
    .split(":")[0]!
    .toLowerCase();

  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./u.test(host)
  ) {
    return "http";
  }
  return "https";
}

function toHttpBaseUrl(url: URL): string {
  const next = new URL(url.toString());
  if (next.protocol === "ws:") {
    next.protocol = "http:";
  } else if (next.protocol === "wss:") {
    next.protocol = "https:";
  }
  next.pathname = "/";
  next.search = "";
  next.hash = "";
  return next.toString();
}

function toWsBaseUrl(url: URL): string {
  const next = new URL(url.toString());
  if (next.protocol === "http:") {
    next.protocol = "ws:";
  } else if (next.protocol === "https:") {
    next.protocol = "wss:";
  }
  next.pathname = "/";
  next.search = "";
  next.hash = "";
  return next.toString();
}

export function resolveRemotePairingTarget(input: {
  readonly pairingUrl?: string;
  readonly host?: string;
  readonly pairingCode?: string;
}): ResolvedRemotePairingTarget {
  const pairingUrl = input.pairingUrl?.trim() ?? "";
  if (pairingUrl.length > 0) {
    const url = new URL(pairingUrl, window.location.origin);
    const hostedPairingRequest = readHostedPairingRequest(url);
    if (hostedPairingRequest) {
      const hostedBackendUrl = normalizeRemoteBaseUrl(hostedPairingRequest.host);
      return {
        credential: hostedPairingRequest.token,
        httpBaseUrl: toHttpBaseUrl(hostedBackendUrl),
        wsBaseUrl: toWsBaseUrl(hostedBackendUrl),
      };
    }

    const credential = getPairingTokenFromUrl(url) ?? "";
    if (!credential) {
      throw new Error("Pairing URL is missing its token.");
    }
    return {
      credential,
      httpBaseUrl: toHttpBaseUrl(url),
      wsBaseUrl: toWsBaseUrl(url),
    };
  }

  const host = input.host?.trim() ?? "";
  const pairingCode = input.pairingCode?.trim() ?? "";
  if (!host) {
    throw new Error("Enter a backend URL.");
  }
  if (!pairingCode) {
    throw new Error("Enter a pairing code.");
  }

  const normalizedHost = normalizeRemoteBaseUrl(host);
  return {
    credential: pairingCode,
    httpBaseUrl: toHttpBaseUrl(normalizedHost),
    wsBaseUrl: toWsBaseUrl(normalizedHost),
  };
}
