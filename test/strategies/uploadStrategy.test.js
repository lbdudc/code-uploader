import { describe, test, expect, vi } from "vitest";
import UploadStrategy from "../../src/strategies/UploadStrategy.js";

describe("UploadStrategy.js Tests", () => {

    describe("Instance Methods", () => {

        test("createInstance() throws an error", () => {
            const strategy = new UploadStrategy();

            expect(() => {
                strategy.createInstance();
            }
            ).toThrow();
        });

        test("uploadCode() throws an error", () => {
            const strategy = new UploadStrategy();

            expect(() => {
                strategy.uploadCode();
            }).toThrow();
        });

        test("configureInstance() throws an error", () => {
            const strategy = new UploadStrategy();

            expect(() => {
                strategy.configureInstance();
            }).toThrow();
        });

        test("runDockerComposeUp() throws an error", () => {
            const strategy = new UploadStrategy();

            expect(() => {
                strategy.runDockerComposeUp();
            }).toThrow();
        });

        test("executeCommand() does not throw an error and console logs the correct command", () => {
            const strategy = new UploadStrategy();

            const command = "echo 'Hello World!'";
            const spy = vi.spyOn(console, "log");

            expect(() => {
                strategy.executeCommand(command);
                const expectedConsoleOutput = `Executing command: ${command}`
                expect(spy).toHaveBeenCalledWith(expectedConsoleOutput);
            }).not.toThrow();
        });
    });

});
