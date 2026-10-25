/** Offline release preflight: detect missing files, malformed TS/TSX and local import paths.
 * A successful result is NOT a replacement for `npm test`, Vite build or browser QA.
 */
const fs = require('node:fs');
const path = require('node:path');
let ts;
try { ts = require('typescript'); }
catch { try { ts = require(path.join(path.dirname(path.dirname(process.execPath)), 'lib/node_modules/typescript')); }
catch { console.error('TypeScript unavailable. Run npm install first.'); process.exit(2); } }
const root = path.resolve(__dirname, '..');
const targets = ['src', 'server', 'scripts'];
const required = ['package.json','index.html','vite.config.ts','src/data/generator.ts','src/data/fixtures.ts','src/data/random.ts','src/engine/config.ts','src/engine/index.ts','src/App.tsx','src/ui/screens/TeamWorkspace.tsx','server/index.ts'];
const missing = [];
for (const p of required) if (!fs.existsSync(path.join(root,p))) missing.push(`required file: ${p}`);
const files = [];
for (const folder of targets) {
  function walk(dir) {
    for (const e of fs.readdirSync(dir, {withFileTypes:true})) {
      if(e.name==='node_modules'||e.name==='dist') continue;
      const full = path.join(dir,e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(tsx?|jsx?|mjs|cjs)$/.test(e.name)) files.push(full);
    }
  }
  walk(path.join(root,folder));
}
const relImport = /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\(|\bimport\s*)['"](\.{1,2}\/[^'"\r\n]+)['"]/g;
let imports = 0, parseErrors = 0;
for (const full of files) {
  const source = fs.readFileSync(full,'utf8');
  if (/\.tsx?$/.test(full)) {
    const sf = ts.createSourceFile(full, source, ts.ScriptTarget.Latest, true, full.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    for (const diag of sf.parseDiagnostics) {
      parseErrors++;
      const pos = sf.getLineAndCharacterOfPosition(diag.start ?? 0);
      missing.push(`syntax ${path.relative(root,full)}:${pos.line+1}: ${ts.flattenDiagnosticMessageText(diag.messageText,' ')}`);
    }
  }
  for (const match of source.matchAll(relImport)) {
    imports++;
    const dest = path.resolve(path.dirname(full),match[1]);
    if (![dest,...['.ts','.tsx','.js','.jsx','.mjs','.cjs','.json','.css','.webp','.png','.svg'].map(x=>dest+x),...['index.ts','index.tsx','index.js'].map(x=>path.join(dest,x))].some(x=>fs.existsSync(x))) {
      missing.push(`import ${path.relative(root,full)} -> ${match[1]}`);
    }
  }
}
if (missing.length) { console.error(`SOURCE PREFLIGHT FAILED (${missing.length} issues):\n${missing.join('\n')}`); process.exit(1); }
console.log(`SOURCE PREFLIGHT PASS: ${required.length} required files, ${files.length} source files, ${imports} local imports, ${parseErrors} syntax errors.`);
console.log('NOTE: Full React/Vite build and browser E2E still require dependency installation and runtime testing.');
