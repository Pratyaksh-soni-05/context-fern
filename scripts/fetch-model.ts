// Downloads the embedding model — the one place in this repo allowed
// to make a real network call to Hugging Face. Two callers: the
// release pipeline (pass an explicit <cache-dir> to package the result
// into the checksummed model release asset) and CI's own smoke test
// (no argument — writes directly into the real modelCacheDir() the
// compiled binary under test will read from, so the smoke test's own
// network-block step then proves zero runtime fetches — see
// docs/decisions.md's PR 1 addendum). The compiled binary itself must
// never reach this script's code path.

import { CLI_NAME } from "@context-fern/core";
import {
  checkModelFiles,
  DEFAULT_MODEL_ID,
  modelCacheDir,
} from "@context-fern/embed";
import { env, pipeline } from "@huggingface/transformers";

const cacheDir = process.argv[2] ?? modelCacheDir();

env.cacheDir = cacheDir;
env.allowRemoteModels = true;

const extractor = await pipeline("feature-extraction", DEFAULT_MODEL_ID, {
  dtype: "q8",
});
const output = await extractor(["warm"], { pooling: "mean", normalize: true });
console.log(
  `fetched ${DEFAULT_MODEL_ID}, dims=${output.tolist()[0].length}, cacheDir=${cacheDir}`,
);

// What was just fetched must be exactly the pinned files — otherwise
// the release would ship (and every daemon would then refuse) a model
// that no longer matches MODEL_FILE_SHA256.
const problem = await checkModelFiles(cacheDir);
if (problem) {
  console.error(
    `fetched model does not match its pinned checksum (${problem.kind}): ${problem.path}`,
  );
  process.exit(1);
}
console.log("model files match their pinned SHA-256");
console.log(
  `If a ${CLI_NAME} daemon is already running, restart it to load the model: ${CLI_NAME} daemon stop`,
);
