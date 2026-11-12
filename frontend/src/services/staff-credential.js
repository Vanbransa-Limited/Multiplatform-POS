// This namespace adapts short PINs to Firebase's password length requirement.
// It adds no entropy: Firebase still verifies the credential and limits attempts.
export function staffCredential(value) {
  const secret = String(value ?? '');
  return /^[0-9]{1,4}$/.test(secret) ? `staff-pin-v1:${secret}` : secret;
}
