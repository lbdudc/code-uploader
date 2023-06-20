import { defineConfig } from "vitest/config"

export default defineConfig({
    test: {
        files: ["./src/**/*.test.ts"],
        coverage: {
            provider: "v8",
        }
    }
})