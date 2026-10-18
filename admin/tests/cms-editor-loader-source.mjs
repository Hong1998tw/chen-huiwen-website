import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const cmsEditorLoaderPath = fileURLToPath(
  new URL("../../scripts/cms_editor_loader.js", import.meta.url),
);

export function readCmsEditorLoaderSource() {
  return readFileSync(cmsEditorLoaderPath, "utf8");
}
