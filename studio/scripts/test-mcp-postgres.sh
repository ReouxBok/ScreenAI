#!/usr/bin/env bash
set -euo pipefail
: "${STUDIO_MCP_TEST_DATABASE_URL:?Provide an isolated local extension_mcp_test database}"
MCP_TLS_DIRECTORY=$(mktemp -d)
trap 'rm -rf "$MCP_TLS_DIRECTORY"' EXIT
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout "$MCP_TLS_DIRECTORY/key.pem" -out "$MCP_TLS_DIRECTORY/cert.pem" \
  -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' >/dev/null 2>&1
NODE_EXTRA_CA_CERTS="$MCP_TLS_DIRECTORY/cert.pem" \
STUDIO_MCP_TEST_TLS_KEY="$MCP_TLS_DIRECTORY/key.pem" \
STUDIO_MCP_TEST_TLS_CERT="$MCP_TLS_DIRECTORY/cert.pem" \
  npx vitest run --config vitest.mcp-postgres.config.mts
