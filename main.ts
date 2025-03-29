import {
    App,
    Menu,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    TAbstractFile,
    FileView,
    WorkspaceLeaf
} from 'obsidian';
import * as path from 'path';
// Use node's fs.promises API for async file operations
import * as fs from 'fs/promises';
import matter from 'gray-matter';
// Use node's os module to resolve home directory
import { homedir } from 'os';

// Interface defining the structure of plugin settings
interface ObsidianHugoExportSettings {
    postsDirectory: string;
    staticImagesDirectory: string;
    debugMode: boolean;
}

// Default settings values
const DEFAULT_SETTINGS: ObsidianHugoExportSettings = {
    // Sensible default, user should change this
    postsDirectory: '~/hugo-blog/content/posts',
    staticImagesDirectory: '~/hugo-blog/static/images',
    debugMode: false
};

export default class ObsidianHugoExportPlugin extends Plugin {
    settings: ObsidianHugoExportSettings;

    // Called when the plugin is loaded
    async onload() {
        await this.loadSettings(); // Load existing settings or defaults

        // Add command palette command to export the currently active file
        this.addCommand({
            id: 'export-active-to-hugo',
            name: 'Export Active Note to Hugo',
            callback: () => {
                // Export the currently active file, handle potential errors
                this.exportFile().catch(error => this.handleError(error, 'Export Active Note failed'));
            }
        });

        // Add command palette command to export selected (currently open) files
        this.addCommand({
            id: 'export-open-notes-to-hugo', // Renamed for clarity
            name: 'Export Open Notes to Hugo',
            checkCallback: (checking) => {
                const files = this.getOpenMarkdownFiles();
                // Enable the command only if there are open markdown files
                if (files.length > 0) {
                    if (!checking) {
                        // Execute the export if the command is actually run
                        this.exportFiles(files);
                    }
                    return true; // Command is available
                }
                return false; // Command is not available
            }
        });

        // Register context menu item for markdown files
        this.registerEvent(
            this.app.workspace.on('file-menu', (menu, file) => {
                // Add the menu item only if the context is a markdown file
                if (file instanceof TFile && file.extension === 'md') {
                    this.addContextMenu(menu, file);
                }
            })
        );

        // Add the settings tab
        this.addSettingTab(new ObsidianHugoExportSettingTab(this.app, this));

        this.debug('Obsidian Hugo Export Plugin loaded.');
    }

    // Adds the 'Export to Hugo' option to the file context menu
    private addContextMenu(menu: Menu, file: TFile) {
        menu.addItem((item) => {
            item.setTitle('Export to Hugo')
                .setIcon('download') // Use a relevant icon
                .onClick(async () => {
                    // Export the specific file clicked on, handle errors
                    await this.exportFile(file).catch(error => this.handleError(error, `Export failed for ${file.name}`));
                });
        });
        this.debug(`Added context menu for ${file.name}`);
    }

    // Gets all currently open Markdown files in the workspace
    private getOpenMarkdownFiles(): TFile[] {
        const markdownFiles: TFile[] = [];
        this.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
            // Check if the leaf view is a FileView and the file is a TFile instance
            if (leaf.view instanceof FileView && leaf.view.file instanceof TFile) {
                // Check if the file extension is markdown
                if (leaf.view.file.extension === 'md') {
                    markdownFiles.push(leaf.view.file);
                }
            }
        });
        this.debug(`Found ${markdownFiles.length} open markdown files.`);
        return markdownFiles;
    }

    // Exports multiple files, showing progress notices
    private async exportFiles(files: TFile[]) {
        const total = files.length;
        if (total === 0) {
            this.showNotice("No markdown files selected or open to export.", 'error');
            return;
        }

        let successCount = 0;
        this.showNotice(`Starting export of ${total} files...`, 'success');

        // Loop through each file and export it
        for (const [index, file] of files.entries()) {
            try {
                await this.exportFile(file);
                successCount++;
                // Optional: Show progress notice (can be noisy for many files)
                // this.showNotice(`Exported ${index + 1}/${total}: ${file.name}`, 'success', 1500);
            } catch (error) {
                // Log specific error but continue with others
                this.handleError(error, `Failed to export ${index + 1}/${total}: ${file.name}`);
            }
        }

        // Show final summary notice
        const message = `Exported ${successCount}/${total} files.`;
        this.showNotice(message, successCount === total ? 'success' : 'error', successCount === total ? 3000 : 5000);
        this.debug(`Batch export completed. Success: ${successCount}, Failed: ${total - successCount}`);
    }

    // Exports a single file (either specified or the active one)
    async exportFile(file?: TFile): Promise<void> {
        // Determine the target file (passed argument or active file)
        const targetFile = file || this.app.workspace.getActiveFile();
        if (!targetFile) {
            throw new Error('No file selected or active for export.');
        }
        if (targetFile.extension !== 'md') {
             throw new Error(`Cannot export non-markdown file: ${targetFile.name}`);
        }

        this.debug(`Starting export for: ${targetFile.path}`);

        try {
            // Read the markdown content from the vault
            const content = await this.app.vault.read(targetFile);
            // Process markdown (front matter, links, images)
            const processedContent = await this.processMarkdown(targetFile, content);
            // Write the processed content to the Hugo directory
            await this.writeHugoFile(targetFile, processedContent);
            // Success notice is shown in writeHugoFile for single file exports
        } catch (error) {
            // Catch and re-throw errors for centralized handling if needed, or handle directly
             this.debug(`Error during exportFile for ${targetFile.name}: ${error.message}`);
            // Re-throwing allows the caller (e.g., exportFiles) to catch and report
            throw new Error(`Export failed for ${targetFile.name}: ${error.message}`);
        }
    }

    // Resolves a path string, handling '~' and ensuring it's absolute
    private resolvePath(rawPath: string): string {
        let resolved = rawPath;
        // Expand home directory ('~')
        if (rawPath.startsWith('~')) {
            resolved = path.join(homedir(), rawPath.slice(1));
        }
        // Use path.resolve to ensure the path is absolute
        return path.resolve(resolved);
    }

    // Processes the raw markdown content for Hugo compatibility
    private async processMarkdown(file: TFile, content: string): Promise<string> {
        this.debug(`Processing markdown for: ${file.path}`);
        // Parse front matter and body using gray-matter
        const { data: existingFrontMatter, content: body } = matter(content);
        // Generate or update front matter
        const finalFrontMatter = this.generateFrontMatter(file, existingFrontMatter);
        // Process the main content (links, images, handling code blocks)
        const processedBody = await this.processContent(file, body);
        // Reassemble the file with updated front matter and processed body
        return matter.stringify(processedBody, finalFrontMatter);
    }

    // Generates the Hugo front matter, merging existing data
    private generateFrontMatter(file: TFile, existingData: any): object {
        this.debug(`Generating front matter for: ${file.name}`);
        // Ensure title exists, default to filename without extension
        const title = existingData.title || path.parse(file.name).name;
        // Ensure date exists, default to current ISO timestamp
        const date = existingData.date || new Date().toISOString();

        // Merge default/generated fields with existing front matter
        const frontMatter = {
            title: title,
            date: date,
            ...existingData, // Spread existing data after defaults ensures user values override if needed
        };
        this.debug(`Final front matter for ${file.name}: ${JSON.stringify(frontMatter)}`);
        return frontMatter;
    }

   // Processes the body content: masks code blocks, then handles images and wikilinks
    private async processContent(file: TFile, content: string): Promise<string> {
        this.debug(`Processing content body for: ${file.name}`);

        const fencedCodeBlocks: string[] = [];
        const inlineCodeBlocks: string[] = [];
        let processedContent = content;
        const placeholderPrefix = `%%HUGOPLUGIN_CODEBLOCK%%`; // Use a more unique prefix

        // --- STEP 1: Mask Fenced Code Blocks ---
        const fencedCodeRegex = /^ {0,3}(````+|~~~+) *(.*?)\n([\s\S]*?)\n^ {0,3}\1 *$/gm;
        processedContent = processedContent.replace(fencedCodeRegex, (match) => {
            const placeholder = `${placeholderPrefix}_FENCED_${fencedCodeBlocks.length}%%`;
            fencedCodeBlocks.push(match);
            this.debug(`Masking fenced code block with placeholder: ${placeholder}`);
            return placeholder;
        });

        // --- STEP 2: Mask Inline Code Blocks ---
        const inlineCodeRegex = /`([^`\n]+?)`/g;
        processedContent = processedContent.replace(inlineCodeRegex, (match) => {
            if (match.includes(placeholderPrefix)) { // Avoid double-masking if regex catches part of fenced placeholder
                 return match;
            }
            const placeholder = `${placeholderPrefix}_INLINE_${inlineCodeBlocks.length}%%`;
            inlineCodeBlocks.push(match);
            this.debug(`Masking inline code block with placeholder: ${placeholder}`);
            return placeholder;
        });

        this.debug(`Content after masking: ${processedContent.substring(0, 200)}...`);

        // --- STEP 3: Process Images on Masked Content ---
        const imagePromises: Promise<{ match: string, replacement: string }>[] = [];
        const wikiImageRegex = /!\[\[([^\]\n]+?)\]\]/g; // Non-greedy match inside [[ ]]
        const markdownImageRegex = /!\[([^\]]*)\]\(([^)\s]+?)(?:\s+"[^"]+")?\)/g; // Non-greedy path

        // Gather promises for wiki-style images
        for (const match of processedContent.matchAll(wikiImageRegex)) {
            const fullMatch = match[0];
            const imageName = match[1].trim();
            this.debug(`Found wiki image reference (post-masking): ${fullMatch}`);
            imagePromises.push(
                this.handleImage(file, imageName, path.parse(imageName).name)
                    .then(hugoImageMarkdown => ({ match: fullMatch, replacement: hugoImageMarkdown }))
                    .catch(error => {
                        this.debug(`Error handling wiki image ${imageName}: ${error.message}`);
                        return { match: fullMatch, replacement: `<!-- ERROR PROCESSING WIKI IMAGE: ${imageName} -->` };
                    })
            );
        }

        // Gather promises for markdown-style images
        for (const match of processedContent.matchAll(markdownImageRegex)) {
            const fullMatch = match[0];
            const altText = match[1].trim();
            const imagePath = match[2].trim();
             this.debug(`Found markdown image reference (post-masking): ${fullMatch}`);
            if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
                this.debug(`Skipping external image: ${imagePath}`);
                continue;
            }
            imagePromises.push(
                this.handleImage(file, imagePath, altText)
                    .then(hugoImageMarkdown => ({ match: fullMatch, replacement: hugoImageMarkdown }))
                    .catch(error => {
                        this.debug(`Error handling markdown image ${imagePath}: ${error.message}`);
                        return { match: fullMatch, replacement: `<!-- ERROR PROCESSING MARKDOWN IMAGE: ${imagePath} -->` };
                    })
            );
        }

        // Wait for all image processing to complete
        const imageResults = await Promise.all(imagePromises);

        // Replace image syntax with Hugo links (descending order to avoid index issues)
        imageResults.sort((a, b) => (processedContent.lastIndexOf(b.match) - processedContent.lastIndexOf(a.match)));
        for (const result of imageResults) {
            // Check if the match still exists; simple replace might fail with overlapping matches
            const index = processedContent.lastIndexOf(result.match);
            if (index !== -1) {
                 // More robust replacement using index
                processedContent = processedContent.substring(0, index) + result.replacement + processedContent.substring(index + result.match.length);
                this.debug(`Replaced image match ${result.match} with ${result.replacement}`);
            } else {
                 this.debug(`Skipped image replacement for ${result.match} as it was no longer found (index ${index})`);
            }
        }

        // --- STEP 4: Process Wikilinks on Masked Content ---
        // Regex explanation:
        // \[\[         -> Match [[ literally
        // ([^|\]\n]+) -> Capture group 1: Link target (anything not |, ], or newline)
        // (\|          -> Optional Capture group 2: Starts with |
        // [^\]\n]+    -> Display text (anything not ] or newline)
        // )?           -> Makes group 2 optional
        // \]\]         -> Match ]] literally
        const wikilinkRegex = /\[\[([^|\]\n]+?)(\|[^\]\n]+?)?\]\]/g; // Use non-greedy match for target
        processedContent = processedContent.replace(wikilinkRegex, (_, linkTarget, linkTextWithPipe) => {
            const target = linkTarget.trim();
            // Extract text after pipe if it exists, otherwise use the target
            const text = linkTextWithPipe ? linkTextWithPipe.slice(1).trim() : target;

            // Skip processing if it looks like a file path/extension or external URL
            if (/\.\w{2,5}$/.test(target) || target.startsWith('http:') || target.startsWith('https://') || target.startsWith('/')) {
                this.debug(`Skipping wikilink processing for potential file/URL/absolute link: [[${target}]]`);
                // Return the original wikilink syntax
                return `[[${linkTarget}${linkTextWithPipe || ''}]]`;
            }

            const slug = this.slugify(target);
            // Common Hugo structure: /section/slug/ - adjust if needed
            const hugoLink = `[${text}](/posts/${slug}/)`;
            this.debug(`Processed wikilink (post-masking): [[${target}]] -> ${hugoLink}`);
            return hugoLink;
        });


        // --- STEP 5: Restore Inline Code Blocks (in reverse order) ---
        for (let i = inlineCodeBlocks.length - 1; i >= 0; i--) {
            const placeholder = `${placeholderPrefix}_INLINE_${i}%%`;
            // Use function replace to avoid issues with special characters ($&) in the code
             processedContent = processedContent.replace(placeholder, () => inlineCodeBlocks[i]);
            this.debug(`Restored inline code block for placeholder: ${placeholder}`);
        }

        // --- STEP 6: Restore Fenced Code Blocks (in reverse order) ---
        for (let i = fencedCodeBlocks.length - 1; i >= 0; i--) {
            const placeholder = `${placeholderPrefix}_FENCED_${i}%%`;
             processedContent = processedContent.replace(placeholder, () => fencedCodeBlocks[i]);
            this.debug(`Restored fenced code block for placeholder: ${placeholder}`);
        }


        this.debug(`Finished processing content body for: ${file.name}`);
        return processedContent;
    }


    // Handles finding, copying, and generating markdown for a single image
    private async handleImage(sourceNote: TFile, imageNameOrPath: string, altText: string): Promise<string> {
        this.debug(`Handling image: '${imageNameOrPath}' referenced in ${sourceNote.name}`);
        try {
            // Find the absolute path to the source image file within the vault
            const sourceImagePath = await this.findImage(sourceNote, imageNameOrPath);
            this.debug(`Found image source at: ${sourceImagePath}`);

            // Determine the destination filename (use base name to flatten structure)
            const imageBasename = path.basename(imageNameOrPath);
            const safeImageBasename = this.sanitizeFilename(imageBasename);
            const destinationDir = this.resolvePath(this.settings.staticImagesDirectory);
            const destinationPath = path.join(destinationDir, safeImageBasename);
             this.debug(`Image destination path: ${destinationPath}`);

            // Copy the image file to the Hugo static directory
            await this.copyImage(sourceImagePath, destinationPath);

            // Generate the Hugo markdown image link (e.g., ![alt text](/images/image.png))
            const hugoImageUrl = `/images/${encodeURIComponent(safeImageBasename)}`;
            // Use provided alt text, fallback to sanitized filename without extension
            const finalAltText = altText || path.parse(safeImageBasename).name;
            const markdown = `![${finalAltText}](${hugoImageUrl})`;
            this.debug(`Generated Hugo image markdown: ${markdown}`);
            return markdown;

        } catch (error) {
             this.debug(`Image handling failed for '${imageNameOrPath}': ${error.message}`);
            throw new Error(`Failed to process image '${imageNameOrPath}': ${error.message}`);
        }
    }

    // Finds the absolute path of an image file, searching common locations in the correct order
    private async findImage(sourceNote: TFile, imageNameOrPath: string): Promise<string> {
        this.debug(`Searching for image '${imageNameOrPath}' relative to note '${sourceNote.path}'`);
        const vaultBasePath = (this.app.vault.adapter as any).basePath; // Get vault's absolute base path

        // Get components of the source note's path
        const noteDir = path.dirname(sourceNote.path); // e.g., 'posts' or '.' if in root
        const noteBaseName = sourceNote.basename; // e.g., 'N_1'

        // Define potential relative locations to search within the vault
        const searchBases = [
            // 1. Subdirectory named after the note, inside the note's directory (PRIMARY location)
            path.join(noteDir, noteBaseName),
            // 2. Same directory as the note
            noteDir,
            // 3. Vault root
            '',
            // 4. Common attachment folders (relative to vault root)
            'Attachments', // Obsidian default often suggests this
            'assets',
            'images',
            // Add any other custom attachment folders you might use here
            // e.g., 'media', 'files'
        ];
        // Remove duplicates and ensure paths are relative (handle '.' for root)
        const uniqueSearchBases = [...new Set(searchBases)].map(p => (p === '.' ? '' : p));
        this.debug(`Effective search bases relative to vault: [${uniqueSearchBases.map(b => b || '<root>').join(', ')}]`);


        // Check if imageNameOrPath itself appears absolute relative to the vault (starts with /)
        if (imageNameOrPath.startsWith('/')) {
             const absoluteVaultPath = path.join(vaultBasePath, imageNameOrPath.substring(1));
              try {
                  await fs.access(absoluteVaultPath, fs.constants.R_OK);
                  this.debug(`Found image at absolute vault path (treated as root relative): ${absoluteVaultPath}`);
                  return absoluteVaultPath;
              } catch {
                  this.debug(`Image not found at absolute vault path (treated as root relative): ${absoluteVaultPath}`);
              }
        }

        // Iterate through search bases and construct potential absolute paths
        for (const base of uniqueSearchBases) {
            const potentialPath = path.join(vaultBasePath, base, imageNameOrPath);
            try {
                await fs.access(potentialPath, fs.constants.R_OK);
                this.debug(`Found image at (Base: '${base || '<root>'}'): ${potentialPath}`);
                return potentialPath; // Return the first found path
            } catch (err) {
                this.debug(`Image not found at (Base: '${base || '<root>'}'): ${potentialPath}`);
            }
        }

        // Check if imageNameOrPath includes directory separators itself (e.g., "Folder/image.png")
        // This handles cases like ![[Folder/My Image]] or ![alt](Folder/MyImage.png)
         if (imageNameOrPath.includes('/') || imageNameOrPath.includes('\\')) {
             // Try resolving relative to the NOTE'S directory first
             const relativeToNotePath = path.join(vaultBasePath, noteDir, imageNameOrPath);
             try {
                 await fs.access(relativeToNotePath, fs.constants.R_OK);
                 this.debug(`Found image via path relative to note dir: ${relativeToNotePath}`);
                 return relativeToNotePath;
             } catch (err) {
                 this.debug(`Image not found via path relative to note dir: ${relativeToNotePath}`);
             }

            // As a fallback, try resolving it directly relative to the VAULT root
            const directVaultPath = path.join(vaultBasePath, imageNameOrPath);
             try {
                 await fs.access(directVaultPath, fs.constants.R_OK);
                 this.debug(`Found image via direct vault path resolution: ${directVaultPath}`);
                 return directVaultPath;
             } catch (err) {
                 this.debug(`Image not found via direct vault path resolution: ${directVaultPath}`);
             }
         }

        // If all searches fail, throw a detailed error
        const searchedPathsDescription = uniqueSearchBases
            .map(base => `'${path.join(base || '<root>', imageNameOrPath)}'`)
            .join(', ');
        throw new Error(`Image not found: '${imageNameOrPath}'. Searched standard locations based on note '${sourceNote.path}': ${searchedPathsDescription}. Also checked relative/absolute paths.`);
    }


    // Copies an image file from source to destination, creating directories if needed
    private async copyImage(source: string, dest: string): Promise<void> {
        const destDir = path.dirname(dest);
        try {
            // Ensure the destination directory exists
            await fs.mkdir(destDir, { recursive: true });
            this.debug(`Ensured destination directory exists: ${destDir}`);

            // Check if destination file already exists
            let destExists = false;
            try {
                 await fs.access(dest);
                 destExists = true;
            } catch {
                 // Destination file does not exist
            }

            // Optional: Add check to compare file stats (size, mtime) to avoid unnecessary copies
            // For simplicity, this version overwrites if exists, but checks first
            if(destExists) {
                // Simple check: Just log that it exists, could compare stats here
                 this.debug(`Image already exists at destination: ${dest}. Overwriting.`);
                 // To skip copy if exists: return;
            }

            // Copy the file (will overwrite if destExists is true)
            await fs.copyFile(source, dest);
            this.debug(`Successfully copied image from ${source} to ${dest}`);
        } catch (error) {
            this.debug(`Image copy failed: ${error.message}`);
            throw new Error(`Failed to copy image from '${source}' to '${dest}': ${error.message}`);
        }
    }

    // Writes the processed markdown content to the Hugo posts directory
    private async writeHugoFile(originalFile: TFile, content: string): Promise<void> {
        const postsDir = this.resolvePath(this.settings.postsDirectory);
        const safeFilename = this.sanitizeFilename(originalFile.basename) + '.md'; // Use basename and add .md extension
        const destPath = path.join(postsDir, safeFilename);

        this.debug(`Attempting to write Hugo file to: ${destPath}`);

        try {
            // Ensure the Hugo posts directory exists
            await fs.mkdir(postsDir, { recursive: true });
             this.debug(`Ensured posts directory exists: ${postsDir}`);

            // Write the processed content to the destination file
            await fs.writeFile(destPath, content, 'utf8'); // Specify encoding
            // Only show notice here for single-file exports via context menu or command palette
            // Batch exports show summary notice in exportFiles()
            // We need a way to distinguish call contexts if we want different notice behavior
            if (!(this.app.workspace.getActiveFile() !== originalFile && this.getOpenMarkdownFiles().length > 1)) {
                // Simple heuristic: assume batch if active file isn't the one written AND more than one MD file open
                // This isn't perfect. A dedicated flag passed down would be better.
                 this.showNotice(`Exported '${originalFile.name}' to '${safeFilename}'`, 'success');
            }
            this.debug(`Successfully wrote Hugo file: ${destPath}`);
        } catch (error) {
            this.debug(`Error writing Hugo file ${destPath}: ${error.message}`);
            throw new Error(`Failed to write Hugo file '${safeFilename}': ${error.message}`);
        }
    }

    // Converts a string into a URL-friendly slug
    private slugify(text: string): string {
        return text
            .toString()
            .normalize('NFKD') // split accented characters into base characters and diacritics
            .replace(/[\u0300-\u036f]/g, '') // remove diacritics
            .toLowerCase()
            .trim()
            .replace(/[^\w\s-]/g, '') // remove non-word characters (excluding spaces and hyphens)
            .replace(/[\s_-]+/g, '-') // replace spaces and underscores with hyphens
            .replace(/^-+|-+$/g, ''); // remove leading/trailing hyphens
    }

    // Cleans a filename to remove potentially problematic characters for file systems/URLs
    private sanitizeFilename(filename: string): string {
        // Remove potentially problematic characters: <>:"/\|?* and control characters
        // Replace spaces with underscores or hyphens (using hyphen consistent with slugify)
        const sanitized = filename
            .replace(/[\s]+/g, '-') // Replace whitespace with hyphen
            .replace(/[<>:"/\\|?*\x00-\x1F]/g, '') // Remove forbidden characters
            .replace(/-{2,}/g, '-') // Collapse multiple hyphens
            .replace(/^-+|-+$/g, ''); // Trim leading/trailing hyphens

        if (sanitized !== filename) {
            this.debug(`Sanitized filename: '${filename}' -> '${sanitized}'`);
        }
        // Ensure filename isn't empty after sanitization
        return sanitized || 'untitled';
    }


    // Logs messages to the console if debug mode is enabled
    private debug(message: string) {
        if (this.settings.debugMode) {
            console.log(`[Hugo Export DEBUG] ${message}`);
        }
    }

    // Shows an Obsidian notice message
    private showNotice(message: string, type: 'success' | 'error' = 'success', duration: number = 3000) {
        new Notice(message, type === 'error' ? Math.max(duration, 5000) : duration);
    }

    // Handles errors by logging them and showing an error notice
    private handleError(error: Error, context: string) {
        console.error(`[Hugo Export ERROR] ${context}:`, error);
        // Try to provide a more informative message from the error object
        const errorMessage = error.message || 'An unknown error occurred.';
        this.showNotice(`${context}: ${errorMessage}`, 'error');
    }

    // Loads plugin settings from Obsidian's storage
    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        this.debug("Settings loaded.");
    }

    // Saves plugin settings to Obsidian's storage
    async saveSettings() {
        await this.saveData(this.settings);
        this.debug("Settings saved.");
    }
}

// Defines the settings tab for the plugin
class ObsidianHugoExportSettingTab extends PluginSettingTab {
    plugin: ObsidianHugoExportPlugin;

    constructor(app: App, plugin: ObsidianHugoExportPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    // Creates the UI elements for the settings tab
    display(): void {
        const { containerEl } = this;
        containerEl.empty(); // Clear previous settings elements

        containerEl.createEl('h2', { text: 'Hugo Export Settings' });

        // Setting for Hugo Posts Directory
        this.addDirectorySetting(
            containerEl,
            'Hugo Posts Directory',
            'path to your Hugo `content/posts`',
            'postsDirectory'
        );

        // Setting for Hugo Static Images Directory
        this.addDirectorySetting(
            containerEl,
            'Hugo Static Images Directory',
            'path to your Hugo `static/images`',
            'staticImagesDirectory'
        );

        // Setting for Debug Mode
        new Setting(containerEl)
            .setName('Debug Mode')
            .setDesc('Enable detailed logging in the developer console (requires reopening dev console or reloading Obsidian).')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.debugMode)
                .onChange(async (value) => {
                    this.plugin.settings.debugMode = value;
                    await this.plugin.saveSettings();
                    this.plugin.debug(`Debug mode toggled: ${value}`);
                }));
    }

    // Helper function to create a directory setting input field with resolved path display
    private addDirectorySetting(containerEl: HTMLElement, name: string, desc: string, key: keyof ObsidianHugoExportSettings) {
        const setting = new Setting(containerEl)
            .setName(name)
            .setDesc(desc)
            .addText(text => {
                text.setPlaceholder(DEFAULT_SETTINGS[key])
                    .setValue(this.plugin.settings[key])
                    .onChange(async (value) => {
                        this.plugin.settings[key] = value.trim();
                        await this.plugin.saveSettings();
                        // Re-render the entire settings tab to update the resolved path display
                        this.display();
                    });
                text.inputEl.style.width = '100%';
            });

        // Add display for the resolved path below the input
        const resolvedPathContainer = setting.controlEl.createDiv({
             cls: 'setting-item-description',
             attr: { style: 'font-size: 0.9em; opacity: 0.8; margin-top: 5px;' }
        });

        try {
            const resolved = this.plugin.resolvePath(this.plugin.settings[key]);
            resolvedPathContainer.setText(`Resolved path: ${resolved}`);
            // Optionally check if path exists or is accessible (async check might be slow here)
            // fs.access(resolved, fs.constants.W_OK).catch(err => {
            //    resolvedPathContainer.style.color = 'var(--text-error)';
            //    resolvedPathContainer.setText(`Resolved path: ${resolved} (Warning: Not accessible/writable - ${err.code})`);
            // });
        } catch (e) {
             resolvedPathContainer.setText(`Error resolving path: ${e.message}`);
             resolvedPathContainer.style.color = 'var(--text-error)';
        }
    }
}
