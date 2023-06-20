
import { executeCommand } from '../../src/utils/utils';

/**
 * Returns true if docker is installed, false otherwise
 */
const checkDocher = async () => {

    let dockerRunning = false;
    try {
        await executeCommand("docker ps");
        dockerRunning = true;
    } catch (error) {
        dockerRunning = false;
    }

    return dockerRunning;

}

export default checkDocher;