/**
 * Recursive-descent parser for Justfiles.
 *
 * Tier 1: no VS Code API, no I/O, no subprocesses. See AGENTS.md.
 *
 * Like the lexer, this is total. `parse` accepts any string and always returns
 * a `Justfile`. It never throws and never returns null. When input does not
 * match, it records a syntax error, skips to the next synchronisation point,
 * and carries on — so half a Justfile still produces an outline, and someone
 * typing a recipe one character at a time still gets navigation.
 *
 * The errors it records are strictly syntactic. Anything semantic — unknown
 * attributes, undefined variables, dependencies on recipes that do not exist —
 * is deliberately absent, because `just` is the only authority on those.
 */

import type {
    Alias,
    Assignment,
    Attribute,
    AttributeArgument,
    BodyFragment,
    BodyLine,
    Dependency,
    Expression,
    Import,
    Item,
    Justfile,
    ModuleDeclaration,
    Name,
    Parameter,
    ParameterKind,
    ParseError,
    Recipe,
    Setting,
    StringExpression,
} from "./ast.js";
import { tokenize } from "./lexer.js";
import { type Span, StringStyle, type Token, TokenKind } from "./token.js";

const EMPTY_SPAN: Span = { offset: 0, length: 0, line: 0, column: 0 };

/** Keywords that introduce an item. Not reserved words — `set` can be a recipe name. */
const KEYWORD = {
    set: "set",
    alias: "alias",
    export: "export",
    unexport: "unexport",
    import: "import",
    mod: "mod",
    if: "if",
    else: "else",
} as const;

function spanBetween(from: Span, to: Span): Span {
    return {
        offset: from.offset,
        length: Math.max(0, to.offset + to.length - from.offset),
        line: from.line,
        column: from.column,
    };
}

class Parser {
    private readonly tokens: readonly Token[];
    private readonly errors: ParseError[] = [];
    private index = 0;
    /** Comment lines seen since the last item, used for doc comments. */
    private pendingDoc: string[] = [];

    constructor(tokens: readonly Token[]) {
        this.tokens = tokens;
    }

    // -- token access -------------------------------------------------------

    private peek(offset = 0): Token {
        return this.tokens[this.index + offset] ?? this.eofToken();
    }

    private eofToken(): Token {
        const last = this.tokens.at(-1);
        return last ?? { kind: TokenKind.Eof, span: EMPTY_SPAN, text: "" };
    }

    private get done(): boolean {
        return this.peek().kind === TokenKind.Eof;
    }

    private at(kind: TokenKind): boolean {
        return this.peek().kind === kind;
    }

    private atKeyword(word: string): boolean {
        const token = this.peek();
        return token.kind === TokenKind.Identifier && token.text === word;
    }

    private advance(): Token {
        const token = this.peek();
        if (token.kind !== TokenKind.Eof) {
            this.index++;
        }
        return token;
    }

    private eat(kind: TokenKind): Token | undefined {
        return this.at(kind) ? this.advance() : undefined;
    }

    /** Consume `kind`, or record an error and return undefined. Never throws. */
    private expect(kind: TokenKind, what: string): Token | undefined {
        const token = this.eat(kind);
        if (token === undefined) {
            this.error(`expected ${what}`, this.peek().span);
        }
        return token;
    }

    private error(message: string, span: Span): void {
        // Cap the error list: a pathological file must not turn into millions
        // of diagnostics, and after the first few they stop being useful.
        if (this.errors.length < 100) {
            this.errors.push({ message, span });
        }
    }

    private skipNewlines(): void {
        while (this.at(TokenKind.Newline)) {
            this.advance();
        }
    }

    /** Skip to the start of the next line. The main recovery point. */
    private recoverToNextLine(): void {
        while (!this.done && !this.at(TokenKind.Newline)) {
            this.advance();
        }
        this.skipNewlines();
    }

    // -- entry point --------------------------------------------------------

    parse(): Justfile {
        const items: Item[] = [];
        const start = this.peek().span;

        while (!this.done) {
            const before = this.index;
            const item = this.parseItem();
            if (item !== undefined) {
                items.push(item);
            }
            // Guarantee progress. Without this, any bug in a parse method turns
            // into a hang, which is far worse than a wrong parse.
            if (this.index === before) {
                this.advance();
            }
        }

        return {
            kind: "justfile",
            span: spanBetween(start, this.eofToken().span),
            items,
            errors: this.errors,
        };
    }

    private parseItem(): Item | undefined {
        if (this.skipTrivia()) {
            return undefined;
        }
        const attributes = this.at(TokenKind.BracketL) ? this.parseAttributes() : [];
        return this.parseItemBody(attributes);
    }

    /**
     * Consume anything that is not itself an item: blank lines, comments, and
     * indentation that appears outside a recipe body. Returns true if it
     * consumed something, meaning there is no item to parse here.
     */
    private skipTrivia(): boolean {
        if (this.at(TokenKind.Newline)) {
            this.advance();
            this.pendingDoc = [];
            return true;
        }
        if (this.at(TokenKind.Comment)) {
            const comment = this.advance();
            this.pendingDoc.push(comment.text.replace(/^#+\s?/, ""));
            // Consume the newline here rather than letting the branch above see
            // it, which would clear the doc we just collected. Only a *blank*
            // line separates a comment from the item it documents.
            this.eat(TokenKind.Newline);
            return true;
        }
        // Stray indentation outside a recipe body. Skip the whole block rather
        // than trying to interpret it, so one bad indent does not derail the file.
        if (this.at(TokenKind.Indent)) {
            this.advance();
            while (!this.done && !this.at(TokenKind.Dedent)) {
                this.advance();
            }
            this.eat(TokenKind.Dedent);
            return true;
        }
        if (this.at(TokenKind.Dedent)) {
            this.advance();
            return true;
        }
        return false;
    }

    private parseItemBody(attributes: readonly Attribute[]): Item {
        if (this.atKeyword(KEYWORD.set) && this.isItemKeyword()) {
            return this.parseSetting();
        }
        if (this.atKeyword(KEYWORD.alias) && this.isItemKeyword()) {
            return this.parseAlias();
        }
        if (this.atKeyword(KEYWORD.import)) {
            return this.parseImport();
        }
        if (this.atKeyword(KEYWORD.mod) && this.isItemKeyword()) {
            return this.parseModule(attributes);
        }
        if (this.atExportedAssignment()) {
            const exported = this.advance().text === KEYWORD.export;
            return this.parseAssignment(exported);
        }
        if (this.isAssignmentAhead(0)) {
            return this.parseAssignment(false);
        }
        if (this.at(TokenKind.Identifier) || this.at(TokenKind.At)) {
            return this.parseRecipe(attributes);
        }

        const token = this.peek();
        this.error("expected a recipe, assignment, alias, setting, import or module", token.span);
        const text = token.text;
        this.recoverToNextLine();
        return { kind: "error-item", span: token.span, text };
    }

    private atExportedAssignment(): boolean {
        const isExportWord = this.atKeyword(KEYWORD.export) || this.atKeyword(KEYWORD.unexport);
        return isExportWord && this.isAssignmentAhead(1);
    }

    /**
     * `set`, `alias` and `mod` are not reserved, so `set:` is a recipe named
     * "set". Only treat the word as a keyword when an identifier follows.
     */
    private isItemKeyword(): boolean {
        return this.peek(1).kind === TokenKind.Identifier;
    }

    /** Is there a `:=` on this line, making it an assignment rather than a recipe? */
    private isAssignmentAhead(offset: number): boolean {
        if (this.peek(offset).kind !== TokenKind.Identifier) {
            return false;
        }
        return this.peek(offset + 1).kind === TokenKind.ColonEquals;
    }

    // -- items --------------------------------------------------------------

    private parseName(): Name {
        const token = this.peek();
        if (token.kind === TokenKind.Identifier) {
            this.advance();
            return { kind: "name", span: token.span, text: token.text };
        }
        this.error("expected a name", token.span);
        return { kind: "name", span: token.span, text: "" };
    }

    private parseSetting(): Setting {
        const start = this.advance().span; // `set`
        const name = this.parseName();
        let value: Expression | undefined;
        if (this.eat(TokenKind.ColonEquals) !== undefined) {
            value = this.parseExpression();
        }
        const end = this.peek().span;
        this.recoverToNextLine();
        return value === undefined
            ? { kind: "setting", span: spanBetween(start, end), name }
            : { kind: "setting", span: spanBetween(start, end), name, value };
    }

    private parseAlias(): Alias {
        const start = this.advance().span; // `alias`
        const name = this.parseName();
        let target: Name | undefined;
        if (this.expect(TokenKind.ColonEquals, "`:=`") !== undefined) {
            target = this.parseName();
        }
        const end = this.peek().span;
        this.recoverToNextLine();
        return target === undefined
            ? { kind: "alias", span: spanBetween(start, end), name }
            : { kind: "alias", span: spanBetween(start, end), name, target };
    }

    private parseAssignment(exported: boolean): Assignment {
        const name = this.parseName();
        this.expect(TokenKind.ColonEquals, "`:=`");
        const value = this.parseExpression();
        const end = this.peek().span;
        this.recoverToNextLine();
        return {
            kind: "assignment",
            span: spanBetween(name.span, end),
            name,
            exported,
            value,
        };
    }

    private parseImport(): Import {
        const start = this.advance().span; // `import`
        const optional = this.eat(TokenKind.QuestionMark) !== undefined;
        const path = this.at(TokenKind.StringLiteral) ? this.parseStringExpression() : undefined;
        if (path === undefined) {
            this.error("expected a quoted path after `import`", this.peek().span);
        }
        const end = this.peek().span;
        this.recoverToNextLine();
        return path === undefined
            ? { kind: "import", span: spanBetween(start, end), optional }
            : { kind: "import", span: spanBetween(start, end), optional, path };
    }

    private parseModule(attributes: readonly Attribute[]): ModuleDeclaration {
        const start = this.advance().span; // `mod`
        const optional = this.eat(TokenKind.QuestionMark) !== undefined;
        const name = this.parseName();
        const path = this.at(TokenKind.StringLiteral) ? this.parseStringExpression() : undefined;
        const doc = this.takeDoc();
        const end = this.peek().span;
        this.recoverToNextLine();
        const base = {
            kind: "module",
            span: spanBetween(start, end),
            name,
            optional,
            attributes,
        } as const;
        if (path !== undefined && doc !== undefined) {
            return { ...base, path, doc };
        }
        if (path !== undefined) {
            return { ...base, path };
        }
        if (doc !== undefined) {
            return { ...base, doc };
        }
        return base;
    }

    /**
     * The doc comment for the item about to be parsed.
     *
     * just takes only the *last* comment line above an item, not the whole
     * block — verified against `--dump`, which reports "Second line" for a
     * two-line comment. Joining the lines instead would put text in hovers that
     * `just --list` never shows.
     */
    private takeDoc(): string | undefined {
        const doc = this.pendingDoc.at(-1);
        this.pendingDoc = [];
        return doc;
    }

    // -- attributes ---------------------------------------------------------

    private parseAttributes(): Attribute[] {
        const attributes: Attribute[] = [];
        while (this.at(TokenKind.BracketL)) {
            const start = this.advance().span;
            // A single bracket group may hold several comma-separated attributes.
            do {
                attributes.push(this.parseAttribute(start));
            } while (this.eat(TokenKind.Comma) !== undefined);
            this.expect(TokenKind.BracketR, "`]`");
            this.skipNewlines();
            // Comments may sit between attributes and the recipe they decorate.
            while (this.at(TokenKind.Comment)) {
                this.pendingDoc.push(this.advance().text.replace(/^#+\s?/, ""));
                this.skipNewlines();
            }
        }
        return attributes;
    }

    /** One attribute inside a bracket group: `name` or `name('arg', 'arg')`. */
    private parseAttribute(start: Span): Attribute {
        const name = this.parseName();
        const args: AttributeArgument[] = [];
        if (this.eat(TokenKind.ParenL) !== undefined) {
            while (!this.done && !this.at(TokenKind.ParenR) && !this.at(TokenKind.Newline)) {
                const token = this.advance();
                if (token.kind === TokenKind.StringLiteral) {
                    args.push({
                        kind: "attribute-argument",
                        span: token.span,
                        value: token.value ?? "",
                    });
                } else if (token.kind !== TokenKind.Comma) {
                    this.error("expected a quoted attribute argument", token.span);
                }
            }
            this.expect(TokenKind.ParenR, "`)`");
        }
        return {
            kind: "attribute",
            span: spanBetween(start, this.peek().span),
            name,
            args,
        };
    }

    // -- recipes ------------------------------------------------------------

    private parseRecipe(attributes: readonly Attribute[]): Recipe {
        const startToken = this.peek();
        const quiet = this.eat(TokenKind.At) !== undefined;
        const name = this.parseName();
        const doc = this.takeDoc();

        const parameters: Parameter[] = [];
        while (!this.done && !this.at(TokenKind.Colon) && !this.at(TokenKind.Newline)) {
            const before = this.index;
            parameters.push(this.parseParameter());
            if (this.index === before) {
                this.advance();
            }
        }

        this.expect(TokenKind.Colon, "`:` after the recipe name");

        const dependencies: Dependency[] = [];
        const subsequents: Dependency[] = [];
        let target = dependencies;
        while (!this.done && !this.at(TokenKind.Newline)) {
            if (this.eat(TokenKind.AmpAmp) !== undefined) {
                target = subsequents;
                continue;
            }
            const dependency = this.parseDependency();
            if (dependency === undefined) {
                break;
            }
            target.push(dependency);
        }
        this.skipNewlines();

        const body = this.at(TokenKind.Indent) ? this.parseBody() : [];
        const shebang = bodyHasShebang(body);

        const base = {
            kind: "recipe",
            span: spanBetween(startToken.span, this.peek().span),
            name,
            attributes,
            parameters,
            dependencies,
            subsequents,
            body,
            quiet,
            shebang,
        } as const;
        return doc === undefined ? base : { ...base, doc };
    }

    private parseParameter(): Parameter {
        const start = this.peek().span;
        let parameterKind: ParameterKind = "singular";
        if (this.eat(TokenKind.Plus) !== undefined) {
            parameterKind = "plus";
        } else if (this.eat(TokenKind.Asterisk) !== undefined) {
            parameterKind = "star";
        }
        const exported = this.eat(TokenKind.Dollar) !== undefined;
        const name = this.parseName();
        let defaultValue: Expression | undefined;
        if (this.eat(TokenKind.Equals) !== undefined) {
            defaultValue = this.parseExpression();
        }
        const span = spanBetween(start, this.peek().span);
        return defaultValue === undefined
            ? { kind: "parameter", span, name, parameterKind, exported }
            : { kind: "parameter", span, name, parameterKind, exported, default: defaultValue };
    }

    private parseDependency(): Dependency | undefined {
        if (this.at(TokenKind.ParenL)) {
            const start = this.advance().span;
            const name = this.parseName();
            const args: Expression[] = [];
            while (!this.done && !this.at(TokenKind.ParenR) && !this.at(TokenKind.Newline)) {
                const before = this.index;
                args.push(this.parseExpression());
                if (this.index === before) {
                    this.advance();
                }
            }
            this.expect(TokenKind.ParenR, "`)`");
            return {
                kind: "dependency",
                span: spanBetween(start, this.peek().span),
                name,
                args,
            };
        }
        if (this.at(TokenKind.Identifier)) {
            const name = this.parseName();
            return { kind: "dependency", span: name.span, name, args: [] };
        }
        this.error("expected a dependency", this.peek().span);
        this.recoverToNextLine();
        return undefined;
    }

    private parseBody(): BodyLine[] {
        this.advance(); // Indent
        const lines: BodyLine[] = [];
        let fragments: BodyFragment[] = [];
        let lineStart = this.peek().span;

        const endLine = (end: Span): void => {
            if (fragments.length > 0) {
                lines.push({
                    kind: "body-line",
                    span: spanBetween(lineStart, end),
                    fragments,
                });
                fragments = [];
            }
        };

        while (!this.done && !this.at(TokenKind.Dedent)) {
            const token = this.peek();
            if (token.kind === TokenKind.Newline) {
                this.advance();
                endLine(token.span);
                lineStart = this.peek().span;
                continue;
            }
            if (token.kind === TokenKind.Text) {
                this.advance();
                fragments.push({ kind: "text", span: token.span, text: token.text });
                continue;
            }
            if (token.kind === TokenKind.InterpolationStart) {
                fragments.push(this.parseInterpolation());
                continue;
            }
            // Anything else inside a body is shell text the lexer split up.
            this.advance();
            fragments.push({ kind: "text", span: token.span, text: token.text });
        }
        endLine(this.peek().span);
        this.eat(TokenKind.Dedent);
        return lines;
    }

    private parseInterpolation(): BodyFragment {
        const start = this.advance().span; // `{{`
        const expression = this.at(TokenKind.InterpolationEnd) ? undefined : this.parseExpression();
        const closed = this.eat(TokenKind.InterpolationEnd) !== undefined;
        if (!closed) {
            this.error("unterminated `{{`", start);
        }
        const span = spanBetween(start, this.peek().span);
        return expression === undefined
            ? { kind: "interpolation", span, unterminated: !closed }
            : { kind: "interpolation", span, expression, unterminated: !closed };
    }

    // -- expressions --------------------------------------------------------

    private parseExpression(): Expression {
        if (this.atKeyword(KEYWORD.if)) {
            return this.parseConditional();
        }
        return this.parseConcat();
    }

    private parseConditional(): Expression {
        const start = this.advance().span; // `if`
        const left = this.parseConcat();

        let operator: "==" | "!=" | "=~" | undefined;
        if (this.eat(TokenKind.EqualsEquals) !== undefined) {
            operator = "==";
        } else if (this.eat(TokenKind.BangEquals) !== undefined) {
            operator = "!=";
        } else if (this.eat(TokenKind.EqualsTilde) !== undefined) {
            operator = "=~";
        } else {
            this.error("expected `==`, `!=` or `=~`", this.peek().span);
        }

        const right = operator === undefined ? undefined : this.parseConcat();
        const then = this.parseBraceBlock();
        let otherwise: Expression | undefined;
        if (this.atKeyword(KEYWORD.else)) {
            this.advance();
            otherwise = this.atKeyword(KEYWORD.if)
                ? this.parseConditional()
                : this.parseBraceBlock();
        }

        const span = spanBetween(start, this.peek().span);
        return {
            kind: "conditional",
            span,
            ...(left !== undefined && { left }),
            ...(operator !== undefined && { operator }),
            ...(right !== undefined && { right }),
            ...(then !== undefined && { then }),
            ...(otherwise !== undefined && { otherwise }),
        };
    }

    /**
     * `{ expr }`. The lexer produces `{{` for a doubled brace, so a block that
     * opens immediately with a nested brace arrives as one token; treat that as
     * a single `{` and let the matching `}}` close both.
     */
    private parseBraceBlock(): Expression | undefined {
        if (this.eat(TokenKind.InterpolationStart) === undefined) {
            const token = this.peek();
            if (token.kind === TokenKind.Unknown && token.text === "{") {
                this.advance();
            } else {
                this.error("expected `{`", token.span);
                return undefined;
            }
        }
        const inner = this.parseExpression();
        if (this.eat(TokenKind.InterpolationEnd) === undefined) {
            const token = this.peek();
            if (token.kind === TokenKind.Unknown && token.text === "}") {
                this.advance();
            } else {
                this.error("expected `}`", token.span);
            }
        }
        return inner;
    }

    private parseConcat(): Expression {
        let left = this.parseJoin();
        while (this.at(TokenKind.Plus)) {
            this.advance();
            const right = this.parseJoin();
            left = {
                kind: "concat",
                span: spanBetween(left.span, right.span),
                left,
                right,
            };
        }
        return left;
    }

    private parseJoin(): Expression {
        // `/ path` is a valid absolute join with no left operand.
        if (this.at(TokenKind.Slash)) {
            const start = this.advance().span;
            const right = this.parseUnary();
            return { kind: "join", span: spanBetween(start, right.span), right };
        }
        let left = this.parseUnary();
        while (this.at(TokenKind.Slash)) {
            this.advance();
            const right = this.parseUnary();
            left = { kind: "join", span: spanBetween(left.span, right.span), left, right };
        }
        return left;
    }

    private parseUnary(): Expression {
        const token = this.peek();

        if (token.kind === TokenKind.StringLiteral) {
            return this.parseStringExpression();
        }

        if (token.kind === TokenKind.Backtick) {
            this.advance();
            return {
                kind: "backtick",
                span: token.span,
                command: token.value ?? "",
                unterminated: token.unterminated === true,
            };
        }

        if (token.kind === TokenKind.ParenL) {
            this.advance();
            const inner = this.at(TokenKind.ParenR) ? undefined : this.parseExpression();
            this.expect(TokenKind.ParenR, "`)`");
            const span = spanBetween(token.span, this.peek().span);
            return inner === undefined ? { kind: "group", span } : { kind: "group", span, inner };
        }

        if (token.kind === TokenKind.Identifier) {
            const name = this.parseName();
            if (!this.at(TokenKind.ParenL)) {
                return { kind: "variable", span: name.span, name };
            }
            this.advance();
            const args = this.parseCallArguments();
            return {
                kind: "call",
                span: spanBetween(name.span, this.peek().span),
                callee: name,
                args,
            };
        }

        this.error("expected an expression", token.span);
        return { kind: "error-expression", span: token.span };
    }

    /** Comma-separated arguments up to the closing paren. Always terminates. */
    private parseCallArguments(): Expression[] {
        const args: Expression[] = [];
        while (!this.done && !this.at(TokenKind.ParenR) && !this.at(TokenKind.Newline)) {
            const before = this.index;
            args.push(this.parseExpression());
            this.eat(TokenKind.Comma);
            if (this.index === before) {
                this.advance();
            }
        }
        this.expect(TokenKind.ParenR, "`)`");
        return args;
    }

    private parseStringExpression(): StringExpression {
        const token = this.advance();
        const unterminated = token.unterminated === true;
        const style = token.style ?? StringStyle.DoubleCooked;
        return token.value === undefined
            ? { kind: "string", span: token.span, style, unterminated }
            : { kind: "string", span: token.span, style, value: token.value, unterminated };
    }
}

function bodyHasShebang(body: readonly BodyLine[]): boolean {
    const first = body[0]?.fragments[0];
    return first?.kind === "text" && first.text.startsWith("#!");
}

export function parse(source: string): Justfile {
    return new Parser(tokenize(source)).parse();
}

export function parseTokens(tokens: readonly Token[]): Justfile {
    return new Parser(tokens).parse();
}
