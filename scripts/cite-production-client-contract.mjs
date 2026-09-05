export const CITE_THE_MOVE_CLIENT_ID = "axon-web";
export const CITE_THE_MOVE_CALLBACK = "https://app.citethemove.com/auth/callback";

export function redirectUrisToRemove(redirectUris) {
  return redirectUris
    .filter((entry) => entry.redirectUri !== CITE_THE_MOVE_CALLBACK)
    .map((entry) => entry.redirectUri)
    .sort();
}

export function needsCallbackEnable(redirectUris) {
  return !redirectUris.some(
    (entry) => entry.redirectUri === CITE_THE_MOVE_CALLBACK && entry.enabled,
  );
}
