import { describe, expect, it } from "vitest";
import { parse } from "../parser/parser.js";
import { FoldingKind, foldingRanges } from "./ranges.js";

/** Every candidate's covered text, alongside its kind when it has one. */
function foldedText(source: string): Array<{ text: string; kind?: FoldingKind }> {
    return foldingRanges(parse(source), source).map(({ range, kind }) => {
        const text = source.slice(range.offset, range.offset + range.length);
        return kind === undefined ? { text } : { text, kind };
    });
}

describe("recipe bodies", () => {
    it("folds the header through the last body line", () => {
        const texts = foldedText("build:\n    echo one\n    echo two\n");
        expect(texts).toContainEqual({ text: "build:\n    echo one\n    echo two" });
    });

    it("offers nothing for a recipe with no body", () => {
        const texts = foldedText("build:\n\nother:\n    echo hi\n");
        expect(texts.map((t) => t.text)).not.toContain("build:");
    });

    it("folds every recipe independently", () => {
        const texts = foldedText("a:\n    echo a\nb:\n    echo b\n").map((t) => t.text);
        expect(texts).toContain("a:\n    echo a");
        expect(texts).toContain("b:\n    echo b");
    });
});

describe("bracketed and parenthesised expressions", () => {
    it("candidates a list literal regardless of whether it spans one line", () => {
        // Whether `[...]` actually spans more than one line needs the
        // document to know, so the pure layer offers it either way — see
        // the module doc comment. The provider is what filters this out.
        const texts = foldedText('x := ["a", "b"]\n').map((t) => t.text);
        expect(texts).toContain('["a", "b"]');
    });

    it("candidates a multi-line list literal", () => {
        const texts = foldedText('x := [\n    "a",\n    "b",\n]\n').map((t) => t.text);
        expect(texts).toContain('[\n    "a",\n    "b",\n]');
    });

    // A group's or a call's own argument list does not yet tolerate a raw
    // newline right after its own opening bracket — that lands separately,
    // in fix/paren-newlines. Putting a nested list immediately after the
    // opening bracket instead, with the newline inside *that* (which
    // already works today), still stretches the group's or call's own span
    // across the same lines, with no newline tolerance of its own needed.

    it("candidates a group whose span is stretched by what is nested inside it", () => {
        const texts = foldedText('x := ([\n    "a"\n])\n').map((t) => t.text);
        expect(texts).toContain('([\n    "a"\n])');
    });

    it("candidates a call whose span is stretched by what is nested inside it", () => {
        const texts = foldedText('x := lowercase([\n    "a"\n])\n').map((t) => t.text);
        expect(texts).toContain('lowercase([\n    "a"\n])');
    });

    it("finds a list nested inside another list", () => {
        const texts = foldedText('x := [\n    ["a"],\n    "b",\n]\n').map((t) => t.text);
        expect(texts).toContain('[\n    ["a"],\n    "b",\n]');
        expect(texts).toContain('["a"]');
    });

    it("finds an expression in a parameter default", () => {
        const source = 'build target=([\n    "release"\n]):\n    echo hi\n';
        const texts = foldedText(source).map((t) => t.text);
        expect(texts).toContain('([\n    "release"\n])');
    });

    it("finds an expression in a body interpolation", () => {
        const source = 'build:\n    echo {{ lowercase(["a"]) }}\n';
        const texts = foldedText(source).map((t) => t.text);
        expect(texts).toContain('["a"]');
    });

    it("finds an expression in a dependency argument", () => {
        const source = 'build:\n    echo hi\nuse: (build ["a"])\n    echo used\n';
        const texts = foldedText(source).map((t) => t.text);
        expect(texts).toContain('["a"]');
    });
});

describe("multi-line strings and backticks", () => {
    it("candidates a triple-quoted string", () => {
        const texts = foldedText('x := """\nhello\nworld\n"""\n').map((t) => t.text);
        expect(texts).toContain('"""\nhello\nworld\n"""');
    });

    it("offers nothing for a string that never closed", () => {
        const texts = foldedText('x := """\nhello\n').map((t) => t.text);
        expect(texts.some((t) => t.includes("hello"))).toBe(false);
    });

    it("candidates a triple-backtick command", () => {
        const texts = foldedText("x := ```\necho one\necho two\n```\n").map((t) => t.text);
        expect(texts).toContain("```\necho one\necho two\n```");
    });

    it("offers nothing for a backtick command that never closed", () => {
        const texts = foldedText("x := ```\necho one\n").map((t) => t.text);
        expect(texts.some((t) => t.includes("echo one"))).toBe(false);
    });
});

describe("comment blocks", () => {
    it("folds a run of consecutive comment lines", () => {
        const source = "# one\n# two\n# three\nbuild:\n    echo hi\n";
        const found = foldedText(source).find((t) => t.kind === FoldingKind.Comment);
        expect(found?.text).toBe("# one\n# two\n# three");
    });

    it("offers nothing for a single comment line", () => {
        const source = "# one\nbuild:\n    echo hi\n";
        expect(foldedText(source).some((t) => t.kind === FoldingKind.Comment)).toBe(false);
    });

    it("breaks the run at a blank line, producing two separate folds", () => {
        const source = "# one\n# two\n\n# three\n# four\nbuild:\n    echo hi\n";
        const comments = foldedText(source)
            .filter((t) => t.kind === FoldingKind.Comment)
            .map((t) => t.text);
        expect(comments).toEqual(["# one\n# two", "# three\n# four"]);
    });

    it("does not read a line starting with # inside a multi-line string as a comment", () => {
        const source = 'x := """\n# not a comment\nstill not one\n"""\n';
        expect(foldedText(source).some((t) => t.kind === FoldingKind.Comment)).toBe(false);
    });
});

describe("totality", () => {
    it("never throws, whatever the input", () => {
        for (const source of ["", "#", "(((((", "[[[[[", '"""', "```", "x := ) ] }"]) {
            expect(() => foldingRanges(parse(source), source)).not.toThrow();
        }
    });
});
