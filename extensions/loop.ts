import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLoopTool } from "../src/index.js";

export default function extension(pi: ExtensionAPI) {
	pi.registerTool(createLoopTool());

	pi.on("session_start", () => {
		const active = pi.getActiveTools();
		if (!active.includes("loop")) {
			pi.setActiveTools([...active, "loop"]);
		}
	});
}
