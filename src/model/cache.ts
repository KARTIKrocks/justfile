/**
 * Per-document parse cache.
 *
 * Tier 1: no VS Code API, no I/O, no subprocesses. See AGENTS.md.
 *
 * Every Tier 1 feature — semantic tokens, outline, folding, completion, hover,
 * navigation — needs the same tree for the same document, and each of them is
 * asked for it independently as the user types. Parsing once per keystroke
 * instead of once per feature per keystroke is the whole point.
 *
 * Keyed by an opaque string rather than a `vscode.Uri` so this stays testable
 * in plain Node. The provider layer passes `document.uri.toString()`.
 */

import type { Justfile } from "../parser/ast.js";
import { parse } from "../parser/parser.js";
import { buildModel } from "./build.js";
import type { JustfileModel } from "./justfile.js";

export interface ParsedDocument {
    /** The document version this was parsed from. */
    readonly version: number;
    readonly ast: Justfile;
    /** Built on first use: the token providers only ever want the tree. */
    readonly model: JustfileModel;
}

class Entry implements ParsedDocument {
    readonly version: number;
    readonly ast: Justfile;
    #model: JustfileModel | undefined;

    constructor(version: number, ast: Justfile) {
        this.version = version;
        this.ast = ast;
    }

    get model(): JustfileModel {
        this.#model ??= buildModel(this.ast);
        return this.#model;
    }
}

export class ParseCache {
    readonly #entries = new Map<string, Entry>();

    /**
     * The parse of `text`, reusing the previous one when the version matches.
     *
     * The version is the whole invalidation story: VS Code bumps it on every
     * edit, so a stale entry cannot survive a change to the document.
     */
    parse(key: string, version: number, text: string): ParsedDocument {
        const hit = this.#entries.get(key);
        if (hit !== undefined && hit.version === version) {
            return hit;
        }
        const entry = new Entry(version, parse(text));
        this.#entries.set(key, entry);
        return entry;
    }

    /** Drop a document, on close. Nothing here should outlive its editor. */
    forget(key: string): void {
        this.#entries.delete(key);
    }

    clear(): void {
        this.#entries.clear();
    }

    /** How many documents are held. For tests and for spotting a leak. */
    get size(): number {
        return this.#entries.size;
    }
}
