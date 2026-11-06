import {cssModules} from './index.js';

export default {
  input: 'test/browser/test-js-module.js',
  output: {
    file: 'test/browser/test-js-module-rolldown-bundle.js',
    format: 'esm',
    sourcemap: true,
  },
  // Rolldown only passes import attributes to plugins with this option.
  experimental: {
    importAttributes: true,
  },
  plugins: [
    cssModules(),
  ],
};
