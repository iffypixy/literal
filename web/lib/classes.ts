/** Joins class names, skipping those left out, so a primitive's own come first and the caller's last. */
export function classes(...names: (string | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}
