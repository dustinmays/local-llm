import { join, resolve } from "node:path";
import {
  ReleaseEvidenceLoadError,
  deriveRoutingRecommendation,
  loadReleaseEvidence,
} from "./release-evidence.js";

function evidenceDirectory(arguments_: string[]): string {
  let directory = join(process.cwd(), "artifacts", "delegate");
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--evidence-dir") {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new ReleaseEvidenceLoadError("--evidence-dir requires a path.");
      }
      directory = resolve(value);
      index += 1;
      continue;
    }
    throw new ReleaseEvidenceLoadError("Only --evidence-dir PATH is supported.");
  }
  return directory;
}

async function main(): Promise<number> {
  try {
    const evidence = await loadReleaseEvidence(evidenceDirectory(process.argv.slice(2)));
    const recommendation = deriveRoutingRecommendation(evidence);
    process.stdout.write(`${JSON.stringify(recommendation)}\n`);
    return recommendation.complete ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      `${error instanceof ReleaseEvidenceLoadError ? error.message : "Could not derive release routing safely."}\n`,
    );
    return error instanceof ReleaseEvidenceLoadError ? 2 : 70;
  }
}

process.exitCode = await main();
