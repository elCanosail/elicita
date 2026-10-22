#!/bin/bash
export ELICITA_BASE=http://localhost:4321
exec /usr/bin/python3 /root/.openclaw/workspace/projects/elicita/scripts/alertas-scan.py "$@"