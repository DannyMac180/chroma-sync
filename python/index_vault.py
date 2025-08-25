#!/usr/bin/env python3
"""
Chroma Cloud indexer for Obsidian vault sync.
Accepts JSONL on stdin with configuration and document actions.
Outputs progress JSON on stdout.
Supports PDF text extraction and image OCR when dependencies are available.
"""

import sys
import json
import logging
import time
import os
import re
from pathlib import Path
from typing import Dict, List, Any, Optional
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

# Optional dependencies with graceful degradation
PYPDF2_AVAILABLE = False
PILLOW_AVAILABLE = False
PYTESSERACT_AVAILABLE = False

try:
    import PyPDF2
    PYPDF2_AVAILABLE = True
except ImportError:
    pass

try:
    from PIL import Image
    PILLOW_AVAILABLE = True
except ImportError:
    pass

try:
    import pytesseract
    PYTESSERACT_AVAILABLE = True
except ImportError:
    pass


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


class ChromaIndexer:
    def __init__(self, config: ChromaConfig):
        self.config = config
        self.client: Optional[ClientAPI] = None
        self.collection = None
        self.processed = 0
        self.vault_root = ""  # Will be set from config
        
        # Setup logging to stderr so it doesn't interfere with JSON output
        logging.basicConfig(
            level=logging.INFO,
            format='%(asctime)s - %(levelname)s - %(message)s',
            stream=sys.stderr
        )
        self.logger = logging.getLogger(__name__)
        
        # Log availability of optional features
        self.log_feature_availability()

    def log_feature_availability(self) -> None:
        """Log which optional features are available."""
        features = []
        if PYPDF2_AVAILABLE:
            features.append("PDF text extraction")
        if PILLOW_AVAILABLE and PYTESSERACT_AVAILABLE:
            features.append("Image OCR")
        
        if features:
            self.logger.info(f"Optional features available: {', '.join(features)}")
        else:
            self.logger.info("No optional content extraction features available")
            
        if not PYPDF2_AVAILABLE:
            self.logger.debug("PDF extraction unavailable - install PyPDF2: pip install PyPDF2")
        if not PILLOW_AVAILABLE or not PYTESSERACT_AVAILABLE:
            missing = []
            if not PILLOW_AVAILABLE:
                missing.append("Pillow")
            if not PYTESSERACT_AVAILABLE:
                missing.append("pytesseract")
            self.logger.debug(f"Image OCR unavailable - install: pip install {' '.join(missing)}")

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

            # Get or create collection
            try:
                self.collection = self.client.get_collection(name=self.config.collection)
                self.logger.info(f"Using existing collection: {self.config.collection}")
            except Exception:
                try:
                    self.collection = self.client.create_collection(name=self.config.collection)
                    self.logger.info(f"Created new collection: {self.config.collection}")
                except Exception as e:
                    self.logger.error(f"Failed to create collection: {e}")
                    return False

            return True

        except Exception as e:
            self.logger.error(f"Connection failed: {e}")
            return False

    def process_action(self, action: Dict[str, Any]) -> bool:
        """Process a single delta action."""
        try:
            action_type = action.get('action')
            doc_id = action.get('id')

            if not doc_id:
                self.logger.error("Action missing document ID")
                return False

            if action_type == 'upsert':
                return self.upsert_document(action)
            elif action_type == 'delete':
                return self.delete_document(doc_id)
            else:
                self.logger.error(f"Unknown action type: {action_type}")
                return False

        except Exception as e:
            self.logger.error(f"Failed to process action: {e}")
            return False

    def upsert_document(self, action: Dict[str, Any]) -> bool:
        """Upsert a document into the collection."""
        try:
            doc_id = action['id']
            text = action.get('text', '')
            metadata = action.get('metadata', {})
            file_path = metadata.get('path', '')
            
            # Process content based on metadata flags and file type
            processed_text = self.process_content(text, metadata, file_path)
            
            # Check if content exceeds size limits and chunk if needed
            if len(processed_text.encode('utf-8')) > 16000:  # 16KB limit with some buffer
                return self.upsert_document_chunked(doc_id, processed_text, metadata)
            
            # Check if ID exceeds size limit and truncate if needed
            if len(doc_id.encode('utf-8')) > 120:  # 128 byte limit with buffer
                original_id = doc_id
                doc_id = self.truncate_document_id(doc_id)
                self.logger.warning(f"Truncated document ID from {len(original_id)} to {len(doc_id)} characters: {original_id} -> {doc_id}")
            
            # Ensure metadata is JSON-serializable
            clean_metadata = self.clean_metadata(metadata)
            
            self.collection.upsert(
                ids=[doc_id],
                documents=[processed_text],
                metadatas=[clean_metadata]
            )
            
            self.logger.debug(f"Upserted document: {doc_id}")
            return True
            
        except Exception as e:
            error_msg = str(e)
            # Check if this is a quota error (not a hard failure)
            if "Quota exceeded" in error_msg:
                self.logger.warning(f"Quota exceeded for document {action.get('id')}: {e}")
                return True  # Treat quota errors as warnings, not failures
            else:
                self.logger.error(f"Failed to upsert document {action.get('id')}: {e}")
                return False

    def delete_document(self, doc_id: str) -> bool:
        """Delete a document from the collection."""
        try:
            # Check if document exists first
            try:
                result = self.collection.get(ids=[doc_id])
                if not result['ids']:
                    self.logger.warning(f"Document {doc_id} not found for deletion")
                    return True  # Not an error if it doesn't exist
            except Exception:
                # If get fails, try delete anyway
                pass
            
            self.collection.delete(ids=[doc_id])
            self.logger.debug(f"Deleted document: {doc_id}")
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to delete document {doc_id}: {e}")
            return False

    def clean_metadata(self, metadata: Dict[str, Any]) -> Dict[str, Any]:
        """Clean metadata to ensure it's JSON-serializable and Chroma-compatible."""
        clean = {}
        for key, value in metadata.items():
            if isinstance(value, (str, int, float, bool)):
                clean[key] = value
            elif value is None:
                continue  # Skip None values
            else:
                # Convert complex types to strings
                clean[key] = str(value)
        return clean

    def truncate_document_id(self, doc_id: str) -> str:
        """Truncate document ID to fit within size limits while keeping it meaningful."""
        max_bytes = 120  # Conservative limit
        
        # If already short enough, return as-is
        if len(doc_id.encode('utf-8')) <= max_bytes:
            return doc_id
        
        # Try to keep the meaningful parts: start and end
        # Remove middle characters and add ellipsis
        start_chars = max_bytes // 3
        end_chars = max_bytes // 3
        
        # Ensure we don't split in the middle of a UTF-8 character
        while start_chars > 0 and len(doc_id[:start_chars].encode('utf-8')) > start_chars:
            start_chars -= 1
            
        while end_chars > 0 and len(doc_id[-end_chars:].encode('utf-8')) > end_chars:
            end_chars -= 1
        
        truncated = doc_id[:start_chars] + "..." + doc_id[-end_chars:]
        
        # Make sure the result fits
        while len(truncated.encode('utf-8')) > max_bytes and start_chars > 1:
            start_chars -= 1
            truncated = doc_id[:start_chars] + "..." + doc_id[-end_chars:]
        
        return truncated

    def upsert_document_chunked(self, doc_id: str, text: str, metadata: Dict[str, Any]) -> bool:
        """Upsert a large document by splitting it into chunks."""
        try:
            chunk_size = 15000  # 15KB per chunk to stay under limit
            text_bytes = text.encode('utf-8')
            
            if len(text_bytes) <= chunk_size:
                # Document is small enough, process normally
                return self.upsert_single_document(doc_id, text, metadata)
            
            # Split into chunks
            chunks = []
            start = 0
            chunk_num = 0
            
            while start < len(text_bytes):
                end = min(start + chunk_size, len(text_bytes))
                
                # Try not to break in the middle of UTF-8 characters
                while end < len(text_bytes) and (text_bytes[end] & 0x80) != 0:
                    end -= 1
                
                chunk_bytes = text_bytes[start:end]
                chunk_text = chunk_bytes.decode('utf-8')
                
                chunk_id = f"{doc_id}_chunk_{chunk_num}"
                if len(chunk_id.encode('utf-8')) > 120:
                    base_id = self.truncate_document_id(doc_id)
                    chunk_id = f"{base_id}_chunk_{chunk_num}"
                
                # Update metadata for chunk
                chunk_metadata = metadata.copy()
                chunk_metadata['is_chunk'] = True
                chunk_metadata['chunk_number'] = chunk_num
                chunk_metadata['total_chunks'] = -1  # Will be updated after all chunks are created
                chunk_metadata['original_doc_id'] = doc_id
                
                chunks.append((chunk_id, chunk_text, chunk_metadata))
                
                start = end
                chunk_num += 1
            
            # Update total_chunks in all chunk metadata
            for i, (chunk_id, chunk_text, chunk_metadata) in enumerate(chunks):
                chunk_metadata['total_chunks'] = len(chunks)
            
            # Upload all chunks
            success_count = 0
            for chunk_id, chunk_text, chunk_metadata in chunks:
                if self.upsert_single_document(chunk_id, chunk_text, chunk_metadata):
                    success_count += 1
                else:
                    self.logger.error(f"Failed to upload chunk {chunk_id}")
            
            # Consider successful if at least half the chunks uploaded
            success = success_count >= len(chunks) // 2
            
            if success:
                self.logger.info(f"Successfully chunked and uploaded document {doc_id} into {len(chunks)} chunks ({success_count}/{len(chunks)} successful)")
            else:
                self.logger.error(f"Failed to upload chunked document {doc_id} - only {success_count}/{len(chunks)} chunks successful")
            
            return success
            
        except Exception as e:
            self.logger.error(f"Failed to chunk document {doc_id}: {e}")
            return False

    def upsert_single_document(self, doc_id: str, text: str, metadata: Dict[str, Any]) -> bool:
        """Upsert a single document (helper method for chunking)."""
        try:
            clean_metadata = self.clean_metadata(metadata)
            
            self.collection.upsert(
                ids=[doc_id],
                documents=[text],
                metadatas=[clean_metadata]
            )
            
            return True
            
        except Exception as e:
            error_msg = str(e)
            if "Quota exceeded" in error_msg:
                self.logger.warning(f"Quota exceeded for document {doc_id}: {e}")
                return True  # Treat as warning
            else:
                self.logger.error(f"Failed to upsert document {doc_id}: {e}")
                return False

    def process_content(self, text: str, metadata: Dict[str, Any], file_path: str) -> str:
        """Process content based on metadata flags and file type."""
        try:
            processed_text = text
            
            # Check if PDF extraction is required
            if metadata.get('requiresExtraction', False) and file_path.lower().endswith('.pdf'):
                processed_text = self.extract_pdf_text(processed_text, file_path)
            
            # Check if image OCR is required
            if metadata.get('requiresOCR', False) and self.is_image_file(file_path):
                processed_text = self.extract_image_text(processed_text, file_path)
            
            # Replace any remaining placeholders
            processed_text = self.replace_content_placeholders(processed_text)
            
            return processed_text
            
        except Exception as e:
            self.logger.error(f"Failed to process content for {file_path}: {e}")
            return text  # Return original text on error

    def extract_pdf_text(self, text: str, file_path: str) -> str:
        """Extract text from PDF file, replacing placeholders."""
        if not PYPDF2_AVAILABLE:
            self.logger.warning(f"PDF extraction requested but PyPDF2 not available for {file_path}")
            return text
        
        # Check if text contains PDF placeholder
        if '[PDF_CONTENT_PLACEHOLDER]' not in text:
            return text
        
        try:
            # Construct full path
            full_path = os.path.join(self.vault_root, file_path) if self.vault_root else file_path
            
            if not os.path.exists(full_path):
                self.logger.warning(f"PDF file not found: {full_path}")
                return text.replace('[PDF_CONTENT_PLACEHOLDER]', '[PDF file not found]')
            
            extracted_text = ""
            with open(full_path, 'rb') as file:
                pdf_reader = PyPDF2.PdfReader(file)
                for page_num, page in enumerate(pdf_reader.pages):
                    try:
                        page_text = page.extract_text()
                        if page_text.strip():
                            extracted_text += f"Page {page_num + 1}:\n{page_text}\n\n"
                    except Exception as e:
                        self.logger.warning(f"Failed to extract text from page {page_num + 1} of {file_path}: {e}")
            
            if extracted_text.strip():
                result = text.replace('[PDF_CONTENT_PLACEHOLDER]', extracted_text.strip())
                self.logger.debug(f"Extracted {len(extracted_text)} characters from PDF: {file_path}")
                return result
            else:
                return text.replace('[PDF_CONTENT_PLACEHOLDER]', '[PDF extraction failed - no text found]')
                
        except Exception as e:
            self.logger.error(f"Failed to extract PDF text from {file_path}: {e}")
            return text.replace('[PDF_CONTENT_PLACEHOLDER]', f'[PDF extraction failed: {str(e)}]')

    def extract_image_text(self, text: str, file_path: str) -> str:
        """Extract text from image file using OCR, replacing placeholders."""
        if not (PILLOW_AVAILABLE and PYTESSERACT_AVAILABLE):
            self.logger.warning(f"Image OCR requested but dependencies not available for {file_path}")
            return text
        
        # Check if text contains image OCR placeholder
        if '[IMAGE_OCR_PLACEHOLDER]' not in text:
            return text
        
        try:
            # Construct full path
            full_path = os.path.join(self.vault_root, file_path) if self.vault_root else file_path
            
            if not os.path.exists(full_path):
                self.logger.warning(f"Image file not found: {full_path}")
                return text.replace('[IMAGE_OCR_PLACEHOLDER]', '[Image file not found]')
            
            # Open and process image
            with Image.open(full_path) as img:
                # Convert to RGB if necessary
                if img.mode != 'RGB':
                    img = img.convert('RGB')
                
                # Extract text using OCR
                extracted_text = pytesseract.image_to_string(img)
                
                if extracted_text.strip():
                    result = text.replace('[IMAGE_OCR_PLACEHOLDER]', extracted_text.strip())
                    self.logger.debug(f"Extracted {len(extracted_text)} characters from image: {file_path}")
                    return result
                else:
                    return text.replace('[IMAGE_OCR_PLACEHOLDER]', '[OCR extraction failed - no text found]')
                    
        except Exception as e:
            self.logger.error(f"Failed to extract text from image {file_path}: {e}")
            return text.replace('[IMAGE_OCR_PLACEHOLDER]', f'[OCR extraction failed: {str(e)}]')

    def is_image_file(self, file_path: str) -> bool:
        """Check if file is a supported image format."""
        image_extensions = {'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.tif', '.webp'}
        return Path(file_path).suffix.lower() in image_extensions

    def replace_content_placeholders(self, text: str) -> str:
        """Replace any remaining content placeholders with appropriate messages."""
        replacements = {
            '[PDF_CONTENT_PLACEHOLDER]': '[PDF content extraction not configured]',
            '[IMAGE_OCR_PLACEHOLDER]': '[Image OCR not configured]'
        }
        
        result = text
        for placeholder, replacement in replacements.items():
            result = result.replace(placeholder, replacement)
        
        return result

    def output_progress(self, message: str, processed: Optional[int] = None, total: Optional[int] = None) -> None:
        """Output progress update as JSON."""
        progress = {
            "type": "progress",
            "message": message
        }
        if processed is not None:
            progress["processed"] = processed
        if total is not None:
            progress["total"] = total
        
        print(json.dumps(progress), flush=True)

    def run(self) -> int:
        """Main execution loop."""
        try:
            # Read configuration from first line
            first_line = sys.stdin.readline().strip()
            if not first_line:
                self.logger.error("No input provided")
                return 1

            try:
                config_data = json.loads(first_line)
                if 'config' not in config_data:
                    self.logger.error("First line must contain config")
                    return 1
                    
                config_dict = config_data['config']
                config = ChromaConfig(**config_dict)
                self.config = config
                
                # Set vault root if provided for content extraction
                self.vault_root = config_data.get('vaultRoot', '')
                
            except (json.JSONDecodeError, TypeError) as e:
                self.logger.error(f"Invalid config JSON: {e}")
                return 1

            # Connect to Chroma
            self.output_progress("Connecting to Chroma Cloud...")
            if not self.connect():
                self.logger.error("Failed to connect to Chroma Cloud")
                return 1

            # Process actions
            actions_processed = 0
            actions_failed = 0
            
            # Read all actions first to get total count
            actions = []
            for line in sys.stdin:
                line = line.strip()
                if not line:
                    continue
                    
                try:
                    action = json.loads(line)
                    actions.append(action)
                except json.JSONDecodeError as e:
                    self.logger.error(f"Invalid action JSON: {e}")
                    actions_failed += 1
                    continue
            
            total_actions = len(actions)
            self.output_progress(f"Starting to process {total_actions} actions", 0, total_actions)
            
            # Now process each action with accurate progress
            for i, action in enumerate(actions, 1):
                # Check if this action requires content extraction
                action_id = action.get('id', f'action_{i}')
                metadata = action.get('metadata', {})
                file_path = metadata.get('path', '')
                
                needs_extraction = (
                    metadata.get('requiresExtraction', False) or
                    metadata.get('requiresOCR', False)
                )
                
                if needs_extraction:
                    file_type = "PDF" if file_path.lower().endswith('.pdf') else "image" if self.is_image_file(file_path) else "file"
                    self.output_progress(f"Extracting content from {file_type}: {Path(file_path).name}", actions_processed, total_actions)
                
                if self.process_action(action):
                    actions_processed += 1
                else:
                    actions_failed += 1
                    
                self.processed = actions_processed
                
                # Output progress for every action now that we know the total
                self.output_progress(
                    f"Processed {actions_processed} of {total_actions} documents",
                    actions_processed,
                    total_actions
                )

            # Final summary
            self.output_progress(
                f"Completed: {actions_processed} processed, {actions_failed} failed",
                actions_processed,
                total_actions
            )

            # Get final collection count
            try:
                count = self.collection.count()
                self.logger.info(f"Collection now contains {count} documents")
            except Exception as e:
                self.logger.warning(f"Could not get collection count: {e}")

            return 0 if actions_failed == 0 else 1

        except KeyboardInterrupt:
            self.logger.info("Interrupted by user")
            return 1
        except Exception as e:
            self.logger.error(f"Unexpected error: {e}")
            return 1


def main():
    """Entry point."""
    indexer = ChromaIndexer(ChromaConfig("", 0, False, "", "", "", "", ""))
    return indexer.run()


if __name__ == "__main__":
    sys.exit(main())
