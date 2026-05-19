// Minimal site + credential loader for the GH Actions runner.
// Adapted from the engine's load-config.js but trimmed to ONLY what
// backfill-context-links.js needs.
//
// Site list = sites.json + external-sites.json (committed to this repo;
// they contain only domain metadata, NO passwords).
//
// Credentials come from environment variables (set as GitHub Actions Secrets):
//   WP_USERNAME       — shared username used on every site
//   WP_APP_PASSWORD   — shared password for engine sites
//   WP_PASSWORDS_JSON — JSON object of per-site passwords for external sites
//                       e.g. {"site1.com":"xxxx xxxx ...","site2.com":"yyyy ..."}

const fs = require('fs');
const path = require('path');
require('dotenv').config();

const RUNNER_ROOT = path.join(__dirname, '..', '..');

function readJsonOrEmptyArray(file) {
    if (!fs.existsSync(file)) return [];
    try {
        const v = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(v) ? v : [];
    } catch (e) {
        console.error('Failed to parse ' + file + ': ' + e.message);
        return [];
    }
}

function parseEnvJsonArray(envVarName) {
    const raw = process.env[envVarName];
    if (!raw) return null;
    try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? v : null;
    } catch (e) {
        console.error(envVarName + ' is set but not valid JSON array: ' + e.message);
        return null;
    }
}

// Sites can come from env var (GH Actions, preferred when set) OR a local file
// (dev machine fallback). Env wins so production stays decoupled from disk.
function loadSites() {
    const fromEnv = parseEnvJsonArray('SITES_JSON');
    if (fromEnv) return fromEnv;
    return readJsonOrEmptyArray(path.join(RUNNER_ROOT, 'sites.json'));
}

function loadExternalSites() {
    const fromEnv = parseEnvJsonArray('EXTERNAL_SITES_JSON');
    const arr = fromEnv || readJsonOrEmptyArray(path.join(RUNNER_ROOT, 'external-sites.json'));
    return arr.map(s => ({ ...s, _external: true }));
}

function loadAllSites() {
    return [...loadSites(), ...loadExternalSites()];
}

let _passwordsCache = null;
function loadPasswordsMap() {
    if (_passwordsCache !== null) return _passwordsCache;
    if (process.env.WP_PASSWORDS_JSON) {
        try {
            _passwordsCache = JSON.parse(process.env.WP_PASSWORDS_JSON);
            return _passwordsCache;
        } catch (e) {
            console.warn('WP_PASSWORDS_JSON env present but invalid JSON; ignoring');
        }
    }
    _passwordsCache = {};
    return _passwordsCache;
}

function getCredentialsForSite(siteOrDomain) {
    const username = process.env.WP_USERNAME;
    const sharedPassword = process.env.WP_APP_PASSWORD;
    if (!username) throw new Error('WP_USERNAME env var is required');
    const domain = typeof siteOrDomain === 'string' ? siteOrDomain : (siteOrDomain && siteOrDomain.domain);
    const passwords = loadPasswordsMap();
    if (domain && passwords[domain.toLowerCase()]) {
        return { username, appPassword: passwords[domain.toLowerCase()] };
    }
    if (!sharedPassword) {
        throw new Error('No per-site password and WP_APP_PASSWORD not set for ' + (domain || 'unknown'));
    }
    return { username, appPassword: sharedPassword };
}

function siteUrl(site) {
    return 'https://' + site.domain;
}

module.exports = { RUNNER_ROOT, loadSites, loadExternalSites, loadAllSites, getCredentialsForSite, siteUrl };
