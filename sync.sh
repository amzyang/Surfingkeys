#!/usr/bin/env bash
set -euo pipefail

git fetch --tags --all
git rebase upstream/master
npm test
npm run build:dev
