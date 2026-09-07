import { describe, expect, it } from "vitest";
import { modelFromSource } from "../model/build.js";
import { parse } from "./parser.js";

describe("parser totality", () => {
    it("bounds expression nesting rather than overflowing the stack", () => {
        // Unbounded recursive descent throws RangeError here, which escapes the
        // parser and breaks the promise that parse() returns a Justfile for any
        // input. Depth 5000 was where it overflowed before the bound was added.
        for (const depth of [10, 500, 5_000, 50_000]) {
            const expr = `${"if a == b { ".repeat(depth)}x${" } else { y }".repeat(depth)}`;
            expect(() => parse(`v := ${expr}`), `depth ${depth}`).not.toThrow();
        }
    });

    it("bounds nested calls and groups too", () => {
        const calls = `${"f(".repeat(5_000)}x${")".repeat(5_000)}`;
        expect(() => parse(`v := ${calls}`)).not.toThrow();
        const groups = `${"(".repeat(5_000)}x${")".repeat(5_000)}`;
        expect(() => parse(`v := ${groups}`)).not.toThrow();
    });

    it("still returns a Justfile when an expression is cut short", () => {
        const expr = `${"if a == b { ".repeat(1_000)}x${" } else { y }".repeat(1_000)}`;
        const ast = parse(`v := ${expr}\n\nbuild:\n    echo hi\n`);
        expect(ast.kind).toBe("justfile");
        expect(ast.errors.length).toBeGreaterThan(0);
    });
});

describe("recovery around unterminated strings", () => {
    it("still finds the recipe below an EOF-unterminated string", () => {
        const model = modelFromSource('broken := "oops\n\nbuild:\n    echo hi\n');
        expect(model.recipes.map((r) => r.name)).toEqual(["build"]);
        expect(model.assignments.map((a) => a.name)).toEqual(["broken"]);
    });

    it("treats a genuinely multi-line string as one value, matching just", () => {
        // just parses this as a single assignment whose value contains a
        // newline; there is no recipe here as far as just is concerned either.
        const model = modelFromSource('a := "one\ntwo"\n\nbuild:\n    echo hi\n');
        expect(model.assignments.map((x) => x.name)).toEqual(["a"]);
        expect(model.recipes.map((r) => r.name)).toEqual(["build"]);
    });
});
