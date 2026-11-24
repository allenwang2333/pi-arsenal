import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import installBackgroundProcess from "./tools/background-process.ts";
import installHashlineEdit from "./tools/edit.ts";
import { installClaudeMessages } from "./util/claude-messages.ts";
import { installClaudeToolCalls } from "./util/claude-tools.ts";
import { installClaudeInput, installClaudeSpinner } from "./util/claude-ui.ts";
import { installCodeBlocks } from "./util/code-blocks.ts";
import { contextCommand } from "./util/context.ts";
import { installExtensionList } from "./util/extension-list.ts";
import { installModelScopeNotice } from "./util/model-scope.ts";
import { installSelectionTheme } from "./util/selection.ts";
import { usageCommand } from "./util/usage.ts";

export default function (pi: ExtensionAPI) {
	installModelScopeNotice(pi);
	installExtensionList(pi);
	installClaudeInput(pi);
	installClaudeSpinner(pi);
	installClaudeToolCalls(pi);
	installCodeBlocks(pi);
	installClaudeMessages(pi);
	installSelectionTheme(pi);

	installHashlineEdit(pi);
	installBackgroundProcess(pi);
	pi.registerCommand("context", contextCommand(pi));
	pi.registerCommand("usage", usageCommand);
}
