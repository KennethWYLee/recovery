export type PublicSiteOriginInput = {
  configuredOrigin?: string | null;
  forwardedHost?: string | null;
  host?: string | null;
  forwardedProtocol?: string | null;
};

function firstHeaderValue(value: string | null | undefined): string {
  return value?.split(",")[0]?.trim() ?? "";
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function parseHttpsOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      isLocalHostname(url.hostname)
    ) return null;

    return url.origin;
  } catch {
    return null;
  }
}

export function resolvePublicSiteOrigin(input: PublicSiteOriginInput): string | null {
  const configuredOrigin = input.configuredOrigin?.trim();
  if (configuredOrigin) return parseHttpsOrigin(configuredOrigin);

  const protocol = firstHeaderValue(input.forwardedProtocol) || "https";
  if (protocol !== "https") return null;

  const host = firstHeaderValue(input.forwardedHost) || firstHeaderValue(input.host);
  if (!host || /[/?#\\@]/u.test(host)) return null;

  return parseHttpsOrigin(`https://${host}`);
}

export function roleSelectionUrl(input: PublicSiteOriginInput): string | null {
  const origin = resolvePublicSiteOrigin(input);
  return origin ? new URL("/role-selection", origin).toString() : null;
}
