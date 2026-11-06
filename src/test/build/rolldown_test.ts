import test from 'node:test';
import assert from 'node:assert';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {cssModules, type CssModulesOptions} from '../../index.js';
import {rolldown, type RolldownPlugin} from 'rolldown';

/**
 * Builds `modules` with Rolldown. The modules are written to a temp directory
 * rather than served by @rollup/plugin-virtual, because with
 * `experimental.importAttributes` module ids get an `?attributes=` suffix
 * that plugin-virtual's `load` hook doesn't recognize.
 */
const build = async (
  modules: Record<string, string>,
  {
    options,
    importAttributes = true,
    external,
  }: {
    options?: CssModulesOptions;
    importAttributes?: boolean;
    external?: (id: string) => boolean;
  } = {},
) => {
  const root = await mkdtemp(join(tmpdir(), 'css-modules-rolldown-'));
  try {
    for (const [name, code] of Object.entries(modules)) {
      await writeFile(join(root, name), code);
    }
    const bundle = await rolldown({
      input: join(root, 'index.js'),
      ...(external ? {external} : {}),
      experimental: {importAttributes},
      plugins: [cssModules(options) as RolldownPlugin],
    });
    const {output} = await bundle.generate({format: 'es'});
    return output;
  } finally {
    await rm(root, {recursive: true, force: true});
  }
};

const chunkCode = (output: Awaited<ReturnType<typeof build>>) =>
  output.map((o) => (o.type === 'chunk' ? o.code : '')).join('\n');

test('Rolldown: transforms CSS files imported with the correct attribute', async () => {
  const output = await build({
    'index.js': `
      import styles from './styles.css' with {type: 'css'};
      console.log(styles);
    `,
    'styles.css': `.foo { color: red; }`,
  });
  const code = output[0].code;
  assert(code.includes('new CSSStyleSheet()'));
  assert(code.includes('color: red;'));
  // No import is left (Rolldown's module comments may mention the
  // attributes, so look for an import statement).
  assert(!/\bfrom\s*["']/.test(code), code);
});

test('Rolldown: transforms re-exports and dynamic imports', async () => {
  const output = await build({
    'index.js': `
      export {default as a} from './a.css' with {type: 'css'};
      export const b = () => import('./b.css', {with: {type: 'css'}});
    `,
    'a.css': `.a { color: red; }`,
    'b.css': `.b { color: blue; }`,
  });
  const code = chunkCode(output);
  assert(code.includes('color: red;'));
  assert(code.includes('color: blue;'));
  assert.equal(code.match(/new CSSStyleSheet\(\)/g)?.length, 2);
});

test('Rolldown: leaves type attribute on external imports', async () => {
  const output = await build(
    {
      'index.js': `
        import styles from './styles.css' with {type: 'css'};
        console.log(styles);
      `,
      'styles.css': `.foo { color: red; }`,
    },
    {external: (id) => id.endsWith('.css')},
  );
  const code = output[0].code;
  assert(!code.includes('new CSSStyleSheet()'));
  assert(/with \{ type: ["']css["'] \}/.test(code), code);
});

test('Rolldown: fails on CSS files imported without attributes', async () => {
  await assert.rejects(
    build({
      'index.js': `
        import styles from './styles.css';
        console.log(styles);
      `,
      'styles.css': `.foo { color: red; }`,
    }),
  );
});

test('Rolldown: without experimental.importAttributes, fails with Rolldown’s error', async () => {
  // Rolldown only passes import attributes to plugins with the option, so the
  // plugin can't tell CSS modules apart. It shouldn't crash, though.
  await assert.rejects(
    build(
      {
        'index.js': `
          import styles from './styles.css' with {type: 'css'};
          console.log(styles);
        `,
        'styles.css': `.foo { color: red; }`,
      },
      {importAttributes: false},
    ),
    (e: Error) => !/Cannot read properties of undefined/.test(e.message),
  );
});

test('Rolldown: preserves all escape sequences in the CSS', async () => {
  const output = await build({
    'index.js': `
      import styles from './styles.css' with {type: 'css'};
      console.log(styles);
    `,
    'styles.css': `.foo::before { content: "\\2014 \\2014"; }`,
  });
  assert(output[0].code.includes(String.raw`content: "\\2014 \\2014"`));
});

test('Rolldown: bundledSheet emits a CSS file and imports it', async () => {
  const output = await build(
    {
      'index.js': `
        import stylesA from './a.css' with {type: 'css'};
        import stylesB from './b.css' with {type: 'css'};
        console.log(stylesA, stylesB);
      `,
      'a.css': `.foo { color: red; }`,
      'b.css': `.bar { color: blue; }`,
    },
    {options: {bundledSheet: {fileName: 'bundle.css'}}},
  );

  const cssAsset = output.find(
    (item) => item.type === 'asset' && item.fileName === 'bundle.css',
  );
  assert(cssAsset && cssAsset.type === 'asset');
  const cssSource = cssAsset.source as string;
  // Sheet names come from the file name, without Rolldown's attributes suffix.
  assert(cssSource.includes('@supports sheet("a.css")'), cssSource);
  assert(cssSource.includes('@supports sheet("b.css")'), cssSource);

  const jsChunk = output.find((item) => item.type === 'chunk');
  assert(jsChunk && jsChunk.type === 'chunk');
  assert(
    /from ["']\.\/bundle\.css["'] with \{ type: ["']css["'] \}/.test(
      jsChunk.code,
    ),
    jsChunk.code,
  );
  assert(!jsChunk.code.includes('bundled-css'));
  assert(jsChunk.code.includes('getBundledSheet'));
});
