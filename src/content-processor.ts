import { TFile, Vault } from 'obsidian';

export interface ProcessedContent {
	content: string;
	metadata: Record<string, any>;
	chunks?: ContentChunk[];
}

export interface ContentChunk {
	id: string;
	content: string;
	metadata: Record<string, any>;
}

export interface ContentProcessor {
	canProcess(file: TFile): boolean;
	process(file: TFile, vault: Vault): Promise<ProcessedContent>;
}

/**
 * Base processor for text files
 */
export class TextProcessor implements ContentProcessor {
	canProcess(file: TFile): boolean {
		return file.extension === 'txt';
	}

	async process(file: TFile, vault: Vault): Promise<ProcessedContent> {
		const content = await vault.read(file);
		
		return {
			content,
			metadata: {
				path: file.path,
				extension: file.extension,
				type: 'text',
				mtime: file.stat.mtime,
				size: file.stat.size,
			}
		};
	}
}

/**
 * Processor for Markdown files with frontmatter support
 */
export class MarkdownProcessor implements ContentProcessor {
	canProcess(file: TFile): boolean {
		return file.extension === 'md';
	}

	async process(file: TFile, vault: Vault): Promise<ProcessedContent> {
		const rawContent = await vault.read(file);
		const { content, frontmatter } = this.extractFrontmatter(rawContent, file.path);
		
		return {
			content: content.trim(),
			metadata: {
				path: file.path,
				extension: file.extension,
				type: 'markdown',
				mtime: file.stat.mtime,
				size: file.stat.size,
				frontmatter,
				...frontmatter // Flatten frontmatter into metadata
			}
		};
	}

	private extractFrontmatter(content: string, filePath?: string): { content: string; frontmatter: Record<string, any> } {
		// Simple frontmatter extraction (YAML between ---)
		const frontmatterRegex = /^---\s*\n(.*?)\n---\s*\n(.*)$/s;
		const match = content.match(frontmatterRegex);
		
		if (!match) {
			return { content, frontmatter: {} };
		}

		try {
			// Basic YAML parsing (key: value pairs)
			const yamlContent = match[1];
			const frontmatter: Record<string, any> = {};
			
			const lines = yamlContent.split('\n');
			for (const line of lines) {
				const colonIndex = line.indexOf(':');
				if (colonIndex > 0) {
					const key = line.substring(0, colonIndex).trim();
					const value = line.substring(colonIndex + 1).trim();
					
					// Remove quotes if present
					const cleanValue = value.replace(/^["']|["']$/g, '');
					frontmatter[key] = cleanValue;
				}
			}
			
			return {
				content: match[2],
				frontmatter
			};
		} catch (error) {
			console.warn(`Failed to parse frontmatter in ${filePath || 'unknown'}:`, error);
			return { content, frontmatter: {} };
		}
	}
}

/**
 * Processor for PDF files (requires Python backend)
 */
export class PDFProcessor implements ContentProcessor {
	private extractionEnabled: boolean = true;

	canProcess(file: TFile): boolean {
		return file.extension === 'pdf';
	}

	async process(file: TFile, vault: Vault): Promise<ProcessedContent> {
		if (!this.extractionEnabled) {
			return {
				content: '',
				metadata: {
					path: file.path,
					extension: file.extension,
					type: 'pdf',
					mtime: file.stat.mtime,
					size: file.stat.size,
					extractionError: 'PDF extraction not available'
				}
			};
		}

		// For now, return placeholder - actual extraction happens in Python
		return {
			content: '[PDF_CONTENT_PLACEHOLDER]',
			metadata: {
				path: file.path,
				extension: file.extension,
				type: 'pdf',
				mtime: file.stat.mtime,
				size: file.stat.size,
				requiresExtraction: true
			}
		};
	}

	setExtractionEnabled(enabled: boolean): void {
		this.extractionEnabled = enabled;
	}
}

/**
 * Processor for image files (requires OCR backend)
 */
export class ImageProcessor implements ContentProcessor {
	private ocrEnabled: boolean = false;

	canProcess(file: TFile): boolean {
		return ['png', 'jpg', 'jpeg', 'gif', 'bmp'].includes(file.extension.toLowerCase());
	}

	async process(file: TFile, vault: Vault): Promise<ProcessedContent> {
		const baseMetadata = {
			path: file.path,
			extension: file.extension,
			type: 'image',
			mtime: file.stat.mtime,
			size: file.stat.size,
		};

		if (!this.ocrEnabled) {
			return {
				content: '',
				metadata: {
					...baseMetadata,
					ocrError: 'OCR not available'
				}
			};
		}

		// For now, return placeholder - actual OCR happens in Python
		return {
			content: '[IMAGE_OCR_PLACEHOLDER]',
			metadata: {
				...baseMetadata,
				requiresOCR: true
			}
		};
	}

	setOCREnabled(enabled: boolean): void {
		this.ocrEnabled = enabled;
	}
}

/**
 * Factory for content processors
 */
export class ContentProcessorFactory {
	private processors: ContentProcessor[];

	constructor() {
		this.processors = [
			new MarkdownProcessor(),
			new TextProcessor(),
			new PDFProcessor(),
			new ImageProcessor(),
		];
	}

	/**
	 * Get the appropriate processor for a file
	 */
	getProcessor(file: TFile): ContentProcessor | null {
		for (const processor of this.processors) {
			if (processor.canProcess(file)) {
				return processor;
			}
		}
		return null;
	}

	/**
	 * Process a file with the appropriate processor
	 */
	async processFile(file: TFile, vault: Vault): Promise<ProcessedContent | null> {
		const processor = this.getProcessor(file);
		if (!processor) {
			return null;
		}

		try {
			return await processor.process(file, vault);
		} catch (error) {
			console.error(`Failed to process file ${file.path}:`, error);
			return {
				content: '',
				metadata: {
					path: file.path,
					extension: file.extension,
					type: 'unknown',
					mtime: file.stat.mtime,
					size: file.stat.size,
					processingError: (error as Error).message
				}
			};
		}
	}

	/**
	 * Enable/disable PDF extraction
	 */
	setPDFExtractionEnabled(enabled: boolean): void {
		const pdfProcessor = this.processors.find(p => p instanceof PDFProcessor) as PDFProcessor;
		if (pdfProcessor) {
			pdfProcessor.setExtractionEnabled(enabled);
		}
	}

	/**
	 * Enable/disable OCR
	 */
	setOCREnabled(enabled: boolean): void {
		const imageProcessor = this.processors.find(p => p instanceof ImageProcessor) as ImageProcessor;
		if (imageProcessor) {
			imageProcessor.setOCREnabled(enabled);
		}
	}
}
