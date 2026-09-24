import RemoteStrategy from "./RemoteStrategy.js";

/**
 * Deploys to any Debian/Ubuntu (or RPM based) server reachable over ssh.
 * Docker is installed on first use; later deployments skip that step.
 */
class DebianUploadStrategy extends RemoteStrategy {}

export default DebianUploadStrategy;
