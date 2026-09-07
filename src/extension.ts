/**
 * Extension entry point.
 *
 * Activation is a budget, not a preference: under 50 ms, no I/O, no subprocess,
 * no runtime dependencies. See AGENTS.md. Anything expensive is built lazily on
 * first use, and anything that runs `just` waits for Workspace Trust.
 */

import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel("Just", { log: true });
    context.subscriptions.push(output);

    output.info(
        vscode.l10n.t(
            "Justfile extension activated (workspace trusted: {0})",
            String(vscode.workspace.isTrusted),
        ),
    );

    // Trust can be granted mid-session, so it is read at call time rather than
    // captured here. This listener exists to light up Tier 2 when that happens.
    context.subscriptions.push(
        vscode.workspace.onDidGrantWorkspaceTrust(() => {
            output.info(
                vscode.l10n.t("Workspace trusted; features that run just are now available."),
            );
        }),
    );
}

export function deactivate(): void {
    // Nothing to tear down: everything owned by the extension is registered in
    // `context.subscriptions` and disposed by VS Code.
}
