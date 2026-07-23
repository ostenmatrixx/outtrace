import { createHash, timingSafeEqual } from 'node:crypto';

const invalidCredentialHash = createHash('sha256')
  .update('openflow-invalid-credential-sentinel')
  .digest();

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function verifySha256Secret(secret: string, expectedHash: string | undefined): boolean {
  const provided = createHash('sha256').update(secret, 'utf8').digest();
  const expected = /^[a-f0-9]{64}$/i.test(expectedHash ?? '')
    ? Buffer.from(expectedHash!, 'hex')
    : invalidCredentialHash;

  return timingSafeEqual(provided, expected) && expectedHash !== undefined;
}
