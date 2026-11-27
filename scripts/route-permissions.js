/* eslint-disable no-console */
/**
 * Prints the route → permission table (what each API route needs from an Agent).
 *   node scripts/route-permissions.js            → markdown table
 * Reads each router's middleware stack; `can()` / `roleGuard.org()` label themselves.
 */
const path = require('path');
process.chdir(path.resolve(__dirname, '..'));
process.env.SAAS_MODE = 'true';
const MOUNTS = require('fs').readFileSync('src/routes/index.js', 'utf8')
  .split('\n').map((l) => l.match(/router\.use\('([^']+)',\s*require\('\.\/([A-Za-z]+)'\)/)).filter(Boolean).map((m) => [m[1], m[2]]);

function describe(layers) {
  const parts = [];
  if (!layers.some((l) => l.name === 'authenticate')) return ['public (no login; secured by token/signature)'];
  for (const l of layers) {
    if (l.permissionKeys) parts.push(`${l.mode === 'any' ? 'any of' : 'needs'} ${l.permissionKeys.join(' + ')}`);
    else if (l.orgRoles) parts.push(`${l.orgRoles.join('/')} only${l.writesOnly ? ' (writes)' : ''}`);
  }
  return parts;
}

function collect() {
  const rows = [];
  for (const [mount, file] of MOUNTS) {
    let router;
    try { router = require(`../src/routes/${file}`); } catch { continue; }
    const routerGuards = [];
    for (const layer of router.stack || []) {
      if (layer.route) {
        const handlers = layer.route.stack.map((s) => s.handle);
        for (const method of Object.keys(layer.route.methods)) {
          rows.push({ method: method.toUpperCase(), url: `/api${mount}${layer.route.path === '/' ? '' : layer.route.path}`, guards: describe([...routerGuards, ...handlers]) });
        }
      } else if (layer.handle && (layer.handle.permissionKeys || layer.handle.orgRoles || layer.handle.name === 'authenticate')) {
        routerGuards.push(layer.handle);
      }
    }
  }
  return rows;
}

if (require.main === module) {
  const rows = collect();
  console.log('| Method | Route | Agent access |\n|---|---|---|');
  for (const r of rows) console.log(`| ${r.method} | \`${r.url}\` | ${r.guards.length ? r.guards.join('; ') : 'any logged-in agent (data scoped to their assigned leads)'} |`);
}
module.exports = { collect };
