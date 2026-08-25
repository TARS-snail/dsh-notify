/**
 * Wraps the compiled client half into the `window.__ModuleLoader__` bundle
 * format the web shell expects (lazy CJS factory), and emits an identity
 * source map so browser devtools can show the TypeScript source.
 *
 * The client half must stay import-free: its factory receives `require` for
 * graph-internal packages only, and the harness's build-time purity gate
 * rejects unresolvable requests. This script fails loudly if the compiled
 * body contains any `require(` call.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const PACKAGE_NAME = 'dsh-notify'
const BODY_FILE = 'lib/.client-cjs/index.js'
const DECLARATION_FILE = 'lib/.client-cjs/index.d.ts'
const SOURCE_FILE = 'src/client/index.ts'
const OUT_BUNDLE = 'lib/client.js'
const OUT_DECLARATION = 'lib/client.d.ts'
const OUT_MAP = 'lib/client.js.map'

const body = readFileSync(BODY_FILE, 'utf8')
if (/require\(/.test(body)) {
  throw new Error('client half must stay import-free — the compiled bundle contains a require() call')
}

const declaration = readFileSync(DECLARATION_FILE, 'utf8')
const sourcesContent = readFileSync(SOURCE_FILE, 'utf8')

// Identity map: valid JSON source map with empty mappings; devtools fall back
// to sourcesContent for display.
const map = {
  version: 3,
  file: 'client.js',
  sources: ['src/client/index.ts'],
  sourcesContent: [sourcesContent],
  names: [],
  mappings: '',
}

const bundle = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(PACKAGE_NAME)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${body.trimEnd()}
\t\treturn module.exports;
\t}
});
//# sourceMappingURL=client.js.map
`

mkdirSync('lib', { recursive: true })
writeFileSync(OUT_BUNDLE, bundle)
writeFileSync(OUT_DECLARATION, declaration)
writeFileSync(OUT_MAP, JSON.stringify(map))
console.log(`[build-client] wrote ${OUT_BUNDLE} (${bundle.length} bytes) + source map + types`)
