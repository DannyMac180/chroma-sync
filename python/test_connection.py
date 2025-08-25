#!/usr/bin/env python3
"""
Test connection script for Chroma Cloud.
Accepts config JSON on stdin and tests the connection.
"""

import sys
import json
import logging

try:
    import chromadb
    from chromadb.config import Settings
except ImportError:
    print(json.dumps({
        "success": False,
        "error": "chromadb not installed"
    }))
    sys.exit(1)


def test_connection():
    """Test connection to Chroma Cloud."""
    try:
        # Read config from stdin
        config_json = sys.stdin.read().strip()
        if not config_json:
            print(json.dumps({
                "success": False,
                "error": "No config provided"
            }))
            return 1

        try:
            config = json.loads(config_json)
        except json.JSONDecodeError as e:
            print(json.dumps({
                "success": False,
                "error": f"Invalid JSON: {e}"
            }))
            return 1

        # Prepare authentication
        headers = {}
        if config.get("token_header") == "Authorization":
            headers["Authorization"] = f"Bearer {config['token']}"
        else:
            headers[config["token_header"]] = config["token"]

        # Create settings
        settings = Settings()
        
        # Create HTTP client with tenant/database
        client = chromadb.HttpClient(
            host=config["host"],
            port=config["port"],
            ssl=config["ssl"],
            headers=headers,
            settings=settings,
            tenant=config.get("tenant", "default_tenant"),
            database=config.get("database", "default_database")
        )

        # Test connection by listing collections
        collections = client.list_collections()
        
        # Try to get or create the specified collection
        collection_name = config["collection"]
        try:
            collection = client.get_collection(name=collection_name)
        except:
            collection = client.create_collection(name=collection_name)

        print(json.dumps({
            "success": True,
            "collections_count": len(collections),
            "collection": collection_name
        }))
        return 0

    except Exception as e:
        print(json.dumps({
            "success": False,
            "error": str(e)
        }))
        return 1


if __name__ == "__main__":
    sys.exit(test_connection())
