import { createHash } from 'crypto';

export interface ChunkerOptions {
	maxLen?: number;          // hard ceiling per chunk (default 1000 chars)
	targetLen?: number;       // soft goal before looking for a boundary (default 800)
	overlap?: number;         // trailing characters to repeat (default 200)
}

export interface SourceDocument {
	id: string;               // vault-wide stable doc id
	mime: 'markdown' | 'text' | 'pdf';
	content: string;          // raw text (PDF already extracted)
	updatedAt: number;        // ms epoch – used for change detection
}

export interface DocumentChunk {
	id: string;               // stable across edits when text unchanged
	parentId: string;
	content: string;          // chunk text incl. front overlap
	start: number;            // 0-based char index in parent
	end: number;              // exclusive index in parent
	hash: string;             // sha1(content) – quick re-index check
	meta: {
		overlapWithPrev: boolean;
		overlapWithNext: boolean;
		mime: SourceDocument['mime'];
		parentPath?: string;
		headings?: string[];
		order: number;
		updatedAt: number;
	};
}

interface TokenChunk {
	start: number;
	end: number;
	type: string;
	content: string;
}

const DEFAULT_OPTIONS: Required<ChunkerOptions> = {
	maxLen: 1000,
	targetLen: 800,
	overlap: 200,
};

export class DocumentChunker {
	private options: Required<ChunkerOptions>;

	constructor(options: ChunkerOptions = {}) {
		this.options = { ...DEFAULT_OPTIONS, ...options };
	}

	/**
	 * Main entry point - chunk a document into semantic segments
	 */
	async *chunkDocument(doc: SourceDocument): AsyncGenerator<DocumentChunk> {
		if (doc.content.length <= this.options.maxLen) {
			// Small document - return as single chunk
			yield this.createSingleChunk(doc);
			return;
		}

		const tokens = this.tokenizeDocument(doc);
		let chunkIndex = 0;
		
		for await (const chunk of this.processTokens(doc, tokens)) {
			chunk.meta.order = chunkIndex++;
			yield chunk;
		}
	}

	/**
	 * Create a single chunk for small documents
	 */
	private createSingleChunk(doc: SourceDocument): DocumentChunk {
		const hash = this.hashContent(doc.content);
		
		return {
			id: `${doc.id}:${hash.slice(0, 12)}`,
			parentId: doc.id,
			content: doc.content,
			start: 0,
			end: doc.content.length,
			hash,
			meta: {
				overlapWithPrev: false,
				overlapWithNext: false,
				mime: doc.mime,
				headings: this.extractHeadings(doc.content, 0),
				order: 0,
				updatedAt: doc.updatedAt,
			}
		};
	}

	/**
	 * Tokenize document into semantic units that shouldn't be split
	 */
	private tokenizeDocument(doc: SourceDocument): TokenChunk[] {
		if (doc.mime === 'markdown') {
			return this.tokenizeMarkdown(doc.content);
		} else {
			return this.tokenizePlainText(doc.content);
		}
	}

	/**
	 * Tokenize markdown content preserving structure
	 */
	private tokenizeMarkdown(content: string): TokenChunk[] {
		const tokens: TokenChunk[] = [];
		const lines = content.split('\n');
		let currentPos = 0;

		let i = 0;
		while (i < lines.length) {
			const line = lines[i];
			const lineStart = currentPos;
			const lineEnd = currentPos + line.length + 1; // +1 for newline

			// Check for code fences
			if (line.trim().startsWith('```')) {
				const codeBlock = this.extractCodeBlock(lines, i);
				const blockContent = codeBlock.lines.join('\n');
				tokens.push({
					start: lineStart,
					end: currentPos + blockContent.length,
					type: 'code_fence',
					content: blockContent
				});
				i += codeBlock.lineCount;
				currentPos += blockContent.length + 1;
				continue;
			}

			// Check for headings
			if (line.trim().match(/^#{1,6}\s+/)) {
				tokens.push({
					start: lineStart,
					end: lineEnd - 1,
					type: 'heading',
					content: line
				});
			}
			// Check for list items
			else if (line.trim().match(/^[-*+]\s+/) || line.trim().match(/^\d+\.\s+/)) {
				// Collect multi-line list item
				const listItem = this.extractListItem(lines, i);
				tokens.push({
					start: lineStart,
					end: currentPos + listItem.content.length,
					type: 'list_item',
					content: listItem.content
				});
				i += listItem.lineCount;
				currentPos += listItem.content.length + 1;
				continue;
			}
			// Regular paragraph
			else if (line.trim()) {
				// Collect full paragraph (until blank line)
				const paragraph = this.extractParagraph(lines, i);
				tokens.push({
					start: lineStart,
					end: currentPos + paragraph.content.length,
					type: 'paragraph',
					content: paragraph.content
				});
				i += paragraph.lineCount;
				currentPos += paragraph.content.length + 1;
				continue;
			}
			// Blank line
			else {
				tokens.push({
					start: lineStart,
					end: lineEnd - 1,
					type: 'blank',
					content: line
				});
			}

			currentPos = lineEnd;
			i++;
		}

		return tokens;
	}

	/**
	 * Extract complete code block
	 */
	private extractCodeBlock(lines: string[], startIndex: number): { lines: string[]; lineCount: number } {
		const codeLines = [lines[startIndex]]; // Include opening fence
		let i = startIndex + 1;
		
		while (i < lines.length) {
			codeLines.push(lines[i]);
			if (lines[i].trim().startsWith('```')) {
				// Found closing fence
				break;
			}
			i++;
		}

		return {
			lines: codeLines,
			lineCount: codeLines.length
		};
	}

	/**
	 * Extract complete list item (may span multiple lines)
	 */
	private extractListItem(lines: string[], startIndex: number): { content: string; lineCount: number } {
		const itemLines = [lines[startIndex]];
		let i = startIndex + 1;
		
		// Continue while lines are indented (continuation of list item)
		while (i < lines.length && (lines[i].startsWith('  ') || lines[i].trim() === '')) {
			itemLines.push(lines[i]);
			if (lines[i].trim() === '') {
				// Check if next line starts new item
				if (i + 1 < lines.length && 
					(lines[i + 1].trim().match(/^[-*+]\s+/) || lines[i + 1].trim().match(/^\d+\.\s+/))) {
					break;
				}
			}
			i++;
		}

		return {
			content: itemLines.join('\n'),
			lineCount: itemLines.length
		};
	}

	/**
	 * Extract complete paragraph (until blank line)
	 */
	private extractParagraph(lines: string[], startIndex: number): { content: string; lineCount: number } {
		const paragraphLines = [lines[startIndex]];
		let i = startIndex + 1;
		
		while (i < lines.length && lines[i].trim()) {
			// Stop if we hit a special markdown element
			if (lines[i].trim().match(/^#{1,6}\s+/) || 
				lines[i].trim().match(/^[-*+]\s+/) || 
				lines[i].trim().match(/^\d+\.\s+/) ||
				lines[i].trim().startsWith('```')) {
				break;
			}
			paragraphLines.push(lines[i]);
			i++;
		}

		return {
			content: paragraphLines.join('\n'),
			lineCount: paragraphLines.length
		};
	}

	/**
	 * Simple plain text tokenization by paragraphs
	 */
	private tokenizePlainText(content: string): TokenChunk[] {
		const tokens: TokenChunk[] = [];
		const paragraphs = content.split(/\n\s*\n/);
		let currentPos = 0;

		for (const paragraph of paragraphs) {
			if (paragraph.trim()) {
				tokens.push({
					start: currentPos,
					end: currentPos + paragraph.length,
					type: 'paragraph',
					content: paragraph
				});
			}
			currentPos += paragraph.length + 2; // +2 for double newline
		}

		return tokens;
	}

	/**
	 * Process tokens into chunks using boundary selection algorithm
	 */
	private async *processTokens(doc: SourceDocument, tokens: TokenChunk[]): AsyncGenerator<DocumentChunk> {
		let buffer: TokenChunk[] = [];
		let bufferLen = 0;
		let overlapBuffer = '';
		let chunkStart = 0;

		for (const token of tokens) {
			// Check if adding this token would exceed maxLen
			if (bufferLen + token.content.length > this.options.maxLen) {
				// Finalize current chunk if we have content
				if (buffer.length > 0) {
					const chunk = this.finalizeChunk(doc, buffer, chunkStart, overlapBuffer);
					if (chunk) yield chunk;

					// Prepare overlap for next chunk
					const result = this.prepareOverlap(buffer);
					overlapBuffer = result.overlapContent;
					chunkStart = result.nextStart;
					buffer = result.nextBuffer;
					bufferLen = result.nextBufferLen;
				}
			}

			// Add token to buffer
			buffer.push(token);
			bufferLen += token.content.length;

			// Check if we've reached target length and can break
			if (bufferLen >= this.options.targetLen) {
				const chunk = this.finalizeChunk(doc, buffer, chunkStart, overlapBuffer);
				if (chunk) yield chunk;

				// Prepare overlap for next chunk
				const result = this.prepareOverlap(buffer);
				overlapBuffer = result.overlapContent;
				chunkStart = result.nextStart;
				buffer = result.nextBuffer;
				bufferLen = result.nextBufferLen;
			}
		}

		// Finalize remaining buffer
		if (buffer.length > 0) {
			const chunk = this.finalizeChunk(doc, buffer, chunkStart, overlapBuffer);
			if (chunk) yield chunk;
		}
	}

	/**
	 * Create a chunk from token buffer
	 */
	private finalizeChunk(doc: SourceDocument, buffer: TokenChunk[], start: number, overlapContent: string): DocumentChunk | null {
		if (buffer.length === 0) return null;

		const chunkContent = (overlapContent ? overlapContent + '\n' : '') + 
			buffer.map(token => token.content).join('\n');
		const hash = this.hashContent(chunkContent);
		const end = buffer[buffer.length - 1].end;

		return {
			id: `${doc.id}:${hash.slice(0, 12)}`,
			parentId: doc.id,
			content: chunkContent,
			start,
			end,
			hash,
			meta: {
				overlapWithPrev: overlapContent.length > 0,
				overlapWithNext: true, // We don't know yet - will be updated if this is the last chunk
				mime: doc.mime,
				headings: this.extractHeadings(doc.content, start),
				order: 0, // Will be set by caller
				updatedAt: doc.updatedAt,
			}
		};
	}

	/**
	 * Prepare overlap content for next chunk
	 */
	private prepareOverlap(buffer: TokenChunk[]): {
		overlapContent: string;
		nextStart: number;
		nextBuffer: TokenChunk[];
		nextBufferLen: number;
	} {
		if (buffer.length === 0) {
			return {
				overlapContent: '',
				nextStart: 0,
				nextBuffer: [],
				nextBufferLen: 0
			};
		}

		const fullContent = buffer.map(token => token.content).join('\n');
		let overlapContent = '';
		let overlapTokens: TokenChunk[] = [];
		let remainingOverlap = this.options.overlap;

		// Take tokens from the end until we have enough overlap
		for (let i = buffer.length - 1; i >= 0 && remainingOverlap > 0; i--) {
			const token = buffer[i];
			if (token.content.length <= remainingOverlap) {
				overlapTokens.unshift(token);
				remainingOverlap -= token.content.length;
			} else {
				// Partial token - avoid breaking atomic units like code blocks
				if (token.type === 'code_fence' || token.type === 'heading') {
					// Don't split these - include the whole token
					overlapTokens.unshift(token);
				} else {
					// For paragraphs, try to split at sentence boundaries
					const partialContent = token.content.slice(-remainingOverlap);
					const sentenceBoundary = this.findSentenceBoundary(partialContent);
					
					if (sentenceBoundary > 0) {
						const adjustedContent = token.content.slice(-sentenceBoundary);
						overlapTokens.unshift({
							...token,
							content: adjustedContent
						});
					}
				}
				break;
			}
		}

		overlapContent = overlapTokens.map(token => token.content).join('\n');
		const lastToken = buffer[buffer.length - 1];

		return {
			overlapContent,
			nextStart: lastToken.end - overlapContent.length,
			nextBuffer: overlapTokens,
			nextBufferLen: overlapContent.length
		};
	}

	/**
	 * Find a good sentence boundary for partial token overlap
	 */
	private findSentenceBoundary(content: string): number {
		// Look for sentence endings with following space or newline
		const sentenceEnds = /[.!?]\s+/g;
		let lastMatch = 0;
		let match;
		
		while ((match = sentenceEnds.exec(content)) !== null) {
			lastMatch = match.index + match[0].length;
		}

		return lastMatch || content.length;
	}

	/**
	 * Extract heading trail for metadata breadcrumbs
	 */
	private extractHeadings(content: string, position: number): string[] {
		const lines = content.substring(0, position).split('\n');
		const headings: string[] = [];
		
		for (const line of lines) {
			const match = line.match(/^(#{1,6})\s+(.+)$/);
			if (match) {
				const level = match[1].length;
				const title = match[2].trim();
				
				// Keep only headings at this level or higher
				while (headings.length > 0) {
					const lastLevel = headings[headings.length - 1].match(/^#{1,6}/)?.[0].length || 0;
					if (lastLevel < level) break;
					headings.pop();
				}
				
				headings.push(`${'#'.repeat(level)} ${title}`);
			}
		}

		return headings;
	}

	/**
	 * Generate SHA1 hash of content for stable chunk IDs
	 */
	private hashContent(content: string): string {
		return createHash('sha1').update(content, 'utf8').digest('hex');
	}

	/**
	 * Check if document needs chunking
	 */
	static needsChunking(content: string, options: ChunkerOptions = {}): boolean {
		const opts = { ...DEFAULT_OPTIONS, ...options };
		return content.length > opts.maxLen;
	}

	/**
	 * Quick hash check to see if document has changed
	 */
	static documentHash(content: string): string {
		return createHash('sha1').update(content, 'utf8').digest('hex');
	}
}
