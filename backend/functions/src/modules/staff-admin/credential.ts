/** Adapt short PINs to Firebase's minimum length; this does not add entropy. */
export function staffCredential(secret: string): string {
  return /^[0-9]{1,4}$/.test(secret) ? `staff-pin-v1:${secret}` : secret;
}
