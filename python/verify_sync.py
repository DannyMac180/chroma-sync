#!/usr/bin/env python3
"""
Chroma Cloud verification script for Obsidian vault sync.
Compares local file state with Chroma collection to detect inconsistencies.
Accepts JSONL on stdin with configuration and file state.
Outputs verification results as JSON on stdout.
"""

import sys
import json
import logging
from typing import Dict, List, Set, Any, Optional
from dataclasses import dataclass

try:
    import chromadb
    from chromadb.config import Settings
    from chromadb.api import ClientAPI
except ImportError:
    print(json.dumps({
        "type": "error",
        "message": "chromadb not installed. Run: pip install chromadb>=1.0.0"
    }), file=sys.stderr)
    sys.exit(1)


@dataclass
class ChromaConfig:
    host: str
    port: int
    ssl: bool
    token_header: str
    token: str
    tenant: str
    database: str
    collection: str


@dataclass
class FileInfo:
    path: str
    hash: str
    mtime: number
    size: number


@dataclass
class VerificationResult:
    verified: bool
    missing_in_chroma: List[str]
    extra_in_chroma: List[str]
    hash_mismatches: List[Dict[str, str]]
    total_local_files: int
    total_chroma_documents: int
    collection_count: int


class ChromaVerifier:
    def __init__(self, config: ChromaConfig):
        self.config = config
        self.client: Optional[ClientAPI] = None
        self.collection = None
        
        # Setup logging to stderr so it doesn't interfere with JSON output
        logging.basicConfig(
            level=logging.INFO,
            format='%(asctime)s - %(levelname)s - %(message)s',
            stream=sys.stderr
        )
        self.logger = logging.getLogger(__name__)

    def connect(self) -> bool:
        """Establish connection to Chroma Cloud."""
        try:
            # Prepare authentication
            headers = {}
            if self.config.token_header == "Authorization":
                headers["Authorization"] = f"Bearer {self.config.token}"
            else:
                headers[self.config.token_header] = self.config.token

            # Create settings
            settings = Settings()
            
            # Create HTTP client with tenant/database
            self.client = chromadb.HttpClient(
                host=self.config.host,
                port=self.config.port,
                ssl=self.config.ssl,
                headers=headers,
                settings=settings,
                tenant=self.config.tenant,
                database=self.config.database
            )

            # Test connection by listing collections
            try:
                collections = self.client.list_collections()
                self.logger.info(f"Connected to Chroma Cloud. Found {len(collections)} collections.")
            except Exception as e:
                self.logger.error(f"Failed to list collections: {e}")
                return False

            # Set tenant and database if supported
            try:
                if hasattr(self.client, 'set_tenant'):
                    self.client.set_tenant(self.config.tenant)
                if hasattr(self.client, 'set_database'):
                    self.client.set_database(self.config.database)
            except Exception as e:
                self.logger.warning(f"Could not set tenant/database: {e}")

            # Get collection
            try:
                self.collection = self.client.get_collection(name=self.config.collection)
                self.logger.info(f"Using collection: {self.config.collection}")
                return True
            except Exception as e:
                self.logger.error(f"Collection '{self.config.collection}' not found: {e}")
                return False

        except Exception as e:
            self.logger.error(f"Connection failed: {e}")
            return False

    def verify_sync(self, local_files: Dict[str, FileInfo]) -> VerificationResult:
        """Verify sync between local files and Chroma collection."""
        try:
            self.output_progress("Fetching Chroma collection data...")
            
            # Get all documents from Chroma collection
            chroma_data = self.get_all_chroma_documents()
            
            if chroma_data is None:
                return VerificationResult(
                    verified=False,
                    missing_in_chroma=[],
                    extra_in_chroma=[],
                    hash_mismatches=[],
                    total_local_files=0,
                    total_chroma_documents=0,
                    collection_count=0
                )

            self.output_progress("Analyzing differences...")
            
            # Create sets for comparison
            local_doc_ids = set()
            local_path_to_id = {}
            
            # Generate document IDs for local files (same logic as delta.ts)
            for path, file_info in local_files.items():
                doc_id = self.generate_document_id(path)
                local_doc_ids.add(doc_id)
                local_path_to_id[path] = doc_id

            chroma_doc_ids = set(chroma_data['ids'])
            chroma_metadata = {doc_id: meta for doc_id, meta in zip(chroma_data['ids'], chroma_data['metadatas'])}

            # Find missing documents (in local but not in Chroma)
            missing_in_chroma = []
            for path, doc_id in local_path_to_id.items():
                if doc_id not in chroma_doc_ids:
                    missing_in_chroma.append(path)

            # Find extra documents (in Chroma but not in local)
            extra_in_chroma = []
            for doc_id in chroma_doc_ids:
                # Check if this document corresponds to any local file
                found_locally = False
                for path, local_doc_id in local_path_to_id.items():
                    if local_doc_id == doc_id:
                        found_locally = True
                        break
                
                if not found_locally:
                    # Try to get path from metadata if available
                    metadata = chroma_metadata.get(doc_id, {})
                    path = metadata.get('path', doc_id)
                    extra_in_chroma.append(path)

            # Find hash mismatches (documents exist in both but content differs)
            hash_mismatches = []
            for path, file_info in local_files.items():
                doc_id = local_path_to_id[path]
                if doc_id in chroma_doc_ids:
                    # For now, we don't have a good way to compare hashes
                    # since Chroma doesn't store our file hashes directly
                    # This could be enhanced by storing file hashes in metadata
                    pass

            # Determine if verification passed
            verified = (len(missing_in_chroma) == 0 and 
                       len(extra_in_chroma) == 0 and 
                       len(hash_mismatches) == 0)

            return VerificationResult(
                verified=verified,
                missing_in_chroma=missing_in_chroma,
                extra_in_chroma=extra_in_chroma,
                hash_mismatches=hash_mismatches,
                total_local_files=len(local_files),
                total_chroma_documents=len(chroma_doc_ids),
                collection_count=self.collection.count()
            )

        except Exception as e:
            self.logger.error(f"Verification failed: {e}")
            return VerificationResult(
                verified=False,
                missing_in_chroma=[],
                extra_in_chroma=[],
                hash_mismatches=[],
                total_local_files=len(local_files),
                total_chroma_documents=0,
                collection_count=0
            )

    def get_all_chroma_documents(self) -> Optional[Dict[str, List[Any]]]:
        """Retrieve all documents from the Chroma collection."""
        try:
            # Get all documents (Chroma handles pagination internally)
            result = self.collection.get()
            
            self.logger.info(f"Retrieved {len(result['ids'])} documents from Chroma collection")
            return result
            
        except Exception as e:
            self.logger.error(f"Failed to retrieve documents from Chroma: {e}")
            return None

    def generate_document_id(self, path: str) -> str:
        """Generate document ID using same logic as delta.ts"""
        # Replace path separators and special chars to ensure valid Chroma ID
        return path.replace('/', '_').replace('\\', '_').replace(' ', '_')

    def output_progress(self, message: str) -> None:
        """Output progress update as JSON."""
        progress = {
            "type": "progress",
            "message": message
        }
        print(json.dumps(progress), flush=True)

    def output_result(self, result: VerificationResult) -> None:
        """Output verification result as JSON."""
        output = {
            "type": "complete",
            "verified": result.verified,
            "missing_in_chroma": result.missing_in_chroma,
            "extra_in_chroma": result.extra_in_chroma,
            "hash_mismatches": result.hash_mismatches,
            "stats": {
                "total_local_files": result.total_local_files,
                "total_chroma_documents": result.total_chroma_documents,
                "collection_count": result.collection_count,
                "missing_count": len(result.missing_in_chroma),
                "extra_count": len(result.extra_in_chroma),
                "mismatch_count": len(result.hash_mismatches)
            }
        }
        print(json.dumps(output), flush=True)

    def run(self) -> int:
        """Main execution loop."""
        try:
            # Read configuration and file state from stdin
            input_data = []
            for line in sys.stdin:
                line = line.strip()
                if line:
                    try:
                        data = json.loads(line)
                        input_data.append(data)
                    except json.JSONDecodeError as e:
                        self.logger.error(f"Invalid JSON input: {e}")
                        return 1

            if len(input_data) < 2:
                self.logger.error("Expected at least config and file state data")
                return 1

            # First line should contain config
            config_data = input_data[0]
            if 'config' not in config_data:
                self.logger.error("First line must contain config")
                return 1
                
            config_dict = config_data['config']
            config = ChromaConfig(**config_dict)
            self.config = config

            # Second line should contain file state
            file_state_data = input_data[1]
            if 'files' not in file_state_data:
                self.logger.error("Second line must contain file state")
                return 1

            # Convert file state to FileInfo objects
            local_files = {}
            for path, file_data in file_state_data['files'].items():
                local_files[path] = FileInfo(
                    path=file_data['path'],
                    hash=file_data['hash'],
                    mtime=file_data['mtime'],
                    size=file_data['size']
                )

            # Connect to Chroma
            self.output_progress("Connecting to Chroma Cloud...")
            if not self.connect():
                self.logger.error("Failed to connect to Chroma Cloud")
                return 1

            # Perform verification
            self.output_progress("Starting verification...")
            result = self.verify_sync(local_files)

            # Output results
            self.output_result(result)

            return 0 if result.verified else 1

        except KeyboardInterrupt:
            self.logger.info("Interrupted by user")
            return 1
        except Exception as e:
            self.logger.error(f"Unexpected error: {e}")
            return 1


def main():
    """Entry point."""
    verifier = ChromaVerifier(ChromaConfig("", 0, False, "", "", "", "", ""))
    return verifier.run()


if __name__ == "__main__":
    sys.exit(main())
