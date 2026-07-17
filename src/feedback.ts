// "Send Feedback" command. Unlike everything else in this extension, feedback
// is an EXPLICIT, user-initiated network POST (not telemetry): the user types a
// message and chooses to send it. No session/event data is included — only the
// note plus which editor/version it came from.

import * as vscode from "vscode";
import * as https from "https";
import * as http from "http";
import { URL } from "url";

const MAX_MESSAGE = 4000;

const CATEGORIES: { label: string; value: string }[] = [
  { label: "General", value: "" },
  { label: "Idea", value: "idea" },
  { label: "Bug", value: "bug" },
  { label: "Praise", value: "praise" },
  { label: "Other", value: "other" },
];

// Prod by default; PROMPTCONDUIT_API_URL overrides it for local/dev testing
// (mirrors the CLI).
function apiUrl(): string {
  const override = process.env.PROMPTCONDUIT_API_URL?.trim();
  return override || "https://api.promptconduit.dev";
}

// Minimal JSON POST via node's http/https (no runtime deps). Resolves the
// status code; rejects on network/timeout error.
function postFeedback(body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(apiUrl() + "/v1/feedback");
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    const payload = JSON.stringify(body);
    const mod = url.protocol === "http:" ? http : https;
    const req = mod.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "User-Agent": "PromptConduit-Extension",
        },
        timeout: 15000,
      },
      (res) => {
        res.resume(); // drain the response so the socket frees
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.write(payload);
    req.end();
  });
}

/** Prompt for a message + optional category and send it to /v1/feedback. */
export async function sendFeedback(extensionVersion: string): Promise<void> {
  const message = await vscode.window.showInputBox({
    title: "Send feedback to PromptConduit",
    prompt: "An idea, a bug, or just what you think — we read every note.",
    placeHolder: "What's on your mind?",
    ignoreFocusOut: true,
    validateInput: (v) => {
      const t = v.trim();
      if (!t) return "Please enter a message";
      if (v.length > MAX_MESSAGE) return `Message is too long (${v.length}/${MAX_MESSAGE})`;
      return undefined;
    },
  });
  if (!message || !message.trim()) return;

  const pick = await vscode.window.showQuickPick(
    CATEGORIES.map((c) => c.label),
    { title: "Category (optional)", placeHolder: "General" },
  );
  // Escaping the category picker is fine — send with no category.
  const category = CATEGORIES.find((c) => c.label === pick)?.value || undefined;

  try {
    const status = await postFeedback({
      message: message.trim(),
      category,
      source: "extension",
      context: {
        editor: vscode.env.appName,
        editor_version: vscode.version,
        extension_version: extensionVersion,
        os: process.platform,
      },
    });
    if (status >= 200 && status < 300) {
      void vscode.window.showInformationMessage("Thanks — your feedback landed. We read every note.");
    } else {
      void vscode.window.showErrorMessage(`Could not send feedback (HTTP ${status}). Please try again.`);
    }
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Could not send feedback: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
