// Shared vitest setup. Runs in every worker before tests.
// Keep tests hermetic: no real data dir, no real provider keys.

process.env.FOUNDRY_DATA_DIR ??= "./.test-data";
process.env.FOUNDRY_MASTER_KEY ??= "test-master-key-not-a-secret";
process.env.FOUNDRY_LOG_LEVEL ??= "warn";