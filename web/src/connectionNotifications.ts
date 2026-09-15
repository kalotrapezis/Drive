export type ConnectionNotification = {
  id: string;
  level: "action" | "warning" | "success";
  message: string;
  action: "setup" | "settings";
  actionLabel: string;
  storageId?: string;
};

type State = {
  storages: { id: string; label: string; present?: boolean }[];
  firstSeenDevices?: { id: string; label: string; category?: string; present?: boolean }[];
  routes: { id: string; contentType: string; storageId?: string; storagePresent: boolean; jobState?: string }[];
};

export function connectionNotifications(state: State): ConnectionNotification[] {
  const known = new Map(state.storages.filter((storage) => storage.id !== "local").map((storage) => [storage.id, storage]));
  for (const device of state.firstSeenDevices || []) if (device.category === "storage") known.set(device.id, device);
  const notices: ConnectionNotification[] = [];
  for (const storage of known.values()) if (storage.present && !state.routes.some((route) => route.storageId === storage.id)) notices.push({ id: `setup-${storage.id}`, level: "action", message: `${storage.label} is ready but has no connection.`, action: "setup", actionLabel: "Set up connection", storageId: storage.id });
  for (const route of state.routes) {
    const storage = known.get(route.storageId || "");
    const label = storage?.label || "destination storage";
    if (!route.storagePresent) notices.push({ id: `waiting-${route.id}`, level: "warning", message: `${route.contentType} backup is waiting for ${label}.`, action: "settings", actionLabel: "Review connection" });
    else if (["Failed", "Conflict", "Paused", "Cleanup pending"].includes(route.jobState || "")) notices.push({ id: `review-${route.id}`, level: "warning", message: `${route.contentType} backup needs review: ${route.jobState}.`, action: "settings", actionLabel: "Review backup" });
    else if (["Complete", "Verified"].includes(route.jobState || "")) notices.push({ id: `complete-${route.id}`, level: "success", message: `${route.contentType} backup to ${label} was verified.`, action: "settings", actionLabel: "View connection" });
  }
  return notices;
}
