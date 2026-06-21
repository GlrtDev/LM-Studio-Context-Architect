/**
 * fileProcessor.ts
 * Handles cleaning and preprocessing of local files.
 */

export interface ProcessedFile {
  name: string;
  content: string;
}

/**
 * Processes a list of files, applying specific rules based on file extension.
 */
export async function preprocessLocalFiles(
  files: { name: string; content: string }[]
): Promise<ProcessedFile[]> {
  return files.map((file) => {
    const ext = file.name.toLowerCase().split('.').pop();

    if (ext === 'cs') {
      return {
        name: file.name,
        content: stripCSharpComments(file.content),
      };
    }

    // Add more extensions here in the future (e.g., 'ts', 'js')
    return { ...file };
  });
}

/**
 * Removes C# comments:
 * 1. Multi-line: like this comment
 * 2. Single-line: // ...
 * 3. XML Documentation: /// ...
 * 
 * Uses a negative lookbehind to avoid stripping "://" in URLs.
 */
function stripCSharpComments(content: string): string {
  return content
    // 1. Remove multi-line comments
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // 2. Remove single-line and XML comments, avoiding http://
    // This regex looks for // or /// that is NOT preceded by a colon
    .replace(/(?<!:)\/\/\s?.*$/gm, "")
    .trim();
}
