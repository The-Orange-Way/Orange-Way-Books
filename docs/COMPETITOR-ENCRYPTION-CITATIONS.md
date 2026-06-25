# Competitor encryption-posture citations

This doc records the public source material behind the README claim that the major commercial accounting products (QuickBooks, Xero, FreshBooks, Wave, NetSuite, Sage) all hold customer data in a form their own servers can read.

The claim is **architectural**, not pejorative. The bar is not "do they encrypt at rest" (most do), but **"is the encryption key held by the operator or by the customer?"** When the operator holds the key, the operator (and anyone with subpoena power, anyone who breaches the operator, and anyone who buys the operator) can read the data. That is the architectural fact this project tries to flip.

## Status: research in progress

This doc is intentionally a placeholder so the README footnote has a real destination. Citations land here as they are verified against each vendor's currently-published security materials. Anyone wanting to challenge a specific claim should open an issue with the vendor URL and the relevant quote; that triggers a re-read of the source.

Reading the marketing copy alone is insufficient: every vendor markets "bank-level encryption" or "AES-256," which is necessary but not sufficient evidence either way. The architectural question is whether the operator can decrypt without the customer's participation. That fact is usually buried in a security whitepaper or a knowledge-base article, not the marketing page.

## Vendors covered by the README claim

| Vendor                     | Status           | Source(s)                                                                                                  |
| -------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------- |
| QuickBooks Online (Intuit) | Citation pending | Intuit security overview page (canonical URL to be verified against current site structure before linking) |
| Xero                       | Citation pending | Xero security page + Xero Central knowledge-base entry on data encryption                                  |
| FreshBooks                 | Citation pending | FreshBooks security page                                                                                   |
| Wave                       | Citation pending | Wave security page                                                                                         |
| NetSuite (Oracle)          | Citation pending | Oracle's NetSuite security whitepaper                                                                      |
| Sage                       | Citation pending | Sage security overview + Sage trust center if available                                                    |

Each row will become a direct link to the operator-held-key statement once verified against the live page. URLs are not inlined here yet to avoid linking to pages that may have moved or been replaced; verification means opening the page, confirming the architectural fact, and recording the wording.

## Counter-evidence channel

If you are an employee of one of the named vendors and your product's architecture has changed (specifically: if customer data is now encrypted under a key the operator does not hold), please open an issue or email the maintainers. The README claim will be amended to reflect the change, and your product will be acknowledged in the change.

## Why this matters legally

Naming competitors with a factual claim about how their architecture works is defensible only if the claim is documented against their own published material. This doc is where that documentation lives. Until it is filled in vendor-by-vendor, the README couches the claim against "each vendor's published security documentation" rather than naming a specific document per vendor, and points readers here, so the epistemic state is honest.
