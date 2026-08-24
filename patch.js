const fs = require('fs');
const content = fs.readFileSync('/srv/apps/loom/scanner/src/index.ts', 'utf8');

let newContent = content.replace(
  /async function generateThumbnail\(\n  absolutePath: string,\n  fileNodeId: string,\n  sourceVersion: string\n\): Promise<string \| null> {/g,
  `async function generateThumbnail(
  absolutePath: string,
  fileNodeId: string,
  sourceVersion: string,
  forceRetryFailed: boolean = false
): Promise<string | null> {`
);

newContent = newContent.replace(
  /try { await access\(failedPath, constants.F_OK\); return null; } catch {}/g,
  `if (!forceRetryFailed) {
    try { await access(failedPath, constants.F_OK); return null; } catch {}
  } else {
    await unlink(failedPath).catch(() => {});
  }`
);

newContent = newContent.replace(
  /async function generatePreview\(\n  absolutePath: string,\n  fileNodeId: string,\n  sourceVersion: string\n\): Promise<string \| null> {/g,
  `async function generatePreview(
  absolutePath: string,
  fileNodeId: string,
  sourceVersion: string,
  forceRetryFailed: boolean = false
): Promise<string | null> {`
);

newContent = newContent.replace(
  /async function generateVideoThumbnail\(\n  absolutePath: string,\n  fileNodeId: string,\n  sourceVersion: string\n\): Promise<string \| null> {/g,
  `async function generateVideoThumbnail(
  absolutePath: string,
  fileNodeId: string,
  sourceVersion: string,
  forceRetryFailed: boolean = false
): Promise<string | null> {`
);

// Now update the calls in scanDirectory
newContent = newContent.replace(
  /\? \(\) => generateThumbnail\(absolutePath, existing\.id, currentVersion\)\n              : \(\) => generateVideoThumbnail\(absolutePath, existing\.id, currentVersion\);/g,
  `? () => generateThumbnail(absolutePath, existing.id, currentVersion, true)
              : () => generateVideoThumbnail(absolutePath, existing.id, currentVersion, true);`
);

newContent = newContent.replace(
  /const previewPath = await generatePreview\(absolutePath, existing\.id, currentVersion\);/g,
  `const previewPath = await generatePreview(absolutePath, existing.id, currentVersion, true);`
);

fs.writeFileSync('/srv/apps/loom/scanner/src/index.ts', newContent);
