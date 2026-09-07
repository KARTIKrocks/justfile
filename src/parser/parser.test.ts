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

    it("survives a long else-if chain without exhausting the stack", () => {
        // `else if` is a flat chain, not nesting. Recursing once per clause
        // overflowed the stack at 20,000 clauses.
        for (const n of [10, 5_000, 50_000]) {
            const chain = `if a == b { x }${" else if c == d { y }".repeat(n)} else { z }`;
            expect(() => parse(`v := ${chain}`), `chain ${n}`).not.toThrow();
        }
    });

    it("does not report a syntax error on a long chain that just accepts", () => {
        // Verified against just 1.58.0: a 300-clause chain is legal. Spending
        // the depth budget per clause would squiggle a file just runs happily.
        const chain = `if a == "1" { "x" }${' else if a == "1" { "y" }'.repeat(300)} else { "z" }`;
        const ast = parse(`a := "1"\nv := ${chain}\n`);
        expect(ast.errors).toEqual([]);
    });

    it("keeps the chain's clauses linked in order", () => {
        const ast = parse('v := if a == "1" { "x" } else if b == "2" { "y" } else { "z" }\n');
        const item = ast.items.find((i) => i.kind === "assignment");
        expect(item?.kind).toBe("assignment");
        let node = item?.kind === "assignment" ? item.value : undefined;
        let clauses = 0;
        while (node?.kind === "conditional") {
            clauses++;
            node = node.alternative;
        }
        expect(clauses).toBe(2);
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

describe("item spans", () => {
    /** The source each item's span actually covers. */
    const covers = (source: string): string[] =>
        parse(source).items.map((item) =>
            source.slice(item.span.offset, item.span.offset + item.span.length),
        );

    it("stops an item before the next one begins", () => {
        // A span built from the next *unconsumed* token swallows that token, so
        // every item covered the first character of its neighbour. Nothing
        // noticed: the dump carries no spans, so the differential suite cannot
        // see this, and it only shows up once a feature uses a range.
        expect(covers("a:\n    echo a\nb:\n    echo b\n")).toEqual([
            "a:\n    echo a\n",
            "b:\n    echo b\n",
        ]);
    });

    it("never lets two items overlap", () => {
        const source = `set shell := ["bash"]
x := "1"

[group('g')]
build target="d": dep
    echo {{ target }}

alias b := build
mod sub
`;
        const items = parse(source).items;
        for (let i = 1; i < items.length; i++) {
            const previous = items[i - 1];
            const current = items[i];
            if (previous === undefined || current === undefined) {
                continue;
            }
            expect(
                current.span.offset,
                `item ${i} starts inside item ${i - 1}`,
            ).toBeGreaterThanOrEqual(previous.span.offset + previous.span.length);
        }
    });

    it("keeps every span inside the document", () => {
        const source = 'x := "1"\nbuild:\n    echo hi\n';
        for (const item of parse(source).items) {
            expect(item.span.offset + item.span.length).toBeLessThanOrEqual(source.length);
        }
    });

    it("covers a one-line item exactly", () => {
        expect(covers('x := "1"\n')).toEqual(['x := "1"\n']);
        expect(covers("set quiet\n")).toEqual(["set quiet\n"]);
        expect(covers("alias b := build\n")).toEqual(["alias b := build\n"]);
    });

    it("holds at every truncation", () => {
        const source = 'x := "1"\nbuild p="q": dep\n    echo {{ p }}\nalias b := build\n';
        for (let i = 0; i <= source.length; i++) {
            const prefix = source.slice(0, i);
            for (const item of parse(prefix).items) {
                expect(item.span.offset, `truncation ${i}`).toBeGreaterThanOrEqual(0);
                expect(item.span.offset + item.span.length, `truncation ${i}`).toBeLessThanOrEqual(
                    prefix.length,
                );
            }
        }
    });

    it("keeps a parameter's span off the colon that ends the signature", () => {
        const source = "build target:\n    echo hi\n";
        const recipe = parse(source).items[0];
        expect(recipe?.kind).toBe("recipe");
        if (recipe?.kind !== "recipe") {
            return;
        }
        const parameter = recipe.parameters[0];
        expect(parameter).toBeDefined();
        if (parameter === undefined) {
            return;
        }
        const text = source.slice(
            parameter.span.offset,
            parameter.span.offset + parameter.span.length,
        );
        expect(text).toBe("target");
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
