#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cert_dir="$root/.dev-auth/certs"
cert="$cert_dir/localhost.pem"
key="$cert_dir/localhost-key.pem"

mkdir -p "$cert_dir"
chmod 700 "$root/.dev-auth" "$cert_dir"

if [[ -e "$cert" || -e "$key" ]]; then
  echo "Refusing to overwrite an existing local authentication certificate." >&2
  echo "Remove $cert and $key explicitly before rotating it." >&2
  exit 1
fi

openssl req -x509 -newkey rsa:3072 -sha256 -nodes \
  -days 30 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth" \
  -keyout "$key" \
  -out "$cert"

chmod 600 "$key"
chmod 644 "$cert"

cat <<EOF
Created:
  $cert
  $key

The certificate is self-signed. Import localhost.pem into a development-only
browser trust store, or have IT provide a locally trusted replacement using the
same filenames. Do not install it as a system-wide CA: it is an end-entity
localhost certificate and expires after 30 days.
EOF
