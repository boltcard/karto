import { transformWithOxc, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

// The suite is run at low priority on a machine that is often busy with a build: vitest's 5 seconds turned
// slow runs of the heavier tests (the backup's encryption, onboarding) into failures. A test that hangs still fails.
const testTimeout = 30_000;

// Packages whose web build vitest must transform itself, so that their own `import 'react-native'` reaches
// react-native-web too (Node would otherwise load React Native's Flow sources and fail).
const WEB_INLINE = [/react-native-web/, /react-native-svg/, /react-native-qrcode-svg/];

// React Native packages publish JSX in plain .js files (react-native-qrcode-svg's src): Metro reads it, Vite doesn't.
const jsxInJs: Plugin = {
  name: 'rn-jsx-in-js',
  enforce: 'pre',
  async transform(code, id) {
    if (!/node_modules\/react-native-qrcode-svg\/.*\.js$/.test(id)) return null;
    const out = await transformWithOxc(code, `${id}x`, { jsx: { runtime: 'automatic' } });
    return { code: out.code, map: out.map };
  },
};

export default defineConfig({
  test: {
    projects: [
      {
        // The helpers' tests: plain Node, as before.
        test: { name: 'unit', include: ['src/**/*.test.ts'], environment: 'node', testTimeout },
      },
      {
        // Screen tests: a screen rendered by react-native-web into jsdom, driven by Testing Library;
        // a package's `.web.js` is picked before its plain `.js`, as Expo's web build does.
        plugins: [jsxInJs],
        resolve: {
          // The packages' ES modules, whose `.web.js` files can be picked; their CommonJS builds `require()` past Vite.
          mainFields: ['module', 'main'],
          alias: [{ find: /^react-native$/, replacement: 'react-native-web' }],
          extensions: ['.web.tsx', '.web.ts', '.web.mjs', '.web.js', '.tsx', '.ts', '.mjs', '.js', '.jsx', '.json'],
        },
        define: { __DEV__: 'true' },
        test: {
          name: 'screens',
          include: ['src/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['src/testing/screens/setup.ts'],
          server: { deps: { inline: WEB_INLINE } },
          testTimeout,
        },
      },
    ],
  },
});
