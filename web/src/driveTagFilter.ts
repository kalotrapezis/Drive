export function matchesDriveTag(tags: readonly string[] | undefined, selectedTag: string): boolean {
  return selectedTag ? !!tags?.includes(selectedTag) : !!tags?.length;
}
