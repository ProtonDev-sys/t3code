import { readHashParams, removeHashParam, setHashParam } from "./urlHashParams";

const PAIRING_TOKEN_PARAM = "token";

export function getPairingTokenFromUrl(url: URL): string | null {
  const hashToken = readHashParams(url.hash).get(PAIRING_TOKEN_PARAM)?.trim() ?? "";
  if (hashToken.length > 0) {
    return hashToken;
  }

  const searchToken = url.searchParams.get(PAIRING_TOKEN_PARAM)?.trim() ?? "";
  return searchToken.length > 0 ? searchToken : null;
}

export function stripPairingTokenFromUrl(url: URL): URL {
  const next = new URL(url.toString());
  if (readHashParams(next.hash).has(PAIRING_TOKEN_PARAM)) {
    next.hash = removeHashParam(next.hash, PAIRING_TOKEN_PARAM);
  }
  next.searchParams.delete(PAIRING_TOKEN_PARAM);
  return next;
}

export function setPairingTokenOnUrl(url: URL, credential: string): URL {
  const next = new URL(url.toString());
  next.searchParams.delete(PAIRING_TOKEN_PARAM);
  next.hash = setHashParam(next.hash, PAIRING_TOKEN_PARAM, credential);
  return next;
}
