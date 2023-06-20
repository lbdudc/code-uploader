import { describe, test, expect, it } from "vitest";
import LocalUploadStrategy from "../../src/strategies/LocalUploadStrategy";
import checkDocker from "../scripts/checkDocker.js"

describe("LocalUploadStrategy.js Tests", () => {

    describe("Instance Methods", () => {

        test("uploadCode() with a not valid route ", async () => {

            const strategy = new LocalUploadStrategy();

            const config = {
                repoPath: "test"
            }

            // expect error to be thrown
            await expect(strategy.uploadCode(config)).rejects.toThrow();
        });

        test("uploadCode() with a valid route but docker is not up", async () => {

            const strategy = new LocalUploadStrategy();

            const config = {
                repoPath: "./test/exampleCode"
            }

            // check if docker is up
            const isDockerUp = await checkDocker();

            // if docker is not up, expect error to be thrown
            if (!isDockerUp) {
                try {
                    await strategy.uploadCode(config);
                } catch (error) {
                    const { code, stderr } = error
                    expect(code).toBe(1);
                    expect(stderr).toContain("docker");
                }

                // if docker is up, expect Hello world container to be running
            } else {
                const { stdout } = await strategy.uploadCode(config);
                expect(stdout).toContain("Hello world");
            }
        });

    });

});