/**
 * The document outline, derived from the semantic model.
 *
 * Tier 1: no VS Code API, no I/O, no subprocesses. See AGENTS.md. The provider
 * layer turns this into `vscode.DocumentSymbol`; keeping the shape decisions
 * here means they are testable in plain Node.
 *
 * The layout follows PRD 8.10: assignments gathered under one heading, and
 * recipes gathered under the groups their `[group('...')]` attributes name.
 *
 * Ranges are byte offsets rather than line/column pairs. A span records where
 * a construct starts and how long it is, and turning an end offset back into a
 * position needs the document — which the provider has and this does not.
 */

import type { JustfileModel, ModelParameter, ModelRecipe } from "../model/justfile.js";
import type { Span } from "../parser/token.js";

/**
 * Symbol kinds, named for the `vscode.SymbolKind` members they map to.
 *
 * A frozen object plus a derived union rather than an enum: `erasableSyntaxOnly`
 * forbids enums, and this keeps the values readable in a test failure.
 */
export const OutlineKind = {
    Namespace: "namespace",
    File: "file",
    Variable: "variable",
    Function: "function",
    Module: "module",
    Property: "property",
} as const;

export type OutlineKind = (typeof OutlineKind)[keyof typeof OutlineKind];

/** A half-open byte range into the document. */
export interface OffsetRange {
    readonly offset: number;
    readonly length: number;
}

export interface OutlineSymbol {
    readonly name: string;
    /** Shown beside the name in muted text. Empty when there is nothing to add. */
    readonly detail: string;
    readonly kind: OutlineKind;
    /** The whole construct, which is what gets revealed on click. */
    readonly range: OffsetRange;
    /** Just the name, which is what gets selected. */
    readonly selectionRange: OffsetRange;
    readonly children: readonly OutlineSymbol[];
}

/**
 * Headings this layer invents rather than reads out of the file.
 *
 * Passed in because they are user-facing and must go through `vscode.l10n`,
 * which Tier 1 cannot import. Group names come from the Justfile itself and are
 * never translated.
 */
export interface OutlineLabels {
    readonly variables: string;
}

function rangeOf(span: Span): OffsetRange {
    return { offset: span.offset, length: span.length };
}

/** The smallest range covering every one of these, for a synthetic heading. */
function spanning(ranges: readonly OffsetRange[]): OffsetRange {
    let start = Number.POSITIVE_INFINITY;
    let end = 0;
    for (const range of ranges) {
        start = Math.min(start, range.offset);
        end = Math.max(end, range.offset + range.length);
    }
    if (!Number.isFinite(start)) {
        return { offset: 0, length: 0 };
    }
    return { offset: start, length: end - start };
}

/**
 * One parameter as it reads in a signature.
 *
 * The default's *value* is deliberately not in the model — just resolves those
 * at parse time and we do not — so a default shows as `=…`. Saying a parameter
 * is optional is worth more here than saying what it falls back to.
 */
function renderParameter(parameter: ModelParameter): string {
    const variadic = parameter.kind === "plus" ? "+" : parameter.kind === "star" ? "*" : "";
    const exported = parameter.export ? "$" : "";
    const fallback = parameter.hasDefault ? "=…" : "";
    return `${variadic}${exported}${parameter.name}${fallback}`;
}

function signatureOf(recipe: ModelRecipe): string {
    return recipe.parameters.map(renderParameter).join(" ");
}

/**
 * The groups a recipe belongs to. just allows more than one.
 *
 * A blank name is dropped rather than made into a heading. `[group('')]` is
 * something just accepts, and VS Code silently discards a symbol with an empty
 * name — heading and recipes together — so the recipe would simply vanish from
 * the outline. Treating it as ungrouped keeps it reachable, which is the whole
 * point of an outline.
 */
function groupsOfRecipe(recipe: ModelRecipe): string[] {
    const names: string[] = [];
    for (const attribute of recipe.attributes) {
        if (attribute.name === "group") {
            names.push(...attribute.args.filter((arg) => arg.trim() !== ""));
        }
    }
    return names;
}

function recipeSymbol(recipe: ModelRecipe): OutlineSymbol {
    return {
        name: recipe.name,
        detail: signatureOf(recipe),
        kind: OutlineKind.Function,
        range: rangeOf(recipe.span),
        selectionRange: rangeOf(recipe.nameSpan),
        children: [],
    };
}

/**
 * The outline for a Justfile.
 *
 * Private recipes are included. `just --list` hides them, but this is a
 * navigation tool for the file in front of you, and a recipe you cannot reach
 * from the outline is a recipe you cannot find.
 */
export function outline(model: JustfileModel, labels: OutlineLabels): OutlineSymbol[] {
    const symbols: OutlineSymbol[] = [];

    if (model.assignments.length > 0) {
        const children = model.assignments.map(
            (assignment): OutlineSymbol => ({
                name: assignment.name,
                detail: assignment.export ? "export" : "",
                kind: OutlineKind.Variable,
                range: rangeOf(assignment.span),
                selectionRange: rangeOf(assignment.nameSpan),
                children: [],
            }),
        );
        symbols.push({
            name: labels.variables,
            detail: "",
            kind: OutlineKind.Namespace,
            range: spanning(children.map((c) => c.range)),
            selectionRange: spanning(children.map((c) => c.range)),
            children,
        });
    }

    // A recipe with two `[group]` attributes belongs under both headings, so
    // this is a fan-out rather than a partition.
    const grouped = new Map<string, OutlineSymbol[]>();
    for (const recipe of model.recipes) {
        const names = groupsOfRecipe(recipe);
        if (names.length === 0) {
            symbols.push(recipeSymbol(recipe));
            continue;
        }
        for (const name of names) {
            const bucket = grouped.get(name);
            if (bucket === undefined) {
                grouped.set(name, [recipeSymbol(recipe)]);
            } else {
                bucket.push(recipeSymbol(recipe));
            }
        }
    }
    for (const [name, children] of grouped) {
        symbols.push({
            name,
            detail: "",
            kind: OutlineKind.Namespace,
            range: spanning(children.map((c) => c.range)),
            selectionRange: spanning(children.map((c) => c.range)),
            children,
        });
    }

    for (const module of model.modules) {
        symbols.push({
            name: module.name,
            detail: module.path ?? "",
            kind: OutlineKind.Module,
            range: rangeOf(module.span),
            selectionRange: rangeOf(module.nameSpan),
            children: [],
        });
    }

    for (const importation of model.imports) {
        // An import has no name of its own, so its path is the only thing to
        // show. One with no path at all is unnameable and would be dropped by
        // VS Code anyway.
        if (importation.path === "") {
            continue;
        }
        symbols.push({
            name: importation.path,
            detail: importation.optional ? "optional" : "",
            kind: OutlineKind.File,
            range: rangeOf(importation.span),
            selectionRange: rangeOf(importation.span),
            children: [],
        });
    }

    for (const alias of model.aliases) {
        symbols.push({
            name: alias.name,
            detail: `→ ${alias.target}`,
            kind: OutlineKind.Function,
            range: rangeOf(alias.span),
            selectionRange: rangeOf(alias.nameSpan),
            children: [],
        });
    }

    for (const setting of model.settings) {
        symbols.push({
            name: setting.name,
            detail: "",
            kind: OutlineKind.Property,
            // A setting has no separate name span in the model; the whole line
            // is close enough to select, and it is one line by construction.
            range: rangeOf(setting.span),
            selectionRange: rangeOf(setting.span),
            children: [],
        });
    }

    // Source order, so the outline reads like the file. VS Code can re-sort by
    // name if the user prefers; it cannot recover position if we lose it.
    symbols.sort((a, b) => a.range.offset - b.range.offset);
    return symbols;
}
