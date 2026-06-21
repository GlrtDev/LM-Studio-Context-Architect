import { createConfigSchematics } from "@lmstudio/sdk";

export const configSchematics = createConfigSchematics()
  .field(
    "retrievalLimit",
    "numeric",
    {
      int: true,
      min: 1,
      displayName: "Retrieval Limit",
      subtitle: "When retrieval is triggered, this is the maximum number of chunks to return.",
      slider: { min: 1, max: 10, step: 1 },
    },
    3,
  )
  .field(
    "retrievalAffinityThreshold",
    "numeric",
    {
      min: 0.0,
      max: 1.0,
      displayName: "Retrieval Affinity Threshold",
      subtitle: "The minimum similarity score for a chunk to be considered relevant.",
      slider: { min: 0.0, max: 1.0, step: 0.01 },
    },
    0.5,
  )
  .field(
    "targetExtensions",
    "string",
    {
      displayName: "Target Extensions",
      subtitle: "Comma-separated list of extensions (e.g., .cs,.ts,.js)",
    },
    ".cs,.ts,.js",
  ).field(
    "autoContextDirectory",
    "string",
    {
      displayName: "Auto-load Directory",
      subtitle: "Absolute path to a folder. Files here will be automatically included in your prompt based on relevance.",
    },
    "", // Default empty
  ).field(
    "injectionThreshold",
    "numeric",
    {
      displayName: "Injection Threshold",
      subtitle: "Maximum tokens allowed before switching from full injection to RAG.",
      slider: { min: 500, max: 10000, step: 500 },
    },
    3000, // Default value
  )
  .build();
