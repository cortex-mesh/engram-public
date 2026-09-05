export type BrandTheme = "engram" | "tradepost" | "citethemove";

export function brandThemeForClient(clientId: string | null): BrandTheme {
  if (clientId === "tradepost-web") return "tradepost";
  if (clientId === "axon-web") return "citethemove";
  return "engram";
}
