import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        projects: [
            {
                test: {
                    name: "unit",
                    include: ["src/**/*.test.ts"],
                    environment: "node",
                },
            },
            {
                test: {
                    name: "differential",
                    include: ["test/differential/**/*.test.ts"],
                    environment: "node",
                    // Each case shells out to the just binary.
                    testTimeout: 30_000,
                },
            },
        ],
    },
});
