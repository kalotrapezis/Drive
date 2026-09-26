export function storageTotals(storages: { id: string; identity?: string; present?: boolean; bytesTotal?: number; bytesFree?: number }[]) {
  const groups = new Map<string, typeof storages[number]>();
  for (const storage of storages) {
    const key = storage.identity || storage.id;
    if (!groups.has(key) || storage.present) groups.set(key, storage);
  }
  let total = 0, free = 0, excluded = 0;
  for (const storage of groups.values()) {
    if (!storage.present || !Number.isFinite(storage.bytesTotal) || !Number.isFinite(storage.bytesFree) || storage.bytesTotal! <= 0 || storage.bytesFree! < 0 || storage.bytesFree! > storage.bytesTotal!) { excluded++; continue; }
    total += storage.bytesTotal!; free += storage.bytesFree!;
  }
  return { total, free, used: total - free, excluded };
}
