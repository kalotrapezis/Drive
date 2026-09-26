export function isScreenshot(photo: { path: string; type: string }) {
  // Folder provenance only: filenames alone cannot reliably identify screenshots.
  return photo.type === "Photo" && photo.path.split("/").slice(0, -1).some((part) => /^(screenshots|screen shots|στιγμιότυπα οθόνης)$/iu.test(part));
}
