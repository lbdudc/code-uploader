/**
 * @file config.js
 * @description Normalizes the deploy configuration every strategy receives, so
 * callers (gispublisher, the QGIS plugin) can keep using either the historical
 * key names or the AWS_* ones without each strategy re-implementing the mapping.
 */

const DEFAULT_SSH_PORT = 22;

/**
 * A remote path is later used in `rm -rf "<path>"/*`, so it must be an
 * absolute path that cannot expand to something dangerous.
 * @param {String} remotePath
 */
export const assertSafeRemotePath = (remotePath) => {
  if (typeof remotePath !== "string" || !remotePath.trim()) {
    throw new Error("remoteRepoPath is required");
  }
  if (!/^\/[A-Za-z0-9._\-/]+$/.test(remotePath)) {
    throw new Error(
      `remoteRepoPath must be an absolute path made of letters, digits, ". _ - /" (got "${remotePath}")`,
    );
  }
  const segments = remotePath.split("/").filter(Boolean);
  if (segments.length < 2 || segments.includes("..")) {
    throw new Error(
      `remoteRepoPath "${remotePath}" is too shallow or contains ".." (use e.g. /home/<user>/app)`,
    );
  }
};

/**
 * @param {Object} config Raw deploy configuration
 * @returns {Object} Configuration with canonical keys
 */
export const normalizeConfig = (config = {}) => {
  const normalized = { ...config };

  normalized.username = config.username ?? config.AWS_USERNAME;
  normalized.certRoute = config.certRoute ?? config.AWS_SSH_PRIVATE_KEY_PATH;
  normalized.remoteRepoPath = config.remoteRepoPath ?? config.REMOTE_REPO_PATH;
  normalized.awsRegion = config.awsRegion ?? config.AWS_REGION;
  normalized.port = Number(config.port) || DEFAULT_SSH_PORT;

  return normalized;
};

/**
 * Validates the fields a remote (ssh/aws) deployment needs.
 * @param {Object} config Normalized configuration
 */
export const assertRemoteConfig = (config) => {
  for (const key of ["host", "username"]) {
    if (!config[key]) throw new Error(`"${key}" is required`);
  }
  assertSafeRemotePath(config.remoteRepoPath);
};
