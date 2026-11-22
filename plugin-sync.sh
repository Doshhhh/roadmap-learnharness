
#!/usr/bin/env bash
set -euo pipefail

project="$(basename "$PWD")"
path="$HOME/Library/Application Support/LearnHarness/data/plugins/$project"

force=false
restart=false

# Parse arguments
for arg in "$@"; do
  case "$arg" in
    --force) force=true ;;
    --restart) restart=true ;;
    *)
      echo "Unknown argument: $arg"
      echo "Usage: $0 [--force] [--restart]"
      exit 1
      ;;
  esac
done

echo "Preparing installation: $project"

# Handle existing installation
if [[ -e "$path" ]]; then
  if [[ "$force" == true ]]; then
    echo "Removing existing installation: $path"
    rm -rf -- "$path"
  else
    echo "Error: $path already exists. Use --force to overwrite."
    exit 1
  fi
fi

# Install dependencies
echo "Installing dependencies..."
npm ci

# Build project
echo "Building $project..."
npm run build

# Install plugin
echo "Installing $project to $path..."
mkdir -p "$path"
npm run install:local -- "$(dirname "$path")"

echo "$project installed successfully!"

# Optionally restart LearnHarness
if [[ "$restart" == true ]]; then
  echo "Restarting LearnHarness..."
  node scripts/restart-learnharness.mjs --restart
fi
