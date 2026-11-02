// SILA — dependency-free bundler: inlines the ES modules and stylesheets under src/ into single HTML files.
// Usage: node build.js                      → dist/index.html (the app) and dist/tests.html (the test page)
//        node build.js <entry.html> <out>   → one custom build
// Supports the module syntax this codebase uses: `import { a, b as c } from './x.js'`, `import * as X from './x.js'`,
// and `export function|async function|const|let|class name`. Anything else fails the build loudly.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, 'src');

const IMPORT_NAMED = /^import\s*\{([\s\S]*?)\}\s*from\s*['"](\.{1,2}\/[^'"]+)['"];?[ \t]*$/gm;
const IMPORT_STAR = /^import\s*\*\s*as\s+([\w$]+)\s+from\s*['"](\.{1,2}\/[^'"]+)['"];?[ \t]*$/gm;
const IMPORT_BARE = /^import\s*['"](\.{1,2}\/[^'"]+)['"];?[ \t]*$/gm;
const EXPORT_DECL = /^export\s+(async\s+function\*?|function\*?|const|let|var|class)\s+([\w$]+)/gm;
const SCRIPT = /<script type="module">([\s\S]*?)<\/script>/g;
const STYLESHEET = /<link\s+rel="stylesheet"\s+href="(\.{1,2}\/[^"]+)"\s*\/?>/g;

const key = (file) => relative(src, file).split('\\').join('/');

export function build(entry, out) {
  const modules = new Map(); // key → transformed code; insertion order = dependency order

  const rewriteImports = (code, fromDir, onDep) => {
    const ref = (spec) => {
      const file = resolve(fromDir, spec);
      if (!existsSync(file)) throw new Error(`Cannot resolve ${spec} from ${fromDir}`);
      onDep(file);
      return `__sila_modules[${JSON.stringify(key(file))}]`;
    };
    return code
      .replace(IMPORT_NAMED, (_, names, spec) => {
        const fields = names.split(',').map((n) => n.trim()).filter(Boolean).map((n) => n.replace(/^([\w$]+)\s+as\s+([\w$]+)$/, '$1: $2'));
        return `const { ${fields.join(', ')} } = ${ref(spec)};`;
      })
      .replace(IMPORT_STAR, (_, name, spec) => `const ${name} = ${ref(spec)};`)
      .replace(IMPORT_BARE, (_, spec) => { ref(spec); return ''; });
  };

  const addModule = (file) => {
    const k = key(file);
    if (modules.has(k)) return;
    modules.set(k, null); // in progress
    const deps = [];
    let code = rewriteImports(readFileSync(file, 'utf8'), dirname(file), (dep) => deps.push(dep));
    for (const dep of deps) {
      if (modules.get(key(dep)) === null && key(dep) !== k) throw new Error(`Circular import between ${k} and ${key(dep)}`);
      addModule(dep);
    }
    const names = [];
    code = code.replace(EXPORT_DECL, (_, kind, name) => { names.push(name); return `${kind} ${name}`; });
    const leftover = code.match(/^\s*(import|export)\b.*$/m);
    if (leftover) throw new Error(`${k}: unsupported module syntax: ${leftover[0].trim()}`);
    modules.delete(k); // re-insert after its dependencies
    modules.set(k, `// ---- ${k} ----\n__sila_modules[${JSON.stringify(k)}] = (() => {\n${code}\nreturn { ${names.join(', ')} };\n})();\n`);
  };

  let html = readFileSync(entry, 'utf8');
  const scripts = [...html.matchAll(SCRIPT)];
  if (!scripts.length) throw new Error(`${relative(root, entry)} has no inline <script type="module">`);
  const entryBodies = scripts.map(([, body]) => rewriteImports(body, dirname(entry), addModule));
  // The test page scans engine sources for message codes; embed them so the bundled file:// build can too.
  const sources = /tests\.html$/.test(entry)
    ? `globalThis.__SILA_SOURCES = ${JSON.stringify(Object.fromEntries(['data.js', 'messages.js', 'permissions.js', 'readiness.js', 'actions.js', 'selectors.js', 'store.js', 'vitals.js',
      ...readdirSync(join(src, 'ui')).filter((f) => f.endsWith('.js')).map((f) => `ui/${f}`)]
      .map((f) => [f, readFileSync(join(src, f), 'utf8')])))};\n` : '';
  const bundle = `const __sila_modules = Object.create(null);\n${sources}${[...modules.values()].join('\n')}\nglobalThis.SILA = __sila_modules;\n`;

  let first = true;
  html = html.replace(SCRIPT, () => {
    const body = entryBodies.shift();
    const content = first ? `${bundle}\n// ---- entry ----\n${body}` : body;
    first = false;
    return `<script type="module">\n${content.replace(/<\/script/gi, '<\\/script')}\n</script>`;
  });
  const styles = [];
  html = html.replace(STYLESHEET, (_, href) => {
    const file = resolve(dirname(entry), href);
    styles.push(key(file));
    return `<style>\n${readFileSync(file, 'utf8').replace(/<\/style/gi, '<\\/style')}\n</style>`;
  });
  html = html.replace(/<html([^>]*)>/, `<html$1>\n<!-- Built by build.js from ${relative(root, entry)} on ${new Date().toISOString()} — do not edit; edit src/ and rebuild. -->`);

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  console.log(`Built ${relative(root, out)} (${(html.length / 1024).toFixed(1)} KB) from ${relative(root, entry)}: ${modules.size} modules${styles.length ? `, styles ${styles.join(', ')}` : ''}`);
}

const [entryArg, outArg] = process.argv.slice(2);
if (entryArg) {
  build(resolve(entryArg), resolve(outArg ?? join(root, 'dist', 'index.html')));
} else {
  build(join(src, 'index.html'), join(root, 'dist', 'index.html'));
  build(join(src, 'tests.html'), join(root, 'dist', 'tests.html'));
}
