import { describe, expect, it } from "vitest";
import { modelFromSource } from "../model/build.js";
import { OutlineKind, type OutlineSymbol, outline } from "./symbols.js";

const LABELS = { variables: "Variables" };

function outlineOf(source: string): OutlineSymbol[] {
    return outline(modelFromSource(source), LABELS);
}

function named(symbols: readonly OutlineSymbol[], name: string): OutlineSymbol {
    const found = symbols.find((s) => s.name === name);
    if (found === undefined) {
        throw new Error(`no symbol named ${name} in [${symbols.map((s) => s.name).join(", ")}]`);
    }
    return found;
}

/** The text a range actually covers, so assertions can name it. */
function covered(source: string, range: { offset: number; length: number }): string {
    return source.slice(range.offset, range.offset + range.length);
}

describe("variables", () => {
    it("gathers assignments under one heading", () => {
        const symbols = outlineOf('version := "1"\nenvironment := "dev"\n');
        const variables = named(symbols, "Variables");
        expect(variables.kind).toBe(OutlineKind.Namespace);
        expect(variables.children.map((c) => c.name)).toEqual(["version", "environment"]);
        expect(variables.children.every((c) => c.kind === OutlineKind.Variable)).toBe(true);
    });

    it("omits the heading when there are no assignments", () => {
        expect(outlineOf("build:\n    echo hi\n").map((s) => s.name)).toEqual(["build"]);
    });

    it("uses the heading it is given rather than one of its own", () => {
        // The heading is user-facing, so it has to come through vscode.l10n,
        // which this layer cannot import.
        const symbols = outline(modelFromSource('x := "1"\n'), { variables: "Variabelen" });
        expect(symbols.map((s) => s.name)).toEqual(["Variabelen"]);
    });

    it("marks an exported assignment", () => {
        const variables = named(outlineOf('export EDITOR := "vim"\n'), "Variables");
        expect(variables.children[0]?.detail).toBe("export");
    });
});

describe("groups", () => {
    const SOURCE = `[group('Development')]
build:
    echo b

[group('Development')]
dev:
    echo d

[group('Testing')]
test:
    echo t

loose:
    echo l
`;

    it("gathers recipes under the group their attribute names", () => {
        const symbols = outlineOf(SOURCE);
        expect(named(symbols, "Development").children.map((c) => c.name)).toEqual(["build", "dev"]);
        expect(named(symbols, "Testing").children.map((c) => c.name)).toEqual(["test"]);
    });

    it("leaves an ungrouped recipe at the top level", () => {
        // A Justfile with no groups at all is the common case, and burying it
        // under a heading would add a level that says nothing.
        const symbols = outlineOf(SOURCE);
        expect(named(symbols, "loose").kind).toBe(OutlineKind.Function);
    });

    it("puts a recipe under every group it names", () => {
        // just allows more than one `[group]` on a recipe.
        const symbols = outlineOf("[group('a')]\n[group('b')]\nboth:\n    echo hi\n");
        expect(named(symbols, "a").children.map((c) => c.name)).toEqual(["both"]);
        expect(named(symbols, "b").children.map((c) => c.name)).toEqual(["both"]);
    });

    it("keeps a recipe visible when its group name is blank", () => {
        // `[group('')]` is something just accepts. VS Code silently discards a
        // symbol with an empty name — heading and children together — so the
        // recipe would disappear from the outline entirely.
        for (const source of [
            "[group('')]\nfoo:\n    echo hi\n",
            "[group('  ')]\nfoo:\n    echo hi\n",
        ]) {
            const symbols = outlineOf(source);
            expect(symbols.map((s) => s.name)).toEqual(["foo"]);
        }
    });

    it("still groups under the names that are not blank", () => {
        const symbols = outlineOf("[group('')]\n[group('real')]\nfoo:\n    echo hi\n");
        expect(named(symbols, "real").children.map((c) => c.name)).toEqual(["foo"]);
        expect(symbols.map((s) => s.name)).not.toContain("");
    });

    it("covers its children with the heading's range", () => {
        // VS Code reveals the range on click and uses it for breadcrumbs, so a
        // heading that does not contain its children misplaces both.
        const symbols = outlineOf(SOURCE);
        const group = named(symbols, "Development");
        for (const child of group.children) {
            expect(child.range.offset).toBeGreaterThanOrEqual(group.range.offset);
            expect(child.range.offset + child.range.length).toBeLessThanOrEqual(
                group.range.offset + group.range.length,
            );
        }
    });
});

describe("recipes", () => {
    it("shows the parameters as the detail", () => {
        const symbols = outlineOf("build target *flags:\n    echo hi\n");
        expect(named(symbols, "build").detail).toBe("target *flags");
    });

    it("marks a parameter that has a default without inventing its value", () => {
        // just resolves defaults at parse time and the model deliberately does
        // not carry the value, so the elision is the honest rendering.
        const symbols = outlineOf('build target="release":\n    echo hi\n');
        expect(named(symbols, "build").detail).toBe("target=…");
    });

    it("keeps the variadic and export markers", () => {
        const symbols = outlineOf("run $env +rest:\n    echo hi\n");
        expect(named(symbols, "run").detail).toBe("$env +rest");
    });

    it("has no detail when there are no parameters", () => {
        expect(named(outlineOf("build:\n    echo hi\n"), "build").detail).toBe("");
    });

    it("includes private recipes", () => {
        // `just --list` hides these. The outline is for navigating the file in
        // front of you, and a recipe you cannot reach from it is one you cannot
        // find.
        const symbols = outlineOf("_hidden:\n    echo h\n\n[private]\nalso:\n    echo a\n");
        expect(symbols.map((s) => s.name)).toEqual(["_hidden", "also"]);
    });

    it("selects the name and reveals the whole recipe", () => {
        const source = "build target:\n    echo hi\n";
        const build = named(outlineOf(source), "build");
        expect(covered(source, build.selectionRange)).toBe("build");
        expect(covered(source, build.range)).toContain("echo hi");
    });
});

describe("the other items", () => {
    it("shows an alias and what it points at", () => {
        const symbols = outlineOf("build:\n    echo b\n\nalias b := build\n");
        expect(named(symbols, "b").detail).toBe("→ build");
        expect(named(symbols, "b").kind).toBe(OutlineKind.Function);
    });

    it("shows a module and its path", () => {
        const symbols = outlineOf('mod docs "docs/justfile"\n');
        expect(named(symbols, "docs").kind).toBe(OutlineKind.Module);
        expect(named(symbols, "docs").detail).toBe("docs/justfile");
    });

    it("shows a module with no explicit path", () => {
        expect(named(outlineOf("mod sub\n"), "sub").detail).toBe("");
    });

    it("shows an import by its path", () => {
        const symbols = outlineOf('import "other.just"\nfoo:\n    echo hi\n');
        expect(named(symbols, "other.just").kind).toBe(OutlineKind.File);
        expect(named(symbols, "other.just").detail).toBe("");
    });

    it("marks an optional import", () => {
        const symbols = outlineOf('import? "maybe.just"\nfoo:\n    echo hi\n');
        expect(named(symbols, "maybe.just").detail).toBe("optional");
    });

    it("skips an import with no path to name it by", () => {
        const symbols = outlineOf('import ""\nfoo:\n    echo hi\n');
        expect(symbols.map((s) => s.name)).toEqual(["foo"]);
    });

    it("shows settings", () => {
        const symbols = outlineOf('set shell := ["bash"]\nset dotenv-load\n');
        expect(named(symbols, "shell").kind).toBe(OutlineKind.Property);
        expect(symbols.map((s) => s.name)).toContain("dotenv-load");
    });
});

describe("ordering and shape", () => {
    const BUSY = `set shell := ["bash"]
import "shared.just"

version := "1"

[group('Build')]
compile:
    echo c

serve:
    echo s

mod docs "docs/justfile"
alias c := compile
`;

    it("reads in source order", () => {
        // VS Code can re-sort by name if the user asks; it cannot recover
        // position once we have thrown it away.
        const offsets = outlineOf(BUSY).map((s) => s.range.offset);
        expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    });

    it("keeps every selection range inside its own range", () => {
        const check = (symbols: readonly OutlineSymbol[]): void => {
            for (const symbol of symbols) {
                expect(symbol.selectionRange.offset).toBeGreaterThanOrEqual(symbol.range.offset);
                expect(
                    symbol.selectionRange.offset + symbol.selectionRange.length,
                ).toBeLessThanOrEqual(symbol.range.offset + symbol.range.length);
                check(symbol.children);
            }
        };
        check(outlineOf(BUSY));
    });

    it("keeps every range inside the document", () => {
        const check = (symbols: readonly OutlineSymbol[]): void => {
            for (const symbol of symbols) {
                expect(symbol.range.offset).toBeGreaterThanOrEqual(0);
                expect(symbol.range.offset + symbol.range.length).toBeLessThanOrEqual(BUSY.length);
                check(symbol.children);
            }
        };
        check(outlineOf(BUSY));
    });

    it("names everything it returns", () => {
        const check = (symbols: readonly OutlineSymbol[]): void => {
            for (const symbol of symbols) {
                // VS Code drops a symbol with an empty name, silently.
                expect(symbol.name.length).toBeGreaterThan(0);
                check(symbol.children);
            }
        };
        check(outlineOf(BUSY));
    });
});

describe("totality", () => {
    it("returns nothing for an empty document", () => {
        expect(outlineOf("")).toEqual([]);
    });

    it("outlines what it can of a file the parser recovered from", () => {
        const symbols = outlineOf('broken := "oops\n\nbuild:\n    echo hi\n');
        expect(symbols.map((s) => s.name)).toContain("Variables");
    });

    it("never throws, at any truncation of a real file", () => {
        const source = `set shell := ["bash"]
version := "1"
[group('Build')]
build target="release" *flags: fetch
    echo {{ target }}
alias b := build
mod sub "sub/justfile"
`;
        for (let i = 0; i <= source.length; i++) {
            expect(() => outlineOf(source.slice(0, i)), `truncation ${i}`).not.toThrow();
        }
    });

    it("holds its shape at every truncation", () => {
        const source = "[group('g')]\nbuild p=\"q\": dep\n    echo hi\nalias b := build\n";
        for (let i = 0; i <= source.length; i++) {
            const prefix = source.slice(0, i);
            const check = (symbols: readonly OutlineSymbol[]): void => {
                for (const symbol of symbols) {
                    expect(symbol.name.length, `truncation ${i}`).toBeGreaterThan(0);
                    expect(
                        symbol.range.offset + symbol.range.length,
                        `truncation ${i}`,
                    ).toBeLessThanOrEqual(prefix.length);
                    check(symbol.children);
                }
            };
            check(outline(modelFromSource(prefix), LABELS));
        }
    });
});
