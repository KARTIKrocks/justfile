/**
 * Differential test harness.
 *
 * Parses a fixture with our parser and with `just --dump --dump-format json`,
 * reduces both to the same comparable shape, and reports any disagreement.
 * When the two disagree, `just` is right. See AGENTS.md.
 *
 * This is test-only code and therefore Tier 2 by definition: it spawns `just`.
 * The fixtures are files we control. Note that just evaluates backticks and
 * `shell()` at parse time, so a fixture containing either would execute during
 * the test run — fixtures must stay free of side effects.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { modelFromSource } from "../../src/model/build.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(HERE, "fixtures");

/** The shape both sides are reduced to. Structure only — never evaluated values. */
export interface ComparableRecipe {
    readonly name: string;
    readonly parameters: ReadonlyArray<{ name: string; kind: string; export: boolean }>;
    /** Prior dependencies followed by `&&` subsequents, matching the dump's order. */
    readonly dependencies: ReadonlyArray<{ recipe: string; argumentCount: number }>;
    readonly priors: number;
    readonly attributes: readonly string[];
    readonly doc: string | null;
    readonly quiet: boolean;
    readonly shebang: boolean;
    readonly private: boolean;
}

export interface ComparableAssignment {
    readonly name: string;
    readonly export: boolean;
    /** Omitted when the installed `just` does not report it. See DumpCapabilities. */
    readonly private?: boolean;
}

export interface Comparable {
    readonly recipes: readonly ComparableRecipe[];
    readonly assignments: readonly ComparableAssignment[];
    readonly aliases: ReadonlyArray<{ name: string; target: string }>;
    readonly first: string | null;
}

// ---------------------------------------------------------------------------
// The just CLI
// ---------------------------------------------------------------------------

export function justBinary(): string {
    return process.env["JUST_BINARY"] ?? "just";
}

export function justVersion(): string {
    const output = execFileSync(justBinary(), ["--version"], { encoding: "utf8" });
    return output.trim().replace(/^just\s+/, "");
}

/** Compare dotted versions numerically. Returns true when `a` >= `b`. */
export function versionAtLeast(a: string, b: string): boolean {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] ?? 0;
        const y = pb[i] ?? 0;
        if (x !== y) {
            return x > y;
        }
    }
    return true;
}

/**
 * What the installed `just` actually reports, so the comparison never asserts
 * something the CLI never said.
 *
 * Coercing a missing field to a default is the subtle way a differential test
 * stops being differential: it turns "just is silent about this" into "just
 * says false", and then fails our parser for disagreeing with a value that was
 * never there.
 */
export interface DumpCapabilities {
    /**
     * `private` on assignments. Absent before 1.35.0 — established by bisecting
     * the real binaries, not from the changelog, which documents only the
     * `[private]` attribute and not the underscore convention.
     */
    readonly assignmentPrivate: boolean;
}

export function capabilitiesFor(version: string): DumpCapabilities {
    return { assignmentPrivate: versionAtLeast(version, "1.35.0") };
}

export interface DumpResult {
    readonly ok: boolean;
    readonly json?: unknown;
    readonly stderr?: string;
}

export function dumpWithJust(file: string): DumpResult {
    try {
        const stdout = execFileSync(
            justBinary(),
            [
                "--justfile",
                file,
                "--working-directory",
                dirname(file),
                "--dump",
                "--dump-format",
                "json",
            ],
            { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] },
        );
        return { ok: true, json: JSON.parse(stdout) };
    } catch (error) {
        const stderr =
            error instanceof Error && "stderr" in error
                ? String((error as { stderr?: unknown }).stderr ?? error.message)
                : String(error);
        return { ok: false, stderr };
    }
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Render one dump attribute as `name` or `name(arg,arg)`.
 *
 * The dump emits a bare string for an attribute with no arguments and a
 * single-key object otherwise, with the value either a string or an array.
 */
function attributeToString(entry: unknown): string {
    if (typeof entry === "string") {
        return entry;
    }
    const record = asRecord(entry);
    const name = Object.keys(record)[0];
    if (name === undefined) {
        return "";
    }
    const value = record[name];
    if (value === null || value === undefined) {
        return name;
    }
    const args = Array.isArray(value) ? value.map(String) : [String(value)];
    return `${name}(${args.join(",")})`;
}

export function comparableFromDump(dump: unknown, caps: DumpCapabilities): Comparable {
    const root = asRecord(dump);
    const recipesRecord = asRecord(root["recipes"]);

    const recipes = Object.values(recipesRecord)
        .map((raw): ComparableRecipe => {
            const r = asRecord(raw);
            const parameters = (Array.isArray(r["parameters"]) ? r["parameters"] : []).map((p) => {
                const param = asRecord(p);
                return {
                    name: String(param["name"] ?? ""),
                    kind: String(param["kind"] ?? "singular"),
                    export: param["export"] === true,
                };
            });
            const dependencies = (Array.isArray(r["dependencies"]) ? r["dependencies"] : []).map(
                (d) => {
                    const dep = asRecord(d);
                    const args = dep["arguments"];
                    return {
                        recipe: String(dep["recipe"] ?? ""),
                        argumentCount: Array.isArray(args) ? args.length : 0,
                    };
                },
            );
            const attributes = (Array.isArray(r["attributes"]) ? r["attributes"] : [])
                .map(attributeToString)
                .sort();
            return {
                name: String(r["name"] ?? ""),
                parameters,
                dependencies,
                priors: typeof r["priors"] === "number" ? r["priors"] : 0,
                attributes,
                doc: typeof r["doc"] === "string" ? r["doc"] : null,
                quiet: r["quiet"] === true,
                shebang: r["shebang"] === true,
                private: r["private"] === true,
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

    const assignments = Object.values(asRecord(root["assignments"]))
        .map((raw): ComparableAssignment => {
            const a = asRecord(raw);
            return {
                name: String(a["name"] ?? ""),
                export: a["export"] === true,
                ...(caps.assignmentPrivate ? { private: a["private"] === true } : {}),
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

    const aliases = Object.values(asRecord(root["aliases"]))
        .map((raw) => {
            const a = asRecord(raw);
            return { name: String(a["name"] ?? ""), target: String(a["target"] ?? "") };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

    return {
        recipes,
        assignments,
        aliases,
        first: typeof root["first"] === "string" ? root["first"] : null,
    };
}

export function comparableFromParser(source: string, caps: DumpCapabilities): Comparable {
    const model = modelFromSource(source);

    const recipes = model.recipes
        .map((recipe): ComparableRecipe => {
            const attributes = recipe.attributes
                .map((a) => (a.args.length === 0 ? a.name : `${a.name}(${a.args.join(",")})`))
                .sort();
            return {
                name: recipe.name,
                parameters: recipe.parameters.map((p) => ({
                    name: p.name,
                    kind: p.kind,
                    export: p.export,
                })),
                // The dump concatenates priors and subsequents into one list.
                dependencies: [...recipe.dependencies, ...recipe.subsequents].map((d) => ({
                    recipe: d.recipe,
                    argumentCount: d.argumentCount,
                })),
                priors: recipe.dependencies.length,
                attributes,
                doc: recipe.doc ?? null,
                quiet: recipe.quiet,
                shebang: recipe.shebang,
                private: recipe.private,
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

    const assignments = model.assignments
        .map(
            (a): ComparableAssignment => ({
                name: a.name,
                export: a.export,
                ...(caps.assignmentPrivate ? { private: a.private } : {}),
            }),
        )
        .sort((a, b) => a.name.localeCompare(b.name));

    const aliases = model.aliases
        .map((a) => ({ name: a.name, target: a.target }))
        .sort((a, b) => a.name.localeCompare(b.name));

    return { recipes, assignments, aliases, first: model.first ?? null };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export interface Fixture {
    readonly name: string;
    readonly path: string;
    readonly source: string;
    /** From a `# requires: X.Y.Z` header, so old binaries skip rather than fail. */
    readonly requires?: string;
}

export function loadFixtures(): Fixture[] {
    return readdirSync(FIXTURES_DIR)
        .filter((name) => name.endsWith(".just"))
        .sort()
        .map((name) => {
            const path = join(FIXTURES_DIR, name);
            const source = readFileSync(path, "utf8");
            const requires = /^#\s*requires:\s*([0-9.]+)\s*$/m.exec(source)?.[1];
            const base = { name, path, source } as const;
            return requires === undefined ? base : { ...base, requires };
        });
}
