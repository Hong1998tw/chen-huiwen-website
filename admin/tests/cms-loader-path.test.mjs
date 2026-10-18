import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  cmsEditorLoaderPath,
  readCmsEditorLoaderSource,
} from "./cms-editor-loader-source.mjs";

test("CMS browser fixture resolves and reads the repository editor loader", () => {
  const expectedPath = fileURLToPath(
    new URL("../../scripts/cms_editor_loader.js", import.meta.url),
  );
  assert.equal(cmsEditorLoaderPath, expectedPath);
  assert.equal(
    existsSync(expectedPath),
    true,
    `CMS editor loader must exist at ${expectedPath}`,
  );
  assert.ok(readCmsEditorLoaderSource().trim(), "CMS editor loader source must be readable");
});
