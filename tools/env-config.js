'use strict';

/*
 * Per-environment configuration (deploy/environments.local/<name>.json, then deploy/environments/<name>.json).
 *
 *  - loadEnvironment(name)  reads and strictly validates an environment (JSON schema + consistency);
 *  - validateEnvironment()  returns the list of errors (empty = valid);
 *  - validateAll()          validates every file and checks that addinId values and names are unique;
 *  - resolveRules()         rules injected into the bundle (environment JSON, then the BLOCKED_DAYS / WORKING_DAYS
 *                           overrides kept for compatibility; the optional `bypass` object is injected only when
 *                           it is in the file: without it the output is identical to what it was before it
 *                           existed);
 *  - getBuildContext(env)   everything webpack, the manifest and the bundle check need.
 *
 * CLI: node tools/env-config.js <name> [--deploy]   validates one environment (exit code 1 on error);
 *      --deploy also refuses placeholder identifiers (add-in Id, bypass.mfa Entra IDs), see deployErrors().
 */
const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const { parseBlockedDays, parseWorkingDays } = require('./blocked-days');

const root = path.join(__dirname, '..');
const trackedEnvDir = path.join(root, 'deploy', 'environments');
// Operator files (staging, customers...): ignored by git, never published, looked up first.
const localEnvDir = path.join(root, 'deploy', 'environments.local');

/**
 * Environment folders, in priority order: deploy/environments.local (your files, not published) then
 * deploy/environments (prod, example). NFM_ENVIRONMENTS_DIR (read on every call) replaces them with a single folder,
 * so that tests work on fixtures (tests/fixtures/environments) and not on the operator's files.
 */
function environmentsDirs() {
  const override = String(process.env.NFM_ENVIRONMENTS_DIR || '').trim();
  return override ? [path.resolve(override)] : [localEnvDir, trackedEnvDir];
}
const schemaFile = path.join(root, 'deploy', 'environment.schema.json');

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/;

/** Defaults of the `bypass` object (justified exceptional send): same as src/shared/bypass.js. */
const BYPASS_DEFAULTS = { minLength: 20, maxLength: 200, minWords: 3, minDistinctChars: 6 };

/** Placeholder for the Entra identifiers in an environment file that has not been filled in yet. */
const PLACEHOLDER_GUID = '00000000-0000-0000-0000-000000000000';

/**
 * Add-in Ids that are template values, never real ones. An environment keeps ONE add-in Id for its whole life
 * (same Id = Outlook updates the same add-in; a new Id would install a second add-in for every user), so the Id is
 * generated once with tools/New-NoFridayMailEnvironment.ps1 and never at deploy time.
 */
const PLACEHOLDER_ADDIN_IDS = ['11111111-2222-4333-8444-555555555555', PLACEHOLDER_GUID];

/** Complete bypass object (stable key order) built from the one in the file. */
function completeBypass(b) {
  const out = {
    enabled: b.enabled === true,
    minLength: b.minLength === undefined ? BYPASS_DEFAULTS.minLength : b.minLength,
    maxLength: b.maxLength === undefined ? BYPASS_DEFAULTS.maxLength : b.maxLength,
    minWords: b.minWords === undefined ? BYPASS_DEFAULTS.minWords : b.minWords,
    minDistinctChars: b.minDistinctChars === undefined ? BYPASS_DEFAULTS.minDistinctChars : b.minDistinctChars
  };
  // Optional MFA step: keys in a stable order (the bundle check depends on it).
  if (b.mfa && typeof b.mfa === 'object') {
    out.mfa = {
      required: b.mfa.required === true,
      tenantId: b.mfa.tenantId === undefined ? '' : b.mfa.tenantId,
      clientId: b.mfa.clientId === undefined ? '' : b.mfa.clientId,
      authContext: b.mfa.authContext === undefined ? 'c1' : b.mfa.authContext
    };
  }
  return out;
}

/** True when the environment requires the MFA step: the site then ships the API (api/) and MSAL in the task pane. */
function apiEnabled(rules) {
  return !!(rules && rules.bypass && rules.bypass.enabled && rules.bypass.mfa && rules.bypass.mfa.required);
}

/**
 * Errors that do not prevent validation or the build, but FORBID a real deployment: a template add-in Id, or Entra
 * identifiers still at the placeholder value. Returns a list of messages (empty = deployable).
 */
function deployErrors(env) {
  const errors = [];
  if (env && typeof env.addinId === 'string' && PLACEHOLDER_ADDIN_IDS.indexOf(env.addinId.toLowerCase()) !== -1) {
    errors.push(
      `addinId: ${env.addinId} is a placeholder, not a real add-in Id. Each environment needs its own Id, generated ONCE and then kept for good (a new Id would install a second add-in for every user). ` +
        `Generate it with: pwsh tools/New-NoFridayMailEnvironment.ps1 -Name <name> (new environment), or put the output of [guid]::NewGuid() in "addinId" of deploy/environments.local/${env.name}.json.`
    );
  }
  const mfa = env && env.bypass && env.bypass.enabled && env.bypass.mfa;
  if (mfa && mfa.required) {
    const missing = ['tenantId', 'clientId'].filter((k) => String(mfa[k] || '').toLowerCase() === PLACEHOLDER_GUID);
    if (missing.length) {
      errors.push(
        `bypass.mfa.${missing.join(' and bypass.mfa.')}: placeholder value (${PLACEHOLDER_GUID}). ` +
          'Fill in the tenant ID (Entra ID > Overview) and the application (client) ID of the app registration ' +
          `of this environment in its environment file (deploy/environments.local/${env.name}.json, see docs/NoFridayMail-Guide.md, "Fill in mfa"), ` +
          'then run again.'
      );
    }
  }
  return errors;
}

/** Default rules = those of src/shared/config.js without injection. */
const DEFAULT_RULES = {
  blockedDays: [5],
  workingDays: [1, 2, 3, 4, 5],
  sendHour: 8,
  sendMinute: 0,
  slotTimes: ['08:00', '09:00', '10:00', '11:00', '14:00', '16:00'],
  dayCount: 10,
  defaultLanguage: 'fr'
};

let compiled;
function schemaValidator() {
  if (!compiled) {
    const ajv = new Ajv({ allErrors: true, strict: true });
    compiled = ajv.compile(JSON.parse(fs.readFileSync(schemaFile, 'utf8')));
  }
  return compiled;
}

function environmentPath(name) {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw new Error(`Invalid environment name: "${name}" (lowercase letters, digits and hyphens).`);
  }
  const candidates = environmentsDirs().map((dir) => path.join(dir, `${name}.json`));
  // The first existing file wins (the local folder has priority); otherwise the last path is used in the error message.
  return candidates.find((file) => fs.existsSync(file)) || candidates[candidates.length - 1];
}

/** Schema errors (readable messages). */
function schemaErrors(env) {
  const validate = schemaValidator();
  if (validate(env)) {
    return [];
  }
  return validate.errors.map((e) => {
    const where = e.instancePath || '(root)';
    if (e.keyword === 'additionalProperties') {
      return `${where}: unknown property "${e.params.additionalProperty}"`;
    }
    if (e.keyword === 'required') {
      return `${where}: missing required property "${e.params.missingProperty}"`;
    }
    return `${where}: ${e.message}`;
  });
}

/** Consistency rules that the schema alone cannot express. */
function coherenceErrors(env, fileName) {
  const errors = [];
  if (fileName && env.name !== fileName) {
    errors.push(`name ("${env.name}") must equal the file name ("${fileName}")`);
  }
  const r = env.rules;
  if (r && Array.isArray(r.blockedDays) && Array.isArray(r.workingDays)) {
    const proposable = r.workingDays.filter((d) => r.blockedDays.indexOf(d) === -1);
    if (proposable.length === 0) {
      errors.push('rules: at least one working day (workingDays) must not be blocked (blockedDays)');
    }
  }
  if (r && Array.isArray(r.slotTimes)) {
    // The proposed times go through the same parser as the task pane (src/shared/rules.js).
    const rules = require('../src/shared/rules');
    r.slotTimes.forEach((text) => {
      if (!rules.parseSlotTime(text)) {
        errors.push(`rules.slotTimes: invalid time "${text}" (HH:mm)`);
      }
    });
  }
  if (env.bypass && typeof env.bypass === 'object') {
    const b = completeBypass(env.bypass);
    if (b.minLength > b.maxLength) {
      errors.push(`bypass: minLength (${b.minLength}) cannot exceed maxLength (${b.maxLength})`);
    }
  }
  if (env.bypass && env.bypass.mfa && env.bypass.mfa.required === true && env.bypass.enabled !== true) {
    errors.push('bypass.mfa.required requires bypass.enabled: true');
  }
  const m = env.version && /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(env.version);
  if (m) {
    if (m.slice(1).some((p) => Number(p) > 65535)) {
      errors.push('version: each part must be less than or equal to 65535');
    }
    if (Number(m[1]) < 1) {
      errors.push('version: must be at least 1.0.0.0 (the manifest validator rejects 0.x)');
    }
  }
  return errors;
}

function validateEnvironment(env, fileName) {
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    return ['the file must contain a JSON object'];
  }
  const errors = schemaErrors(env);
  // Consistency only makes sense when the structure is correct.
  return errors.length ? errors : coherenceErrors(env, fileName);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Cannot read ${path.relative(root, file)}: ${e.message}`);
  }
}

function listEnvironmentNames() {
  const names = new Set();
  environmentsDirs()
    .filter((dir) => fs.existsSync(dir))
    .forEach((dir) => {
      fs.readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .forEach((f) => names.add(f.slice(0, -5)));
    });
  return Array.from(names).sort();
}

/** Reads an environment, validates it and fails with the complete list of errors. */
function loadEnvironment(name) {
  const file = environmentPath(name);
  if (!fs.existsSync(file)) {
    throw new Error(
      `Environment "${name}" not found (${path.relative(root, file)}). Available: ${listEnvironmentNames().join(', ')}.`
    );
  }
  const env = readJson(file);
  const errors = validateEnvironment(env, name);
  if (errors.length) {
    throw new Error(`Environment "${name}" is invalid:\n - ${errors.join('\n - ')}`);
  }
  // addinId must be unique across all environments (staging and prod must coexist in one tenant).
  const clash = findAddinIdClashes(env.addinId, name);
  if (clash.length) {
    throw new Error(`Environment "${name}" is invalid: ${clashMessage(env.addinId, clash)}`);
  }
  return env;
}

/** Names of the other environments (not `exceptName`) that already use this add-in Id. */
function findAddinIdClashes(addinId, exceptName) {
  return listEnvironmentNames()
    .filter((other) => other !== exceptName)
    .filter((other) => {
      try {
        const o = readJson(environmentPath(other));
        return typeof o.addinId === 'string' && o.addinId.toLowerCase() === String(addinId).toLowerCase();
      } catch (e) {
        return false;
      }
    });
}

function clashMessage(addinId, clash) {
  return (
    `addinId ${addinId} is already used by "${clash.join('", "')}". Two environments must never share an add-in Id. ` +
    'Give the environment that was never deployed a new Id: [guid]::NewGuid() (New-Guid) in its "addinId". ' +
    'Never change the Id of an environment whose add-in users already installed.'
  );
}

/**
 * Uniqueness across environments: addinId (staging and prod must coexist in one tenant) and Static Web Apps
 * resource. `entries` = [{ name, env }].
 */
function uniquenessErrors(entries) {
  const errors = [];
  const seenIds = {};
  const seenApps = {};
  entries.forEach(({ name, env }) => {
    if (typeof env.addinId === 'string') {
      const id = env.addinId.toLowerCase();
      if (seenIds[id]) {
        errors.push(`${name}: addinId is the same as the one of "${seenIds[id]}"`);
      }
      seenIds[id] = name;
    }
    const swa = env.azure && env.azure.staticWebAppName;
    if (swa) {
      const key = `${(env.azure.subscriptionId || '').toLowerCase()}/${env.azure.resourceGroup}/${swa}`;
      if (seenApps[key]) {
        errors.push(`${name}: same Static Web Apps resource as "${seenApps[key]}"`);
      }
      seenApps[key] = name;
    }
  });
  return errors;
}

/** Validates every file and the uniqueness of addinId / staticWebAppName. Returns { errors }. */
function validateAll() {
  const errors = [];
  const entries = [];
  listEnvironmentNames().forEach((name) => {
    let env;
    try {
      env = readJson(environmentPath(name));
    } catch (e) {
      errors.push(e.message);
      return;
    }
    validateEnvironment(env, name).forEach((e) => errors.push(`${name}: ${e}`));
    entries.push({ name, env });
  });
  return { errors: errors.concat(uniquenessErrors(entries)) };
}

/**
 * Rules to inject: defaults, then the environment JSON, then the BLOCKED_DAYS / WORKING_DAYS overrides
 * (historical environment variables, strictly validated).
 */
function resolveRules(env, processEnv) {
  const pe = processEnv || {};
  const rules = JSON.parse(JSON.stringify(DEFAULT_RULES));
  if (env) {
    Object.keys(env.rules).forEach((k) => {
      rules[k] = JSON.parse(JSON.stringify(env.rules[k]));
    });
    rules.defaultLanguage = env.defaultLanguage;
    if (env.bypass) {
      rules.bypass = completeBypass(env.bypass);
    }
  }
  if (String(pe.BLOCKED_DAYS || '').trim() !== '') {
    rules.blockedDays = parseBlockedDays(pe.BLOCKED_DAYS);
  }
  if (String(pe.WORKING_DAYS || '').trim() !== '') {
    rules.workingDays = parseWorkingDays(pe.WORKING_DAYS);
  }
  // BYPASS_ENABLED=true|false: optional override of bypass.enabled (npm run preview uses it to show the
  // exceptional-send section; do not use it for a deployment, prefer the environment file).
  const bypassOverride = String(pe.BYPASS_ENABLED || '').trim().toLowerCase();
  if (bypassOverride !== '') {
    if (bypassOverride !== 'true' && bypassOverride !== 'false') {
      throw new Error('BYPASS_ENABLED is invalid: "true" or "false" expected.');
    }
    rules.bypass = completeBypass(Object.assign({}, rules.bypass, { enabled: bypassOverride === 'true' }));
  }
  // Same guard as for a file: at least one proposable day.
  if (rules.workingDays.filter((d) => rules.blockedDays.indexOf(d) === -1).length === 0) {
    throw new Error('Inconsistent rules: every working day (workingDays) is blocked (blockedDays).');
  }
  return rules;
}

/** Build context from the environment variables (NFM_ENV, ADDIN_BASE_URL, BLOCKED_DAYS...). */
function getBuildContext(processEnv) {
  const pe = processEnv || process.env;
  const envName = String(pe.NFM_ENV || '').trim() || null;
  const env = envName ? loadEnvironment(envName) : null;
  const rules = resolveRules(env, pe);
  const outDir = path.join(root, 'dist', envName || '');
  return {
    root,
    envName,
    env,
    rules,
    outDir: envName ? outDir : path.join(root, 'dist'),
    manifestFile: path.join(envName ? outDir : path.join(root, 'dist'), 'manifest.prod.xml')
  };
}

module.exports = {
  DEFAULT_RULES,
  BYPASS_DEFAULTS,
  PLACEHOLDER_GUID,
  PLACEHOLDER_ADDIN_IDS,
  completeBypass,
  apiEnabled,
  deployErrors,
  NAME_PATTERN,
  environmentPath,
  listEnvironmentNames,
  findAddinIdClashes,
  loadEnvironment,
  validateEnvironment,
  validateAll,
  uniquenessErrors,
  resolveRules,
  getBuildContext
};

if (require.main === module) {
  const name = process.argv[2];
  try {
    if (name && process.argv.includes('--stdin')) {
      // Candidate check without any file: the environment JSON arrives on stdin (used by
      // tools/New-NoFridayMailEnvironment.ps1 before it writes anything).
      const candidate = JSON.parse(fs.readFileSync(0, 'utf8'));
      const errors = validateEnvironment(candidate, name);
      if (!errors.length) {
        const clash = findAddinIdClashes(candidate.addinId, name);
        if (clash.length) {
          errors.push(clashMessage(candidate.addinId, clash));
        }
        errors.push(...deployErrors(candidate));
      }
      if (errors.length) {
        console.error(`Environment "${name}" is invalid:\n - ${errors.join('\n - ')}`);
        process.exit(1);
      }
      console.log(`Environment "${name}" is valid (addinId ${candidate.addinId}, version ${candidate.version}).`);
      return;
    }
    if (!name) {
      const { errors } = validateAll();
      if (errors.length) {
        console.error(`Invalid environments:\n - ${errors.join('\n - ')}`);
        process.exit(1);
      }
      console.log(`Valid environments: ${listEnvironmentNames().join(', ')}`);
    } else {
      const env = loadEnvironment(name);
      if (process.argv.includes('--deploy')) {
        // Checks specific to a real deployment (placeholder identifiers are refused).
        const errors = deployErrors(env);
        if (errors.length) {
          console.error(`Environment "${env.name}" is not deployable:\n - ${errors.join('\n - ')}`);
          process.exit(1);
        }
      }
      console.log(`Environment "${env.name}" is valid (addinId ${env.addinId}, version ${env.version}).`);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
