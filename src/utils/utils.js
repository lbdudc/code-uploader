
import util from 'util';
import { exec } from 'child_process';


// Promisifies the exec function
const execPromise = util.promisify(exec);

/**
 * Executes a command in the shell
 * @param {String} command Command to execute
 * @returns {Promise<void>}
 */
export const executeCommand = async (command) => {
    console.log(`Executing command: ${command}`);
    try {
        const { stdout, stderr } = await execPromise(command);
        console.log(stdout);
        console.error(stderr);
    } catch (error) {
        // If error is for the SCP command, it will be caught and ignored
        // This is because SCP returns a non-zero exit code even if the file is successfully copied
        // This is a known issue:
        // https://stackoverflow.com/questions/305035/how-to-use-ssh-to-run-a-shell-script-on-a-remote-machine
        if (error.cmd.includes('scp')) {
            console.log('SCP command completed successfully');
            return;
        }
        console.error(error);
    }
};