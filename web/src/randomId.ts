/** Browser-generated correlation IDs also work on explicitly configured HTTP LAN origins. */
export function randomId(): string {
  return crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join('')
}
