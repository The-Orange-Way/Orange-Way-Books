/**
 * Loads `/brand-logo.png` and returns a data URL for reliable embedding in print windows.
 * When the PNG is missing (common in dev), returns an inline SVG mark so exports always show branding.
 */
export function getFallbackBrandLogoDataUri(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="40" viewBox="0 0 220 40" role="img" aria-label="Orange Way Books">
  <text x="0" y="28" font-family="Inter,system-ui,-apple-system,sans-serif" font-weight="700" font-size="22" fill="#111827">Orange Way Books</text>
  <rect x="188" y="6" width="32" height="28" rx="6" fill="#f7931a"/>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export async function fetchBrandLogoDataUri(): Promise<string> {
  try {
    const res = await fetch('/brand-logo.png', { credentials: 'same-origin', cache: 'force-cache' });
    if (!res.ok) {
      return getFallbackBrandLogoDataUri();
    }
    const blob = await res.blob();
    const dataUri = await new Promise<string | null>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result;
        resolve(typeof result === 'string' && result.length > 0 ? result : null);
      };
      reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
      reader.readAsDataURL(blob);
    });
    return dataUri ?? getFallbackBrandLogoDataUri();
  } catch {
    return getFallbackBrandLogoDataUri();
  }
}
