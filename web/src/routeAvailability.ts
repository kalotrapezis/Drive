// Source cleanup requires a separate, verified Trash confirmation.
export function routeUnavailable(route: { behavior?: string; keepPolicy?: string; stagingMaxBytes?: number; storagePresent: boolean }) {
  if (!route.storagePresent) return 'Connect and mount the destination storage to preview.';
  return '';
}

export function routeMode(route: { behavior?: string; keepPolicy?: string }): "Copy" | "Move" {
  return route.behavior === "Move" || (route.keepPolicy && route.keepPolicy !== "Everything") ? "Move" : "Copy";
}
