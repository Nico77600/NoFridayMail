'use strict';

/*
 * staticwebapp.config.json served by an environment.
 *
 * Without the MFA step, the repository file is copied as is (byte for byte: existing environments do not change).
 * With bypass.mfa.required, the site ships the managed API (api/ folder): we declare its Node 22 runtime and the
 * /api/* route as anonymous at the Static Web Apps level (authentication is done with the Entra token, validated by
 * the function) and never cached. Existing headers are kept.
 */

function withApi(base) {
  const config = JSON.parse(JSON.stringify(base));
  config.routes = (config.routes || []).filter((r) => r.route !== '/api/*');
  config.routes.push({
    route: '/api/*',
    allowedRoles: ['anonymous'],
    headers: { 'Cache-Control': 'no-store' }
  });
  config.platform = Object.assign({}, config.platform, { apiRuntime: 'node:22' });
  return config;
}

/** Content (Buffer or string) to write for staticwebapp.config.json. */
function staticWebAppConfig(content, withApiRoutes) {
  if (!withApiRoutes) {
    return content;
  }
  return JSON.stringify(withApi(JSON.parse(String(content))), null, 2) + '\n';
}

module.exports = { staticWebAppConfig, withApi };
