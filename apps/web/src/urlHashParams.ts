function stripHashPrefix(hash: string): string {
  return hash.startsWith("#") ? hash.slice(1) : hash;
}

function splitHashRouteAndQuery(hash: string): {
  readonly routePrefix: string;
  readonly query: string;
  readonly isRouteHash: boolean;
} {
  const value = stripHashPrefix(hash);
  const queryStart = value.indexOf("?");
  if (queryStart >= 0) {
    return {
      routePrefix: value.slice(0, queryStart),
      query: value.slice(queryStart + 1),
      isRouteHash: true,
    };
  }

  if (value.startsWith("/")) {
    return {
      routePrefix: value,
      query: "",
      isRouteHash: true,
    };
  }

  return {
    routePrefix: "",
    query: value,
    isRouteHash: false,
  };
}

export function readHashParams(hash: string): URLSearchParams {
  return new URLSearchParams(splitHashRouteAndQuery(hash).query);
}

export function removeHashParam(hash: string, name: string): string {
  const { isRouteHash, query, routePrefix } = splitHashRouteAndQuery(hash);
  const params = new URLSearchParams(query);
  params.delete(name);
  const nextQuery = params.toString();

  if (isRouteHash) {
    return nextQuery ? `${routePrefix}?${nextQuery}` : routePrefix;
  }

  return nextQuery;
}

export function setHashParam(hash: string, name: string, value: string): string {
  const { isRouteHash, query, routePrefix } = splitHashRouteAndQuery(hash);
  const params = new URLSearchParams(query);
  params.set(name, value);
  const nextQuery = params.toString();

  if (isRouteHash) {
    return `${routePrefix || "/"}?${nextQuery}`;
  }

  return nextQuery;
}
