export function destinationInFolder(folder: string, path: string) {
  return `${folder.replace(/\/+$/, "")}/${path.split("/").at(-1)}`;
}
