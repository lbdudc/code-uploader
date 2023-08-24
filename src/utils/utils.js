import { spawn } from 'child_process';
import path from 'path';

export const getAbsolutePath = (folderPath) => {
    if (path.isAbsolute(folderPath))
        return folderPath;

    return path.join(process.cwd(), folderPath);
};

/**
 * Executes a command in the shell
 * @param {String} command Command to execute
 * @param {Number} timeout Timeout in milliseconds (optional)
 * @returns {Promise<void>}
 */
export const executeCommand = async (command, timeout) => {
    console.log(`Executing command: ${command}`);

    return new Promise((resolve, reject) => {
        const childProcess = spawn(command, {
            shell: true,
            stdio: ['inherit', 'pipe', 'pipe'], // Inherit stdin, pipe stdout and stderr
        });

        let stdoutData = '';
        let stderrData = '';

        childProcess.stdout.on('data', (data) => {
            stdoutData += data;
            console.log(data.toString()); // Output stdout in real-time
        });

        childProcess.stderr.on('data', (data) => {
            stderrData += data;
            console.error(data.toString()); // Output stderr in real-time
        });

        childProcess.on('error', (error) => {
            reject(error);
        });

        childProcess.on('close', (code) => {
            if (code !== 0) {
                reject({
                    code: code,
                    stderr: stderrData,
                    stdout: stdoutData
                });
                return;
            }

            resolve({
                stdout: stdoutData,
                stderr: stderrData,
                code: code,
            });
        });

        if (timeout) {
            setTimeout(() => {
                resolve({
                    stdout: stdoutData,
                    stderr: stderrData,
                    code: null, // Indicate timeout with a null code
                });
            }, timeout);
        }
    });
};
