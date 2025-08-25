# Agent Instructions for Obsidian Chroma Sync

## Commands
- **Build**: `npm run build` (production) / `npm run dev` (development with watch)
- **Typecheck**: `npm run typecheck` (tsc --noEmit --skipLibCheck)
- **Lint**: `npm run lint` (eslint src --ext .ts)
- **Test**: `npm test` (all tests) / `jest tests/delta.test.ts` (single test)
- **Single test**: `npm test -- --testNamePattern="test name"`

## Architecture
- **TypeScript Obsidian Plugin**: Main entry point is `src/main.ts` (ChromaSyncPlugin class)
- **Core modules**: `settings.ts` (config), `delta.ts` (file change detection), `runner.ts` (Python integration)
- **Python backend**: `python/index_vault.py` (Chroma DB integration), managed virtual environment
- **Testing**: Jest with ts-jest, mocked Obsidian vault API in tests
- **Build**: ESBuild with TypeScript compilation, outputs to `main.js`

## Code Style
- **Imports**: Destructured from modules, grouped by source (Obsidian, node, local)
- **Classes**: PascalCase, interfaces with descriptive names (e.g., ChromaSyncSettings)
- **Variables**: camelCase, descriptive names, class properties declared with types
- **Types**: Explicit interfaces for settings and data structures, union types for enums
- **Error handling**: Try-catch blocks with Notice() for user feedback, detailed logging
- **Async**: Proper async/await patterns, no blocking operations on startup
