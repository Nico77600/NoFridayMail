'use strict';

const path = require('path');
const webpack = require('webpack');
const { getBuildContext, apiEnabled } = require('./tools/env-config');
const { staticWebAppConfig } = require('./tools/swa-config');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const TerserPlugin = require('terser-webpack-plugin'); // shipped with webpack 5

async function getHttpsOptions() {
  // Local development certificates (office-addin-dev-certs), only for `webpack serve`.
  const devCerts = require('office-addin-dev-certs');
  const httpsOptions = await devCerts.getHttpsServerOptions();
  return { ca: httpsOptions.ca, key: httpsOptions.key, cert: httpsOptions.cert };
}

module.exports = async (env, options) => {
  const dev = options.mode === 'development';
  const serving = !!(env && env.WEBPACK_SERVE);
  // Environment (NFM_ENV), rules and output folder; fails immediately if a value is invalid
  // (see tools/env-config.js).
  const ctx = getBuildContext(process.env);
  // MFA step (bypass.mfa.required): the task pane ships MSAL and the site ships the API; otherwise MSAL is replaced
  // by an empty module (environments without it keep a light task pane and an unchanged site configuration).
  const withApi = apiEnabled(ctx.rules);

  return {
    devtool: dev ? 'source-map' : false,
    entry: {
      // Single classic bundle for the JavaScript-only runtime of classic Outlook for Windows:
      // rules.js and config.js are embedded in it (no import at run time), without chunk splitting.
      launchevent: './src/launchevent/launchevent.js',
      taskpane: './src/taskpane/taskpane.js'
    },
    // ES5 : le runtime JavaScript seul d'Outlook classique n'est pas un navigateur moderne.
    target: ['web', 'es5'],
    output: {
      path: ctx.outDir, // dist/ ou dist/<environnement>/
      filename: '[name].js',
      clean: true
    },
    optimization: {
      splitChunks: false,
      runtimeChunk: false,
      // Pure ASCII output (accents escaped as \uXXXX): independent of the encoding read by the Outlook runtime.
      minimizer: [new TerserPlugin({ extractComments: false, terserOptions: { output: { ascii_only: true } } })]
    },
    resolve: {
      extensions: ['.js'],
      alias: withApi ? {} : { '@azure/msal-browser$': path.join(__dirname, 'src', 'taskpane', 'msal-stub.js') }
    },
    plugins: [
      // Injects all the environment rules into src/shared/config.js (__NFM_RULES__).
      new webpack.DefinePlugin({ __NFM_RULES__: JSON.stringify(ctx.rules) }),
      new HtmlWebpackPlugin({
        filename: 'taskpane.html',
        template: './src/taskpane/taskpane.html',
        chunks: ['taskpane'],
        inject: 'body'
      }),
      new HtmlWebpackPlugin({
        filename: 'commands.html',
        template: './src/commands/commands.html',
        chunks: ['launchevent'],
        // Like the official sample: blocking <script> in <head>, after office.js (no defer).
        inject: 'head',
        scriptLoading: 'blocking'
      }),
      new CopyWebpackPlugin({
        patterns: [
          // Page d'accueil statique : Azure Static Web Apps exige un index.html dans l'artefact.
          { from: 'src/index.html', to: 'index.html' },
          { from: 'assets/*.png', to: 'assets/[name][ext]' },
          {
            from: 'staticwebapp.config.json',
            to: 'staticwebapp.config.json',
            transform: (content) => staticWebAppConfig(content, withApi)
          }
        ]
      })
    ],
    devServer: {
      static: { directory: path.join(__dirname, 'dist') },
      headers: { 'Access-Control-Allow-Origin': '*' },
      server: serving
        ? { type: 'https', options: await getHttpsOptions() }
        : undefined,
      port: 3000
    },
    performance: { hints: false },
    stats: 'minimal'
  };
};
