// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightTypeDoc, { typeDocSidebarGroup } from 'starlight-typedoc';

// Circuit's syntax palette is fixed across every erisera OSS site (see
// erisera-code/circuit's src/tokens.css) — this is the same custom
// Shiki/Expressive-Code theme built for circuit.erisera.com, reused
// verbatim here so code reads identically across the whole family.
const circuitShikiTheme = {
  name: 'circuit',
  type: 'dark',
  colors: {
    'editor.background': '#0f172a',
    'editor.foreground': '#e2e8f0',
  },
  tokenColors: [
    { scope: ['comment'], settings: { foreground: '#8b93a1', fontStyle: 'italic' } },
    { scope: ['string', 'string.quoted'], settings: { foreground: '#0f9d63' } },
    { scope: ['keyword', 'keyword.control', 'storage.type', 'storage.modifier'], settings: { foreground: '#d6337d' } },
    { scope: ['entity.name.function', 'support.function'], settings: { foreground: '#1d6fbf' } },
    { scope: ['constant.numeric'], settings: { foreground: '#9333d6' } },
    { scope: ['entity.name.tag', 'meta.tag'], settings: { foreground: '#b45f06' } },
    { scope: ['entity.other.attribute-name'], settings: { foreground: '#1d8f8f' } },
    { scope: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'], settings: { foreground: '#7c4fd6' } },
    { scope: ['constant.language', 'constant.language.boolean'], settings: { foreground: '#c0392b', fontStyle: 'bold' } },
    { scope: ['punctuation', 'punctuation.definition', 'punctuation.separator'], settings: { foreground: '#94a3b8' } },
  ],
};

// Same 21 packages scripts/generate-all-api-docs.ts used to feed the old
// Docusaurus + typedoc-plugin-markdown pipeline — now generated directly
// by starlight-typedoc instead of a bespoke 583-line generator script.
// entryPointStrategy: 'packages' below resolves each entry as a package
// root (must contain package.json); required here because packages mix
// plain TS and JSX (react-stream etc.) with different compiler needs —
// 'packages' mode reads each package's own local tsconfig automatically,
// where 'resolve' mode would force one shared tsconfig on everything and
// break JSX compilation.
const apiEntryPoints = [
  'aimatey', 'aimatey-core', 'aimatey-types', 'aimatey-errors', 'aimatey-utils', 'aimatey-testing',
  'backend', 'frontend', 'middleware', 'http', 'http.core', 'wrapper', 'cli',
  'react-core', 'react-hooks', 'react-stream', 'react-nextjs',
  'native-apple', 'native-node-llamacpp', 'native-model-runner', 'native-onnx', 'native-laya', 'backend-browser',
  'mcp', 'patterns',
].map((pkg) => `../${pkg}`);

// 'packages' entryPointStrategy invokes TypeDoc's PackageJsonReader, which
// bundles each package's README *and* LICENSE as "media" files alongside
// the generated docs — regardless of the `readme: 'none'` option below.
// One package (aimatey-types/readme.md) also links to files in the
// monorepo's separate root-level docs/ folder, which get swept in too.
// None of that media has Starlight frontmatter, so Astro's content schema
// rejects it outright. The old Docusaurus pipeline never hit this because
// it wrote to a plain directory with no schema validation. Fix: after
// Starlight's own config:setup hook finishes generating, sweep the output
// dir and inject minimal frontmatter into anything that's missing it.
function fixTypeDocMediaFrontmatter() {
  return {
    name: 'fix-typedoc-media-frontmatter',
    hooks: {
      'astro:config:setup'({ config }) {
        const refDir = path.join(path.dirname(new URL(import.meta.url).pathname), 'src/content/docs/reference');
        const mediaDir = path.join(refDir, '_media');
        if (!fs.existsSync(mediaDir)) return;
        for (const file of fs.readdirSync(mediaDir)) {
          const full = path.join(mediaDir, file);
          if (!file.endsWith('.md') && !file.endsWith('.mdx')) {
            fs.rmSync(full, { force: true, recursive: true });
            continue;
          }
          const text = fs.readFileSync(full, 'utf8');
          if (!text.startsWith('---')) {
            const title = file.replace(/\.mdx?$/, '');
            fs.writeFileSync(full, `---\ntitle: "${title}"\n---\n\n${text}`);
          }
        }
      },
    },
  };
}

export default defineConfig({
  site: 'https://matey.erisera.com',
  integrations: [
    starlight({
      title: 'aimatey',
      tagline: 'Universal AI Adapter System — write once, run anywhere.',
      logo: {
        src: './src/assets/logo.svg',
      },
      customCss: ['./src/styles/circuit-bridge.css'],
      expressiveCode: {
        themes: [circuitShikiTheme],
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/johnhenry/aimatey' },
      ],
      plugins: [
        starlightTypeDoc({
          entryPoints: apiEntryPoints,
          tsconfig: '../../tsconfig.json',
          // Defaults to 'api' — which collided with and silently overwrote
          // the hand-authored api/*.md pages (curated Bridge/Router/etc.
          // guides), since both would live at src/content/docs/api/.
          // Reference docs get their own directory.
          output: 'reference',
          typeDoc: {
            entryPointStrategy: 'packages',
            readme: 'none',
            excludePrivate: true,
            excludeProtected: true,
            excludeInternal: true,
          },
          sidebar: { label: 'Complete API Reference', collapsed: true },
        }),
      ],
      sidebar: [
        { label: 'Introduction', slug: 'index' },
        {
          label: 'Getting Started',
          items: [
            'getting-started/installation',
            'getting-started/quick-start',
            'getting-started/core-concepts',
            'getting-started/your-first-bridge',
          ],
        },
        {
          label: 'Tutorials',
          items: [
            { label: 'Overview', slug: 'tutorials' },
            {
              label: 'Beginner',
              items: [
                'tutorials/beginner/simple-bridge',
                'tutorials/beginner/using-middleware',
                'tutorials/beginner/multi-provider',
                'tutorials/beginner/building-chat-api',
              ],
            },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'IR Format', slug: 'guides/architecture/ir-format' },
            { label: 'Testing', slug: 'guides/testing' },
          ],
        },
        { label: 'Integration Patterns', slug: 'patterns' },
        {
          label: 'API Reference',
          items: [
            { label: 'Overview', slug: 'api' },
            'api/bridge', 'api/router', 'api/middleware', 'api/types', 'api/errors',
          ],
        },
        {
          label: 'Packages',
          items: [
            { label: 'Overview', slug: 'packages/overview' },
            { label: 'All Packages', slug: 'api/all-packages' },
          ],
        },
        // Per-package generated reference (one page per package, symbol-level
        // detail) — replaces the old custom generate-all-api-docs.ts script's
        // hand-rolled "Packages" sub-tree, which pointed at now-removed
        // pre-generated markdown.
        typeDocSidebarGroup,
        {
          label: 'Contributing',
          items: [
            { label: 'Overview', slug: 'contributing' },
            'contributing/development', 'contributing/architecture',
          ],
        },
      ],
    }),
    fixTypeDocMediaFrontmatter(),
  ],
});
