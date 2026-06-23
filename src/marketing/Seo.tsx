import { Helmet } from 'react-helmet-async';
import { SITE_NAME, SITE_URL, SITE_DESCRIPTION } from './seo';

interface SeoProps {
  /** Page title, appended to ", Orange Way Books" automatically. */
  title?: string;
  /** Meta description (≤160 chars). Falls back to site default. */
  description?: string;
  /** Path of the current page (e.g. "/faq"). Used for canonical + OG URL. */
  path: string;
  /** Optional OG image path. Falls back to /og/default.png. */
  image?: string;
  /** One or more JSON-LD objects to inject. */
  jsonLd?: object | object[];
  /** Set to true for /docs/* and /blog/* pages. */
  isArticle?: boolean;
}

/**
 * Centralized per-page SEO. Every public marketing page should render
 * exactly one <Seo /> at the top so titles, canonicals, OG tags, and
 * structured data stay consistent.
 */
export function Seo({
  title,
  description = SITE_DESCRIPTION,
  path,
  image = '/og/default.png',
  jsonLd,
  isArticle = false,
}: SeoProps) {
  const fullTitle = title
    ? `${title}, ${SITE_NAME}`
    : `${SITE_NAME}, Zero-Knowledge Bitcoin Accounting`;
  const url = `${SITE_URL}${path}`;
  const fullImage = image.startsWith('http') ? image : `${SITE_URL}${image}`;
  const ldArray = Array.isArray(jsonLd) ? jsonLd : jsonLd ? [jsonLd] : [];

  return (
    <Helmet>
      <title>{fullTitle}</title>
      <meta name="description" content={description} />
      <link rel="canonical" href={url} />

      <meta property="og:type" content={isArticle ? 'article' : 'website'} />
      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={url} />
      <meta property="og:image" content={fullImage} />
      <meta property="og:site_name" content={SITE_NAME} />

      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={fullTitle} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={fullImage} />

      {ldArray.map((ld, i) => (
        <script key={i} type="application/ld+json">
          {JSON.stringify(ld)}
        </script>
      ))}
    </Helmet>
  );
}
