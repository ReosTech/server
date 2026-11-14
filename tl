#!/bin/bash

# Target URL to test (replace with your application endpoint)
TARGET_URL="http://localhost:8080"

# Common test payloads designed to trigger WAF rules
# 1. Basic XSS payload
PAYLOAD_XSS='<script>alert(1)</script>'
# 2. Basic SQL Injection payload
PAYLOAD_SQL="' OR 1=1 --"

echo "[*] Testing XSS payload on $TARGET_URL..."
response_xss=$(curl -s -o /dev/null -w "%{http_code}" --data-urlencode "input=$PAYLOAD_XSS" "$TARGET_URL")
echo "HTTP Status Code: $response_xss"

echo "[*] Testing SQLi payload on $TARGET_URL..."
response_sql=$(curl -s -o /dev/null -w "%{http_code}" --data-urlencode "input=$PAYLOAD_SQL" "$TARGET_URL")
echo "HTTP Status Code: $response_sql"
