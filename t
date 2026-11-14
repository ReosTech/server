#!/bin/bash
clear
# Target URL to test (replace with your application endpoint)
TARGET_URL="https://reostech.pagekite.me"

# Common test payloads designed to trigger WAF rules
# 1. Basic XSS payload
PAYLOAD_XSS='<script>alert(1)</script>'
# 2. Basic SQL Injection payload
PAYLOAD_SQL="' OR 1=1 --"

echo "[TEST] Testing XSS payload on $TARGET_URL..."
response_xss=$(curl -s -o /dev/null -w "%{http_code}" --data-urlencode "input=$PAYLOAD_XSS" "$TARGET_URL")
echo "[RESULT]HTTP Status Code: $response_xss"

echo "[TEST] Testing SQLi payload on $TARGET_URL..."
response_sql=$(curl -s -o /dev/null -w "%{http_code}" --data-urlencode "input=$PAYLOAD_SQL" "$TARGET_URL")
echo "[RESULT]HTTP Status Code: $response_sql"
