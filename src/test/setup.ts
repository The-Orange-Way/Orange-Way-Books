import '@testing-library/jest-dom';

// `src/lib/supabase.ts` throws at import time when VITE_SUPABASE_URL or
// VITE_SUPABASE_PUBLISHABLE_KEY are unset. Tests that don't directly
// touch Supabase still import modules that transitively import the
// client, so without these stubs the entire suite refuses to load. The
// values are intentionally non-functional ("test"/"test"): any test
// that actually hits the network is expected to vi.mock the client.
if (typeof import.meta !== 'undefined' && import.meta.env) {
  import.meta.env.VITE_SUPABASE_URL ||= 'http://supabase.test';
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||= 'test-key';
}

// jsdom 20 (bundled with vitest 3.x at this dependency level) does not
// implement Blob.prototype.arrayBuffer, added in jsdom 21. Polyfill it
// here so that any test involving encryptBlob / decryptBlob works.
if (typeof Blob !== 'undefined' && !Blob.prototype.arrayBuffer) {
  Object.defineProperty(Blob.prototype, 'arrayBuffer', {
    value(this: Blob): Promise<ArrayBuffer> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(this);
      });
    },
    writable: true,
    configurable: true,
  });
}

// matchMedia only exists in jsdom; skip when running under the
// "node" environment (used by tests that don't touch DOM APIs
// e.g. the Phase 4.1 vault-keypair test).
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => {},
    }),
  });
}
