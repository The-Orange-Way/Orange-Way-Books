import { describe, it, expect } from "vitest";
import {
  deriveKey,
  encryptText,
  decryptText,
  encryptBlob,
  decryptBlob,
} from "@/lib/vault";

// Fixtures — a stable (password, userId) lets us deterministically derive a
// key for the whole suite. Derivation is expensive (PBKDF2 600k iters) so we
// do it once in `beforeAll`-style helpers inside each test by caching.
const PASSWORD = "correct horse battery staple";
const OTHER_PASSWORD = "different password 42";
const USER_ID = "11111111-2222-3333-4444-555555555555";

describe("vault.ts — Web Crypto encrypt/decrypt", () => {
  it("roundtrips a short plaintext string", async () => {
    const key = await deriveKey(PASSWORD, USER_ID);
    const plain = "Hello, Orange Way Books!";
    const cipher = await encryptText(plain, key);
    const back = await decryptText(cipher, key);
    expect(back).toBe(plain);
  });

  it("roundtrips a 128 KB plaintext string (chunked base64 path)", async () => {
    const key = await deriveKey(PASSWORD, USER_ID);
    // 128 KB of repeating content — exercises the CHUNK_SIZE=32KB loop in bytesToBase64.
    const plain = "A".repeat(128 * 1024);
    const cipher = await encryptText(plain, key);
    const back = await decryptText(cipher, key);
    expect(back.length).toBe(plain.length);
    expect(back).toBe(plain);
  });

  it("throws when decrypting with the wrong key", async () => {
    const keyRight = await deriveKey(PASSWORD, USER_ID);
    const keyWrong = await deriveKey(OTHER_PASSWORD, USER_ID);
    const cipher = await encryptText("secret", keyRight);
    // AES-GCM auth tag mismatch → decrypt rejects. Assert it throws rather
    // than silently produces garbage.
    await expect(decryptText(cipher, keyWrong)).rejects.toBeDefined();
  });

  it("produces a different ciphertext on every call (random IV)", async () => {
    const key = await deriveKey(PASSWORD, USER_ID);
    const a = await encryptText("same-plaintext", key);
    const b = await encryptText("same-plaintext", key);
    const c = await encryptText("same-plaintext", key);
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
    // But every IV+ciphertext still decrypts back to the same plaintext.
    for (const ct of [a, b, c]) {
      expect(await decryptText(ct, key)).toBe("same-plaintext");
    }
  });

  it("roundtrips a Blob through encryptBlob → decryptBlob", async () => {
    const key = await deriveKey(PASSWORD, USER_ID);
    const raw = new Uint8Array([1, 2, 3, 4, 5, 254, 255, 0, 128]);
    const blob = await encryptBlob(raw, key);
    const decryptedBuf = await decryptBlob(blob, key);
    const decryptedBytes = new Uint8Array(decryptedBuf);
    expect(decryptedBytes.length).toBe(raw.length);
    expect(Array.from(decryptedBytes)).toEqual(Array.from(raw));
  });

  it("same (password, userId) produces keys that can decrypt each other's output", async () => {
    // Derive twice independently — simulates a user logging in on two devices
    // using the same vault password. The MEKs should be byte-equivalent even
    // though the CryptoKey *objects* differ.
    const keyA = await deriveKey(PASSWORD, USER_ID);
    const keyB = await deriveKey(PASSWORD, USER_ID);
    const cipher = await encryptText("cross-device secret", keyA);
    const back = await decryptText(cipher, keyB);
    expect(back).toBe("cross-device secret");
  });

  it("different passwords produce isolated keys (cannot cross-decrypt)", async () => {
    const keyA = await deriveKey(PASSWORD, USER_ID);
    const keyB = await deriveKey(OTHER_PASSWORD, USER_ID);
    const cipher = await encryptText("isolated", keyA);
    await expect(decryptText(cipher, keyB)).rejects.toBeDefined();
  });
});
