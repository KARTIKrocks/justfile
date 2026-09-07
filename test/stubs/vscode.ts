/**
 * A stand-in for the `vscode` module, for testing the provider layer.
 *
 * The extension host is not available in a unit test, so without this the only
 * untested code in the extension would be the layer that actually talks to the
 * editor — registration, encoding, disposal — which is where a silent mistake
 * costs the most. Type checking still runs against the real `@types/vscode`;
 * this is substituted at run time only, by an alias in `vitest.config.mts`.
 *
 * It implements exactly what the extension calls and nothing else. Anything
 * missing should fail loudly rather than quietly returning undefined.
 */

export interface Disposable {
    dispose(): void;
}

type Listener<T> = (event: T) => void;

class EventSource<T> {
    readonly listeners: Listener<T>[] = [];

    readonly register = (listener: Listener<T>): Disposable => {
        this.listeners.push(listener);
        return { dispose: () => {} };
    };

    emit(event: T): void {
        for (const listener of this.listeners) {
            listener(event);
        }
    }
}

export class SemanticTokensLegend {
    // Written out rather than declared as parameter properties: those emit
    // runtime code, which `erasableSyntaxOnly` forbids. See AGENTS.md.
    readonly tokenTypes: string[];
    readonly tokenModifiers: string[];

    constructor(tokenTypes: string[], tokenModifiers: string[]) {
        this.tokenTypes = tokenTypes;
        this.tokenModifiers = tokenModifiers;
    }
}

export interface PushedToken {
    readonly line: number;
    readonly char: number;
    readonly length: number;
    readonly tokenType: number;
    readonly tokenModifiers: number;
}

export class SemanticTokens {
    readonly pushed: readonly PushedToken[];

    constructor(pushed: readonly PushedToken[]) {
        this.pushed = pushed;
    }
}

export class SemanticTokensBuilder {
    readonly pushed: PushedToken[] = [];

    readonly legend: SemanticTokensLegend | undefined;

    constructor(legend?: SemanticTokensLegend) {
        this.legend = legend;
    }

    push(line: number, char: number, length: number, tokenType: number, tokenModifiers = 0): void {
        this.pushed.push({ line, char, length, tokenType, tokenModifiers });
    }

    build(): SemanticTokens {
        return new SemanticTokens(this.pushed);
    }
}

export interface RegisteredProvider {
    readonly selector: unknown;
    readonly provider: { provideDocumentSemanticTokens(document: unknown): unknown };
    readonly legend: SemanticTokensLegend;
}

/** Everything the stub recorded. Reset between tests with `resetStub()`. */
export const recorded = {
    semanticTokenProviders: [] as RegisteredProvider[],
    outputChannels: [] as { name: string; messages: string[]; disposed: boolean }[],
    onDidCloseTextDocument: new EventSource<{ uri: { toString(): string } }>(),
    onDidGrantWorkspaceTrust: new EventSource<void>(),
};

export function resetStub(): void {
    recorded.semanticTokenProviders.length = 0;
    recorded.outputChannels.length = 0;
    recorded.onDidCloseTextDocument.listeners.length = 0;
    recorded.onDidGrantWorkspaceTrust.listeners.length = 0;
}

export const languages = {
    registerDocumentSemanticTokensProvider(
        selector: unknown,
        provider: RegisteredProvider["provider"],
        legend: SemanticTokensLegend,
    ): Disposable {
        recorded.semanticTokenProviders.push({ selector, provider, legend });
        return { dispose: () => {} };
    },
};

export const window = {
    createOutputChannel(name: string, _options?: unknown) {
        const channel = { name, messages: [] as string[], disposed: false };
        recorded.outputChannels.push(channel);
        return {
            ...channel,
            info: (message: string) => channel.messages.push(message),
            dispose: () => {
                channel.disposed = true;
            },
        };
    },
};

export const workspace = {
    isTrusted: true,
    onDidCloseTextDocument: recorded.onDidCloseTextDocument.register,
    onDidGrantWorkspaceTrust: recorded.onDidGrantWorkspaceTrust.register,
};

export const l10n = {
    t(message: string, ...args: unknown[]): string {
        return message.replace(/\{(\d+)\}/g, (whole, index: string) => {
            const value = args[Number(index)];
            return value === undefined ? whole : String(value);
        });
    },
};
