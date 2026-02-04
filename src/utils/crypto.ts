import * as ed from '@noble/ed25519';

/**
 * Verify Ed25519 signature
 * @param publicKey - Public key with format "base64key:ed25519"
 * @param message - The canonical message string that was signed
 * @param signature - Base64-encoded signature
 * @returns boolean indicating if signature is valid
 */
export async function verifySignature(
  publicKey: string,
  message: string,
  signature: string
): Promise<boolean> {
  try {
    // Parse public key format: "base64key:ed25519"
    const [keyBase64, algo] = publicKey.split(':');
    if (algo !== 'ed25519') {
      throw new Error(`Unsupported algorithm: ${algo}`);
    }
    
    // Decode public key
    const publicKeyBytes = Uint8Array.from(atob(keyBase64), c => c.charCodeAt(0));
    
    // Decode signature
    const signatureBytes = Uint8Array.from(atob(signature), c => c.charCodeAt(0));
    
    // Verify
    const messageBytes = new TextEncoder().encode(message);
    return await ed.verify(signatureBytes, messageBytes, publicKeyBytes);
  } catch (error) {
    console.error('Signature verification error:', error);
    return false;
  }
}

/**
 * Sign a message with private key
 * @param privateKey - Base64-encoded private key
 * @param message - Message to sign
 * @returns Base64-encoded signature
 */
export async function signMessage(
  privateKey: string,
  message: string
): Promise<string> {
  const privateKeyBytes = Uint8Array.from(atob(privateKey), c => c.charCodeAt(0));
  const messageBytes = new TextEncoder().encode(message);
  const signature = await ed.sign(messageBytes, privateKeyBytes);
  return btoa(String.fromCharCode(...signature));
}

/**
 * Generate new Ed25519 key pair
 * @returns Object with publicKey and privateKey (both base64-encoded)
 */
export async function generateKeyPair(): Promise<{
  publicKey: string;
  privateKey: string;
}> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKey(privateKey);
  
  return {
    publicKey: btoa(String.fromCharCode(...publicKey)),
    privateKey: btoa(String.fromCharCode(...privateKey))
  };
}

/**
 * Build canonical request string for signing
 * @param method - HTTP method
 * @param path - Request path
 * @param timestamp - ISO 8601 timestamp
 * @param body - Request body (or empty string)
 * @returns Canonical string to sign
 */
export function buildCanonicalString(
  method: string,
  path: string,
  timestamp: string,
  body: string
): string {
  const bodyHash = crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
    .then(hash => {
      return Array.from(new Uint8Array(hash))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    });
  return `${method} ${path}\n${timestamp}\n${bodyHash}`;
}

/**
 * Hash a string using SHA-256
 * @param input - String to hash
 * @returns Hex-encoded hash
 */
export async function sha256(input: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
