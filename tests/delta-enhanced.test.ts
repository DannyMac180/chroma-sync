import { DeltaEngine, FileState } from '../src/delta';

describe('DeltaEngine Enhanced Features', () => {
    let deltaEngine: DeltaEngine;
    
    // Mock vault
    const mockVault = {
        getFiles: jest.fn(() => []),
        getAbstractFileByPath: jest.fn(),
        read: jest.fn()
    };

    beforeEach(() => {
        deltaEngine = new DeltaEngine(mockVault as any, ['**/*.md'], ['**/.obsidian/**']);
    });

    describe('Partial sync tracking', () => {
        it('should mark files as failed', () => {
            const initialState: FileState = {
                files: {},
                lastSync: Date.now(),
                version: 1
            };

            const failedFiles = ['file1.md', 'file2.md'];
            const updatedState = deltaEngine.markFilesFailed(initialState, failedFiles);

            expect(updatedState.partialSync).toBeDefined();
            expect(updatedState.partialSync!.failedFiles).toEqual(failedFiles);
            expect(updatedState.partialSync!.retryCount['file1.md']).toBe(1);
            expect(updatedState.partialSync!.retryCount['file2.md']).toBe(1);
        });

        it('should increment retry count for repeated failures', () => {
            let state: FileState = {
                files: {},
                lastSync: Date.now(),
                version: 1
            };

            // First failure
            state = deltaEngine.markFilesFailed(state, ['file1.md']);
            expect(state.partialSync!.retryCount['file1.md']).toBe(1);

            // Second failure
            state = deltaEngine.markFilesFailed(state, ['file1.md']);
            expect(state.partialSync!.retryCount['file1.md']).toBe(2);
        });

        it('should remove files from failed tracking on success', () => {
            let state: FileState = {
                files: {},
                lastSync: Date.now(),
                version: 1,
                partialSync: {
                    failedFiles: ['file1.md', 'file2.md'],
                    retryCount: { 'file1.md': 1, 'file2.md': 2 },
                    lastFailure: Date.now()
                }
            };

            const succeededFiles = ['file1.md'];
            const updatedState = deltaEngine.markFilesSucceeded(state, succeededFiles);

            expect(updatedState.partialSync!.failedFiles).toEqual(['file2.md']);
            expect(updatedState.partialSync!.retryCount['file1.md']).toBeUndefined();
            expect(updatedState.partialSync!.retryCount['file2.md']).toBe(2);
        });

        it('should clear partial sync state when all files succeed', () => {
            let state: FileState = {
                files: {},
                lastSync: Date.now(),
                version: 1,
                partialSync: {
                    failedFiles: ['file1.md'],
                    retryCount: { 'file1.md': 1 },
                    lastFailure: Date.now()
                }
            };

            const updatedState = deltaEngine.markFilesSucceeded(state, ['file1.md']);
            expect(updatedState.partialSync).toBeUndefined();
        });

        it('should get retryable files within retry limit', () => {
            const state: FileState = {
                files: {},
                lastSync: Date.now(),
                version: 1,
                partialSync: {
                    failedFiles: ['file1.md', 'file2.md', 'file3.md'],
                    retryCount: { 'file1.md': 1, 'file2.md': 2, 'file3.md': 5 },
                    lastFailure: Date.now()
                }
            };

            const retryableFiles = deltaEngine.getRetryableFiles(state, 3);
            expect(retryableFiles).toEqual(['file1.md', 'file2.md']); // file3.md exceeds retry limit
        });
    });

    describe('Verification state tracking', () => {
        it('should update verification state to verified', () => {
            const initialState: FileState = {
                files: {},
                lastSync: Date.now(),
                version: 1
            };

            const updatedState = deltaEngine.updateVerificationState(initialState, 'verified');

            expect(updatedState.chromaState).toBeDefined();
            expect(updatedState.chromaState!.verificationStatus).toBe('verified');
            expect(updatedState.chromaState!.lastVerification).toBeGreaterThan(0);
        });

        it('should update verification state with inconsistencies', () => {
            const initialState: FileState = {
                files: {},
                lastSync: Date.now(),
                version: 1
            };

            const inconsistencies = {
                missingInChroma: ['file1.md'],
                extraInChroma: ['old-file.md']
            };

            const updatedState = deltaEngine.updateVerificationState(
                initialState,
                'inconsistent',
                inconsistencies
            );

            expect(updatedState.chromaState!.verificationStatus).toBe('inconsistent');
            expect(updatedState.chromaState!.inconsistencies).toEqual({
                ...inconsistencies,
                lastChecked: expect.any(Number)
            });
        });

        it('should detect when verification is needed (never verified)', () => {
            const state: FileState = {
                files: {},
                lastSync: Date.now(),
                version: 1
            };

            expect(deltaEngine.needsVerification(state)).toBe(true);
        });

        it('should detect when verification is needed (old verification)', () => {
            const oldTimestamp = Date.now() - (25 * 60 * 60 * 1000); // 25 hours ago
            const state: FileState = {
                files: {},
                lastSync: Date.now(),
                version: 1,
                chromaState: {
                    lastVerification: oldTimestamp,
                    verificationStatus: 'verified'
                }
            };

            expect(deltaEngine.needsVerification(state)).toBe(true);
        });

        it('should detect when verification is not needed (recent verification)', () => {
            const recentTimestamp = Date.now() - (1 * 60 * 60 * 1000); // 1 hour ago
            const state: FileState = {
                files: {},
                lastSync: Date.now(),
                version: 1,
                chromaState: {
                    lastVerification: recentTimestamp,
                    verificationStatus: 'verified'
                }
            };

            expect(deltaEngine.needsVerification(state)).toBe(false);
        });
    });
});
