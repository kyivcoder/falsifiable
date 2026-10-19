// Imported first by every guard test that runs git. Git sets GIT_DIR,
// GIT_WORK_TREE, GIT_INDEX_FILE and friends inside its own hooks; a throwaway
// repository a test builds must never inherit them, or its commands reach the
// repository the tests run in.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('GIT_')) delete process.env[key];
}
