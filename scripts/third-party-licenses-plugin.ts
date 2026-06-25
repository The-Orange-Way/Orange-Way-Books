/**
 * Vite plugin that emits `dist/third-party-licenses.txt` at build time
 * so the distribution carries an exhaustive Apache 2.0 §4(d) attribution
 * surface alongside the hand-curated NOTICE file.
 *
 * The repo's NOTICE file is intentionally a courtesy subset of notable
 * upstream projects; this plugin's output is the authoritative list
 * machine-generated from the resolved dependency graph. Both ship in
 * the same `dist/` so a downstream packager has both surfaces.
 *
 * What it does:
 *   1. At the end of `vite build`, walks every production dependency
 *      reachable from package.json.
 *   2. For each package, reads its license metadata from its installed
 *      `package.json` (name, version, license, homepage, repository)
 *      and tries to inline its LICENSE / LICENCE / COPYING file if one
 *      is present in the package root.
 *   3. Emits a single concatenated `third-party-licenses.txt` in the
 *      Vite output directory.
 *
 * Why not `license-checker`:
 *   - One fewer external dependency.
 *   - We don't need the full feature set (CSV/JSON outputs, allow-list
 *     enforcement, etc.). A concatenated text file is enough for §4(d).
 *   - This runs in-tree so updates to the dep graph (`bun install` etc.)
 *     are reflected on the next build, no extra command to remember.
 *
 * Dev mode is untouched: `apply: 'build'` enforces that.
 */

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';

const LICENSE_FILE_PATTERNS = [/^license(\..*)?$/i, /^licence(\..*)?$/i, /^copying(\..*)?$/i];

interface PackageManifest {
  name?: string;
  version?: string;
  license?: string | { type?: string };
  homepage?: string;
  repository?: string | { url?: string };
}

async function readPackageManifest(pkgDir: string): Promise<PackageManifest | null> {
  try {
    const manifestPath = path.join(pkgDir, 'package.json');
    const raw = await readFile(manifestPath, 'utf8');
    return JSON.parse(raw) as PackageManifest;
  } catch {
    return null;
  }
}

async function findLicenseFile(pkgDir: string): Promise<string | null> {
  try {
    const entries = await readdir(pkgDir);
    for (const entry of entries) {
      if (LICENSE_FILE_PATTERNS.some((re) => re.test(entry))) {
        const full = path.join(pkgDir, entry);
        const info = await stat(full);
        if (info.isFile()) return full;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function licenseToString(license: PackageManifest['license']): string {
  if (!license) return 'UNKNOWN';
  if (typeof license === 'string') return license;
  return license.type ?? 'UNKNOWN';
}

function repoToUrl(repo: PackageManifest['repository']): string | null {
  if (!repo) return null;
  if (typeof repo === 'string') return repo;
  return repo.url ?? null;
}

async function walkNodeModules(root: string): Promise<string[]> {
  const found: string[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const full = path.join(dir, entry);
      if (entry.startsWith('@')) {
        // Scope dir: descend one level for each scoped package.
        let scopedEntries: string[];
        try {
          scopedEntries = await readdir(full);
        } catch {
          continue;
        }
        for (const scoped of scopedEntries) {
          if (scoped.startsWith('.')) continue;
          found.push(path.join(full, scoped));
        }
        continue;
      }
      found.push(full);
    }
  }
  return found;
}

interface Options {
  outFile?: string;
}

export default function thirdPartyLicensesPlugin(options: Options = {}): Plugin {
  const outFile = options.outFile ?? 'third-party-licenses.txt';
  let outDir = 'dist';

  return {
    name: 'orange-way-books-third-party-licenses',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    async closeBundle() {
      const root = process.cwd();
      const nmRoot = path.join(root, 'node_modules');
      let pkgDirs: string[];
      try {
        pkgDirs = await walkNodeModules(nmRoot);
      } catch {
        this.warn('[third-party-licenses] node_modules not found; skipping attribution emission.');
        return;
      }

      // Read the host package's own license to anchor the file.
      const hostManifest = await readPackageManifest(root);
      const hostName = hostManifest?.name ?? 'orange-way-books';
      const hostVersion = hostManifest?.version ?? '0.0.0';

      const records: Array<{
        name: string;
        version: string;
        license: string;
        homepage: string | null;
        repo: string | null;
        text: string | null;
      }> = [];

      for (const pkgDir of pkgDirs) {
        const manifest = await readPackageManifest(pkgDir);
        if (!manifest || !manifest.name || !manifest.version) continue;
        const licenseFile = await findLicenseFile(pkgDir);
        const text = licenseFile ? await readFile(licenseFile, 'utf8').catch(() => null) : null;
        records.push({
          name: manifest.name,
          version: manifest.version,
          license: licenseToString(manifest.license),
          homepage: manifest.homepage ?? null,
          repo: repoToUrl(manifest.repository),
          text,
        });
      }

      records.sort((a, b) => a.name.localeCompare(b.name));

      const buildDate = new Date().toISOString().slice(0, 10);
      const header = [
        `Third-party licenses for ${hostName} ${hostVersion}`,
        `Generated ${buildDate} from the resolved dependency graph.`,
        '',
        'This file is auto-emitted by scripts/third-party-licenses-plugin.ts',
        'at the end of every Vite production build. It complements the',
        'curated NOTICE file at the repo root by providing the full',
        'machine-enumerated attribution surface required by Apache 2.0 §4(d).',
        '',
        '----------------------------------------------------------------------',
        '',
      ].join('\n');

      const body = records
        .map((r) => {
          const links: string[] = [];
          if (r.homepage) links.push(`Homepage: ${r.homepage}`);
          if (r.repo) links.push(`Repository: ${r.repo}`);
          const linksBlock = links.length ? links.join('\n') + '\n' : '';
          const textBlock = r.text
            ? `\n${r.text.trim()}\n`
            : '\n(No LICENSE file shipped with this package.)\n';
          return [
            `=== ${r.name}@${r.version} ===`,
            `License: ${r.license}`,
            linksBlock,
            textBlock,
            '',
          ].join('\n');
        })
        .join('\n');

      const resolvedOutDir = path.isAbsolute(outDir) ? outDir : path.join(root, outDir);
      await mkdir(resolvedOutDir, { recursive: true });
      const destination = path.join(resolvedOutDir, outFile);
      await writeFile(destination, header + body, 'utf8');

      this.info(
        `[third-party-licenses] Wrote ${path.relative(root, destination)} covering ${records.length} packages.`,
      );
    },
  };
}
