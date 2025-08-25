import { SyncStateManager, SyncState } from '../src/sync-state';
import { DeltaAction } from '../src/delta';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

describe('SyncStateManager', () => {
	let stateManager: SyncStateManager;
	let testDataPath: string;

	beforeEach(() => {
		testDataPath = join(__dirname, 'test-sync-data');
		
		// Clean up any existing test data
		if (existsSync(testDataPath)) {
			rmSync(testDataPath, { recursive: true, force: true });
		}
		
		mkdirSync(testDataPath, { recursive: true });
		stateManager = new SyncStateManager(testDataPath);
	});

	afterEach(() => {
		// Clean up test data
		if (existsSync(testDataPath)) {
			rmSync(testDataPath, { recursive: true, force: true });
		}
	});

	const createTestActions = (count: number = 10): DeltaAction[] => {
		return Array.from({ length: count }, (_, i) => ({
			action: 'upsert' as const,
			id: `doc_${i}`,
			path: `test/file_${i}.md`,
			text: `Test content ${i}`,
			metadata: {
				path: `test/file_${i}.md`,
				mtime: Date.now(),
				size: 100,
				type: 'file',
				extension: 'md'
			}
		}));
	};

	describe('Session Management', () => {
		test('should initialize a new session', () => {
			const actions = createTestActions(5);
			const session = stateManager.initializeSession(actions, 2);

			expect(session.id).toBeDefined();
			expect(session.state).toBe('running');
			expect(session.totalActions).toBe(5);
			expect(session.processedActions).toBe(0);
			expect(session.remainingActions).toHaveLength(5);
			expect(session.batchSize).toBe(2);
		});

		test('should get next batch correctly', () => {
			const actions = createTestActions(5);
			stateManager.initializeSession(actions, 2);

			const { actions: batch1, hasMore: hasMore1 } = stateManager.getNextBatch();
			expect(batch1).toHaveLength(2);
			expect(hasMore1).toBe(true);
			expect(batch1[0].id).toBe('doc_0');
			expect(batch1[1].id).toBe('doc_1');

			// Complete the first batch
			stateManager.completeBatch(batch1);

			const { actions: batch2, hasMore: hasMore2 } = stateManager.getNextBatch();
			expect(batch2).toHaveLength(2);
			expect(hasMore2).toBe(true);
			expect(batch2[0].id).toBe('doc_2');
			expect(batch2[1].id).toBe('doc_3');

			// Complete the second batch
			stateManager.completeBatch(batch2);

			const { actions: batch3, hasMore: hasMore3 } = stateManager.getNextBatch();
			expect(batch3).toHaveLength(1);
			expect(hasMore3).toBe(false);
			expect(batch3[0].id).toBe('doc_4');
		});

		test('should track completion progress', () => {
			const actions = createTestActions(10);
			stateManager.initializeSession(actions, 3);

			const batch1 = stateManager.getNextBatch().actions;
			stateManager.completeBatch(batch1);

			const progress1 = stateManager.getProgress();
			expect(progress1?.processed).toBe(3);
			expect(progress1?.total).toBe(10);
			expect(progress1?.percentage).toBe(30);
			expect(progress1?.remaining).toBe(7);

			const batch2 = stateManager.getNextBatch().actions;
			stateManager.completeBatch(batch2);

			const progress2 = stateManager.getProgress();
			expect(progress2?.processed).toBe(6);
			expect(progress2?.percentage).toBe(60);
			expect(progress2?.remaining).toBe(4);
		});
	});

	describe('Pause/Resume Functionality', () => {
		test('should pause and resume sessions', () => {
			const actions = createTestActions(5);
			stateManager.initializeSession(actions, 2);

			// Should be able to pause running session
			expect(stateManager.canPause()).toBe(true);
			expect(stateManager.canResume()).toBe(false);

			const pauseResult = stateManager.pauseSession();
			expect(pauseResult).toBe(true);

			const session = stateManager.getCurrentSession();
			expect(session?.state).toBe('paused');

			// Should be able to resume paused session
			expect(stateManager.canPause()).toBe(false);
			expect(stateManager.canResume()).toBe(true);

			const resumeResult = stateManager.resumeSession();
			expect(resumeResult).toBe(true);

			const resumedSession = stateManager.getCurrentSession();
			expect(resumedSession?.state).toBe('running');
			expect(resumedSession?.resumeTime).toBeDefined();
		});

		test('should stop sessions', () => {
			const actions = createTestActions(5);
			stateManager.initializeSession(actions, 2);

			expect(stateManager.canStop()).toBe(true);

			const stopResult = stateManager.stopSession();
			expect(stopResult).toBe(true);

			const session = stateManager.getCurrentSession();
			expect(session?.state).toBe('stopping');
		});
	});

	describe('Session Persistence', () => {
		test('should persist and load session state', () => {
			const actions = createTestActions(5);
			const session = stateManager.initializeSession(actions, 2);

			// Process one batch
			const batch = stateManager.getNextBatch().actions;
			stateManager.completeBatch(batch);
			
			// Pause the session
			stateManager.pauseSession();

			// Create a new state manager (simulating plugin reload)
			const newStateManager = new SyncStateManager(testDataPath);
			
			// Initialize with same actions should resume from existing session
			const resumedSession = newStateManager.initializeSession(actions, 2);
			
			expect(resumedSession.id).toBe(session.id);
			expect(resumedSession.processedActions).toBe(2);
			expect(resumedSession.remainingActions).toHaveLength(3);
			expect(resumedSession.state).toBe('running');
		});

		test('should handle corrupted session files gracefully', () => {
			const actions = createTestActions(3);
			stateManager.initializeSession(actions, 2);

			// Corrupt the session file
			const sessionPath = join(testDataPath, 'sync_session.json');
			require('fs').writeFileSync(sessionPath, 'invalid json');

			// Creating a new state manager should handle corruption
			const newStateManager = new SyncStateManager(testDataPath);
			const newSession = newStateManager.initializeSession(actions, 2);

			// Should create a fresh session
			expect(newSession.processedActions).toBe(0);
			expect(newSession.remainingActions).toHaveLength(3);
		});
	});

	describe('State Queries', () => {
		test('should report correct active state', (done) => {
			expect(stateManager.isActive()).toBe(false);

			const actions = createTestActions(3);
			stateManager.initializeSession(actions, 2);
			
			expect(stateManager.isActive()).toBe(true);

			stateManager.pauseSession();
			expect(stateManager.isActive()).toBe(true);

			stateManager.stopSession();
			
			// Wait for stop to complete
			setTimeout(() => {
				expect(stateManager.isActive()).toBe(false);
				done();
			}, 600);
		});

		test('should provide abort signal', () => {
			const actions = createTestActions(3);
			stateManager.initializeSession(actions, 2);

			const abortSignal = stateManager.getAbortSignal();
			expect(abortSignal).toBeDefined();
			expect(abortSignal?.aborted).toBe(false);

			stateManager.pauseSession();
			expect(abortSignal?.aborted).toBe(true);
		});
	});

	describe('Progress Calculation', () => {
		test('should calculate progress correctly', (done) => {
			const actions = createTestActions(20);
			stateManager.initializeSession(actions, 5);

			// Add delay to ensure elapsed time > 0
			setTimeout(() => {
				// Process 2 batches (10 items)
				for (let i = 0; i < 2; i++) {
					const batch = stateManager.getNextBatch().actions;
					stateManager.completeBatch(batch);
				}

				const progress = stateManager.getProgress();
				expect(progress).not.toBeNull();
				expect(progress?.processed).toBe(10);
				expect(progress?.total).toBe(20);
				expect(progress?.percentage).toBe(50);
				expect(progress?.remaining).toBe(10);
				expect(progress?.currentBatch).toBe(2);
				expect(progress?.totalBatches).toBe(4);
				expect(progress?.state).toBe('running');
				expect(progress?.elapsedTime).toBeGreaterThan(0);
				done();
			}, 10);
		});
	});

	describe('Error Handling', () => {
		test('should track errors', () => {
			const actions = createTestActions(3);
			stateManager.initializeSession(actions, 2);

			stateManager.addError('Test error 1');
			stateManager.addError('Test error 2');

			const session = stateManager.getCurrentSession();
			expect(session?.errors).toEqual(['Test error 1', 'Test error 2']);
		});
	});
});
