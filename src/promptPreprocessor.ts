import {
  text,
  type Chat,
  type ChatMessage,
  type FileHandle,
  type LLMDynamicHandle,
  type PredictionProcessStatusController,
  type PromptPreprocessorController,
} from "@lmstudio/sdk";
import { configSchematics } from "./config";
import { preprocessLocalFiles } from "./fileProcessor";
import * as fs from "node:fs/promises";
import * as path from "node:path";

type DocumentContextInjectionStrategy = "none" | "inject-full-content" | "retrieval";

// Configuration & Regex
const DIR_TRIGGER_REGEX = /@dir:\s?([^ \n]+)/;
const CHUNK_SIZE = 1000; // Characters per chunk

interface LocalFileSummary {
  name: string;
  content: string;
  summary: string;
  embedding: number[];
}

export async function preprocess(ctl: PromptPreprocessorController, userMessage: ChatMessage) {
  const userPrompt = userMessage.getText();
  const history = await ctl.pullHistory();
  history.append(userMessage);
  const config = ctl.getPluginConfig(configSchematics);
  const injectionThreshold = config.get("injectionThreshold");

  let localFileContents: { name: string; content: string }[] = [];
  const extList = config.get("targetExtensions").split(",").map(e => e.trim().toLowerCase());

  // 1. Collect Files
  const autoDirPath = config.get("autoContextDirectory");
  if (autoDirPath) {
    const rawFiles = await readFilesFromDir(autoDirPath, extList, ctl);
    localFileContents.push(...(await preprocessLocalFiles(rawFiles)));
  }

  const dirMatch = userPrompt.match(DIR_TRIGGER_REGEX);
  if (dirMatch) {
    const triggerPath = dirMatch[1].replace(/['"`]/g, "");
    const rawFiles = await readFilesFromDir(triggerPath, extList, ctl);
    localFileContents.push(...(await preprocessLocalFiles(rawFiles)));
  }

  // 2. DECISION LOGIC
  if (localFileContents.length > 0) {
    const totalTokens = await estimateTokens(localFileContents);

    // If the total code is small, just inject it all to avoid the overhead of summarization
    if (totalTokens < injectionThreshold) {
      return await prepareLocalFullInjection(ctl, userMessage, localFileContents);
    } else {
      // Use the new Summary-Based RAG (Hierarchical RAG)
      return await performSummaryBasedRAG(ctl, userPrompt, localFileContents);
    }
  }

  // Standard UI-uploaded file logic
  const uploadedFiles = userMessage.getFiles(ctl.client).filter(f => f.type !== "image");
  if (uploadedFiles.length > 0) {
    const strategy = await chooseContextInjectionStrategy(ctl, userPrompt, uploadedFiles);
    if (strategy === "inject-full-content") {
      return await prepareDocumentContextInjection(ctl, userMessage);
    } else {
      return await prepareRetrievalResultsContextInjection(ctl, userPrompt, uploadedFiles);
    }
  }

  return userMessage;
}

async function prepareRetrievalResultsContextInjection(
  ctl: PromptPreprocessorController,
  originalUserPrompt: string,
  files: Array<FileHandle>,
): Promise<string> {
  const pluginConfig = ctl.getPluginConfig(configSchematics);
  const retrievalLimit = pluginConfig.get("retrievalLimit");
  const retrievalAffinityThreshold = pluginConfig.get("retrievalAffinityThreshold");

  // process files if necessary

  const statusSteps = new Map<FileHandle, PredictionProcessStatusController>();

  const retrievingStatus = ctl.createStatus({
    status: "loading",
    text: `Loading an embedding model for retrieval...`,
  });
  const model = await ctl.client.embedding.model("nomic-ai/nomic-embed-text-v1.5-GGUF", {
    signal: ctl.abortSignal,
  });
  retrievingStatus.setState({
    status: "loading",
    text: `Retrieving relevant citations for user query...`,
  });
  const result = await ctl.client.files.retrieve(originalUserPrompt, files, {
    embeddingModel: model,
    // Affinity threshold: 0.6 not implemented
    limit: retrievalLimit,
    signal: ctl.abortSignal,
    onFileProcessList(filesToProcess) {
      for (const file of filesToProcess) {
        statusSteps.set(
          file,
          retrievingStatus.addSubStatus({
            status: "waiting",
            text: `Process ${file.name} for retrieval`,
          }),
        );
      }
    },
    onFileProcessingStart(file) {
      statusSteps
        .get(file)!
        .setState({ status: "loading", text: `Processing ${file.name} for retrieval` });
    },
    onFileProcessingEnd(file) {
      statusSteps
        .get(file)!
        .setState({ status: "done", text: `Processed ${file.name} for retrieval` });
    },
    onFileProcessingStepProgress(file, step, progressInStep) {
      const verb = step === "loading" ? "Loading" : step === "chunking" ? "Chunking" : "Embedding";
      statusSteps.get(file)!.setState({
        status: "loading",
        text: `${verb} ${file.name} for retrieval (${(progressInStep * 100).toFixed(1)}%)`,
      });
    },
  });

  result.entries = result.entries.filter(entry => entry.score > retrievalAffinityThreshold);

  // inject retrieval result into the "processed" content
  let processedContent = "";
  const numRetrievals = result.entries.length;
  if (numRetrievals > 0) {
    // retrieval occured and got results
    // show status
    retrievingStatus.setState({
      status: "done",
      text: `Retrieved ${numRetrievals} relevant citations for user query`,
    });
    ctl.debug("Retrieval results", result);
    // add results to prompt
    const prefix = "The following citations were found in the files provided by the user:\n\n";
    processedContent += prefix;
    let citationNumber = 1;
    result.entries.forEach(result => {
      const completeText = result.content;
      processedContent += `Citation ${citationNumber}: "${completeText}"\n\n`;
      citationNumber++;
    });
    await ctl.addCitations(result);
    const suffix =
      `Use the citations above to respond to the user query, only if they are relevant. ` +
      `Otherwise, respond to the best of your ability without them.` +
      `\n\nUser Query:\n\n${originalUserPrompt}`;
    processedContent += suffix;
  } else {
    // retrieval occured but no relevant citations found
    retrievingStatus.setState({
      status: "canceled",
      text: `No relevant citations found for user query`,
    });
    ctl.debug("No relevant citations found for user query");
    const noteAboutNoRetrievalResultsFound =
      `Important: No citations were found in the user files for the user query. ` +
      `In less than one sentence, inform the user of this. ` +
      `Then respond to the query to the best of your ability.`;
    processedContent =
      noteAboutNoRetrievalResultsFound + `\n\nUser Query:\n\n${originalUserPrompt}`;
  }
  ctl.debug("Processed content", processedContent);

  return processedContent;
}

async function prepareDocumentContextInjection(
  ctl: PromptPreprocessorController,
  input: ChatMessage,
): Promise<ChatMessage> {
  const documentInjectionSnippets: Map<FileHandle, string> = new Map();
  const files = input.consumeFiles(ctl.client, file => file.type !== "image");
  for (const file of files) {
    // This should take no time as the result is already in the cache
    const { content } = await ctl.client.files.parseDocument(file, {
      signal: ctl.abortSignal,
    });

    ctl.debug(text`
      Strategy: inject-full-content. Injecting full content of file '${file}' into the
      context. Length: ${content.length}.
    `);
    documentInjectionSnippets.set(file, content);
  }

  // Format the final user prompt
  // TODO:
  //    Make this templatable and configurable
  //      https://github.com/lmstudio-ai/llmster/issues/1017
  let formattedFinalUserPrompt = "";

  if (documentInjectionSnippets.size > 0) {
    formattedFinalUserPrompt +=
      "This is a Enriched Context Generation scenario.\n\nThe following content was found in the files provided by the user.\n";

    for (const [fileHandle, snippet] of documentInjectionSnippets) {
      formattedFinalUserPrompt += `\n\n** ${fileHandle.name} full content **\n\n${snippet}\n\n** end of ${fileHandle.name} **\n\n`;
    }

    formattedFinalUserPrompt += `Based on the content above, please provide a response to the user query.\n\nUser query: ${input.getText()}`;
  }

  input.replaceText(formattedFinalUserPrompt);
  return input;
}

async function getEffectiveContextFormatted(
  ctx: Chat,
  model: LLMDynamicHandle,
  ctl: PromptPreprocessorController,
) {
  try {
    return await model.applyPromptTemplate(ctx);
  } catch (e) {
    const hasAnyUserMessage = ctx.getMessagesArray().some(message => message.getRole() === "user");
    if (!hasAnyUserMessage) {
      // Some prompt templates throw on no user message. Add a minimal placeholder and try again
      const placeholderUserMessageContent = "?"; // non-whitespace to avoid template trimming
      ctl.debug(text`
        Failed to apply prompt template on context with no user messages. Retrying with placeholder
        user message.
      `);
      const measurementContext = ctx.withAppended("user", placeholderUserMessageContent);
      return await model.applyPromptTemplate(measurementContext);
    }
    throw e;
  }
}

async function measureContextWindow(
  ctx: Chat,
  model: LLMDynamicHandle,
  ctl: PromptPreprocessorController,
) {
  const currentContextFormatted = await getEffectiveContextFormatted(ctx, model, ctl);
  const totalTokensInContext = await model.countTokens(currentContextFormatted);
  const modelContextLength = await model.getContextLength();
  const modelRemainingContextLength = modelContextLength - totalTokensInContext;
  const contextOccupiedPercent = (totalTokensInContext / modelContextLength) * 100;
  return {
    totalTokensInContext,
    modelContextLength,
    modelRemainingContextLength,
    contextOccupiedPercent,
  };
}

async function chooseContextInjectionStrategy(
  ctl: PromptPreprocessorController,
  originalUserPrompt: string,
  files: Array<FileHandle>,
): Promise<DocumentContextInjectionStrategy> {
  const status = ctl.createStatus({
    status: "loading",
    text: `Deciding how to handle the document(s)...`,
  });

  const model = await ctl.client.llm.model();
  const ctx = await ctl.pullHistory();

  // Measure the context window
  const {
    totalTokensInContext,
    modelContextLength,
    modelRemainingContextLength,
    contextOccupiedPercent,
  } = await measureContextWindow(ctx, model, ctl);

  ctl.debug(
    `Context measurement result:\n\n` +
      `\tTotal tokens in context: ${totalTokensInContext}\n` +
      `\tModel context length: ${modelContextLength}\n` +
      `\tModel remaining context length: ${modelRemainingContextLength}\n` +
      `\tContext occupied percent: ${contextOccupiedPercent.toFixed(2)}%\n`,
  );

  // Get token count of provided files
  let totalFileTokenCount = 0;
  let totalReadTime = 0;
  let totalTokenizeTime = 0;
  for (const file of files) {
    const startTime = performance.now();

    const loadingStatus = status.addSubStatus({
      status: "loading",
      text: `Loading parser for ${file.name}...`,
    });
    let actionProgressing = "Reading";
    let parserIndicator = "";

    const { content } = await ctl.client.files.parseDocument(file, {
      signal: ctl.abortSignal,
      onParserLoaded: parser => {
        loadingStatus.setState({
          status: "loading",
          text: `${parser.library} loaded for ${file.name}...`,
        });
        // Update action names if we're using a parsing framework
        if (parser.library !== "builtIn") {
          actionProgressing = "Parsing";
          parserIndicator = ` with ${parser.library}`;
        }
      },
      onProgress: progress => {
        loadingStatus.setState({
          status: "loading",
          text: `${actionProgressing} file ${file.name}${parserIndicator}... (${(
            progress * 100
          ).toFixed(2)}%)`,
        });
      },
    });
    loadingStatus.remove();

    totalReadTime += performance.now() - startTime;

    // tokenize file content
    const startTokenizeTime = performance.now();
    totalFileTokenCount += await model.countTokens(content);
    totalTokenizeTime += performance.now() - startTokenizeTime;
    if (totalFileTokenCount > modelRemainingContextLength) {
      // Early exit if we already have too much tokens. Helps with performance when there are a lot of files.
      break;
    }
  }
  ctl.debug(`Total file read time: ${totalReadTime.toFixed(2)} ms`);
  ctl.debug(`Total tokenize time: ${totalTokenizeTime.toFixed(2)} ms`);

  // Calculate total token count of files + user prompt
  ctl.debug(`Original User Prompt: ${originalUserPrompt}`);
  const userPromptTokenCount = (await model.tokenize(originalUserPrompt)).length;
  const totalFilePlusPromptTokenCount = totalFileTokenCount + userPromptTokenCount;

  // Calculate the available context tokens
  const contextOccupiedFraction = contextOccupiedPercent / 100;
  const targetContextUsePercent = 0.7;
  const targetContextUsage = targetContextUsePercent * (1 - contextOccupiedFraction);
  const availableContextTokens = Math.floor(modelRemainingContextLength * targetContextUsage);

  // Debug log
  ctl.debug("Strategy Calculation:");
  ctl.debug(`\tTotal Tokens in All Files: ${totalFileTokenCount}`);
  ctl.debug(`\tTotal Tokens in User Prompt: ${userPromptTokenCount}`);
  ctl.debug(`\tModel Context Remaining: ${modelRemainingContextLength} tokens`);
  ctl.debug(`\tContext Occupied: ${contextOccupiedPercent.toFixed(2)}%`);
  ctl.debug(`\tAvailable Tokens: ${availableContextTokens}\n`);

  if (totalFilePlusPromptTokenCount > availableContextTokens) {
    const chosenStrategy = "retrieval";
    ctl.debug(
      `Chosen context injection strategy: '${chosenStrategy}'. Total file + prompt token count: ` +
        `${totalFilePlusPromptTokenCount} > ${
          targetContextUsage * 100
        }% * available context tokens: ${availableContextTokens}`,
    );
    status.setState({
      status: "done",
      text: `Chosen context injection strategy: '${chosenStrategy}'. Retrieval is optimal for the size of content provided`,
    });
    return chosenStrategy;
  }

  // TODO:
  //
  //   Consider a more sophisticated strategy where we inject some header or summary content
  //   and then perform retrieval on the rest of the content.
  //
  //

  const chosenStrategy = "inject-full-content";
  status.setState({
    status: "done",
    text: `Chosen context injection strategy: '${chosenStrategy}'. All content can fit into the context`,
  });
  return chosenStrategy;
}

/**
 * SUMMARY-BASED RAG (Hierarchical Retrieval)
 * 1. Summarize each file using an LLM.
 * 2. Embed the summaries.
 * 3. Match the user query against the summaries.
 * 4. Return the FULL content of the most relevant files.
 */
async function performSummaryBasedRAG(
  ctl: PromptPreprocessorController,
  query: string,
  files: { name: string; content: string }[]
): Promise<string> {
  const status = ctl.createStatus({ status: "loading", text: "Analyzing project structure..." });
  const model = await ctl.client.llm.model();
  const embedModel = await ctl.client.embedding.model("nomic-ai/nomic-embed-text-v1.5-GGUF", {
    signal: ctl.abortSignal,
  });

  const config = ctl.getPluginConfig(configSchematics);
  const retrievalLimit = config.get("retrievalLimit") || 3;

  const fileSummaries: LocalFileSummary[] = [];

  // Step 1: Generate summaries for every file
  for (const file of files) {
    status.setState({ status: "loading", text: `Summarizing ${file.name}...` });
    try {
      const summary = await summarizeFile(model, file.content);
      const embedding: number[] = (await embedModel.embed(summary))["embedding"];
      fileSummaries.push({
        name: file.name,
        content: file.content,
        summary,
        embedding,
      });
    } catch (e) {
      ctl.debug(`Failed to summarize ${file.name}: ${e}`);
    }
  }

  // Step 2: Embed the user query
  status.setState({ status: "loading", text: "Searching relevant files..." });
  const queryEmbedding: number[] = (await embedModel.embed(query))["embedding"];

  // Step 3: Calculate similarity between Query and File Summaries
  const scoredFiles = fileSummaries.map(f => ({
    ...f,
    score: cosineSimilarity(queryEmbedding, f.embedding)
  })).sort((a, b) => b.score - a.score);

  // Step 4: Select top matches
  const topMatches = scoredFiles.slice(0, retrievalLimit);

  status.setState({ status: "done", text: `Found ${topMatches.length} relevant files via summary analysis.` });

  // Step 5: Build the prompt with FULL content of the selected files
  let prompt = "I have analyzed your project files. Based on your query, the following files are most relevant:\n\n";
  
  for (const match of topMatches) {
    prompt += `--- START OF FILE: ${match.name} ---\n`;
    prompt += `Summary: ${match.summary}\n\n`;
    prompt += `\`\`\`\n${match.content}\n\`\`\`\n\n`;
    prompt += `--- END OF FILE: ${match.name} ---\n\n`;
  }

  prompt += `User Query: ${query}\n\nUse the code above to provide a detailed answer.`;

  return prompt;
}

/**
 * Asks the LLM to create a high-level description of the file
 */
async function summarizeFile(model: LLMDynamicHandle, content: string): Promise<string> {
  // We only send the first 4000 chars to the summarizer to keep it fast and avoid context bloat
  const snippet = content.substring(0, 4000);
  const prompt = `Analyze the following code and provide a concise summary (max 3 sentences). 
  Focus on: 
  1. The primary purpose of the file.
  2. The main classes or functions exported.
  3. Key dependencies or logic.

  Code:
  ${snippet}`;

  const response = await model.respond(prompt);
  return response.content.trim();
}

// --- HELPER FUNCTIONS ---

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.substring(i, i + size));
  }
  return chunks;
}

function cosineSimilarity(vecA: number[], vecB: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function estimateTokens(files: { name: string; content: string }[]): Promise<number> {
  let total = 0;
  for (const f of files) {
    total += Math.ceil(f.content.length / 4);
  }
  return total;
}

async function readFilesFromDir(
  dirPath: string,
  extensions: string[],
  ctl: PromptPreprocessorController
): Promise<{ name: string; content: string }[]> {
  const results: { name: string; content: string }[] = [];
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await readFilesFromDir(fullPath, extensions, ctl)));
    } else if (entry.isFile() && extensions.includes(path.extname(entry.name).toLowerCase())) {
      try {
        const content = await fs.readFile(fullPath, "utf-8");
        results.push({ name: entry.name, content });
      } catch (e) {
        ctl.debug(`Failed to read ${entry.name}: ${e}`);
      }
    }
  }
  return results;
}

async function prepareLocalFullInjection(
  ctl: PromptPreprocessorController,
  input: ChatMessage,
  localFiles: { name: string; content: string }[],
  // uploadedFiles: any[] // FileHandle[]
): Promise<string> {
  let processedContent = "The following files were loaded into context:\n\n";

  // Add Local Files
  for (const file of localFiles) {
    processedContent += `\n** [LOCAL] ${file.name} **\n\`\`\`\n${file.content}\n\`\`\`\n\n`;
  }

  // Add Uploaded Files (parsing them via client)
  // for (const file of uploadedFiles) {
  //   const { content } = await ctl.client.files.parseDocument(file, { signal: ctl.abortSignal });
  //   processedContent += `\n** [UPLOADED] ${file.name} **\n\`\`\`\n${content}\n\`\`\`\n\n`;
  // }

  processedContent += `\nUser Query: ${input.getText()}`;
  return processedContent;
}