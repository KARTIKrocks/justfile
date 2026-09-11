import { beforeEach, describe, expect, it } from "vitest";
import { recorded, resetStub, type StatusBarItem } from "../../test/stubs/vscode.js";
import type { Detection } from "../cli/detect.js";
import { registerCliStatus } from "./cliStatus.js";

function contextOf(): { subscriptions: { dispose(): void }[] } {
    return { subscriptions: [] };
}

/** A fake `detect` that returns each of `results` in turn, then repeats the last. */
function detectSequence(...results: Detection[]): () => Promise<Detection> {
    let index = 0;
    return () => {
        const result = results[Math.min(index, results.length - 1)];
        index++;
        return Promise.resolve(result as Detection);
    };
}

/**
 * Registers with `detect`, waits for the first refresh, and hands back the
 * item from the stub's own recording — not `registerCliStatus`'s return
 * value, which is typed against the real `vscode.StatusBarItem` and so does
 * not expose the stub's `shown` field.
 */
async function statusFor(
    context: { subscriptions: { dispose(): void }[] },
    detect: () => Promise<Detection>,
): Promise<StatusBarItem> {
    await registerCliStatus(context as never, detect);
    const item = recorded.statusBarItems.at(-1);
    if (item === undefined) {
        throw new Error("the status bar item was not created");
    }
    return item;
}

const SUPPORTED: Detection = {
    state: "detected",
    detected: { executablePath: "just", version: "1.58.0", supported: true },
};

const UNSUPPORTED: Detection = {
    state: "detected",
    detected: { executablePath: "just", version: "1.21.0", supported: false },
};

const NOT_FOUND: Detection = { state: "not-found" };
const UNTRUSTED: Detection = { state: "untrusted" };

beforeEach(resetStub);

describe("registration", () => {
    it("creates one status bar item and registers the three commands", async () => {
        const context = contextOf();
        await registerCliStatus(context as never, detectSequence(SUPPORTED));
        expect(recorded.statusBarItems).toHaveLength(1);
        expect(recorded.commands.has("just.checkInstallation")).toBe(true);
        expect(recorded.commands.has("just.showVersion")).toBe(true);
        expect(recorded.commands.has("just.configureExecutable")).toBe(true);
    });

    it("puts the item and every listener and command under the context's disposal", async () => {
        const context = contextOf();
        await registerCliStatus(context as never, detectSequence(SUPPORTED));
        // Item, two listeners (config change, trust granted), three commands.
        expect(context.subscriptions.length).toBeGreaterThanOrEqual(6);
    });

    it("resolves with the status bar item after the first refresh", async () => {
        const item = await statusFor(contextOf(), detectSequence(SUPPORTED));
        expect(item.text).toContain("1.58.0");
        expect(item.shown).toBe(true);
    });
});

describe("status bar text", () => {
    it("shows a shield and no command when untrusted", async () => {
        const item = await statusFor(contextOf(), detectSequence(UNTRUSTED));
        expect(item.text).toContain("$(shield)");
        expect(item.command).toBeUndefined();
    });

    it("shows a warning and the configure command when just is not found", async () => {
        const item = await statusFor(contextOf(), detectSequence(NOT_FOUND));
        expect(item.text).toContain("$(warning)");
        expect(item.command).toBe("just.configureExecutable");
    });

    it("shows a check for a supported version, with the check-installation command", async () => {
        const item = await statusFor(contextOf(), detectSequence(SUPPORTED));
        expect(item.text).toContain("$(check)");
        expect(item.text).toContain("1.58.0");
        expect(item.command).toBe("just.checkInstallation");
    });

    it("shows a warning for an unsupported version, distinct from not-found", async () => {
        const item = await statusFor(contextOf(), detectSequence(UNSUPPORTED));
        expect(item.text).toContain("$(warning)");
        expect(item.text).toContain("1.21.0");
    });
});

describe("the below-minimum warning", () => {
    it("is shown once for an unsupported version", async () => {
        await statusFor(contextOf(), detectSequence(UNSUPPORTED));
        expect(recorded.warningMessages).toHaveLength(1);
    });

    it("is not shown again on a later refresh reporting the same thing", async () => {
        await statusFor(contextOf(), detectSequence(UNSUPPORTED, UNSUPPORTED));
        await recorded.commands.get("just.checkInstallation")?.();
        expect(recorded.warningMessages).toHaveLength(1);
    });

    it("is never shown for a supported version", async () => {
        await statusFor(contextOf(), detectSequence(SUPPORTED));
        expect(recorded.warningMessages).toHaveLength(0);
    });
});

describe("just.checkInstallation", () => {
    it("re-runs detection rather than reusing the cache", async () => {
        const item = await statusFor(contextOf(), detectSequence(NOT_FOUND, SUPPORTED));
        expect(item.text).toContain("not found");
        await recorded.commands.get("just.checkInstallation")?.();
        expect(item.text).toContain("1.58.0");
    });

    it("shows an information message describing the result", async () => {
        await statusFor(contextOf(), detectSequence(SUPPORTED));
        recorded.infoMessages.length = 0;
        await recorded.commands.get("just.checkInstallation")?.();
        expect(recorded.infoMessages).toHaveLength(1);
        expect(recorded.infoMessages[0]).toContain("1.58.0");
    });
});

describe("just.showVersion", () => {
    it("uses the cached detection rather than spawning again", async () => {
        await statusFor(contextOf(), detectSequence(SUPPORTED, UNSUPPORTED));
        recorded.infoMessages.length = 0;
        await recorded.commands.get("just.showVersion")?.();
        // A second call to the fake would have returned UNSUPPORTED; seeing
        // the first version means the cache, not a fresh call, was used.
        expect(recorded.infoMessages[0]).toContain("1.58.0");
    });
});

describe("just.configureExecutable", () => {
    it("opens settings scoped to just.executablePath", async () => {
        await statusFor(contextOf(), detectSequence(NOT_FOUND));
        await recorded.commands.get("just.configureExecutable")?.();
        expect(recorded.executedCommands).toContainEqual({
            command: "workbench.action.openSettings",
            args: ["just.executablePath"],
        });
    });
});

describe("refresh triggers", () => {
    it("refreshes when just.executablePath changes", async () => {
        const item = await statusFor(contextOf(), detectSequence(NOT_FOUND, SUPPORTED));
        expect(item.text).toContain("not found");
        recorded.onDidChangeConfiguration.emit({ affectsConfiguration: () => true });
        await Promise.resolve();
        await Promise.resolve();
        expect(item.text).toContain("1.58.0");
    });

    it("does not refresh for an unrelated configuration change", async () => {
        const item = await statusFor(contextOf(), detectSequence(NOT_FOUND, SUPPORTED));
        recorded.onDidChangeConfiguration.emit({ affectsConfiguration: () => false });
        await Promise.resolve();
        expect(item.text).toContain("not found");
    });

    it("refreshes when workspace trust is granted", async () => {
        const item = await statusFor(contextOf(), detectSequence(UNTRUSTED, SUPPORTED));
        expect(item.text).toContain("$(shield)");
        recorded.onDidGrantWorkspaceTrust.emit(undefined);
        await Promise.resolve();
        await Promise.resolve();
        expect(item.text).toContain("1.58.0");
    });
});
