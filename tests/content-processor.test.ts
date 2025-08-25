import { TFile } from 'obsidian';
import { MarkdownProcessor, TextProcessor, ContentProcessorFactory } from '../src/content-processor';

// Mock TFile and Vault
const mockTFile = (extension: string, path: string): TFile => ({
    extension,
    path,
    stat: { mtime: Date.now(), size: 100, ctime: Date.now() }
} as TFile);

const mockVault = {
    read: jest.fn()
};

describe('ContentProcessor', () => {
    describe('MarkdownProcessor', () => {
        const processor = new MarkdownProcessor();

        it('should process markdown files', () => {
            const file = mockTFile('md', 'test.md');
            expect(processor.canProcess(file)).toBe(true);
        });

        it('should not process non-markdown files', () => {
            const file = mockTFile('txt', 'test.txt');
            expect(processor.canProcess(file)).toBe(false);
        });

        it('should extract frontmatter', async () => {
            const file = mockTFile('md', 'test.md');
            const content = `---
title: Test Document
tags: test, example
---

# Test Content

This is a test document.`;
            
            mockVault.read.mockResolvedValue(content);
            
            const result = await processor.process(file, mockVault as any);
            
            expect(result.content).toBe('# Test Content\n\nThis is a test document.');
            expect(result.metadata.frontmatter).toEqual({
                title: 'Test Document',
                tags: 'test, example'
            });
            expect(result.metadata.type).toBe('markdown');
        });

        it('should handle documents without frontmatter', async () => {
            const file = mockTFile('md', 'test.md');
            const content = `# Test Content

This is a test document.`;
            
            mockVault.read.mockResolvedValue(content);
            
            const result = await processor.process(file, mockVault as any);
            
            expect(result.content).toBe('# Test Content\n\nThis is a test document.');
            expect(result.metadata.frontmatter).toEqual({});
        });
    });

    describe('TextProcessor', () => {
        const processor = new TextProcessor();

        it('should process text files', () => {
            const file = mockTFile('txt', 'test.txt');
            expect(processor.canProcess(file)).toBe(true);
        });

        it('should process plain text content', async () => {
            const file = mockTFile('txt', 'test.txt');
            const content = 'This is plain text content.';
            
            mockVault.read.mockResolvedValue(content);
            
            const result = await processor.process(file, mockVault as any);
            
            expect(result.content).toBe(content);
            expect(result.metadata.type).toBe('text');
            expect(result.metadata.extension).toBe('txt');
        });
    });

    describe('ContentProcessorFactory', () => {
        const factory = new ContentProcessorFactory();

        it('should return markdown processor for .md files', () => {
            const file = mockTFile('md', 'test.md');
            const processor = factory.getProcessor(file);
            expect(processor).toBeInstanceOf(MarkdownProcessor);
        });

        it('should return text processor for .txt files', () => {
            const file = mockTFile('txt', 'test.txt');
            const processor = factory.getProcessor(file);
            expect(processor).toBeInstanceOf(TextProcessor);
        });

        it('should return null for unsupported file types', () => {
            const file = mockTFile('xyz', 'test.xyz');
            const processor = factory.getProcessor(file);
            expect(processor).toBeNull();
        });

        it('should handle processing errors gracefully', async () => {
            const file = mockTFile('md', 'test.md');
            mockVault.read.mockRejectedValue(new Error('File not found'));
            
            const result = await factory.processFile(file, mockVault as any);
            
            expect(result).not.toBeNull();
            expect(result!.content).toBe('');
            expect(result!.metadata.processingError).toBe('File not found');
        });
    });
});
