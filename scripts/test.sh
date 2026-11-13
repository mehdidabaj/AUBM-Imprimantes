#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
node "$ROOT/tests/logic.test.mjs"
cd "$ROOT/server"
python3 -m unittest test_security.py test_snmp_levels.py test_load.py
